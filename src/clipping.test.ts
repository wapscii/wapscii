import { describe, expect, test } from 'bun:test';
import { dropTileClosureSegments } from './clipping';

describe('dropTileClosureSegments', () => {
  test('keeps a polygon\'s own edges and drops the ones clipping added along the tile border', () => {
    // a wood cut by the right tile border at x = 4096
    const ring = [{ x: 100, y: 100 }, { x: 4096, y: 100 }, { x: 4096, y: 900 }, { x: 100, y: 900 }, { x: 100, y: 100 }];
    expect(dropTileClosureSegments(ring, 4096)).toEqual([
      [{ x: 100, y: 100 }, { x: 4096, y: 100 }],
      [{ x: 4096, y: 900 }, { x: 100, y: 900 }, { x: 100, y: 100 }],
    ]);
  });

  test('leaves rings inside the tile whole', () => {
    const ring = [{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 10 }];
    expect(dropTileClosureSegments(ring, 4096)).toEqual([[{ x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 10 }]]);
  });
});
