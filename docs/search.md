# Search

Press `/` (or `s`) and type:

* coordinates: `48.137 11.575`, `48.137, 11.575`, or with a zoom: `48.137, 11.575, 15`
* a geohash: `u33dc0` (a geohash with a digit in it), `gh:u33d`, `geohash:u33d` or a
  `geohash.org/...` link. A word without digits is a place name, even when it
  happens to be a geohash as well (`sydney`, `dresden`, `bern`)
* a place name: `München`, `Sant Julià`, `10 Downing Street`

Enter goes there. When several places match, they are listed above the
prompt: Up/Down picks one, Enter goes there, typing more searches again.
The prompt edits with Left/Right, Home/End (Ctrl-A/Ctrl-E), Backspace,
Delete and Ctrl-U; Escape or Ctrl-C closes it. Keys and the mouse don't move
the map while it is open.

## Where place names come from

1. **An offline index**, if there is one: `--searchDb FILE`, or
   `$MAPSCII_SEARCH_DB`, or `~/.local/share/mapscii/search.sqlite` when it
   exists. It is asked while typing too (it costs nothing), so matching
   places show up as you type.
2. **[Nominatim](https://nominatim.org)**, OpenStreetMap's geocoder, which
   also knows streets and addresses, when the index has nothing. It is asked
   once per Enter and never while typing: its
   [usage policy](https://operations.osmfoundation.org/policies/nominatim/)
   forbids search-as-you-type. The zoom then fits the place found (a country,
   a city, a street). `--no-onlineSearch` leaves it out: nothing typed in
   the search leaves the computer.

Coordinates and geohashes need neither.

## The offline index

`tools/maps-search-index` (Python 3, SQLite 3.33+ with FTS5, no other
modules) builds it from a [GeoNames](https://www.geonames.org/) dump. To
download the cities with 500 inhabitants or more, once:

```sh
python3 tools/maps-search-index --download cities500
mapscii      # finds ~/.local/share/mapscii/search.sqlite by itself
```

Or from a dump you already have (any 19-column GeoNames file, TSV or ZIP):

```sh
python3 tools/maps-search-index /path/to/cities500.zip --output /path/to/search.sqlite
mapscii --searchDb /path/to/search.sqlite
```

`--download` takes cities500, cities1000, cities5000 or cities15000 and is
the only part of this that uses the network. The importer streams the data,
checks the coordinates, keeps names and other names (`Munich` and `慕尼黑`
find München), and refuses to overwrite an index unless `--replace` is
given; a failed rebuild keeps the old one.

Every word of the query matches the start of a name, accents don't matter,
and bigger places come first. Labels add the region and country codes, to
tell namesakes apart. A city dump is not an address geocoder: streets are
Nominatim's.

The index is read with the `sqlite3` program (read-only, without a shell,
the query escaped for FTS and SQL, output and time capped), so mapscii
needs no native module for it. `$MAPSCII_SQLITE` names another `sqlite3`.

GeoNames data is licensed under
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/): keep the
attribution when you share an index. It is also in the index's `metadata`
table, with where the data came from and when the index was made.

## From the library

```js
new Mapscii({
  searchDatabase: '/path/to/search.sqlite', // or null
  onlineSearch: false,
  // or your own, used instead of both:
  searchProvider: async (query, signal) => [{ label: 'Somewhere', lat: 1, lon: 2, kind: 'place' }],
});
```

`sqliteProvider(file)` and `nominatimProvider(language)` are exported too.
Providers get an `AbortSignal`, and answers that come too late (8 s) or after
the query changed are dropped. Labels are stripped of control characters
before they reach the terminal.

## Tests

`bun test` (the prompt, the providers, a real index when `sqlite3` and
`python3` are there) and `python3 tools/test_maps_search_index.py` (the
importer).
