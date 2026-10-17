/*
  MapSCII - Terminal Map Viewer
  Telnet server: `mapscii --telnet 2323`, then `telnet host 2323`.

  Every connection gets a mapscii process of its own, so that sessions
  share nothing but the tile cache on disk: their own settings, their own
  terminal, and a crash or a hang ends one session only. The server speaks
  the telnet protocol (RFC 854) and asks the client for its window size
  (NAWS, RFC 1073) and terminal type (RFC 1091), which the session gets as
  its size and $TERM.
*/

import { spawn, type ChildProcess } from 'child_process';
import net from 'net';

const IAC = 255;
const DONT = 254;
const DO = 253;
const WONT = 252;
const WILL = 251;
const SB = 250;
const SE = 240;

const ECHO = 1;
const SGA = 3; // suppress go-ahead
const TTYPE = 24;
const NAWS = 31;

const TTYPE_IS = 0;
const TTYPE_SEND = 1;

/** What the server asks for when a client connects: the client's keys one by one, unechoed, its size and its type. */
export const GREETING = Buffer.from([
  IAC, WILL, ECHO,
  IAC, WILL, SGA,
  IAC, DO, NAWS,
  IAC, DO, TTYPE,
]);

export const MIN_COLUMNS = 20;
export const MAX_COLUMNS = 400;
export const MIN_ROWS = 8;
export const MAX_ROWS = 200;

export interface WindowSize {
  columns: number;
  rows: number;
}

/** Window sizes as clients report them, kept to what a session will draw. */
export function clampSize(columns: number, rows: number): WindowSize {
  return {
    columns: Math.max(MIN_COLUMNS, Math.min(MAX_COLUMNS, columns || 80)),
    rows: Math.max(MIN_ROWS, Math.min(MAX_ROWS, rows || 24)),
  };
}

/**
 * $TERM for a session, from the terminal type the client reported. Only a
 * few known profiles: the name decides which terminal-kit profile is
 * loaded, so it never comes from the client as it is.
 */
export function termFor(terminalType: string | null): string {
  const type = (terminalType ?? '').toLowerCase();
  if (type.startsWith('rxvt')) return 'rxvt-unicode-256color';
  if (type.startsWith('screen') || type.startsWith('tmux')) return 'screen-256color';
  if (type === 'linux') return 'linux';
  if (type.startsWith('vt1') || type === 'ansi' || type === 'dumb') return 'xterm';
  return 'xterm-256color';
}

export interface TelnetEvents {
  /** keys and text typed, with the telnet protocol taken out */
  data(data: Buffer): void;
  /** bytes the server has to send back (answers to the client's negotiation) */
  reply(data: Buffer): void;
  size(size: WindowSize): void;
  terminalType(type: string): void;
}

const MAX_SUBNEGOTIATION = 64;

/**
 * Reads what a telnet client sends: commands and subnegotiations are
 * answered or reported, the rest is passed on as typed data. Enter comes as
 * CR NUL or CR LF and is passed on as CR, as a terminal would send it.
 */
export class TelnetParser {
  private state: 'data' | 'iac' | 'option' | 'sb' | 'sb-iac' = 'data';
  private command = 0;
  private subnegotiation: number[] = [];
  private afterCR = false;
  private readonly enabled = new Set<string>();

  constructor(private readonly events: TelnetEvents) {}

  push(chunk: Buffer): void {
    const out: number[] = [];
    for (const byte of chunk) {
      switch (this.state) {
        case 'data':
          if (byte === IAC) {
            this.state = 'iac';
          } else if (this.afterCR && (byte === 0 || byte === 10)) {
            this.afterCR = false; // CR NUL, CR LF: the CR went already
          } else {
            this.afterCR = byte === 13;
            out.push(byte);
          }
          break;
        case 'iac':
          if (byte === IAC) {
            out.push(IAC); // an escaped 0xff
            this.state = 'data';
          } else if (byte === WILL || byte === WONT || byte === DO || byte === DONT) {
            this.command = byte;
            this.state = 'option';
          } else if (byte === SB) {
            this.subnegotiation = [];
            this.state = 'sb';
          } else {
            this.state = 'data'; // NOP, AYT, GA...: nothing to do
          }
          break;
        case 'option':
          this.negotiate(this.command, byte);
          this.state = 'data';
          break;
        case 'sb':
          if (byte === IAC) this.state = 'sb-iac';
          else if (this.subnegotiation.length < MAX_SUBNEGOTIATION) this.subnegotiation.push(byte);
          break;
        case 'sb-iac':
          if (byte === SE) {
            this.subnegotiated(this.subnegotiation);
            this.state = 'data';
          } else {
            if (byte === IAC && this.subnegotiation.length < MAX_SUBNEGOTIATION) this.subnegotiation.push(IAC);
            this.state = 'sb';
          }
          break;
      }
    }
    if (out.length) this.events.data(Buffer.from(out));
  }

  private negotiate(command: number, option: number): void {
    const key = `${command}:${option}`;
    // answer each request once, so that two sides never loop
    if (this.enabled.has(key)) return;
    this.enabled.add(key);
    if (command === WILL) {
      if (option === TTYPE) {
        this.events.reply(Buffer.from([IAC, SB, TTYPE, TTYPE_SEND, IAC, SE]));
      } else if (option !== NAWS) {
        this.events.reply(Buffer.from([IAC, DONT, option]));
      }
    } else if (command === DO) {
      if (option !== ECHO && option !== SGA) {
        this.events.reply(Buffer.from([IAC, WONT, option]));
      }
    }
  }

  private subnegotiated(data: number[]): void {
    if (data[0] === NAWS && data.length >= 5) {
      this.events.size(clampSize((data[1] << 8) | data[2], (data[3] << 8) | data[4]));
    } else if (data[0] === TTYPE && data[1] === TTYPE_IS) {
      const type = Buffer.from(data.slice(2)).toString('latin1').replace(/[^A-Za-z0-9._+-]/g, '').slice(0, 40);
      this.events.terminalType(type);
    }
  }
}

/** Session output for the telnet connection: a 0xff byte is sent as IAC IAC. */
export function escapeIAC(data: Buffer): Buffer {
  if (!data.includes(IAC)) return data;
  const out: number[] = [];
  for (const byte of data) {
    out.push(byte);
    if (byte === IAC) out.push(IAC);
  }
  return Buffer.from(out);
}

export interface TelnetServerOptions {
  port: number;
  host?: string;
  /** sessions at once */
  maxSessions?: number;
  /** sessions at once from one address */
  maxPerAddress?: number;
  /** a session without input for this long ends */
  idleMinutes?: number;
  /** the session's command line: mapscii itself, with --telnetSession */
  command: string;
  args: string[];
  /** how long to wait for the client's size and type before starting */
  negotiationMs?: number;
  log?: (message: string) => void;
}

export interface TelnetServer {
  server: net.Server;
  sessions: () => number;
  close: () => Promise<void>;
}

/** Starts the server; resolves once it listens. */
export function startTelnetServer(options: TelnetServerOptions): Promise<TelnetServer> {
  const maxSessions = options.maxSessions ?? 10;
  const maxPerAddress = options.maxPerAddress ?? 3;
  const idleMs = (options.idleMinutes ?? 15) * 60 * 1000;
  const negotiationMs = options.negotiationMs ?? 700;
  const log = options.log ?? (() => undefined);
  const children = new Set<ChildProcess>();
  const sockets = new Set<net.Socket>();
  const perAddress = new Map<string, number>();
  let open = 0;

  const server = net.createServer((socket) => {
    const address = socket.remoteAddress ?? '?';
    socket.setNoDelay(true);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));

    if (open >= maxSessions || (perAddress.get(address) ?? 0) >= maxPerAddress) {
      socket.end('mapscii is busy, please try again later.\r\n');
      log(`${address}: refused, ${open} sessions`);
      return;
    }
    open++;
    perAddress.set(address, (perAddress.get(address) ?? 0) + 1);
    log(`${address}: connected, ${open} sessions`);

    let size: WindowSize = { columns: 80, rows: 24 };
    let gotSize = false;
    let terminalType: string | null = null;
    let child: ChildProcess | null = null;
    let pending: Buffer[] = [];
    let closed = false;

    const startTimer = setTimeout(() => start(), negotiationMs);
    let idleTimer = setTimeout(() => idle(), idleMs);

    const parser = new TelnetParser({
      data: (data) => {
        if (child?.stdin?.writable) child.stdin.write(data);
        else if (!child) pending.push(data);
      },
      reply: (data) => socket.write(data),
      size: (next) => {
        size = next;
        gotSize = true;
        child?.send?.({ type: 'resize', ...size });
        if (terminalType !== null) start();
      },
      terminalType: (type) => {
        terminalType = type;
        if (gotSize) start();
      },
    });

    function start(): void {
      clearTimeout(startTimer);
      if (child || closed) return;
      child = spawn(options.command, options.args, {
        stdio: ['pipe', 'pipe', 'ignore', 'ipc'],
        env: {
          ...process.env,
          TERM: termFor(terminalType),
          MAPSCII_TELNET_SESSION: '1',
          MAPSCII_COLUMNS: String(size.columns),
          MAPSCII_ROWS: String(size.rows),
        },
      });
      children.add(child);
      child.stdout?.on('data', (data: Buffer) => {
        if (!socket.write(escapeIAC(data))) {
          // a slow client: let the session wait instead of piling up frames
          child?.stdout?.pause();
          socket.once('drain', () => child?.stdout?.resume());
        }
      });
      child.stdin?.on('error', () => undefined);
      child.on('exit', () => {
        if (child) children.delete(child);
        socket.end();
      });
      child.on('error', (error) => {
        log(`${address}: session failed: ${error.message}`);
        socket.end();
      });
      for (const data of pending) child.stdin?.write(data);
      pending = [];
    }

    function idle(): void {
      socket.end('\x1b[0m\r\nNo input for a while: bye!\r\n');
    }

    socket.on('data', (chunk: Buffer) => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => idle(), idleMs);
      parser.push(chunk);
    });
    socket.on('error', () => undefined);
    socket.on('close', () => {
      closed = true;
      clearTimeout(startTimer);
      clearTimeout(idleTimer);
      if (child && child.exitCode === null) child.kill('SIGTERM');
      open--;
      const left = (perAddress.get(address) ?? 1) - 1;
      if (left > 0) perAddress.set(address, left);
      else perAddress.delete(address);
      log(`${address}: closed, ${open} sessions`);
    });

    socket.write(GREETING);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve({
        server,
        sessions: () => open,
        close: () => new Promise((done) => {
          for (const child of children) child.kill('SIGTERM');
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}
