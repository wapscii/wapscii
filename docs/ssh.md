# SSH server

Like the [telnet server](./telnet.md), but encrypted, and with the
client's own `ssh`:

```sh
mapscii --ssh 2222                        # on this computer only
mapscii --ssh 2222 --sshHost 0.0.0.0      # for everyone (:: for IPv6 too)
ssh -p 2222 localhost
```

Anyone may connect, with any user name and no password or key. What they
get is a map session on a terminal of their own, and nothing else: no
shell, no commands (`ssh host cmd`), no files (`sftp`, `scp`), no port, agent
or X11 forwarding. The server is part of mapscii (the
[ssh2](https://github.com/mscdex/ssh2) library), not the system's `sshd`,
and it has nothing to do with the server's user accounts.

`--telnet` and `--ssh` can be given together: one mapscii serves both,
and the limits are for both.

## Sessions

The sessions are the telnet server's (see [telnet.md](./telnet.md)): a
mapscii process for each connection, with the map options given to the
server as its defaults, and the same restrictions (no screenshots, cache
reset, location or online search). The window size and terminal type
come from ssh, and resizing the window resizes the map. `q` or Ctrl-C
closes the connection.

The map needs a terminal: `ssh -T`, or ssh with its input from a file or
pipe, gets "The map needs a terminal" instead (`ssh -t` asks for one).

## The host key

The server proves who it is with its host key, which `ssh` remembers
the first time and checks after that. It is made on the first start, an
ed25519 key in OpenSSH's format, readable only by the user running mapscii:

* `~/.local/state/wapscii/ssh_host_ed25519_key` (or under
  `$XDG_STATE_HOME`),
* or the file `--sshHostKey` names; an RSA or ECDSA key of your own works
  too.

The server prints the key's fingerprint when it starts, as ssh shows it
on the first connection:

```
mapscii SSH server on 0.0.0.0:2222, host key SHA256:lHQgnmfPNNHQbWVyIM49tO3hcBq1x3JY6rsHQ43GccE
```

Keep the file: a new key makes everyone's `ssh` warn that the host key
changed.

## Limits

The sessions' limits, for SSH and telnet together:

| Option | Default | |
|---|---|---|
| `--maxSessions` | 10 | sessions at once; each is a process of about 85 MB |
| `--maxPerAddress` | 3 | sessions at once from one IP address |
| `--idleMinutes` | 15 | a session without input for this long is closed |

A connection counts as a session from when ssh says hello. One that
hasn't opened its map within 30 seconds is closed, connections beyond
twice `--maxSessions` are closed at once, and each connection gets one
map.

## Port 22

Port 22 is usually the system's `sshd`. Serve the map on another port, on
an address of its own, or move `sshd` and redirect 22 to the map's port in
the firewall. To use port 22 without running as root, give the service
`CAP_NET_BIND_SERVICE`.

## Running it as a service

A systemd unit, with the host key in the service's state directory:

```ini
[Unit]
Description=wapscii SSH server
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/mapscii --ssh 2222 --sshHost :: --sshHostKey /var/lib/wapscii/ssh_host_ed25519_key --searchDb /var/lib/wapscii/search.sqlite
DynamicUser=yes
CacheDirectory=wapscii
StateDirectory=wapscii
Environment=XDG_CACHE_HOME=/var/cache/wapscii
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

The server logs connections to stdout (the journal): time, `ssh` and
address, sessions open. The tiles advice in [telnet.md](./telnet.md#tiles)
holds here too.
