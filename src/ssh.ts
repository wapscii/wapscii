/*
  MapSCII - Terminal Map Viewer
  SSH server: `mapscii --ssh 2222`, then `ssh -p 2222 host`.

  Anyone may connect, with any user name and no password or key: what they
  get is a map session (sessions.ts) on a terminal of their own, and
  nothing else. No commands, no files (SFTP), no port or agent forwarding.
  The connection is encrypted, and the server proves who it is with its
  host key, made on first start and kept (the fingerprint is printed).
*/

import fs from 'fs';
import net from 'net';
import { homedir } from 'os';
import path from 'path';
import { createHash } from 'crypto';
// CommonJS: Node's ESM loader only gives it a default export
import ssh2 from 'ssh2';
import { clampSize, type SessionPool, type WindowSize } from './sessions';

const { Server, utils } = ssh2;

export interface SshServerOptions {
  port: number;
  host?: string;
  /** the sessions and their limits, shared with the telnet server */
  pool: SessionPool;
  /** OpenSSH private key file; made (ed25519) when missing */
  hostKeyFile?: string;
  /** a connection must reach its map within this long */
  handshakeMs?: number;
  log?: (message: string) => void;
}

export interface SshServer {
  server: net.Server;
  port: () => number;
  fingerprint: string;
  close: () => Promise<void>;
}

/** Where the host key is kept unless --sshHostKey says otherwise. */
export function defaultHostKeyFile(): string {
  const state = process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state');
  return path.join(state, 'wapscii', 'ssh_host_ed25519_key');
}

/** The host key, made and saved (readable only by you) the first time. */
export function loadOrCreateHostKey(file: string): { key: Buffer; created: boolean } {
  try {
    return { key: fs.readFileSync(file), created: false };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const { private: privateKey } = utils.generateKeyPairSync('ed25519');
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, privateKey, { mode: 0o600, flag: 'wx' });
  return { key: Buffer.from(privateKey), created: true };
}

/** SHA256:... as `ssh-keygen -lf` and ssh's first-connection prompt show it. */
export function fingerprintOf(privateKey: Buffer): string {
  const parsed = utils.parseKey(privateKey);
  if (parsed instanceof Error) throw parsed;
  const key = Array.isArray(parsed) ? parsed[0] : parsed;
  const digest = createHash('sha256').update(key.getPublicSSH()).digest('base64').replace(/=+$/, '');
  return `SHA256:${digest}`;
}

export function startSshServer(options: SshServerOptions): Promise<SshServer> {
  const log = options.log ?? (() => undefined);
  const hostKeyFile = options.hostKeyFile ?? defaultHostKeyFile();
  const { key, created } = loadOrCreateHostKey(hostKeyFile);
  const fingerprint = fingerprintOf(key);
  if (created) log(`ssh: made a host key, ${hostKeyFile}`);
  const handshakeMs = options.handshakeMs ?? 30000;
  const sockets = new Set<net.Socket>();
  // connections that haven't opened their map yet, by address:port
  const handshaking = new Map<string, ReturnType<typeof setTimeout>>();
  const keyOf = (address?: string, port?: number) => `${address}:${port}`;

  const ssh = new Server({ hostKeys: [key], ident: 'wapscii' }, (client, info) => {
    client.on('error', () => undefined);
    const admission = options.pool.admit(info.ip, 'ssh');
    const key = keyOf(info.ip, info.port);
    let started = false;

    client.on('close', () => {
      admission?.release();
    });

    // anyone, any name, nothing to type: they only get a map
    client.on('authentication', (ctx) => ctx.accept());

    client.on('ready', () => {
      client.on('session', (accept, reject) => {
        if (started) {
          reject();
          return;
        }
        const channel = accept();
        let terminal: { type: string; size: WindowSize } | null = null;
        let session: { input(data: Buffer): void; resize(size: WindowSize): void } | null = null;

        channel.on('pty', (acceptPty, _rejectPty, pty) => {
          terminal = { type: pty.term, size: clampSize(pty.cols, pty.rows) };
          acceptPty?.();
        });
        channel.on('window-change', (acceptChange, _rejectChange, change) => {
          acceptChange?.();
          session?.resize(clampSize(change.cols, change.rows));
        });
        channel.on('env', (_acceptEnv, rejectEnv) => rejectEnv?.());
        channel.on('exec', (_acceptExec, rejectExec) => rejectExec?.());
        channel.on('subsystem', (_acceptSub, rejectSub) => rejectSub?.());
        channel.on('x11', (_acceptX11, rejectX11) => rejectX11?.());
        channel.on('auth-agent', (_acceptAgent, rejectAgent) => rejectAgent?.());

        channel.on('shell', (acceptShell) => {
          if (started) return;
          started = true;
          clearTimeout(handshaking.get(key));
          handshaking.delete(key);
          const stream = acceptShell();
          let ended = false;
          const end = (message?: string) => {
            if (ended) return;
            ended = true;
            if (message) stream.write(message);
            // exit status, then close the channel: the client hangs up
            // itself (hanging up first makes ssh say the connection was lost)
            stream.exit(0);
            stream.end();
            setTimeout(() => client.end(), 2000).unref();
          };
          if (!admission) {
            end('mapscii is busy, please try again later.\r\n');
            return;
          }
          if (!terminal) {
            end('The map needs a terminal: ssh -t (and not ssh -T).\r\n');
            return;
          }
          const current = terminal as { type: string; size: WindowSize };
          session = admission.start({
            write: (data) => stream.write(data),
            onceDrain: (callback) => stream.once('drain', callback),
            end,
          }, current);
          stream.on('data', (data: Buffer) => session?.input(data));
        });
      });
    });

    // no forwarding of any kind
    client.on('request', (_acceptRequest, rejectRequest) => rejectRequest?.());
    client.on('tcpip', (_acceptTcp, rejectTcp) => rejectTcp());
    client.on('openssh.streamlocal', (_acceptLocal, rejectLocal) => rejectLocal());
  });

  // ssh2's own TCP server (it has no public handle): its sockets are
  // tracked so that close() closes them all, half-open ones included
  const server = (ssh as unknown as { _srv?: net.Server })._srv;
  if (!(server instanceof net.Server)) throw new Error('ssh2 changed: no TCP server to listen with');
  // the sessions, and as many connections again on their way to one
  server.maxConnections = options.pool.maxSessions * 2;
  server.on('connection', (socket: net.Socket) => {
    const key = keyOf(socket.remoteAddress, socket.remotePort);
    sockets.add(socket);
    socket.setNoDelay(true);
    // a connection must reach its map in time, or it goes
    handshaking.set(key, setTimeout(() => socket.destroy(), handshakeMs));
    socket.on('close', () => {
      sockets.delete(socket);
      clearTimeout(handshaking.get(key));
      handshaking.delete(key);
    });
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port, options.host ?? '127.0.0.1', () => {
      server.off('error', reject);
      resolve({
        server,
        port: () => (server.address() as net.AddressInfo).port,
        fingerprint,
        close: () => new Promise((done) => {
          for (const socket of sockets) socket.destroy();
          server.close(() => done());
        }),
      });
    });
  });
}
