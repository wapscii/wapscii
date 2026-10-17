// Type declarations for modules without TypeScript definitions

declare module 'x256' {
  function x256(rgb: [number, number, number]): number;
  export default x256;
}

declare module 'bidi-js' {
  interface BidiLevels {
    levels: Uint8Array;
    paragraphs: Array<{ start: number; end: number; level: number }>;
  }

  interface BidiApi {
    getEmbeddingLevels(text: string, explicitDirection?: 'ltr' | 'rtl'): BidiLevels;
    getReorderSegments(text: string, embeddingLevels: BidiLevels, start?: number, end?: number): Array<[number, number]>;
    getMirroredCharactersMap(text: string, embeddingLevels: BidiLevels, start?: number, end?: number): Map<number, string>;
  }

  export default function bidiFactory(): BidiApi;
}

declare module 'arabic-persian-reshaper' {
  export const ArabicShaper: {
    convertArabic(text: string): string;
    convertArabicBack(text: string): string;
  };
  export const PersianShaper: {
    convertPersian(text: string): string;
    convertPersianBack(text: string): string;
  };
  const reshaper: { ArabicShaper: typeof ArabicShaper; PersianShaper: typeof PersianShaper };
  export default reshaper;
}

declare module 'pngjs' {
  export class PNG {
    width: number;
    height: number;
    data: Buffer;
    static sync: {
      read(buffer: Buffer): PNG;
    };
  }
}

declare module 'simplify-js' {
  interface Point {
    x: number;
    y: number;
  }
  function simplify(points: Point[], tolerance?: number, highQuality?: boolean): Point[];
  export default simplify;
}

declare module 'bresenham' {
  interface Point {
    x: number;
    y: number;
  }
  function bresenham(
    x0: number,
    y0: number,
    x1: number,
    y1: number,
    callback?: (x: number, y: number) => void
  ): Point[];
  export default bresenham;
}

declare module '@mapbox/vector-tile' {
  import Pbf from 'pbf';

  export interface VectorTileFeatureProperties {
    [key: string]: string | number | boolean | undefined;
    $type?: string;
    name?: string;
    name_en?: string;
    house_num?: string;
    localrank?: number;
    scalerank?: number;
  }

  export interface VectorTileFeature {
    type: number;
    id?: number;
    properties: VectorTileFeatureProperties;
    extent: number;
    loadGeometry(): Array<Array<{ x: number; y: number }>>;
  }

  export interface VectorTileLayer {
    version: number;
    name: string;
    extent: number;
    length: number;
    feature(index: number): VectorTileFeature;
  }

  export class VectorTile {
    layers: Record<string, VectorTileLayer>;
    constructor(pbf: Pbf);
  }
}

declare module 'earcut' {
  function earcut(vertices: number[], holes?: number[], dimensions?: number): number[];
  export default earcut;
}

declare module 'ngeohash' {
  interface DecodedGeohash {
    latitude: number;
    longitude: number;
    error: { latitude: number; longitude: number };
  }
  const ngeohash: {
    decode(hash: string): DecodedGeohash;
    encode(latitude: number, longitude: number, precision?: number): string;
  };
  export default ngeohash;
}

declare module '@mapbox/mbtiles' {
  interface MBTilesInfo {
    minzoom?: number;
    maxzoom?: number;
    center?: [number, number, number];
    bounds?: [number, number, number, number];
    name?: string;
    description?: string;
    format?: string;
  }

  interface MBTilesDatabase {
    all(sql: string, callback: (err: Error | null, rows: Array<{ max_zoom?: number }>) => void): void;
  }

  class MBTiles {
    _db: MBTilesDatabase;
    constructor(path: string, callback: (err: Error | null, mbtiles: MBTiles) => void);
    getTile(z: number, x: number, y: number, callback: (err: Error | null, data: Buffer, headers: Record<string, string>) => void): void;
    getInfo(callback: (err: Error | null, info: MBTilesInfo) => void): void;
  }

  export default MBTiles;
}

declare module 'terminal-kit' {
  export interface Terminal {
    width: number;
    height: number;
    grabInput(options: { mouse: string } | boolean): void;
    on(event: 'key', callback: (name: string, matches: string[], data: KeyData) => void): void;
    on(event: 'mouse', callback: (name: string, data: MouseData) => void): void;
    on(event: 'resize', callback: (width: number, height: number) => void): void;
    off(event: 'key', callback: (name: string, matches: string[], data: KeyData) => void): void;
    off(event: 'mouse', callback: (name: string, data: MouseData) => void): void;
    off(event: 'resize', callback: (width: number, height: number) => void): void;
    // Generic event handlers for flexibility
    on(event: string, callback: (...args: (string | number | MouseData | KeyData | string[])[]) => void): void;
    off(event: string, callback: (...args: (string | number | MouseData | KeyData | string[])[]) => void): void;
    noFormat(text: string): void;
    processExit(code: number): void;
    // Cursor and display methods
    moveTo(x: number, y: number): Terminal;
    eraseLine(): Terminal;
    saveCursor(): Terminal;
    restoreCursor(): Terminal;
    styleReset(): Terminal;
    // Color/style chainable methods
    cyan(text: string): Terminal;
    gray(text: string): Terminal;
    white(text: string): Terminal;
    blue(text: string): Terminal;
    dim(text: string): Terminal;
    bgGray: Terminal;
    bgBlack: Terminal;
    // Allow terminal to be called as a function for raw text output
    (text: string): Terminal;
  }

  export interface KeyData {
    isCharacter: boolean;
    codepoint?: number;
    code?: Buffer;
  }

  export interface MouseData {
    x: number;
    y: number;
    left?: boolean;
    right?: boolean;
    middle?: boolean;
    shift?: boolean;
    ctrl?: boolean;
    alt?: boolean;
  }

  const terminal: Terminal;
  export { terminal };
  interface GuessedTerminal {
    generic?: string;
    appId?: string;
    safe?: boolean;
  }
  const terminalKit: {
    terminal: Terminal;
    guessTerminal(unpipe?: boolean): GuessedTerminal;
    createTerminal(options: {
      stdin: NodeJS.ReadableStream;
      stdout: NodeJS.WritableStream;
      stderr: NodeJS.WritableStream;
      generic: string;
      appId?: string;
      isTTY: boolean;
      isSSH: boolean;
      processSigwinch: boolean;
    }): Terminal;
  };
  export default terminalKit;
}
