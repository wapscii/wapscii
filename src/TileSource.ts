/*
  MapSCII - Terminal Map Viewer
  by Michael Strassburger <codepoet@cpan.org>

  Source for VectorTiles - supports
  * remote TileServer: a TileJSON URL, a {z}/{x}/{y} URL template, or a
    base URL ending in / (tiles at base/z/x/y.pbf)
  * local MBTiles and VectorTiles
*/

import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { homedir } from 'os';
import { fileURLToPath } from 'url';

import Tile from './Tile';
import config from './config';
import Styler from './Styler';
import TileWorkerPool from './TileWorkerPool';

function cacheRoot(): string {
  return path.join(process.env.XDG_CACHE_HOME || path.join(homedir(), '.cache'), 'mapscii');
}

// Before each source had its own folder, the tiles of every source went into
// one of these: they are only ever deleted (by resetCache), never read.
function sharedCacheDirs(): string[] {
  return [path.join(cacheRoot(), 'cache-2'), path.join(homedir(), '.mapscii', 'cache-2')];
}

/**
 * Where the tiles of an HTTP source are kept. Each source gets its own folder,
 * so tiles of different servers (and of different schemas: OpenMapTiles,
 * the old mapscii.me tiles, a local tileserver) never mix.
 */
export function sourceCacheDir(source: string): string {
  const id = createHash('sha256').update(source).digest('hex').slice(0, 16);
  return path.join(cacheRoot(), 'sources', id);
}

interface TileJSON {
  tiles: string[];
  minzoom?: number;
  maxzoom?: number;
  attribution?: string;
}

/** Whether an HTTP source is a server on this computer. */
export function isLocalSource(source: string): boolean {
  let host: string;
  try {
    host = new URL(source).hostname.toLowerCase();
  } catch {
    return false;
  }
  return host === 'localhost' || host === '[::1]' || host === '::1' || /^127\.\d+\.\d+\.\d+$/.test(host);
}

/** Whether an HTTP source is a URL template with {z}, {x} and {y} in it. */
export function isTileUrlTemplate(source: string): boolean {
  return source.includes('{z}') && source.includes('{x}') && (source.includes('{y}') || source.includes('{-y}'));
}

/** The URL of one tile: {z}/{x}/{y} replaced, {-y} for TMS servers. */
export function tileUrl(template: string, z: number, x: number, y: number): string {
  return template
    .replaceAll('{z}', String(z))
    .replaceAll('{x}', String(x))
    .replaceAll('{-y}', String((1 << z) - 1 - y))
    .replaceAll('{y}', String(y));
}

/** TileJSON attributions are HTML; the terminal gets their text. */
export function attributionText(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&copy;/g, '©')
    .replace(/&amp;/g, '&')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    // eslint-disable-next-line no-control-regex -- terminal control characters
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseTileJSON(text: string, base: string): TileJSON {
  const data: unknown = JSON.parse(text);
  const json = data as Partial<TileJSON> | null;
  if (!json || !Array.isArray(json.tiles) || typeof json.tiles[0] !== 'string') {
    throw new Error('not a TileJSON: it has no "tiles" list');
  }
  return {
    // tile URLs may be relative to the TileJSON's own
    tiles: json.tiles.map((t) => new URL(t, base).toString().replace(/%7B/gi, '{').replace(/%7D/gi, '}')),
    minzoom: typeof json.minzoom === 'number' ? json.minzoom : undefined,
    maxzoom: typeof json.maxzoom === 'number' ? json.maxzoom : undefined,
    attribution: typeof json.attribution === 'string' ? json.attribution : undefined,
  };
}

/**
 * Writes a file without ever leaving a part of it: the data goes to a
 * temporary file that is renamed when complete. mapscii often exits (q,
 * --ansiScreenshot) right after tiles arrive, and the background
 * fs.writeFile used before then left empty .pbf files, which are valid
 * empty tiles: the map stayed blank there until the cache was reset. A tile
 * is a few kilobytes, so writing it synchronously costs nothing noticeable.
 */
function writeFileAtomic(file: string, data: string | Buffer): void {
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, data);
    fs.renameSync(temporary, file);
  } catch {
    try {
      fs.unlinkSync(temporary);
    } catch {
      // nothing written
    }
  }
}

export interface TileCacheResetResult {
  memoryEntries: number;
  persistentPaths: string[];
  errors: string[];
}

export interface TileCacheResetOptions {
  persistent?: boolean;
}

// MBTiles interface for dynamic import
interface MBTilesInstance {
  _db: {
    all(sql: string, callback: (err: Error | null, rows: Array<{ max_zoom?: number }>) => void): void;
  };
  getTile(z: number, x: number, y: number, callback: (err: Error | null, data: Buffer, headers: Record<string, string>) => void): void;
}

type MBTilesConstructor = new (path: string, callback: (err: Error | null, mbtiles: MBTilesInstance) => void) => MBTilesInstance;

// https://github.com/mapbox/node-mbtiles has native build dependencies (sqlite3).
// To keep the default package install portable, MBTiles support is an optional
// peer dependency and must be installed next to mapscii by consumers that need it.
let MBTiles: MBTilesConstructor | null = null;
try {
  MBTiles = (await import('@mapbox/mbtiles')).default as unknown as MBTilesConstructor;
} catch {
  // MBTiles support not available
}

enum TileMode {
  MBTiles = 1,
  VectorTile = 2,
  HTTP = 3,
}

/**
 * Thrown when a tile definitively doesn't exist in the source (e.g. HTTP 404,
 * zoom level not present). Callers can use this to distinguish "this zoom
 * level isn't available" from transient network/parse failures.
 */
export class TileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TileNotFoundError';
  }
}

export default class TileSource {
  public source: string = '';
  public cache: Record<string, Tile> = {};
  public cacheSize: number = 16;
  public cached: string[] = [];
  public mode: TileMode | null = null;
  public mbtiles: MBTilesInstance | null = null;
  public vectorTilePath: string | null = null;
  public styler: Styler | null = null;
  public maxZoom: number | null = null;
  public cacheDir: string | null = null;
  /** {z}/{x}/{y} template the tiles of an HTTP source are fetched from */
  public tileUrlTemplate: string | null = null;
  /** Attribution the source asks for (from its TileJSON), as text */
  public attribution: string | null = null;
  // De-dupe concurrent requests for the same tile (the globe view requests
  // the same parent tile from many fallback paths simultaneously)
  private inflight: Map<string, Promise<Tile>> = new Map();
  // Tiles the source definitively doesn't have (per session)
  private notFound: Set<string> = new Set();
  private cacheGeneration: number = 0;

  async init(source: string): Promise<void> {
    this.source = source;
    this.cache = {};
    this.cached = [];
    this.vectorTilePath = null;
    this.cacheDir = null;
    this.tileUrlTemplate = null;
    this.attribution = null;
    this.maxZoom = null;

    if (this.source.startsWith('http')) {
      // A tile server on this computer has its tiles already: copying them
      // into the cache only fills the disk (a different folder per port)
      this.cacheDir = isLocalSource(this.source) && !config.cacheLocalSources ? null : sourceCacheDir(this.source);
      if (config.persistDownloadedTiles) {
        this._initPersistence();
      }

      this.mode = TileMode.HTTP;
      if (isTileUrlTemplate(this.source)) {
        this.tileUrlTemplate = this.source;
      } else if (this.source.endsWith('/')) {
        // mapscii's original form: base URL, tiles at base/z/x/y.pbf
        this.tileUrlTemplate = this.source + '{z}/{x}/{y}.pbf';
      } else {
        const tileJSON = await this._loadTileJSON(this.source);
        this.tileUrlTemplate = tileJSON.tiles[0];
        this.maxZoom = tileJSON.maxzoom ?? null;
        this.attribution = tileJSON.attribution ? attributionText(tileJSON.attribution) || null : null;
      }
    } else if (this._isMBTilesSource(this.source)) {
      if (!MBTiles) {
        throw new Error('MBTiles support requires installing optional peer dependency @mapbox/mbtiles in this project.');
      }

      this.mode = TileMode.MBTiles;
      await this.loadMBTiles(this._sourceToLocalPath(source));
    } else if (this._isVectorTileSource(this.source)) {
      this.mode = TileMode.VectorTile;
      this.vectorTilePath = this._sourceToLocalPath(source);
      // The standalone tile is served as 0/0/0 and overzoomed: every zoom
      // level scales the same tile.
      this.maxZoom = 0;
    } else {
      throw new Error('source type isn\'t supported yet');
    }
  }

  async loadMBTiles(source: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!MBTiles) {
        reject(new Error('MBTiles not available'));
        return;
      }

      new MBTiles(source, (err: Error | null, mbtiles: MBTilesInstance) => {
        if (err) {
          reject(err);
          return;
        }
        this.mbtiles = mbtiles;

        this.mbtiles._db.all(
          'SELECT MAX(zoom_level) as max_zoom FROM tiles',
          (err: Error | null, rows: Array<{ max_zoom?: number }>) => {
            this.maxZoom = err || !rows || !rows[0] ? null : rows[0].max_zoom ?? null;
            resolve();
          }
        );
      });
    });
  }

  useStyler(styler: Styler): void {
    this.styler = styler;
  }

  /** The highest zoom level the source has tiles for (deeper zooms scale those). */
  getMaxZoom(): number {
    return this.maxZoom ?? config.tileRange;
  }

  /**
   * Reads a TileJSON (https://github.com/mapbox/tilejson-spec). OpenFreeMap's
   * planet TileJSON points at a dated tile set that changes every week, so
   * the source to configure is the TileJSON, not a tile URL. It is kept next
   * to the cached tiles, so that those still show without a network.
   */
  private async _loadTileJSON(url: string): Promise<TileJSON> {
    const saved = this.cacheDir ? path.join(this.cacheDir, 'tilejson.json') : null;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}`);
      }
      const text = await response.text();
      const tileJSON = parseTileJSON(text, url);
      if (saved && config.persistDownloadedTiles) {
        writeFileAtomic(saved, text);
      }
      return tileJSON;
    } catch (error: unknown) {
      if (saved) {
        try {
          return parseTileJSON(fs.readFileSync(saved, 'utf8'), url);
        } catch {
          // nothing saved: report the download's error
        }
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`cannot read the TileJSON at ${url} (${reason}). A tile URL template ` +
        '(.../{z}/{x}/{y}.pbf) or a base URL ending in / can be given instead.');
    }
  }

  isSingleVectorTile(): boolean {
    return this.mode === TileMode.VectorTile;
  }

  async getTile(z: number, x: number, y: number): Promise<Tile> {
    if (!this.mode) {
      throw new Error('no TileSource defined');
    }

    // Reject out-of-range coordinates without hitting the network
    const gridSize = 1 << z;
    if (z < 0 || z > 30 || x < 0 || x >= gridSize || y < 0 || y >= gridSize) {
      throw new TileNotFoundError(`tile out of range: ${z}/${x}/${y}`);
    }

    const cacheKey = [z, x, y].join('-');
    const generation = this.cacheGeneration;

    if (this.notFound.has(cacheKey)) {
      throw new TileNotFoundError(`tile not found: ${z}/${x}/${y}`);
    }

    const cached = this.cache[cacheKey];
    if (cached) {
      return cached;
    }

    const pending = this.inflight.get(cacheKey);
    if (pending) {
      return pending;
    }

    const promise = this._loadTile(z, x, y)
      .then((tile) => {
        // Only fully loaded tiles enter the cache, so concurrent callers can
        // never observe a half-parsed tile with empty layers.
        if (generation === this.cacheGeneration) {
          this._commitToCache(cacheKey, tile);
        }
        return tile;
      })
      .catch((err) => {
        if (err instanceof TileNotFoundError && generation === this.cacheGeneration) {
          this.notFound.add(cacheKey);
        }
        throw err;
      })
      .finally(() => {
        this.inflight.delete(cacheKey);
      });

    this.inflight.set(cacheKey, promise);
    return promise;
  }

  resetCache(options: TileCacheResetOptions = {}): TileCacheResetResult {
    const memoryEntries = Object.keys(this.cache).length + this.cached.length + this.notFound.size + this.inflight.size;
    this.cacheGeneration += 1;
    this.cache = {};
    this.cached = [];
    this.notFound.clear();
    this.inflight.clear();

    const result: TileCacheResetResult = {
      memoryEntries,
      persistentPaths: [],
      errors: [],
    };

    if (options.persistent !== false) {
      [...(this.cacheDir ? [this.cacheDir] : []), ...sharedCacheDirs()].forEach((folder) => {
        try {
          if (fs.existsSync(folder)) {
            fs.rmSync(folder, { recursive: true, force: true });
            result.persistentPaths.push(folder);
          }
        } catch (error: unknown) {
          result.errors.push(error instanceof Error ? error.message : String(error));
        }
      });
    }

    if (config.persistDownloadedTiles && options.persistent !== false) {
      this._initPersistence();
    }

    return result;
  }

  private _commitToCache(cacheKey: string, tile: Tile): void {
    while (this.cached.length >= this.cacheSize) {
      const oldest = this.cached.shift();
      if (oldest === undefined) break;
      delete this.cache[oldest];
    }
    this.cached.push(cacheKey);
    this.cache[cacheKey] = tile;
  }

  private async _loadTile(z: number, x: number, y: number): Promise<Tile> {
    switch (this.mode) {
      case TileMode.MBTiles:
        return this._getMBTile(z, x, y);
      case TileMode.VectorTile:
        return this._getVectorTile(z, x, y);
      case TileMode.HTTP:
        return this._getHTTP(z, x, y);
      default:
        throw new Error('Unknown tile mode');
    }
  }

  private async _getHTTP(z: number, x: number, y: number): Promise<Tile> {
    if (config.persistDownloadedTiles) {
      const persistedTile = this._getPersisted(z, x, y);
      if (persistedTile) {
        try {
          return await this._parseTile(persistedTile, z);
        } catch {
          // Corrupt persisted tile (e.g. an HTTP error page persisted by an
          // older version): delete it and fall through to a fresh download.
          this._deletePersisted(z, x, y);
        }
      }
    }

    if (!this.tileUrlTemplate) {
      throw new Error('HTTP source not initialized');
    }
    const response = await fetch(tileUrl(this.tileUrlTemplate, z, x, y));
    if (!response.ok) {
      if (response.status === 404 || response.status === 410 || response.status === 204) {
        throw new TileNotFoundError(`tile not found: ${z}/${x}/${y} (HTTP ${response.status})`);
      }
      throw new Error(`tile request failed: ${z}/${x}/${y} (HTTP ${response.status})`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());

    // Parse first, persist only what parsed successfully
    const tile = await this._parseTile(buffer, z);
    if (config.persistDownloadedTiles) {
      this._persistTile(z, x, y, buffer);
    }
    return tile;
  }

  private async _getMBTile(z: number, x: number, y: number): Promise<Tile> {
    const buffer = await new Promise<Buffer>((resolve, reject) => {
      if (!this.mbtiles) {
        reject(new Error('MBTiles not initialized'));
        return;
      }
      this.mbtiles.getTile(z, x, y, (err: Error | null, data: Buffer) => {
        if (err) {
          // node-mbtiles reports missing tiles as plain errors
          reject(new TileNotFoundError(err.message || `tile not found: ${z}/${x}/${y}`));
          return;
        }
        resolve(data);
      });
    });
    return this._parseTile(buffer, z);
  }

  private async _getVectorTile(z: number, x: number, y: number): Promise<Tile> {
    if (z !== 0 || x !== 0 || y !== 0) {
      throw new TileNotFoundError(`single vector tile source only provides 0/0/0, requested ${z}/${x}/${y}`);
    }
    if (!this.vectorTilePath) {
      throw new Error('Vector tile source not initialized');
    }

    const buffer = await fs.promises.readFile(this.vectorTilePath);
    return this._parseTile(buffer, z);
  }

  private async _parseTile(buffer: Buffer, z: number): Promise<Tile> {
    if (config.useTileWorker && this.styler) {
      try {
        const payload = await TileWorkerPool.parse(buffer, z, this.styler, config.language);
        return Tile.fromParsedLayers(this.styler, payload, z);
      } catch {
        // Fall back to main-thread parsing if worker startup/import/parse fails.
      }
    }

    return new Tile(this.styler).load(buffer, z);
  }

  private _initPersistence(): void {
    if (!this.cacheDir) return;
    try {
      this._createFolder(this.cacheDir);
      // which source the folder belongs to, for whoever looks into the cache
      fs.writeFileSync(path.join(this.cacheDir, 'source.txt'), this.source + '\n');
    } catch {
      config.persistDownloadedTiles = false;
    }
  }

  private _tilePath(z: number, x: number, y: number): string | null {
    return this.cacheDir && path.join(this.cacheDir, z.toString(), `${x}-${y}.pbf`);
  }

  private _persistTile(z: number, x: number, y: number, buffer: Buffer): void {
    const filePath = this._tilePath(z, x, y);
    if (!filePath) return;
    try {
      this._createFolder(path.dirname(filePath));
    } catch {
      return;
    }
    writeFileAtomic(filePath, buffer);
  }

  private _getPersisted(z: number, x: number, y: number): Buffer | false {
    const filePath = this._tilePath(z, x, y);
    if (!filePath) return false;
    try {
      const buffer = fs.readFileSync(filePath);
      // empty: cut short by an older version (see writeFileAtomic)
      return buffer.length ? buffer : false;
    } catch {
      return false;
    }
  }

  private _deletePersisted(z: number, x: number, y: number): void {
    const filePath = this._tilePath(z, x, y);
    if (!filePath) return;
    try {
      fs.unlinkSync(filePath);
    } catch {
      // ignore
    }
  }

  private _createFolder(folderPath: string): boolean {
    try {
      fs.mkdirSync(folderPath, { recursive: true });
      return true;
    } catch (error: unknown) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST') return true;
      throw error;
    }
  }

  private _sourceToLocalPath(source: string): string {
    return source.startsWith('file://') ? fileURLToPath(source) : source;
  }

  private _isMBTilesSource(source: string): boolean {
    return this._sourceToLocalPath(source).toLowerCase().endsWith('.mbtiles');
  }

  private _isVectorTileSource(source: string): boolean {
    const normalized = this._sourceToLocalPath(source).toLowerCase();
    return normalized.endsWith('.pbf') || normalized.endsWith('.mvt');
  }
}
