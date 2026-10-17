/*
  MapSCII - Terminal Map Viewer
  Map sessions for people connecting over telnet or SSH.

  Every connection gets a mapscii process of its own (--remoteSession), so
  sessions share nothing but the tile cache on disk: their own settings,
  their own terminal, and a crash or a hang ends one connection only. The
  limits (sessions at once, per address, idle time) are shared by all the
  servers of one mapscii.
*/

import { spawn, type ChildProcess } from 'child_process';

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
export function termFor(terminalType: string | null | undefined): string {
  const type = (terminalType ?? '').toLowerCase();
  if (type.startsWith('rxvt')) return 'rxvt-unicode-256color';
  if (type.startsWith('screen') || type.startsWith('tmux')) return 'screen-256color';
  if (type === 'linux') return 'linux';
  if (type.startsWith('vt1') || type === 'ansi' || type === 'dumb') return 'xterm';
  return 'xterm-256color';
}

/** Where a session's output goes: the telnet socket or the SSH channel. */
export interface SessionOutput {
  /** false: the client is slow, wait for drain */
  write(data: Buffer): boolean;
  onceDrain(callback: () => void): void;
  /** the session ended (or idled out): close the connection */
  end(message?: string): void;
}

export interface SessionPoolOptions {
  /** sessions at once, over all servers */
  maxSessions?: number;
  /** sessions at once from one address */
  maxPerAddress?: number;
  /** a session without input for this long ends */
  idleMinutes?: number;
  /** the session's command line: mapscii itself, with --remoteSession */
  command: string;
  args: string[];
  log?: (message: string) => void;
}

/** A connection let in: counts until released, may start one session. */
export interface Admission {
  readonly address: string;
  start(output: SessionOutput, terminal: { type?: string | null; size: WindowSize }): Session;
  /** the connection is gone: frees its place (once) and ends its session */
  release(): void;
}

export interface Session {
  input(data: Buffer): void;
  resize(size: WindowSize): void;
}

export class SessionPool {
  readonly maxSessions: number;
  readonly maxPerAddress: number;
  readonly idleMs: number;
  private open = 0;
  private readonly perAddress = new Map<string, number>();
  private readonly children = new Set<ChildProcess>();
  private readonly log: (message: string) => void;

  constructor(private readonly options: SessionPoolOptions) {
    this.maxSessions = options.maxSessions ?? 10;
    this.maxPerAddress = options.maxPerAddress ?? 3;
    this.idleMs = (options.idleMinutes ?? 15) * 60 * 1000;
    this.log = options.log ?? (() => undefined);
  }

  sessions(): number {
    return this.open;
  }

  /** A place for a new connection from `address`, or null when full. */
  admit(address: string, via: string): Admission | null {
    if (this.open >= this.maxSessions || (this.perAddress.get(address) ?? 0) >= this.maxPerAddress) {
      this.log(`${via} ${address}: refused, ${this.open} sessions`);
      return null;
    }
    this.open++;
    this.perAddress.set(address, (this.perAddress.get(address) ?? 0) + 1);
    this.log(`${via} ${address}: connected, ${this.open} sessions`);

    let released = false;
    let child: ChildProcess | null = null;
    let idleTimer: ReturnType<typeof setTimeout> | null = null;

    const release = () => {
      if (released) return;
      released = true;
      if (idleTimer) clearTimeout(idleTimer);
      if (child && child.exitCode === null) child.kill('SIGTERM');
      this.open--;
      const left = (this.perAddress.get(address) ?? 1) - 1;
      if (left > 0) this.perAddress.set(address, left);
      else this.perAddress.delete(address);
      this.log(`${via} ${address}: closed, ${this.open} sessions`);
    };

    const start = (output: SessionOutput, terminal: { type?: string | null; size: WindowSize }): Session => {
      if (child) throw new Error('one session per connection');
      const idle = () => output.end('\x1b[0m\r\nNo input for a while: bye!\r\n');
      idleTimer = setTimeout(idle, this.idleMs);
      const size = clampSize(terminal.size.columns, terminal.size.rows);
      const proc = spawn(this.options.command, this.options.args, {
        stdio: ['pipe', 'pipe', 'ignore', 'ipc'],
        env: {
          ...process.env,
          TERM: termFor(terminal.type),
          MAPSCII_REMOTE_SESSION: '1',
          MAPSCII_COLUMNS: String(size.columns),
          MAPSCII_ROWS: String(size.rows),
        },
      });
      child = proc;
      this.children.add(proc);
      proc.stdout?.on('data', (data: Buffer) => {
        if (!output.write(data)) {
          // a slow client: let the session wait instead of piling up frames
          proc.stdout?.pause();
          output.onceDrain(() => proc.stdout?.resume());
        }
      });
      proc.stdin?.on('error', () => undefined);
      proc.on('exit', () => {
        this.children.delete(proc);
        output.end();
      });
      proc.on('error', (error) => {
        this.log(`${via} ${address}: session failed: ${error.message}`);
        output.end();
      });
      return {
        input: (data) => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(idle, this.idleMs);
          if (proc.stdin?.writable) proc.stdin.write(data);
        },
        resize: (next) => {
          if (proc.connected) proc.send({ type: 'resize', ...clampSize(next.columns, next.rows) });
        },
      };
    };

    return { address, start, release };
  }

  /** Ends every session (the server is stopping). */
  closeAll(): void {
    for (const child of this.children) child.kill('SIGTERM');
  }
}
