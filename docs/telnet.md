# Telnet server

The server behind MapSCII's demo, `telnet mapscii.me`, isn't in MapSCII's
repository. wapscii has one built in:

```sh
mapscii --telnet 2323                        # on this computer only
mapscii --telnet 2323 --telnetHost 0.0.0.0   # for everyone (:: for IPv6 too)
telnet localhost 2323
```

Every connection gets a mapscii process of its own. Sessions share nothing
but the tile cache on disk: each has its own position, zoom and settings,
and a session that crashes or hangs ends only that connection. The server
asks the client for its window size and terminal type, and follows the
window when it is resized. Keys and the mouse work as in a local terminal;
`q` or Ctrl-C closes the connection.

The map options given to the server are the sessions' defaults:
`--tile_source`, `--style_file`, the starting `--latitude`, `--longitude`
and `--zoom`, `--colorMode`/`--ansi16`, `--braille`, `--noLabels`,
`--no-mouse`, the attribution and terrain options, `--searchDb`, and
markers (`--marker`, `--geojson`).

## What sessions can't do

People connecting over telnet aren't on the server, so their sessions are
restricted:

* **S** (save a screenshot) would write files on the server,
* **R** (reset the tile cache) would empty the cache everyone uses,
* **g** (go to your location) would find the server's location, not
  theirs;

they show "Not available here". Search works with the offline index
(`--searchDb`, see [search.md](./search.md)) but doesn't ask Nominatim:
searches from anyone, in the server's name, are not what its usage policy
allows.

## Limits

| Option | Default | |
|---|---|---|
| `--telnetMaxSessions` | 10 | sessions at once; each is a process of about 85 MB |
| `--telnetMaxPerAddress` | 3 | sessions at once from one IP address |
| `--telnetIdleMinutes` | 15 | a session without input for this long is closed |

Window sizes are kept between 20×8 and 400×200 characters, and the
terminal type a client reports only chooses between a few known profiles
(xterm-256color, rxvt-unicode-256color, screen-256color, linux, xterm).
Each session's Node.js heap is capped at 256 MB.

## Tiles

Every session downloads the tiles it shows (the cache on disk is shared),
so a public server makes far more tile requests than one person. For more
than a few users, serve your own tiles (an OpenMapTiles `.mbtiles` with
[tileserver-gl](https://github.com/maptiler/tileserver-gl) or
[martin](https://github.com/maplibre/martin)) and point `--tile_source`
at it.

## Running it as a service

Telnet is unencrypted: anyone on the way sees what is typed, which here is
map navigation and searches. To serve on port 23 without running as root,
give the service `CAP_NET_BIND_SERVICE`, or redirect 23 to 2323 in the
firewall.

A systemd unit:

```ini
[Unit]
Description=wapscii telnet server
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/mapscii --telnet 23 --telnetHost :: --searchDb /var/lib/wapscii/search.sqlite
DynamicUser=yes
CacheDirectory=wapscii
StateDirectory=wapscii
Environment=XDG_CACHE_HOME=/var/cache/wapscii
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
Restart=on-failure

[Install]
WantedBy=multi-user.target
```

The server logs connections to stdout (the journal): time, address,
sessions open.
