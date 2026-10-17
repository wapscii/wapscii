/*
  MapSCII - Terminal Map Viewer
  by Michael Strassburger <codepoet@cpan.org>

  Configuration module
*/

import type { SearchProvider } from './search';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

// Get directory path for style file resolution
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface MouseEvent {
  x: number;
  y: number;
  button?: string;
  action?: string;
}

export interface KeyEvent {
  name: string;
}

export interface LayerConfig {
  margin?: number;
  cluster?: boolean;
}

export interface CellGeometry {
  width: number;
  height: number;
}

export type ColorMode = 'xterm-256' | 'ansi-16';
export type TerrainMode = 'elevation' | 'hillshade';

export interface TerrainConfig {
  enabled: boolean;
  mode: TerrainMode;
  source: string;
  minZoom: number;
  maxZoom: number;
  opacity: number;
  azimuth: number;
  altitude: number;
}

export interface MapsciiConfig {
  language: string;
  source: string;
  styleFile: string;
  initialZoom: number | null;
  maxZoom: number;
  zoomStep: number;
  initialLat: number;
  initialLon: number;
  simplifyPolylines: boolean;
  useBraille: boolean;
  colorMode: ColorMode;
  useTileWorker: boolean;
  persistDownloadedTiles: boolean;
  // Cache the tiles of servers on this computer (localhost) too
  cacheLocalSources: boolean;
  tileRange: number;
  projectSize: number;
  labelMargin: number;
  labelMaxWidth: number;
  showAttribution: boolean;
  attribution: string;
  ansiScreenshotFile: string | null;
  exitAfterAnsiScreenshot: boolean;
  terrain: TerrainConfig;
  layers: Record<string, LayerConfig>;
  input: NodeJS.ReadStream;
  output: NodeJS.WriteStream;
  headless: boolean;
  delimeter: string;
  poiMarker: string;
  size?: { width?: number; height?: number };
  mouseCallback?: (event: MouseEvent) => boolean;
  keyCallback?: (key: KeyEvent) => boolean;
  quitCallback?: () => void;
  onUpdate?: () => void;
  // Cell geometry for aspect ratio support (Issue #26)
  cellGeometry: CellGeometry;
  // Enable current location feature (Issue #2)
  enableLocation: boolean;
  // Disable text labels and POI markers for minimal rendering
  noLabels: boolean;
  // Mouse reporting: drag, wheel zoom, hover (off leaves the mouse to the terminal)
  useMouse: boolean;
  // Offline place index (tools/maps-search-index), asked while typing too
  searchDatabase: string | null;
  // Ask Nominatim when Enter is pressed
  onlineSearch: boolean;
  // Replaces both of them (library use)
  searchProvider?: SearchProvider;
  // For people who aren't on this computer (telnet, SSH): no keys that write
  // files, empty the shared cache or look up where the server is
  restricted: boolean;
}

// Used unless the tile source names its own (in its TileJSON)
export const DEFAULT_ATTRIBUTION = '(c) OpenStreetMap contributors';

const config: MapsciiConfig = {
  language: 'en',

  // OpenFreeMap's TileJSON, which names the current tile set (OpenMapTiles)
  source: 'https://tiles.openfreemap.org/planet',

  // Style file path - resolve from src directory
  styleFile: join(__dirname, '..', 'styles', 'dark.json'),

  initialZoom: null,
  maxZoom: 18,
  zoomStep: 0.2,

  // Default coordinates (Berlin)
  initialLat: 52.51298,
  initialLon: 13.42012,

  simplifyPolylines: false,

  useBraille: true,
  colorMode: 'xterm-256',
  // Off-thread tile parsing (opt-in via --tileWorker): the worker keeps the
  // main thread free but structured-cloning parsed geometry makes each tile
  // take ~3x longer to appear, so main-thread parsing is the better default.
  useTileWorker: false,

  // Downloaded files get persisted in ~/.cache/mapscii
  persistDownloadedTiles: true,
  cacheLocalSources: false,

  tileRange: 14,
  projectSize: 256,

  labelMargin: 5,
  labelMaxWidth: 24,

  showAttribution: true,
  attribution: DEFAULT_ATTRIBUTION,
  ansiScreenshotFile: null,
  exitAfterAnsiScreenshot: false,

  terrain: {
    enabled: false,
    mode: 'elevation',
    source: 'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
    minZoom: 0,
    maxZoom: 15,
    opacity: 0.65,
    azimuth: 315,
    altitude: 45,
  },

  layers: {
    housenumber: {
      margin: 4
    },
    poi: {
      cluster: true,
      margin: 5,
    },
    place: {
      cluster: true,
    }
  },

  input: process.stdin,
  output: process.stdout,

  headless: false,

  delimeter: '\r\n',

  poiMarker: '◉',

  // Cell geometry for braille rendering (2x4 by default)
  cellGeometry: {
    width: 2,
    height: 4,
  },

  // Location feature disabled by default for privacy
  enableLocation: false,

  // Labels and POI markers enabled by default
  noLabels: false,

  useMouse: true,

  searchDatabase: null,
  onlineSearch: true,

  restricted: false,
};

export function createMapsciiConfig(overrides: Partial<MapsciiConfig> = {}): MapsciiConfig {
  return {
    ...config,
    ...overrides,
    layers: {
      ...config.layers,
      ...(overrides.layers ?? {}),
    },
    cellGeometry: {
      ...config.cellGeometry,
      ...(overrides.cellGeometry ?? {}),
    },
    terrain: {
      ...config.terrain,
      ...(overrides.terrain ?? {}),
    },
    size: overrides.size
      ? { ...overrides.size }
      : (config.size ? { ...config.size } : undefined),
  };
}

export function applyMapsciiConfig(next: MapsciiConfig): void {
  Object.assign(config, next);
}

export default config;
