import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import fs from 'fs';
import os from 'os';
import path from 'path';
import config from './config';
import TileSource, { sourceCacheDir } from './TileSource';

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
      await a.init('http://127.0.0.1:1/a/');
      const b = new TileSource();
      await b.init('http://127.0.0.1:1/b/');

      expect(a.cacheDir).toBe(sourceCacheDir('http://127.0.0.1:1/a/'));
      expect(a.cacheDir).not.toBe(b.cacheDir);
      expect(a.cacheDir?.startsWith(path.join(cacheHome, 'mapscii', 'sources'))).toBe(true);
      expect(fs.readFileSync(path.join(a.cacheDir ?? '', 'source.txt'), 'utf8').trim())
        .toBe('http://127.0.0.1:1/a/');
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
      await a.init('http://127.0.0.1:1/a/');
      const b = new TileSource();
      await b.init('http://127.0.0.1:1/b/');

      a.resetCache();

      expect(fs.existsSync(path.join(a.cacheDir ?? '', 'source.txt'))).toBe(true); // made again, empty
      expect(fs.readdirSync(a.cacheDir ?? '')).toEqual(['source.txt']);
      expect(fs.existsSync(path.join(b.cacheDir ?? '', 'source.txt'))).toBe(true);
    });
  });
});
