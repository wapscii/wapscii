/*
  MapSCII - Terminal Map Viewer
  Geolocation Module

  Where you are, roughly: the location of your IP address, from ipinfo.io.
  That service sees your IP address (as every server you connect to does),
  and nothing else is sent.
*/

export interface GeoPosition {
    latitude: number;
    longitude: number;
    accuracy?: number;
    source: string;
}

interface IPInfo {
  loc?: string;
  city?: string;
  country?: string;
}

/** Your approximate location (the city of your IP address). */
export async function getCurrentLocation(fetchImpl: typeof fetch = fetch): Promise<GeoPosition> {
  let data: IPInfo;
  try {
    const response = await fetchImpl('https://ipinfo.io/json', { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    data = await response.json() as IPInfo;
  } catch (error) {
    throw new Error(`Location unavailable: ${error instanceof Error ? error.message : error}`);
  }

  const [latitude, longitude] = (data.loc ?? '').split(',').map(Number);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude) || Math.abs(latitude) > 90 || Math.abs(longitude) > 180) {
    throw new Error('Location unavailable: no location in the answer');
  }
  const place = [data.city, data.country].filter(Boolean).join(', ').replace(/[^\p{L}\p{N} ,.'-]/gu, '');
  return { latitude, longitude, source: `IP (${place || 'unknown'})` };
}
