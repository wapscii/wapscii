import { afterEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import net from 'net';
import os from 'os';
import path from 'path';
import ssh2 from 'ssh2';
import { SessionPool } from './sessions';
import { fingerprintOf, loadOrCreateHostKey, startSshServer, type SshServer } from './ssh';

const { Client } = ssh2;

const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mapscii-ssh-'));
// stands in for a mapscii session: reports what it got
const sessionScript = path.join(folder, 'session.cjs');
fs.writeFileSync(sessionScript, `
  process.stdout.write('TERM=' + process.env.TERM + ' SIZE=' + process.env.MAPSCII_COLUMNS + 'x' + process.env.MAPSCII_ROWS + ' SESSION=' + process.env.MAPSCII_REMOTE_SESSION + '\\n');
  process.on('message', (m) => process.stdout.write('RESIZE ' + m.columns + 'x' + m.rows + '\\n'));
  process.stdin.on('data', (d) => {
    if (d.includes(113)) process.exit(0); // q
    process.stdout.write('KEYS ' + JSON.stringify([...d]) + '\\n');
  });
`);

const until = async (check: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await Bun.sleep(10);
  }
};

const clients = new Set<InstanceType<typeof Client>>();

type Connected = { client: InstanceType<typeof Client>; closed: Promise<void> };

function connect(port: number): Promise<Connected> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    clients.add(client);
    // the server hung up (bun's socket says 'end', and may never say 'close')
    const closed = new Promise<void>((done) => {
      client.on('end', () => done());
      client.on('close', () => done());
    });
    client.on('ready', () => resolve({ client, closed }));
    client.on('error', reject);
    client.connect({ host: '127.0.0.1', port, username: 'anyone', tryKeyboard: false });
  });
}

describe('the SSH server', () => {
  let server: SshServer | null = null;
  let pool: SessionPool | null = null;

  afterEach(async () => {
    for (const client of clients) client.end();
    clients.clear();
    pool?.closeAll();
    await server?.close();
    server = null;
  });

  const start = async (limits: { maxSessions?: number; maxPerAddress?: number } = {}, handshakeMs?: number) => {
    pool = new SessionPool({ command: process.execPath, args: [sessionScript], ...limits });
    server = await startSshServer({ port: 0, pool, hostKeyFile: path.join(folder, 'host_key'), handshakeMs });
    return server.port();
  };

  test('lets anyone in, with no password, to a map session on their terminal', async () => {
    const port = await start();
    const { client, closed } = await connect(port);
    const output: Buffer[] = [];
    const text = () => Buffer.concat(output).toString();
    const stream = await new Promise<ssh2.ClientChannel>((resolve, reject) =>
      client.shell({ term: 'rxvt-unicode-256color', cols: 100, rows: 30 }, (error, channel) =>
        error ? reject(error) : resolve(channel)));
    stream.on('data', (data: Buffer) => output.push(data));

    await until(() => text().includes('SESSION=1'));
    expect(text()).toContain('TERM=rxvt-unicode-256color SIZE=100x30');

    stream.write('a\r');
    await until(() => text().includes('KEYS [97,13]'));

    stream.setWindow(25, 90, 0, 0);
    await until(() => text().includes('RESIZE 90x25'));

    // the map ends: its channel closes, and the client hangs up, as ssh does
    const channelClosed = new Promise<void>((done) => stream.on('close', () => done()));
    stream.write('q');
    await channelClosed;
    client.end();
    await closed;
    await until(() => pool?.sessions() === 0);
  });

  test('runs no commands and opens no files', async () => {
    const port = await start();
    const { client } = await connect(port);
    const exec = await new Promise<Error | undefined>((resolve) => client.exec('id', (error) => resolve(error)));
    expect(exec).toBeInstanceOf(Error);
    const sftp = await new Promise<Error | undefined>((resolve) => client.sftp((error) => resolve(error)));
    expect(sftp).toBeInstanceOf(Error);
    const forward = await new Promise<Error | undefined>((resolve) =>
      client.forwardOut('127.0.0.1', 1, '127.0.0.1', 22, (error) => resolve(error)));
    expect(forward).toBeInstanceOf(Error);
    client.end();
  });

  test('says when it needs a terminal, or is busy', async () => {
    const port = await start({ maxSessions: 1 });
    const first = await connect(port);
    const noTerminal = await new Promise<string>((resolve) => first.client.shell(false, (error, channel) => {
      if (error) return resolve(String(error));
      let text = '';
      channel.on('data', (data: Buffer) => { text += data; });
      channel.on('close', () => resolve(text));
      channel.on('end', () => setTimeout(() => resolve(text), 50));
    }));
    expect(noTerminal).toContain('needs a terminal');
    first.client.end();
    await first.closed;

    const holder = await connect(port);
    await until(() => pool?.sessions() === 1);
    const second = await connect(port);
    const busy = await new Promise<string>((resolve) => second.client.shell({ term: 'xterm', cols: 80, rows: 24 }, (error, channel) => {
      if (error) return resolve(String(error));
      let text = '';
      channel.on('data', (data: Buffer) => { text += data; });
      channel.on('close', () => resolve(text));
      channel.on('end', () => setTimeout(() => resolve(text), 50));
    }));
    expect(busy).toContain('busy');
    holder.client.end();
  });

  test('closes connections that don\'t get to their map in time', async () => {
    const port = await start({}, 300);
    // one that never says a word, and one that logs in and opens nothing
    const silent = net.connect(port, '127.0.0.1');
    const silentClosed = new Promise<void>((done) => silent.on('close', () => done()));
    silent.on('error', () => undefined);
    const idle = await connect(port);
    await until(() => pool?.sessions() === 1);
    await silentClosed;
    await idle.closed;
    await until(() => pool?.sessions() === 0);
  });

  test('keeps its host key, readable only by its owner', () => {
    const file = path.join(folder, 'kept', 'key');
    const made = loadOrCreateHostKey(file);
    expect(made.created).toBe(true);
    expect(made.key.toString()).toContain('BEGIN OPENSSH PRIVATE KEY');
    if (process.platform !== 'win32') expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    const again = loadOrCreateHostKey(file);
    expect(again.created).toBe(false);
    expect(fingerprintOf(again.key)).toBe(fingerprintOf(made.key));
    expect(fingerprintOf(made.key)).toMatch(/^SHA256:[A-Za-z0-9+/]{43}$/);
  });
});
