/*
  MapSCII - Terminal Map Viewer
  Telnet server: `mapscii --telnet 2323`, then `telnet host 2323`.

  The server speaks the telnet protocol (RFC 854) and asks the client for
  its window size (NAWS, RFC 1073) and terminal type (RFC 1091), which the
  session (sessions.ts: a mapscii process per connection) gets as its size
  and $TERM.
*/

import net from 'net';
import { clampSize, type SessionPool, type WindowSize } from './sessions';

export { clampSize, termFor, MAX_COLUMNS, MAX_ROWS, MIN_COLUMNS, MIN_ROWS } from './sessions';
export type { WindowSize } from './sessions';

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
  /** the sessions and their limits, shared with the SSH server */
  pool: SessionPool;
  /** how long to wait for the client's size and type before starting */
  negotiationMs?: number;
}

export interface TelnetServer {
  server: net.Server;
  close: () => Promise<void>;
}

/** Starts the server; resolves once it listens. */
export function startTelnetServer(options: TelnetServerOptions): Promise<TelnetServer> {
  const negotiationMs = options.negotiationMs ?? 700;
  const sockets = new Set<net.Socket>();

  const server = net.createServer((socket) => {
    socket.setNoDelay(true);
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);

    const admission = options.pool.admit(socket.remoteAddress ?? '?', 'telnet');
    if (!admission) {
      socket.end('mapscii is busy, please try again later.\r\n');
      return;
    }

    let size: WindowSize = { columns: 80, rows: 24 };
    let gotSize = false;
    let terminalType: string | null = null;
    let session: ReturnType<typeof admission.start> | null = null;
    let pending: Buffer[] = [];
    let closed = false;

    const startTimer = setTimeout(() => start(), negotiationMs);

    const parser = new TelnetParser({
      data: (data) => {
        if (session) session.input(data);
        else pending.push(data);
      },
      reply: (data) => socket.write(data),
      size: (next) => {
        size = next;
        gotSize = true;
        session?.resize(size);
        if (terminalType !== null) start();
      },
      terminalType: (type) => {
        terminalType = type;
        if (gotSize) start();
      },
    });

    function start(): void {
      clearTimeout(startTimer);
      if (session || closed) return;
      session = admission!.start({
        write: (data) => socket.write(escapeIAC(data)),
        onceDrain: (callback) => socket.once('drain', callback),
        end: (message) => (message ? socket.end(message) : socket.end()),
      }, { type: terminalType, size: clampSize(size.columns, size.rows) });
      for (const data of pending) session.input(data);
      pending = [];
    }

    socket.on('data', (chunk: Buffer) => parser.push(chunk));
    socket.on('close', () => {
      closed = true;
      clearTimeout(startTimer);
      admission.release();
    });

    socket.write(GREETING);
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve({
        server,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}
