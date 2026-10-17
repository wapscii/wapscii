# wapscii - The Whole World In Your Console. [![CI](https://github.com/wapscii/wapscii/actions/workflows/ci.yml/badge.svg)](https://github.com/wapscii/wapscii/actions/workflows/ci.yml)

A [Vector Tile](http://wiki.openstreetmap.org/wiki/Vector_tiles) to [Braille](http://www.fileformat.info/info/unicode/block/braille_patterns/utf8test.htm) and [ASCII](https://de.wikipedia.org/wiki/American_Standard_Code_for_Information_Interchange) map renderer for [xterm](https://en.wikipedia.org/wiki/Xterm)-compatible terminals.

wapscii is [MapSCII](https://github.com/rastapasta/mapscii), maintained again. MapSCII's tile server (OSM2VectorTiles, long discontinued) and its pull requests had been standing still; wapscii carries on from them: [OpenMapTiles](https://openmaptiles.org) vector tiles from [OpenFreeMap](https://openfreemap.org) by default, TypeScript, a 3D globe, search, and the fixes collected in the pull requests. The command is still `mapscii`.

<a href="https://asciinema.org/a/117813?autoplay=1" target="_blank">![asciicast](https://cloud.githubusercontent.com/assets/1259904/25480718/497a64e2-2b4a-11e7-9cf0-ed52ee0b89c0.png)</a>

## Features

* Drag the map and zoom with the mouse, or use the keyboard
* Search places by name (offline, or on OpenStreetMap's Nominatim), coordinates and geohashes
* A 3D globe view
* Points of interest, airports and peaks; hover labels, POIs, lines and polygons
* [Mapbox style](https://docs.mapbox.com/style-spec/) layer styling
* Any OpenMapTiles vector tile source: OpenFreeMap by default, your own tileserver ([TileJSON](https://github.com/mapbox/tilejson-spec) or `{z}/{x}/{y}` URLs), [MBTiles](https://github.com/mapbox/mbtiles-spec) and single `.pbf`/`.mvt` tiles offline
* Multi-line and Arabic/right-to-left labels
* ANSI 16-color output for low-color terminals, and `.ans` screenshots
* Terrain/elevation hillshade background
* Markers from the command line, GeoJSON or stdin
* A library API to embed the map in other programs
* Linux, macOS and Windows terminals

## Install

wapscii needs [Node.js](https://nodejs.org) 18 or newer.

From npm:

```sh
npm install -g wapscii
mapscii
```

With Nix (flakes):

```sh
nix run github:wapscii/wapscii                 # try it
nix profile install github:wapscii/wapscii     # mapscii, wapscii, wapscii-search-index
```

In a NixOS or home-manager flake: an input `wapscii.url = "github:wapscii/wapscii";`
and `inputs.wapscii.packages.${system}.default` in your packages (or
`inputs.wapscii.overlays.default` for `pkgs.wapscii`). Leave out
`inputs.nixpkgs.follows` for it: the npm packages are checked against a
hash, and another nixpkgs' bun may install them differently. When
`bun.lock` changes, `nix build` says the new hash for `nix/package.nix`.

From the source ([Bun](https://bun.sh) builds it):

```sh
git clone https://github.com/wapscii/wapscii.git
cd wapscii
bun install
bun run build
node bin/mapscii.js
```

MapSCII's own demo was `telnet mapscii.me`; wapscii can serve one too (see below).

## Running

```sh
mapscii
```

Useful options:

```sh
mapscii --tile_source ./tile.pbf
mapscii --tile_source ./tiles.mbtiles
mapscii --style_file ./styles/dark.json
mapscii --ansi16
mapscii --terrain
mapscii --terrain --terrainMode hillshade
mapscii --terrainSource "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"
mapscii --ansiScreenshot ./map.ans --width 120 --height 40
mapscii --noAttribution
mapscii --latitude 48.137 --longitude 11.575 --zoom 13
mapscii --locate                         # start where your IP address is
mapscii --marker 48.137,11.575 --geojson ./places.geojson
mapscii --searchDb ./search.sqlite       # offline place search, see docs/search.md
mapscii --no-onlineSearch                # never send searches to Nominatim
mapscii --no-mouse                       # leave the mouse to the terminal
```

`mapscii --help` lists them all.

`--tile_source` takes OpenMapTiles vector tiles from:

* a TileJSON URL, like the default `https://tiles.openfreemap.org/planet` ([OpenFreeMap](https://openfreemap.org)); the source's attribution then replaces the default one
* a URL template: `--tile_source 'http://localhost:8080/data/v3/{z}/{x}/{y}.pbf'` (`{-y}` for TMS servers)
* a base URL ending in `/`, with the tiles at `base/z/x/y.pbf`
* an `.mbtiles` file (with the optional `@mapbox/mbtiles` installed) or a single `.pbf`/`.mvt` tile

Tiles are fetched up to the source's highest zoom level (14 for OpenMapTiles) and scaled beyond it.

Downloaded HTTP tiles are cached under `~/.cache/mapscii/sources/`, in one folder per tile source (its `source.txt` says which), so tiles of different servers never mix. `R` empties the folder of the current source. Tile servers on this computer (`localhost`, `127.0.0.1`) aren't cached: their tiles are on disk already.

### Telnet server

```sh
mapscii --telnet 2323 --telnetHost 0.0.0.0
```

serves the map like MapSCII's old `telnet mapscii.me`: one session per connection, with its own position and settings. See [docs/telnet.md](./docs/telnet.md) for the limits and running it as a service.

## Keyboard shortcuts

* Arrows **up**, **down**, **left**, **right** to scroll around
* Press **a** or **z** (**y** on QWERTZ), **+** or **-**, **Page Up** or **Page Down**, or **Shift+Up** or **Shift+Down** to zoom in and out
* Press **/** or **s** to search: place names, `lat,lon[,zoom]` or a geohash (see [docs/search.md](./docs/search.md))
* Press **g** to go to your approximate location (your IP address's, from [ipinfo.io](https://ipinfo.io))
* Press **o** for the 3D globe
* Press **c** to switch to block character mode
* Press **t** to hide or show labels
* Press **m** to remove the markers
* Press **S** to save the current canvas as an ANSI `.ans` screenshot
* Press **R** to reset the tile cache if cached tiles become corrupted
* Press **?** for help
* Press **q** to quit

## Mouse control

If your terminal supports mouse events you can drag the map and use your scroll wheel to zoom in and out. `--no-mouse` leaves the mouse to the terminal, for selecting text and scrolling back.

## Library API

See the full [library API documentation](./docs/library-api.md).

wapscii can also be embedded from Node.js:

```js
import Mapscii from 'wapscii';

const map = new Mapscii({
  initialLat: 48.8566,
  initialLon: 2.3522,
  initialZoom: 12,
  source: 'https://tiles.openfreemap.org/planet',
  styleFile: './styles/dark.json',
  colorMode: 'ansi-16',
  showAttribution: true,
});

map.on('ready', (state) => {
  console.log('ready', state.center, state.zoom);
});

map.on('hover', (event) => {
  console.log(event.lat, event.lon, event.features);
});

map.on('click', (event) => {
  console.log('clicked features', event.features);
});

await map.init();
```

Public methods:

* `setCenter(lat, lon)` and `getCenter()`
* `setZoom(zoom)`, `zoomBy(step)` and `getZoom()`
* `moveBy(latDelta, lonDelta)`
* `addMarker(marker)`, `removeMarker(id)`, `clearMarkers()` and `getMarkers()`
* `featuresAt(column, row)` for programmatic label, POI, line and polygon hit-testing
* `getState()` for `{ center, zoom, markers }`
* `on(event, handler)` and `off(event, handler)` for events

Events:

* `ready`, `update`, `move`, `zoom`, `quit`
* `hover` and `click`, both with `{ x, y, lat, lon, features }`
* `marker:add`, `marker:remove`, `markers:clear`
* `error`

## Development

```sh
bun install
bun run typecheck
bun test
bun run lint
python3 tools/test_maps_search_index.py
bun main.ts --tile_source http://localhost:8080/data/v3.json        # run from the sources
```

`docs/openmaptiles-migration.md` has the notes on moving the styles from OSM2VectorTiles to OpenMapTiles.

## Behind the scenes

* [`terminal-kit`](https://github.com/cronvel/terminal-kit) for keyboard, mouse and terminal handling
* [`x256`](https://github.com/substack/node-x256) for the closest xterm-256 [color code](https://en.wikipedia.org/wiki/File:Xterm_256color_chart.svg) of an RGB value
* [`string-width`](https://github.com/sindresorhus/string-width) for the width of text in terminal cells
* [`bidi-js`](https://github.com/lojjic/bidi-js) and [`arabic-persian-reshaper`](https://github.com/ahmadfarhan/arabic-persian-reshaper) for right-to-left labels
* [`vector-tile`](https://github.com/mapbox/vector-tile-js) and [`pbf`](https://github.com/mapbox/pbf) for [vector tiles](https://github.com/mapbox/vector-tile-spec)
* [`mbtiles`](https://github.com/mapbox/node-mbtiles) (optional) for [MBTiles](https://github.com/mapbox/mbtiles-spec)
* [`earcut`](https://github.com/mapbox/earcut) for polygon triangulation
* [`rbush`](https://github.com/mourner/rbush) for 2D spatial indexing of geo and label data
* [`bresenham`](https://github.com/madbence/node-bresenham) for line point calculations
* [`simplify-js`](https://github.com/mourner/simplify-js) for polyline simplifications
* [`ngeohash`](https://github.com/sunng87/node-geohash) for geohashes
* [`pngjs`](https://github.com/pngjs/pngjs) for terrain tiles
* [`yargs`](https://github.com/yargs/yargs) for the command line

## Special thanks

* [rastapasta](https://github.com/rastapasta) (Michael Straßburger) for MapSCII, and everyone in [AUTHORS](./AUTHORS)
* [ionmeo](https://github.com/ionmeo) for moving the styles to OpenMapTiles, and [Fefedu973](https://github.com/Fefedu973) for the TypeScript version, the globe and much more
* [lukasmartinelli](https://github.com/lukasmartinelli) & [manuelroth](https://github.com/manuelroth) for all their work on [OSM2VectorTiles](https://github.com/osm2vectortiles), MapSCII's first tiles
* [OpenMapTiles](https://openmaptiles.org) for the schema, and [OpenFreeMap](https://openfreemap.org) for hosting tiles for everyone
* [mourner](https://github.com/mourner) for all his work on mindblowing GIS algorithms (like the used [earcut](https://github.com/mapbox/earcut), [rbush](https://github.com/mourner/rbush), [simplify-js](https://github.com/mourner/simplify-js), ..)

## Licenses

### Map data

#### The Open Data Commons Open Database License (oDbl)

[OpenStreetMap](https://www.openstreetmap.org) is open data, licensed under the [Open Data Commons Open Database License](http://opendatacommons.org/licenses/odbl/) (ODbL) by the [OpenStreetMap Foundation](http://osmfoundation.org/) (OSMF).

You are free to copy, distribute, transmit and adapt our data, as long as you credit OpenStreetMap and its contributors. If you alter or build upon our data, you may distribute the result only under the same licence. The full [legal code](http://opendatacommons.org/licenses/odbl/1.0/) explains your rights and responsibilities.

The default tiles come from [OpenFreeMap](https://openfreemap.org), in the [OpenMapTiles](https://openmaptiles.org) schema (© OpenMapTiles). The offline search index is made from [GeoNames](https://www.geonames.org) data, under [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).

### wapscii
* [License](./LICENSE)
* [Authors](./AUTHORS)
