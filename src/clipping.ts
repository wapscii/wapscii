/*
  MapSCII - Terminal Map Viewer

  Shared screen-space clipping helpers used by both the flat Renderer and the Globe.

  Clipping before rasterization is essential: projected coordinates can be
  millions of pixels off-screen (especially on the globe at high zoom), and
  Bresenham/scanline rasterization cost scales with the unclipped size.
*/

export interface ClipPoint {
  x: number;
  y: number;
}

const INSIDE = 0;
const LEFT = 1;
const RIGHT = 2;
const TOP = 4;
const BOTTOM = 8;

/**
 * Cohen–Sutherland segment clipping against an axis-aligned rectangle.
 * Returns the clipped segment with rounded integer coordinates, or null if
 * the segment lies entirely outside the rectangle.
 */
export function clipSegmentToRect(
  p0: ClipPoint,
  p1: ClipPoint,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): [ClipPoint, ClipPoint] | null {
  const outCode = (x: number, y: number) => {
    let code = INSIDE;
    if (x < minX) code |= LEFT;
    else if (x > maxX) code |= RIGHT;
    if (y < minY) code |= TOP;
    else if (y > maxY) code |= BOTTOM;
    return code;
  };

  let x0 = p0.x, y0 = p0.y;
  let x1 = p1.x, y1 = p1.y;

  let c0 = outCode(x0, y0);
  let c1 = outCode(x1, y1);

  while (true) {
    if ((c0 | c1) === 0) {
      return [
        { x: Math.round(x0), y: Math.round(y0) },
        { x: Math.round(x1), y: Math.round(y1) },
      ];
    }
    if ((c0 & c1) !== 0) {
      return null;
    }

    const cOut = c0 !== 0 ? c0 : c1;

    let x = 0, y = 0;

    if (cOut & TOP) {
      const dy = y1 - y0;
      if (dy === 0) return null;
      x = x0 + (x1 - x0) * (minY - y0) / dy;
      y = minY;
    } else if (cOut & BOTTOM) {
      const dy = y1 - y0;
      if (dy === 0) return null;
      x = x0 + (x1 - x0) * (maxY - y0) / dy;
      y = maxY;
    } else if (cOut & RIGHT) {
      const dx = x1 - x0;
      if (dx === 0) return null;
      y = y0 + (y1 - y0) * (maxX - x0) / dx;
      x = maxX;
    } else if (cOut & LEFT) {
      const dx = x1 - x0;
      if (dx === 0) return null;
      y = y0 + (y1 - y0) * (minX - x0) / dx;
      x = minX;
    }

    if (cOut === c0) {
      x0 = x; y0 = y;
      c0 = outCode(x0, y0);
    } else {
      x1 = x; y1 = y;
      c1 = outCode(x1, y1);
    }
  }
}

/**
 * Clip a polyline to a rectangle, splitting it into visible parts.
 * Prevents "shortcut chords" when segments cross offscreen areas.
 */
export function clipPolylineToRect(
  pts: ClipPoint[],
  minX: number,
  minY: number,
  maxX: number,
  maxY: number
): ClipPoint[][] {
  const out: ClipPoint[][] = [];
  let current: ClipPoint[] = [];

  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];

    const clipped = clipSegmentToRect(a, b, minX, minY, maxX, maxY);
    if (!clipped) {
      if (current.length >= 2) out.push(current);
      current = [];
      continue;
    }

    const [c0, c1] = clipped;

    // start a new part or continue current one
    if (current.length === 0) {
      current.push(c0, c1);
    } else {
      const last = current[current.length - 1];
      if (last.x === c0.x && last.y === c0.y) {
        current.push(c1);
      } else {
        if (current.length >= 2) out.push(current);
        current = [c0, c1];
      }
    }
  }

  if (current.length >= 2) out.push(current);

  // remove consecutive duplicates that clipping can introduce
  return out.map((part) => {
    const cleaned: ClipPoint[] = [];
    for (const p of part) {
      const prev = cleaned[cleaned.length - 1];
      if (!prev || prev.x !== p.x || prev.y !== p.y) cleaned.push(p);
    }
    return cleaned;
  }).filter((part) => part.length >= 2);
}

/**
 * When a polygon is clipped to a tile, the clipping algorithm often introduces
 * artificial segments along the tile boundary to "close" rings.
 * If we render polygon outlines by stroking these rings, we get visible tile seams.
 *
 * Fix: for polygon rings rendered as lines, drop border segments created by clipping.
 *
 * Important: vector-tile coords are usually in [0, extent-1], not [0, extent].
 * So we treat a 1-unit band near borders as "tile edge".
 */
export function dropTileClosureSegments(ring: ClipPoint[], extent: number): ClipPoint[][] {
  if (!ring || ring.length < 2) return [];

  // Remove explicit duplicate closing coordinate if present.
  // We handle closure ourselves via wrap-around (i -> i+1 mod n).
  const pts = ring.slice();
  const first = pts[0];
  const last = pts[pts.length - 1];
  if (first && last && first.x === last.x && first.y === last.y) {
    pts.pop();
  }

  const n = pts.length;
  if (n < 2) return [];

  // Vector-tile coords are typically integer in [0, extent-1].
  // Treat a small band as "on the edge" so we also catch extent-1.
  const EDGE_TOL = 1; // tile-coordinate units
  const onLeft = (p: ClipPoint) => p.x <= EDGE_TOL;
  const onTop = (p: ClipPoint) => p.y <= EDGE_TOL;
  const onRight = (p: ClipPoint) => p.x >= (extent - EDGE_TOL);
  const onBottom = (p: ClipPoint) => p.y >= (extent - EDGE_TOL);

  // Only drop segments that are clearly "tile closure":
  // - axis-aligned
  // - both endpoints lie on the SAME tile border side
  const isTileClosureSegment = (a: ClipPoint, b: ClipPoint): boolean => {
    // Degenerate segment: ignore it (it would just spam pixels)
    if (a.x === b.x && a.y === b.y) return true;

    const horizontal = a.y === b.y;
    const vertical = a.x === b.x;

    if (horizontal) {
      if ((onTop(a) && onTop(b)) || (onBottom(a) && onBottom(b))) return true;
    }
    if (vertical) {
      if ((onLeft(a) && onLeft(b)) || (onRight(a) && onRight(b))) return true;
    }
    return false;
  };

  const parts: ClipPoint[][] = [];
  let current: ClipPoint[] = [];

  for (let i = 0; i < n; i++) {
    const a = pts[i];
    const b = pts[(i + 1) % n];

    if (current.length === 0) current.push(a);

    if (isTileClosureSegment(a, b)) {
      if (current.length >= 2) parts.push(current);
      current = [];
    } else {
      current.push(b);
    }
  }

  if (current.length >= 2) parts.push(current);

  // Clean consecutive duplicates that can appear due to wrap/breaks
  return parts
    .map((part) => {
      const cleaned: ClipPoint[] = [];
      for (const p of part) {
        const prev = cleaned[cleaned.length - 1];
        if (!prev || prev.x !== p.x || prev.y !== p.y) cleaned.push(p);
      }
      return cleaned;
    })
    .filter((part) => part.length >= 2);
}
