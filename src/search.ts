/*
  MapSCII - Terminal Map Viewer
  Search: what a query means, where places come from, and the state of the
  search prompt (drawn by SearchBox).

  A query is either a location written out (coordinates, a geohash) or a
  place name. Names are looked up by providers:
  * an offline index (SQLite FTS5, built by tools/maps-search-index), asked
    while typing as well, since that costs nothing;
  * Nominatim, asked only when Enter is pressed: its usage policy forbids
    search-as-you-type (https://operations.osmfoundation.org/policies/nominatim/).
*/

import { execFile } from 'child_process';
import fs from 'fs';
import { homedir } from 'os';
import path from 'path';
import ngeohash from 'ngeohash';

export interface Place {
  lat: number;
  lon: number;
  label: string;
  kind: 'coordinates' | 'geohash' | 'place';
  /** zoom asked for (lat,lon,zoom) */
  zoom?: number;
  /** south, north, west, east: the zoom is chosen to show it */
  box?: [number, number, number, number];
}

export type SearchProvider = (query: string, signal: AbortSignal) => Promise<Place[]>;

const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g; // eslint-disable-line no-control-regex

/** Text from a query, a database or a web service, safe to print: no control or bidi override characters. */
export function clean(text: unknown): string {
  return String(text).replace(CONTROL_RE, ' ');
}

const NUMBER = '[+-]?(?:\\d+(?:\\.\\d*)?|\\.\\d+)';
const SEPARATOR = '(?:\\s*[,;]\\s*|\\s+)';
const COORDINATES_RE = new RegExp(`^(${NUMBER})${SEPARATOR}(${NUMBER})(?:${SEPARATOR}(${NUMBER}))?$`);
const GEOHASH_RE = /^[0-9bcdefghjkmnpqrstuvwxyz]{1,12}$/;

/**
 * "lat,lon" or "lat lon", with an optional zoom: "48.14, 11.58, 15".
 * Null when the query isn't coordinates; throws when it is, out of range.
 */
export function parseCoordinates(query: string): Place | null {
  const match = query.trim().match(COORDINATES_RE);
  if (!match) return null;
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  const zoom = match[3] === undefined ? undefined : Number(match[3]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180 || (zoom !== undefined && (zoom < 0 || zoom > 22))) {
    throw new Error('Coordinates: latitude -90..90, longitude -180..180, zoom 0..22');
  }
  return { lat, lon, zoom, kind: 'coordinates', label: `${lat}, ${lon}` };
}

/**
 * A geohash: "geohash:u33dc0", "gh:u33dc0", a geohash.org link, or a bare
 * geohash of 4 to 12 characters with a digit in it. Bare words without
 * digits are names: "sydney", "dresden" and "bern" are valid geohashes too.
 */
export function parseGeohash(query: string): Place | null {
  const text = query.trim().toLowerCase();
  const prefixed = text.match(/^(?:geohash:|gh:|(?:https?:\/\/)?geohash\.org\/)([0-9a-z]+)$/);
  const hash = prefixed ? prefixed[1] : text;
  if (!GEOHASH_RE.test(hash)) return null;
  if (!prefixed && (hash.length < 4 || !/\d/.test(hash) || !/[a-z]/.test(hash))) return null;
  const { latitude, longitude } = ngeohash.decode(hash);
  return {
    lat: latitude,
    lon: longitude,
    kind: 'geohash',
    label: `geohash ${hash}`,
    // longer hashes are smaller cells
    zoom: Math.min(18, 4 + hash.length * 1.5),
  };
}

/** A location written out in the query, which needs no provider. */
export function parseLocation(query: string): Place | null {
  return parseCoordinates(query) ?? parseGeohash(query);
}

/** Zoom that shows a box (south, north, west, east) on a canvas of width x height braille pixels. */
export function zoomForBox(box: [number, number, number, number], width: number, height: number, projectSize = 256): number {
  const [south, north, west, east] = box;
  const mercatorY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (Math.max(-85, Math.min(85, lat)) * Math.PI) / 360));
  const lonFraction = Math.max(1e-7, Math.abs(east - west) / 360);
  const latFraction = Math.max(1e-7, Math.abs(mercatorY(north) - mercatorY(south)) / (2 * Math.PI));
  const zoom = Math.min(
    Math.log2(width / (projectSize * lonFraction)),
    Math.log2(height / (projectSize * latFraction)),
  );
  return Math.max(2, Math.min(17, zoom));
}

/** The offline index mapscii looks for unless told otherwise. */
export function defaultSearchDatabase(): string {
  const dataHome = process.env.XDG_DATA_HOME || path.join(homedir(), '.local', 'share');
  return path.join(dataHome, 'mapscii', 'search.sqlite');
}

/**
 * Places from an offline index made by tools/maps-search-index (GeoNames).
 * Read with the sqlite3 program: read-only, no shell, the query escaped for
 * FTS and SQL, output and time capped. No native module to install.
 */
export function sqliteProvider(database: string, command = process.env.MAPSCII_SQLITE || 'sqlite3'): SearchProvider {
  return (query, signal) => new Promise((resolve, reject) => {
    if (!fs.existsSync(database)) {
      reject(new Error(`No offline index at ${database} (tools/maps-search-index makes one)`));
      return;
    }
    // every word a prefix, all of them needed; accents don't matter
    const tokens = query.slice(0, 256).normalize('NFKD').replace(/[̀-ͯ]/g, '')
      .split(/[\s,]+/).filter(Boolean).slice(0, 12);
    if (!tokens.length) {
      resolve([]);
      return;
    }
    const match = tokens.map((token) => `"${token.replace(/"/g, '""')}"*`).join(' AND ').replace(/'/g, '\'\'');
    const sql = `SELECT p.label, p.lat, p.lon FROM place_names AS f
      JOIN places AS p ON p.id = f.rowid WHERE place_names MATCH '${match}'
      ORDER BY p.population DESC, p.name, p.id LIMIT 10;`;
    execFile(command, ['-readonly', '-json', path.resolve(database), sql],
      { timeout: 3000, maxBuffer: 256 * 1024, signal }, (error, stdout) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          reject(new Error(code === 'ENOENT'
            ? 'The offline index needs the sqlite3 program'
            : code === 'ABORT_ERR' ? 'cancelled' : 'Cannot read the offline index'));
          return;
        }
        try {
          const rows = JSON.parse(stdout || '[]') as Array<{ label: string; lat: number; lon: number }>;
          resolve(rows.map((row) => ({ lat: row.lat, lon: row.lon, label: row.label, kind: 'place' as const })));
        } catch {
          reject(new Error('Cannot read the offline index'));
        }
      });
  });
}

interface NominatimResult {
  lat: string;
  lon: string;
  display_name: string;
  boundingbox?: [string, string, string, string];
}

export const NOMINATIM_USER_AGENT = 'wapscii (https://github.com/wapscii/wapscii)';

/** Places from Nominatim (OpenStreetMap's geocoder): one request per Enter. */
export function nominatimProvider(
  language = 'en',
  endpoint = 'https://nominatim.openstreetmap.org/search',
): SearchProvider {
  return async (query, signal) => {
    const url = new URL(endpoint);
    url.searchParams.set('format', 'jsonv2');
    url.searchParams.set('q', query.slice(0, 256));
    url.searchParams.set('limit', '5');
    url.searchParams.set('accept-language', language);
    const response = await fetch(url, {
      signal,
      headers: { 'User-Agent': NOMINATIM_USER_AGENT },
    });
    if (!response.ok) {
      throw new Error(`Nominatim: HTTP ${response.status}`);
    }
    const results = await response.json() as NominatimResult[];
    if (!Array.isArray(results)) throw new Error('Nominatim: unexpected answer');
    return results.map((result) => {
      const box = result.boundingbox?.map(Number);
      return {
        lat: Number(result.lat),
        lon: Number(result.lon),
        label: result.display_name,
        kind: 'place' as const,
        box: box && box.length === 4 && box.every(Number.isFinite)
          ? [box[0], box[1], box[2], box[3]] as [number, number, number, number]
          : undefined,
      };
    });
  };
}

function validPlaces(places: unknown): Place[] {
  if (!Array.isArray(places)) throw new Error('The search answered something else than places');
  return places
    .filter((p): p is Place => Boolean(p) && Number.isFinite(p.lat) && Number.isFinite(p.lon) &&
      Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180 && typeof p.label === 'string')
    .slice(0, 10)
    .map((p) => ({ ...p, label: clean(p.label).slice(0, 512) }));
}

export interface SearchSessionOptions {
  /** asked while typing (only local, cheap ones) */
  suggest?: SearchProvider | null;
  /** asked in turn on Enter, until one finds something */
  providers: SearchProvider[];
  /** called when the prompt should be drawn again */
  onChange: () => void;
  /** the chosen place, or null when the search was cancelled */
  onDone: (place: Place | null) => void;
  timeout?: number;
  debounce?: number;
}

/**
 * The search prompt's state: the text being typed, the places to choose
 * from and a message. Keys go in (terminal-kit names), places come out.
 */
export class SearchSession {
  text: string[] = [];
  cursor = 0;
  places: Place[] = [];
  selected = 0;
  message = '';
  busy = false;
  active = true;

  private generation = 0;
  private controller: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly timeout: number;
  private readonly debounce: number;

  constructor(private readonly options: SearchSessionOptions) {
    this.timeout = options.timeout ?? 8000;
    this.debounce = options.debounce ?? 150;
  }

  get query(): string {
    return this.text.join('');
  }

  key(name: string, char?: string): void {
    if (!this.active) return;
    switch (name) {
      case 'ESCAPE':
      case 'CTRL_C':
        this.finish(null);
        return;
      case 'ENTER':
      case 'KP_ENTER':
        void this.submit();
        return;
      case 'UP':
      case 'DOWN':
        if (this.places.length) {
          const step = name === 'UP' ? -1 : 1;
          this.selected = (this.selected + step + this.places.length) % this.places.length;
          this.options.onChange();
        }
        return;
      case 'LEFT':
        this.cursor = Math.max(0, this.cursor - 1);
        break;
      case 'RIGHT':
        this.cursor = Math.min(this.text.length, this.cursor + 1);
        break;
      case 'HOME':
      case 'CTRL_A':
        this.cursor = 0;
        break;
      case 'END':
      case 'CTRL_E':
        this.cursor = this.text.length;
        break;
      case 'CTRL_U':
        this.edit(() => {
          this.text = [];
          this.cursor = 0;
        });
        return;
      case 'BACKSPACE':
        if (this.cursor) this.edit(() => this.text.splice(--this.cursor, 1));
        return;
      case 'DELETE':
        if (this.cursor < this.text.length) this.edit(() => this.text.splice(this.cursor, 1));
        return;
      default:
        if (char !== undefined) {
          const chars = Array.from(clean(char)).slice(0, 256 - this.text.length);
          if (chars.length) {
            this.edit(() => {
              this.text.splice(this.cursor, 0, ...chars);
              this.cursor += chars.length;
            });
          }
        }
        return;
    }
    this.options.onChange();
  }

  /** Enter: the highlighted place, a location written out, or a search. */
  async submit(): Promise<void> {
    if (this.busy) return;
    if (this.places.length) {
      this.finish(this.places[this.selected]);
      return;
    }
    const query = this.query.trim();
    if (!query) {
      this.finish(null);
      return;
    }
    try {
      const location = parseLocation(query);
      if (location) {
        this.finish(location);
        return;
      }
    } catch (error: unknown) {
      this.message = clean(error instanceof Error ? error.message : error);
      this.options.onChange();
      return;
    }
    if (!this.options.providers.length) {
      this.message = 'Place names need an offline index (--searchDb) or online search';
      this.options.onChange();
      return;
    }

    const generation = this.restart();
    this.busy = true;
    this.message = 'Searching…';
    this.options.onChange();
    let failure = '';
    for (const provider of this.options.providers) {
      try {
        const places = validPlaces(await this.ask(provider, query));
        if (generation !== this.generation) return;
        if (places.length === 1) {
          this.finish(places[0]);
          return;
        }
        if (places.length) {
          this.busy = false;
          this.places = places;
          this.selected = 0;
          this.message = '';
          this.options.onChange();
          return;
        }
      } catch (error: unknown) {
        if (generation !== this.generation) return;
        failure = clean(error instanceof Error ? error.message : error);
      }
    }
    this.busy = false;
    this.message = failure || `Nothing found for "${clean(query).slice(0, 60)}"`;
    this.options.onChange();
  }

  cancel(): void {
    this.active = false;
    this.restart();
  }

  private edit(change: () => void): void {
    change();
    this.restart();
    this.busy = false;
    this.places = [];
    this.selected = 0;
    this.message = '';
    this.options.onChange();
    this.scheduleSuggestions();
  }

  private scheduleSuggestions(): void {
    const suggest = this.options.suggest;
    const query = this.query.trim();
    if (!suggest || query.length < 2) return;
    try {
      if (parseLocation(query)) return;
    } catch {
      return;
    }
    const generation = this.generation;
    this.timer = setTimeout(async () => {
      this.timer = null;
      try {
        const places = validPlaces(await this.ask(suggest, query));
        if (generation !== this.generation || !this.active) return;
        this.places = places;
        this.selected = 0;
        this.options.onChange();
      } catch {
        // suggestions are a bonus: Enter reports errors
      }
    }, this.debounce);
  }

  /** A provider's answer, unless it is too slow or superseded. */
  private ask(provider: SearchProvider, query: string): Promise<Place[]> {
    const controller = new AbortController();
    this.controller = controller;
    const timer = setTimeout(() => controller.abort(new Error('The search took too long')), this.timeout);
    return Promise.race([
      Promise.resolve().then(() => provider(query, controller.signal)),
      new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => {
          const reason: unknown = controller.signal.reason;
          reject(reason instanceof Error ? reason : new Error('cancelled'));
        });
      }),
    ]).finally(() => clearTimeout(timer));
  }

  /** Forget whatever is under way: its answer won't be used. */
  private restart(): number {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.controller?.abort(new Error('cancelled'));
    this.controller = null;
    return ++this.generation;
  }

  private finish(place: Place | null): void {
    this.cancel();
    this.options.onDone(place);
  }
}
