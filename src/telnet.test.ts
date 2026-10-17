import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import { SessionPool } from './sessions';
import { GREETING, TelnetParser, clampSize, escapeIAC, startTelnetServer, termFor, type TelnetServer } from './telnet';

const IAC = 255;

function parse(...chunks: number[][]) {
  const seen = { data: [] as number[], replies: [] as number[][], sizes: [] as unknown[], types: [] as string[] };
  const parser = new TelnetParser({
    data: (data) => seen.data.push(...data),
    reply: (data) => seen.replies.push([...data]),
    size: (size) => seen.sizes.push(size),
    terminalType: (type) => seen.types.push(type),
  });
  for (const chunk of chunks) parser.push(Buffer.from(chunk));
  return seen;
}

describe('TelnetParser', () => {
  test('passes keys on and takes the protocol out', () => {
    const seen = parse([0x61, IAC, 241 /* NOP */, 0x62, IAC, IAC, 0x63]);
    expect(seen.data).toEqual([0x61, 0x62, IAC, 0x63]);
  });

  test('Enter (CR NUL, CR LF) arrives as CR, even split across packets', () => {
    expect(parse([0x61, 13, 0], [13], [10, 0x62]).data).toEqual([0x61, 13, 13, 0x62]);
  });

  test('reads the window size, escaped 255s included, and keeps it sane', () => {
    const seen = parse([IAC, 250, 31, 0, 120, 0, 40, IAC, 240], [IAC, 250, 31, 0, IAC, IAC, 0, 50, IAC, 240], [IAC, 250, 31, 39, 16, 0, 1, IAC, 240]);
    expect(seen.sizes).toEqual([{ columns: 120, rows: 40 }, { columns: 255, rows: 50 }, { columns: 400, rows: 8 }]);
    expect(seen.data).toEqual([]);
  });

  test('asks for the terminal type and cleans it', () => {
    const will = parse([IAC, 251, 24]);
    expect(will.replies).toEqual([[IAC, 250, 24, 1, IAC, 240]]);
    const is = parse([IAC, 250, 24, 0, ...Buffer.from('XTERM-256COLOR\u001b[2J/../x'), IAC, 240]);
    expect(is.types).toEqual(['XTERM-256COLOR2J..x']);
  });

  test('refuses options it doesn\'t know, once', () => {
    const seen = parse([IAC, 253, 34], [IAC, 251, 39], [IAC, 253, 34], [IAC, 253, 1]);
    expect(seen.replies).toEqual([[IAC, 252, 34], [IAC, 254, 39]]);
  });

  test('bounds what a subnegotiation can make it keep', () => {
    const long = new Array(10000).fill(0x41);
    const seen = parse([IAC, 250, 24, 0, ...long, IAC, 240]);
    expect(seen.types[0].length).toBeLessThanOrEqual(40);
  });
});

describe('telnet helpers', () => {
  test('$TERM comes from a short list, never from the client as it is', () => {
    expect(termFor('XTERM-256COLOR')).toBe('xterm-256color');
    expect(termFor('rxvt-unicode-256color')).toBe('rxvt-unicode-256color');
    expect(termFor('screen.xterm-256color')).toBe('screen-256color');
    expect(termFor('LINUX')).toBe('linux');
    expect(termFor('../../etc/passwd')).toBe('xterm-256color');
    expect(termFor(null)).toBe('xterm-256color');
  });

  test('window sizes are clamped and 255s escaped', () => {
    expect(clampSize(0, 0)).toEqual({ columns: 80, rows: 24 });
    expect(clampSize(5, 1000)).toEqual({ columns: 20, rows: 200 });
    expect([...escapeIAC(Buffer.from([1, IAC, 2]))]).toEqual([1, IAC, IAC, 2]);
  });
});

describe('the telnet server', () => {
  // stands in for a mapscii session: reports what it got
  const sessionScript = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mapscii-telnet-')), 'session.cjs');
  fs.writeFileSync(sessionScript, `
    process.stdout.write('TERM=' + process.env.TERM + ' SIZE=' + process.env.MAPSCII_COLUMNS + 'x' + process.env.MAPSCII_ROWS + ' SESSION=' + process.env.MAPSCII_REMOTE_SESSION + '\\n');
    process.on('message', (m) => process.stdout.write('RESIZE ' + m.columns + 'x' + m.rows + '\\n'));
    process.stdin.on('data', (d) => {
      if (d.includes(113)) process.exit(0); // q
      process.stdout.write('KEYS ' + JSON.stringify([...d]) + ' ');
      process.stdout.write(Buffer.from([255, 10]));
    });
  `);

  let server: TelnetServer | null = null;
  let pool: SessionPool | null = null;
  afterEach(async () => {
    pool?.closeAll();
    await server?.close();
    server = null;
  });

  const start = async (options: { maxSessions?: number; maxPerAddress?: number; idleMinutes?: number } = {}) => {
    pool = new SessionPool({ command: process.execPath, args: [sessionScript], ...options });
    server = await startTelnetServer({ port: 0, pool, negotiationMs: 300 });
    return (server.server.address() as net.AddressInfo).port;
  };

  const connect = (port: number) => new Promise<{ socket: net.Socket; received: () => Buffer; closed: Promise<void> }>((resolve) => {
    const chunks: Buffer[] = [];
    const socket = net.connect(port, '127.0.0.1', () => resolve({
      socket,
      received: () => Buffer.concat(chunks),
      closed: new Promise((done) => socket.on('close', () => done())),
    }));
    socket.on('data', (data) => chunks.push(data));
  });

  const until = async (check: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!check()) {
      if (Date.now() > end) throw new Error('timed out');
      await Bun.sleep(10);
    }
  };

  test('negotiates, starts a session with the client\'s size and type, and passes keys and resizes', async () => {
    const port = await start();
    const client = await connect(port);
    await until(() => client.received().length >= GREETING.length);
    expect([...client.received().subarray(0, GREETING.length)]).toEqual([...GREETING]);

    client.socket.write(Buffer.from([IAC, 251, 31, IAC, 251, 24, IAC, 250, 31, 0, 100, 0, 30, IAC, 240]));
    await until(() => client.received().includes(Buffer.from([IAC, 250, 24, 1, IAC, 240])));
    client.socket.write(Buffer.from([IAC, 250, 24, 0, ...Buffer.from('RXVT-UNICODE-256COLOR'), IAC, 240]));
    await until(() => client.received().toString('latin1').includes('SESSION=1'));
    expect(client.received().toString('latin1')).toContain('TERM=rxvt-unicode-256color SIZE=100x30');

    client.socket.write(Buffer.from([0x61, 13, 0]));
    await until(() => client.received().toString('latin1').includes('KEYS [97,13]'));
    // the session's 0xff went out escaped
    expect(client.received().includes(Buffer.from([IAC, IAC, 10]))).toBe(true);

    client.socket.write(Buffer.from([IAC, 250, 31, 0, 90, 0, 20, IAC, 240]));
    await until(() => client.received().toString('latin1').includes('RESIZE 90x20'));

    client.socket.write('q');
    await client.closed;
    expect(pool?.sessions()).toBe(0);
  });

  test('starts anyway when the client doesn\'t negotiate', async () => {
    const port = await start();
    const client = await connect(port);
    await until(() => client.received().toString('latin1').includes('SIZE=80x24'));
    expect(client.received().toString('latin1')).toContain('TERM=xterm-256color');
    client.socket.destroy();
  });

  test('turns away clients beyond the limits', async () => {
    const port = await start({ maxSessions: 5, maxPerAddress: 1 });
    const first = await connect(port);
    await until(() => pool?.sessions() === 1);
    const second = await connect(port);
    await second.closed;
    expect(second.received().toString()).toContain('busy');
    first.socket.destroy();
    await first.closed;
    await until(() => pool?.sessions() === 0);
  });

  test('ends the session when the client goes', async () => {
    const port = await start();
    const client = await connect(port);
    await until(() => client.received().toString('latin1').includes('SESSION=1'));
    client.socket.destroy();
    await until(() => pool?.sessions() === 0);
  });
});
