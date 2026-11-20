import { type DrawingUnit, type Point, type Ring, areaSqm, openRing, selfIntersects } from './geometry.js';

/**
 * A bounded vector reader for the subset of SVG an architectural exporter
 * actually emits: `<rect>`, `<polygon>`, closed `<polyline>`, and `<path>` built
 * from absolute `M/L/H/V/Z` commands.
 *
 * What it does NOT do is guess. A path with a curve (`C`, `Q`, `A`) is reported as
 * skipped rather than flattened into an approximation, because a bezier room is
 * not a room — it is a fixture or a title block, and turning it into 60.3 m² of
 * confident nonsense is how a parse becomes a billing error.
 */

export interface PlanShape {
  readonly code: string;
  readonly label: string | null;
  readonly ring: Ring;
  readonly areaSqm: number;
  readonly sourceElement: 'rect' | 'polygon' | 'polyline' | 'path';
}

export type SvgSkipReason =
  | 'unsupported_curve'
  | 'unclosed_polyline'
  | 'not_enough_points'
  | 'unparseable_numbers'
  | 'self_intersecting'
  | 'degenerate_area';

export interface SvgSkipped {
  readonly code: string;
  readonly sourceElement: string;
  readonly reason: SvgSkipReason;
}

export interface SvgParseResult {
  readonly shapes: readonly PlanShape[];
  readonly skipped: readonly SvgSkipped[];
}

const TAG_RE = /<(rect|polygon|polyline|path)\b([^>]*?)\/?>/gi;
const ATTR_RE = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*"([^"]*)"|([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*=\s*'([^']*)'/g;

function attributesOf(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(ATTR_RE)) {
    const name = (match[1] ?? match[3] ?? '').toLowerCase();
    const value = match[2] ?? match[4] ?? '';
    if (name !== '') attrs[name] = value;
  }
  return attrs;
}

function numbers(value: string | undefined): number[] {
  if (value === undefined) return [];
  const out: number[] = [];
  for (const token of value.trim().split(/[\s,]+/)) {
    if (token === '') continue;
    const n = Number(token);
    if (!Number.isFinite(n)) return [];
    out.push(n);
  }
  return out;
}

function pairs(values: readonly number[]): Point[] {
  const points: Point[] = [];
  for (let i = 0; i + 1 < values.length; i += 2) {
    const x = values[i];
    const y = values[i + 1];
    if (x === undefined || y === undefined) continue;
    points.push([x, y]);
  }
  return points;
}

const PATH_TOKEN_RE = /([MmLlHhVvZzCcSsQqTtAa])|(-?\d*\.?\d+(?:[eE][-+]?\d+)?)/g;

/** Absolute M/L/H/V/Z only. Relative commands are normalised; curves are refused. */
function pathToRing(d: string): { ring: Ring } | { reason: SvgSkipReason } {
  const tokens: { command: string | null; value: number | null }[] = [];
  for (const match of d.matchAll(PATH_TOKEN_RE)) {
    if (match[1] !== undefined) tokens.push({ command: match[1], value: null });
    else if (match[2] !== undefined) tokens.push({ command: null, value: Number(match[2]) });
  }

  const ring: Point[] = [];
  let i = 0;
  let cx = 0;
  let cy = 0;
  let startX = 0;
  let startY = 0;
  let mode: 'absolute' | 'relative' = 'absolute';

  while (i < tokens.length) {
    const head = tokens[i];
    if (head === undefined) break;
    if (head.command === null) return { reason: 'unparseable_numbers' };
    const command = head.command;
    if ('CcSsQqTtAa'.includes(command)) return { reason: 'unsupported_curve' };
    mode = command === command.toLowerCase() ? 'relative' : 'absolute';
    const upper = command.toUpperCase();
    i += 1;

    const readPoint = (): Point | null => {
      const x = tokens[i];
      const y = tokens[i + 1];
      if (x === undefined || y === undefined || x.value === null || y.value === null) return null;
      i += 2;
      const px = mode === 'relative' ? cx + x.value : x.value;
      const py = mode === 'relative' ? cy + y.value : y.value;
      return [px, py];
    };
    const readNumber = (): number | null => {
      const token = tokens[i];
      if (token === undefined || token.value === null) return null;
      i += 1;
      return token.value;
    };

    if (upper === 'Z') {
      cx = startX;
      cy = startY;
      continue;
    }
    if (upper === 'M') {
      const point = readPoint();
      if (point === null) return { reason: 'unparseable_numbers' };
      [cx, cy] = point;
      startX = cx;
      startY = cy;
      ring.push(point);
      // Extra coordinate pairs after M are implicit L in the SVG spec.
      let next = readPoint();
      while (next !== null) {
        [cx, cy] = next;
        ring.push(next);
        next = readPoint();
      }
      continue;
    }
    if (upper === 'L') {
      let point = readPoint();
      if (point === null) return { reason: 'unparseable_numbers' };
      while (point !== null) {
        [cx, cy] = point;
        ring.push(point);
        point = readPoint();
      }
      continue;
    }
    if (upper === 'H') {
      let value = readNumber();
      if (value === null) return { reason: 'unparseable_numbers' };
      while (value !== null) {
        cx = mode === 'relative' ? cx + value : value;
        ring.push([cx, cy]);
        value = readNumber();
      }
      continue;
    }
    if (upper === 'V') {
      let value = readNumber();
      if (value === null) return { reason: 'unparseable_numbers' };
      while (value !== null) {
        cy = mode === 'relative' ? cy + value : value;
        ring.push([cx, cy]);
        value = readNumber();
      }
      continue;
    }
    return { reason: 'unparseable_numbers' };
  }

  return { ring: openRing(ring) };
}

export function parseSvgPlan(svg: string, unit: DrawingUnit): SvgParseResult {
  const shapes: PlanShape[] = [];
  const skipped: SvgSkipped[] = [];

  for (const match of svg.matchAll(TAG_RE)) {
    const element = (match[1] ?? '').toLowerCase() as PlanShape['sourceElement'];
    const attrs = attributesOf(match[2] ?? '');
    const code = attrs['id'] ?? attrs['data-code'] ?? `${element}-${shapes.length + skipped.length + 1}`;
    const label = attrs['data-label'] ?? attrs['aria-label'] ?? null;

    // Every branch below either assigns a ring or `continue`s, so an initial value
    // would be dead — and a dead default is how a null sneaks into `ring.length`.
    let ring: Ring;

    if (element === 'rect') {
      const x = Number(attrs['x'] ?? '0');
      const y = Number(attrs['y'] ?? '0');
      const width = Number(attrs['width'] ?? '0');
      const height = Number(attrs['height'] ?? '0');
      if (![x, y, width, height].every(Number.isFinite)) {
        skipped.push({ code, sourceElement: element, reason: 'unparseable_numbers' });
        continue;
      }
      ring = [
        [x, y],
        [x + width, y],
        [x + width, y + height],
        [x, y + height],
      ];
    } else if (element === 'polygon' || element === 'polyline') {
      const values = numbers(attrs['points']);
      if (values.length < 6) {
        skipped.push({ code, sourceElement: element, reason: 'not_enough_points' });
        continue;
      }
      const points = pairs(values);
      const closed = element === 'polygon' || (points[0]?.[0] === points[points.length - 1]?.[0] && points[0]?.[1] === points[points.length - 1]?.[1]);
      if (!closed) {
        skipped.push({ code, sourceElement: element, reason: 'unclosed_polyline' });
        continue;
      }
      ring = openRing(points);
    } else {
      const result = pathToRing(attrs['d'] ?? '');
      if ('reason' in result) {
        skipped.push({ code, sourceElement: element, reason: result.reason });
        continue;
      }
      ring = result.ring;
    }

    if (ring.length < 3) {
      skipped.push({ code, sourceElement: element, reason: 'not_enough_points' });
      continue;
    }
    if (selfIntersects(ring)) {
      skipped.push({ code, sourceElement: element, reason: 'self_intersecting' });
      continue;
    }
    const area = areaSqm(ring, unit);
    if (area <= 0) {
      skipped.push({ code, sourceElement: element, reason: 'degenerate_area' });
      continue;
    }
    shapes.push({ code, label, ring, areaSqm: area, sourceElement: element });
  }

  return { shapes, skipped };
}
