/**
 * Plan geometry: the arithmetic that turns a drawing into area.
 *
 * This module is deliberately arithmetic only — no model, no heuristic that
 * "feels" right. A vector drawing already contains its own geometry, so the
 * honest pipeline is: read the rings, compute the areas, and reconcile the total
 * against the number a human wrote on the drawing. Everything else (raster
 * segmentation, symbol detection) produces a *guess* and belongs behind a
 * confidence and a human confirmation.
 *
 * Areas are not money, so they are plain numbers with three decimals. But an area
 * becomes rentable, so `reconcileAreas` is the gate that refuses to hand a
 * drawing's geometry to the ledger when it does not add up.
 */

export type Point = readonly [number, number];
export type Ring = readonly Point[];

export const DRAWING_UNITS = ['mm', 'cm', 'm', 'ft'] as const;
export type DrawingUnit = (typeof DRAWING_UNITS)[number];

export const METRES_PER_UNIT: Readonly<Record<DrawingUnit, number>> = {
  mm: 0.001,
  cm: 0.01,
  m: 1,
  ft: 0.3048,
};

/** Twice the signed area (shoelace). Positive = counter-clockwise in a y-up frame. */
export function doubleSignedArea(ring: Ring): number {
  if (ring.length < 3) return 0;
  let sum = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    if (a === undefined || b === undefined) continue;
    sum += a[0] * b[1] - b[0] * a[1];
  }
  return sum;
}

/** Absolute area in squared drawing units. */
export function ringArea(ring: Ring): number {
  return Math.abs(doubleSignedArea(ring)) / 2;
}

export function isClockwise(ring: Ring): boolean {
  return doubleSignedArea(ring) < 0;
}

/** True when the last point repeats the first, which exporters do about half the time. */
export function isClosed(ring: Ring): boolean {
  const first = ring[0];
  const last = ring[ring.length - 1];
  if (first === undefined || last === undefined) return false;
  return first[0] === last[0] && first[1] === last[1];
}

/** Drop the duplicated closing point; the shoelace treats the ring as cyclic anyway. */
export function openRing(ring: Ring): Ring {
  return isClosed(ring) ? ring.slice(0, -1) : ring;
}

export interface Bounds {
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  readonly width: number;
  readonly height: number;
}

export function bounds(ring: Ring): Bounds {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [x, y] of ring) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  if (!Number.isFinite(minX)) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function orientation(a: Point, b: Point, c: Point): number {
  const value = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  if (Math.abs(value) < 1e-12) return 0;
  return value > 0 ? 1 : -1;
}

function onSegment(a: Point, b: Point, c: Point): boolean {
  return (
    Math.min(a[0], b[0]) - 1e-12 <= c[0] &&
    c[0] <= Math.max(a[0], b[0]) + 1e-12 &&
    Math.min(a[1], b[1]) - 1e-12 <= c[1] &&
    c[1] <= Math.max(a[1], b[1]) + 1e-12
  );
}

function segmentsIntersect(p1: Point, p2: Point, p3: Point, p4: Point): boolean {
  const d1 = orientation(p3, p4, p1);
  const d2 = orientation(p3, p4, p2);
  const d3 = orientation(p1, p2, p3);
  const d4 = orientation(p1, p2, p4);
  if (d1 !== d2 && d3 !== d4) return true;
  if (d1 === 0 && onSegment(p3, p4, p1)) return true;
  if (d2 === 0 && onSegment(p3, p4, p2)) return true;
  if (d3 === 0 && onSegment(p1, p2, p3)) return true;
  if (d4 === 0 && onSegment(p1, p2, p4)) return true;
  return false;
}

/**
 * A self-intersecting ring (a bow-tie) has a well-defined shoelace area that is
 * exactly the wrong answer: the overlap cancels. Detecting it is what stops a
 * corrupt polyline from becoming a confident square metre count.
 */
export function selfIntersects(ring: Ring): boolean {
  const points = openRing(ring);
  const n = points.length;
  if (n < 4) return false;
  for (let i = 0; i < n; i += 1) {
    const a1 = points[i];
    const a2 = points[(i + 1) % n];
    if (a1 === undefined || a2 === undefined) continue;
    for (let j = i + 2; j < n; j += 1) {
      // Adjacent edges share a vertex by construction; the wrap pair too.
      if (i === 0 && j === n - 1) continue;
      const b1 = points[j];
      const b2 = points[(j + 1) % n];
      if (b1 === undefined || b2 === undefined) continue;
      if (segmentsIntersect(a1, a2, b1, b2)) return true;
    }
  }
  return false;
}

/** Area in square metres, given the drawing's declared unit. */
export function areaSqm(ring: Ring, unit: DrawingUnit): number {
  const factor = METRES_PER_UNIT[unit];
  return round3(ringArea(ring) * factor * factor);
}

export function round3(value: number): number {
  return Math.round(value * 1000) / 1000;
}

export type ScaleWarning = 'too_large_for_a_space' | 'too_small_for_a_space' | 'degenerate';

/**
 * A scale check that refuses to guess. If a "floor" measures 4 m² or 4,000 m² in
 * the declared unit, the unit is probably wrong — mm read as m, or a detail
 * drawing passed as a floor plan. We warn instead of silently converting, because
 * the conversion would be arithmetically perfect and semantically wrong.
 */
export function scaleWarningsForMetres(
  areaRaw: number,
  widthM: number,
  heightM: number,
): readonly ScaleWarning[] {
  const warnings: ScaleWarning[] = [];
  if (areaRaw <= 0 || widthM <= 0 || heightM <= 0) return ['degenerate'];
  if (areaRaw > 5000 || widthM > 200 || heightM > 200) warnings.push('too_large_for_a_space');
  if (areaRaw < 2 || widthM < 0.6 || heightM < 0.6) warnings.push('too_small_for_a_space');
  return warnings;
}

export function scaleWarnings(ring: Ring, unit: DrawingUnit): readonly ScaleWarning[] {
  const size = bounds(ring);
  const factor = METRES_PER_UNIT[unit];
  // Unrounded on purpose: a room read in the wrong unit rounds to 0.000 m², and a
  // rounded zero would be reported as `degenerate` instead of "your scale is off".
  return scaleWarningsForMetres(ringArea(ring) * factor * factor, size.width * factor, size.height * factor);
}

export type ReconciliationVerdict = 'no_statement' | 'within' | 'outside';

export interface Reconcilable {
  readonly code: string;
  readonly areaSqm: number;
}

export interface Reconciliation {
  readonly sumSqm: number;
  readonly statedSqm: number | null;
  readonly deviationSqm: number | null;
  readonly deviationPct: number | null;
  readonly verdict: ReconciliationVerdict;
  readonly tolerance: number;
}

/**
 * The gate between a parsed drawing and the ledger.
 *
 * `tolerance` defaults to 3% — the manual-takeoff baseline practitioners quote.
 * A drawing whose rooms sum further away than that is either mis-parsed or
 * mis-scaled; either way a human looks at it before any area is used to bill.
 */
export function reconcileAreas(
  rooms: readonly Reconcilable[],
  statedSqm: number | null,
  tolerance = 0.03,
): Reconciliation {
  const sumSqm = round3(rooms.reduce((total, room) => total + room.areaSqm, 0));
  if (statedSqm === null || statedSqm <= 0) {
    return { sumSqm, statedSqm: null, deviationSqm: null, deviationPct: null, verdict: 'no_statement', tolerance };
  }
  const deviationSqm = round3(sumSqm - statedSqm);
  const deviationPct = Math.round((Math.abs(deviationSqm) / statedSqm) * 10000) / 10000;
  return {
    sumSqm,
    statedSqm,
    deviationSqm,
    deviationPct,
    verdict: deviationPct <= tolerance ? 'within' : 'outside',
    tolerance,
  };
}
