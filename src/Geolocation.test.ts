import { describe, expect, test } from 'bun:test';
import { getCurrentLocation } from './Geolocation';

const answer = (body: unknown, status = 200) =>
  (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('getCurrentLocation', () => {
  test('reads ipinfo.io\'s answer', async () => {
    const location = await getCurrentLocation(answer({ loc: '42.5078,1.5211', city: 'Andorra la Vella', country: 'AD' }));
    expect(location).toEqual({ latitude: 42.5078, longitude: 1.5211, source: 'IP (Andorra la Vella, AD)' });
  });

  test('fails cleanly, without coordinates or with an error', async () => {
    await expect(getCurrentLocation(answer({ city: 'x' }))).rejects.toThrow('Location unavailable');
    await expect(getCurrentLocation(answer({ loc: '95,0' }))).rejects.toThrow('Location unavailable');
    await expect(getCurrentLocation(answer({}, 429))).rejects.toThrow('HTTP 429');
  });

  test('keeps terminal escapes out of the place name', async () => {
    const location = await getCurrentLocation(answer({ loc: '1,2', city: '\u001b[2JX', country: 'Y' }));
    expect(location.source).toBe('IP (2JX, Y)');
  });
});
