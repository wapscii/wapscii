import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import config from './config';
import TileSource, { attributionText, isLocalSource, isTileUrlTemplate, sourceCacheDir, tileUrl } from './TileSource';

describe('TileSource', () => {
  const originalPersistDownloadedTiles = config.persistDownloadedTiles;
  const originalCacheHome = process.env.XDG_CACHE_HOME;
  let cacheHome = '';

  beforeEach(() => {
    cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mapscii-cache-'));
    process.env.XDG_CACHE_HOME = cacheHome;
  });

  afterEach(() => {
    config.persistDownloadedTiles = originalPersistDownloadedTiles;
    config.cacheLocalSources = false;
    if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalCacheHome;
    fs.rmSync(cacheHome, { recursive: true, force: true });
  });

  describe('with an HTTP source', () => {
    test('sets the mode to HTTP', async () => {
      config.persistDownloadedTiles = false;

      const tileSource = new TileSource();
      await tileSource.init('https://tiles.example.org/');

      expect(tileSource.mode).toBe(3);
    });

    test('keeps the tiles of each source in a folder of its own', async () => {
      config.persistDownloadedTiles = true;

      const a = new TileSource();
      await a.init('http://tiles.example.test/a/');
      const b = new TileSource();
      await b.init('http://tiles.example.test/b/');

      expect(a.cacheDir).toBe(sourceCacheDir('http://tiles.example.test/a/'));
      expect(a.cacheDir).not.toBe(b.cacheDir);
      expect(a.cacheDir?.startsWith(path.join(cacheHome, 'mapscii', 'sources'))).toBe(true);
      expect(fs.readFileSync(path.join(a.cacheDir ?? '', 'source.txt'), 'utf8').trim())
        .toBe('http://tiles.example.test/a/');
    });
  });

  describe('resetCache', () => {
    test('clears in-memory tile caches', () => {
      config.persistDownloadedTiles = false;

      const tileSource = new TileSource();
      tileSource.cache['0-0-0'] = {} as never;
      tileSource.cached.push('0-0-0');

      const result = tileSource.resetCache({ persistent: false });

      expect(tileSource.cache).toEqual({});
      expect(tileSource.cached).toEqual([]);
      expect(result.memoryEntries).toBe(2);
      expect(result.errors).toEqual([]);
    });

    test('deletes only the folder of its own source', async () => {
      config.persistDownloadedTiles = true;

      const a = new TileSource();
      await a.init('http://tiles.example.test/a/');
      const b = new TileSource();
      await b.init('http://tiles.example.test/b/');

      a.resetCache();

      expect(fs.existsSync(path.join(a.cacheDir ?? '', 'source.txt'))).toBe(true); // made again, empty
      expect(fs.readdirSync(a.cacheDir ?? '')).toEqual(['source.txt']);
      expect(fs.existsSync(path.join(b.cacheDir ?? '', 'source.txt'))).toBe(true);
    });
  });
});

describe('HTTP tile URLs', () => {
  test('fill in templates, {-y} counting from the bottom (TMS)', () => {
    expect(tileUrl('https://t.example/{z}/{x}/{y}.pbf', 3, 4, 1)).toBe('https://t.example/3/4/1.pbf');
    expect(tileUrl('https://t.example/{z}/{x}/{-y}.pbf', 3, 4, 1)).toBe('https://t.example/3/4/6.pbf');
    expect(isTileUrlTemplate('https://t.example/{z}/{x}/{y}.pbf')).toBe(true);
    expect(isTileUrlTemplate('https://tiles.openfreemap.org/planet')).toBe(false);
  });

  test('turn HTML attributions into text', () => {
    expect(attributionText(
      '<a href="https://openfreemap.org" target="_blank">OpenFreeMap</a> <a href="https://www.openmaptiles.org/" ' +
      'target="_blank">&copy; OpenMapTiles</a> Data from <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    )).toBe('OpenFreeMap © OpenMapTiles Data from OpenStreetMap');
    expect(attributionText('a\u001b[31mb')).toBe('a[31mb');
  });
});

describe('a TileJSON source', () => {
  const originalPersistDownloadedTiles = config.persistDownloadedTiles;
  const originalCacheHome = process.env.XDG_CACHE_HOME;
  let cacheHome = '';
  let server: ReturnType<typeof Bun.serve> | null = null;
  let served: string[] = [];
  let up = true;

  beforeEach(() => {
    cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mapscii-cache-'));
    process.env.XDG_CACHE_HOME = cacheHome;
    config.persistDownloadedTiles = true;
    config.cacheLocalSources = true; // the test server is on this computer
    served = [];
    up = true;
    server = Bun.serve({
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        served.push(url.pathname);
        if (!up) return new Response('down', { status: 503 });
        if (url.pathname === '/planet') {
          return Response.json({
            tilejson: '3.0.0',
            tiles: ['20261004/{z}/{x}/{y}.pbf'],
            maxzoom: 14,
            attribution: '<a href="x">&copy; OpenMapTiles</a>',
          });
        }
        return new Response('', { status: 404 });
      },
    });
  });

  afterEach(() => {
    server?.stop(true);
    config.persistDownloadedTiles = originalPersistDownloadedTiles;
    config.cacheLocalSources = false;
    if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalCacheHome;
    fs.rmSync(cacheHome, { recursive: true, force: true });
  });

  test('gives the tile URLs, the maximum zoom and the attribution', async () => {
    const source = new TileSource();
    await source.init(`http://127.0.0.1:${server?.port}/planet`);

    expect(source.tileUrlTemplate).toBe(`http://127.0.0.1:${server?.port}/20261004/{z}/{x}/{y}.pbf`);
    expect(source.getMaxZoom()).toBe(14);
    expect(source.attribution).toBe('© OpenMapTiles');

    await expect(source.getTile(1, 0, 1)).rejects.toThrow('not found');
    expect(served).toEqual(['/planet', '/20261004/1/0/1.pbf']);
  });

  test('is remembered for when the server (or the network) is down', async () => {
    const url = `http://127.0.0.1:${server?.port}/planet`;
    await new TileSource().init(url);
    await Bun.sleep(50); // the TileJSON is saved in the background

    up = false;
    const source = new TileSource();
    await source.init(url);
    expect(source.tileUrlTemplate).toBe(`http://127.0.0.1:${server?.port}/20261004/{z}/{x}/{y}.pbf`);
  });

  test('that cannot be read says what else can be given', async () => {
    up = false;
    await expect(new TileSource().init(`http://127.0.0.1:${server?.port}/planet`))
      .rejects.toThrow(/TileJSON .*HTTP 503.*\{z\}\/\{x\}\/\{y\}/);
  });
});

describe('the tile cache', () => {
  const originalPersistDownloadedTiles = config.persistDownloadedTiles;
  const originalCacheHome = process.env.XDG_CACHE_HOME;
  let cacheHome = '';

  beforeEach(() => {
    cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mapscii-cache-'));
    process.env.XDG_CACHE_HOME = cacheHome;
    config.persistDownloadedTiles = true;
    config.cacheLocalSources = true; // the test server is on this computer
  });

  afterEach(() => {
    config.persistDownloadedTiles = originalPersistDownloadedTiles;
    config.cacheLocalSources = false;
    if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
    else process.env.XDG_CACHE_HOME = originalCacheHome;
    fs.rmSync(cacheHome, { recursive: true, force: true });
  });

  test('ignores empty tiles (cut short when mapscii exited), and fetches them again', async () => {
    const served: string[] = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        served.push(new URL(request.url).pathname);
        return new Response('', { status: 404 });
      },
    });
    try {
      const source = new TileSource();
      await source.init(`http://127.0.0.1:${server.port}/{z}/{x}/{y}.pbf`);
      fs.mkdirSync(path.join(source.cacheDir ?? '', '2'), { recursive: true });
      fs.writeFileSync(path.join(source.cacheDir ?? '', '2', '1-1.pbf'), '');

      await expect(source.getTile(2, 1, 1)).rejects.toThrow('not found');
      expect(served).toEqual(['/2/1/1.pbf']);
    } finally {
      server.stop(true);
    }
  });
});

describe('tile servers on this computer', () => {
  test('are recognised', () => {
    expect(isLocalSource('http://127.0.0.1:8765/')).toBe(true);
    expect(isLocalSource('http://localhost:8080/data/v3.json')).toBe(true);
    expect(isLocalSource('http://[::1]:8080/{z}/{x}/{y}.pbf')).toBe(true);
    expect(isLocalSource('https://tiles.openfreemap.org/planet')).toBe(false);
    expect(isLocalSource('http://127.0.0.1.example.org/')).toBe(false);
  });

  test('have no disk cache: their tiles are on disk already', async () => {
    const originalCacheHome = process.env.XDG_CACHE_HOME;
    const cacheHome = fs.mkdtempSync(path.join(os.tmpdir(), 'mapscii-cache-'));
    process.env.XDG_CACHE_HOME = cacheHome;
    config.persistDownloadedTiles = true;
    try {
      const source = new TileSource();
      await source.init('http://127.0.0.1:45678/');
      expect(source.cacheDir).toBeNull();
      expect(fs.existsSync(path.join(cacheHome, 'mapscii'))).toBe(false);
    } finally {
      if (originalCacheHome === undefined) delete process.env.XDG_CACHE_HOME;
      else process.env.XDG_CACHE_HOME = originalCacheHome;
      fs.rmSync(cacheHome, { recursive: true, force: true });
    }
  });
});
