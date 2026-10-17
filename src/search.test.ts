import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  SearchSession,
  SEARCH_INDEX_TOOL,
  clean,
  defaultPython,
  nominatimProvider,
  parseCoordinates,
  parseGeohash,
  sqliteProvider,
  zoomForBox,
  type Place,
  type SearchProvider,
} from './search';

const munich: Place[] = [
  { label: 'München, BY, DE', lat: 48.14, lon: 11.58, kind: 'place' },
  { label: 'Munich, ND, US', lat: 48.67, lon: -98.83, kind: 'place' },
];

function session(providers: SearchProvider[], suggest: SearchProvider | null = null, timeout = 1000) {
  const chosen: Array<Place | null> = [];
  const search = new SearchSession({
    providers,
    suggest,
    timeout,
    debounce: 5,
    onChange: () => undefined,
    onDone: (place) => chosen.push(place),
  });
  const type = (text: string) => {
    for (const ch of text) search.key(ch, ch);
  };
  return { search, chosen, type };
}

describe('locations written out', () => {
  test('coordinates, with an optional zoom', () => {
    expect(parseCoordinates(' -12.5, 130.25, 8 ')).toMatchObject({ lat: -12.5, lon: 130.25, zoom: 8 });
    expect(parseCoordinates('48.14 11.58')).toMatchObject({ lat: 48.14, lon: 11.58, zoom: undefined });
    expect(parseCoordinates('Berlin')).toBeNull();
    expect(parseCoordinates('1,2 rubbish')).toBeNull();
    expect(() => parseCoordinates('91,0')).toThrow();
    expect(() => parseCoordinates('0,181')).toThrow();
    expect(() => parseCoordinates('0,0,-1')).toThrow();
  });

  test('geohashes, but not place names that happen to be geohashes', () => {
    expect(parseGeohash('u33dc0')?.lat).toBeCloseTo(52.52, 1);
    expect(parseGeohash('geohash:u33d')).not.toBeNull();
    expect(parseGeohash('gh:u33d')).not.toBeNull();
    expect(parseGeohash('https://geohash.org/u33dc0')).not.toBeNull();
    // all of these are valid geohashes, and places
    for (const name of ['Sydney', 'Dresden', 'Bern', 'Essen', 'Bremen']) {
      expect(parseGeohash(name)).toBeNull();
    }
    expect(parseGeohash('gh:ilo')).toBeNull(); // not geohash letters
  });

  test('need no provider', () => {
    const { search, chosen, type } = session([() => { throw new Error('must not be asked'); }]);
    type('48,11,9');
    search.key('ENTER');
    expect(chosen[0]).toMatchObject({ lat: 48, lon: 11, zoom: 9, kind: 'coordinates' });
  });

  test('out of range: a message, and the prompt stays', () => {
    const { search, chosen, type } = session([]);
    type('95,10');
    search.key('ENTER');
    expect(chosen).toEqual([]);
    expect(search.message).toContain('latitude');
    expect(search.active).toBe(true);
  });
});

describe('the prompt', () => {
  test('edits Unicode text, digits included', () => {
    const { search, type } = session([]);
    type('東京🙂');
    search.key('LEFT');
    search.key('BACKSPACE');
    expect(search.query).toBe('東🙂');
    search.key('CTRL_U');
    type('10 Downing Street');
    expect(search.query).toBe('10 Downing Street');
    type('x'.repeat(1000));
    expect(search.text.length).toBe(256);
  });

  test('asks the providers only on Enter, then offers what they found', async () => {
    const asked: string[] = [];
    const { search, chosen, type } = session([async (query) => {
      asked.push(query);
      return munich;
    }]);
    type('Munich');
    await Bun.sleep(30);
    expect(asked).toEqual([]);
    await search.submit();
    expect(asked).toEqual(['Munich']);
    expect(search.places.map((p) => p.label)).toEqual(['München, BY, DE', 'Munich, ND, US']);
    search.key('DOWN');
    search.key('ENTER');
    expect(chosen).toEqual([munich[1]]);
  });

  test('goes straight to a single result', async () => {
    const { search, chosen, type } = session([async () => [munich[0]]]);
    type('München');
    await search.submit();
    expect(chosen).toEqual([munich[0]]);
  });

  test('asks the next provider when one finds nothing or fails', async () => {
    const { search, chosen, type } = session([
      async () => { throw new Error('no index'); },
      async () => [],
      async () => [munich[1]],
    ]);
    type('Munich');
    await search.submit();
    expect(chosen).toEqual([munich[1]]);
  });

  test('suggests from the local provider while typing', async () => {
    const { search, type } = session([], async (query) => munich.filter((p) => p.label.startsWith(query)));
    type('Mün');
    await Bun.sleep(40);
    expect(search.places).toEqual([munich[0]]);
    search.key('BACKSPACE');
    expect(search.places).toEqual([]); // edited: the old suggestions go
  });

  test('drops answers to queries that changed meanwhile', async () => {
    let answer: (places: Place[]) => void = () => undefined;
    const { search, type } = session([() => new Promise((resolve) => { answer = resolve; })]);
    type('old');
    const first = search.submit();
    type('er');
    answer([{ lat: 0, lon: 0, label: 'stale', kind: 'place' }, munich[0]]);
    await first;
    expect(search.places).toEqual([]);
    expect(search.busy).toBe(false);
  });

  test('gives up on slow providers', async () => {
    const { search, type } = session([() => new Promise(() => undefined)], null, 20);
    type('slow');
    await search.submit();
    expect(search.message).toContain('too long');
    expect(search.active).toBe(true);
  });

  test('keeps control characters and bad places out', async () => {
    const { search, type } = session([async () => [
      { lat: Number.NaN, lon: 0, label: 'bad', kind: 'place' },
      { lat: 1, lon: 2, label: '\u001b[31mGood\nplace‮', kind: 'place' },
      { lat: 3, lon: 4, label: 'Other', kind: 'place' },
    ]]);
    type('\u001b[2Jtest');
    expect(search.query).not.toContain('\u001b');
    await search.submit();
    expect(search.places.length).toBe(2);
    expect(search.places[0].label).toBe(' [31mGood place ');
    expect(clean('a\u0007b')).toBe('a b');
  });

  test('Escape cancels', () => {
    const { search, chosen } = session([]);
    search.key('ESCAPE');
    expect(chosen).toEqual([null]);
    expect(search.active).toBe(false);
  });
});

describe('Nominatim', () => {
  test('one request per Enter, with a User-Agent, and a zoom from the bounding box', async () => {
    const requests: Array<{ url: string; userAgent: string | null }> = [];
    const server = Bun.serve({
      port: 0,
      fetch(request) {
        requests.push({ url: request.url, userAgent: request.headers.get('user-agent') });
        return Response.json([{
          lat: '48.1371', lon: '11.5754', display_name: 'München, Bayern, Deutschland',
          boundingbox: ['48.06', '48.25', '11.36', '11.72'],
        }]);
      },
    });
    try {
      const provider = nominatimProvider('de', `http://127.0.0.1:${server.port}/search`);
      const places = await provider('München', new AbortController().signal);
      expect(places[0]).toMatchObject({ lat: 48.1371, lon: 11.5754, box: [48.06, 48.25, 11.36, 11.72] });
      expect(requests.length).toBe(1);
      const url = new URL(requests[0].url);
      expect(url.searchParams.get('q')).toBe('München');
      expect(url.searchParams.get('accept-language')).toBe('de');
      expect(requests[0].userAgent).toContain('wapscii');
    } finally {
      server.stop(true);
    }
  });

  test('zoom: a city closer than a country', () => {
    const city = zoomForBox([48.06, 48.25, 11.36, 11.72], 320, 160);
    const country = zoomForBox([47.27, 55.06, 5.87, 15.04], 320, 160);
    expect(city).toBeGreaterThan(9);
    expect(city).toBeLessThan(12);
    expect(country).toBeGreaterThan(4);
    expect(country).toBeLessThan(7);
  });
});

// Python with SQLite's FTS5, which the index tool needs
const python = defaultPython();
const sqlite = (() => {
  try {
    execFileSync(python, ['-c', 'import sqlite3; sqlite3.connect(":memory:").execute("CREATE VIRTUAL TABLE t USING fts5(x)")']);
    return true;
  } catch {
    return false;
  }
})();

describe.skipIf(!sqlite)('the offline index', () => {
  test('UTF-8, other names, ranking, and SQL/FTS characters in queries', async () => {
    const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'mapscii-search-'));
    try {
      const source = path.join(folder, 'cities.txt');
      const database = path.join(folder, 'search.sqlite');
      const row = (id: number, name: string, ascii: string, aliases: string, lat: number, lon: number, pop: number) =>
        [id, name, ascii, aliases, lat, lon, 'P', 'PPL', 'DE', '', 'BY', '', '', '', pop, '', '', 'Europe/Berlin', '2026-01-01'].join('\t');
      fs.writeFileSync(source, [
        row(1, 'München', 'Munchen', 'Munich,慕尼黑', 48.14, 11.58, 1500000),
        row(2, 'Munich', 'Munich', '', 48.67, -98.83, 200),
        row(3, 'L\'Aquila', 'LAquila', '', 42.35, 13.4, 70000),
      ].join('\n'));
      execFileSync(python, ['-B', SEARCH_INDEX_TOOL, source, '--output', database]);
      const provider = sqliteProvider(database);
      const ask = (query: string) => provider(query, new AbortController().signal);
      expect((await ask('munich'))[0].label).toBe('München, BY, DE');
      expect((await ask('München'))[0].label).toBe('München, BY, DE');
      expect((await ask('慕尼黑'))[0].label).toBe('München, BY, DE');
      expect((await ask('L\'Aquila'))[0].label).toBe('L\'Aquila, BY, DE');
      await ask('x\' OR 1=1; DROP TABLE places; --');
      await ask('" OR * NOT (');
      expect(await ask('-12')).toEqual([]); // not taken for an option
      expect((await ask('Munich')).length).toBe(2);
      await expect(sqliteProvider(path.join(folder, 'absent'))('test', new AbortController().signal))
        .rejects.toThrow('No offline index');
    } finally {
      fs.rmSync(folder, { recursive: true, force: true });
    }
  });
});
