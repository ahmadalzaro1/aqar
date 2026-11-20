import { describe, expect, it } from 'vitest';
import {
  areaSqm,
  bounds,
  isClosed,
  reconcileAreas,
  ringArea,
  scaleWarnings,
  selfIntersects,
} from './geometry.js';
import { parseSvgPlan } from './svg.js';

/** A 6 m x 10 m flat, drawn in metres: 60 m² by inspection. */
const RECT_M = [
  [0, 0],
  [6, 0],
  [6, 10],
  [0, 10],
] as const;

describe('plan geometry', () => {
  it('computes the area a human would read off the drawing', () => {
    expect(ringArea(RECT_M)).toBe(60);
    expect(areaSqm(RECT_M, 'm')).toBe(60);
    // The same room drawn in millimetres is the same room.
    const mm = RECT_M.map(([x, y]) => [x * 1000, y * 1000] as const);
    expect(areaSqm(mm, 'mm')).toBe(60);
    expect(ringArea(mm)).toBe(60_000_000);
  });

  it('ignores winding direction', () => {
    const clockwise = [...RECT_M].reverse();
    expect(ringArea(clockwise)).toBe(60);
    expect(areaSqm(clockwise, 'm')).toBe(60);
  });

  it('detects a duplicated closing point without double-counting', () => {
    const closed = [...RECT_M, [0, 0]] as const;
    expect(isClosed(closed)).toBe(true);
    expect(areaSqm(closed, 'm')).toBe(60);
  });

  it('refuses a bow-tie instead of returning its cancelled area', () => {
    const bowtie = [
      [0, 0],
      [4, 4],
      [4, 0],
      [0, 4],
    ] as const;
    expect(selfIntersects(bowtie)).toBe(true);
    expect(selfIntersects(RECT_M)).toBe(false);
  });

  it('reports bounds in drawing units', () => {
    expect(bounds(RECT_M)).toMatchObject({ width: 6, height: 10 });
  });

  it('warns when a declared unit cannot be right, instead of converting silently', () => {
    // A 6x10 metre flat declared as millimetres is 0.06 m².
    const asMm = RECT_M.map(([x, y]) => [x, y] as const);
    expect(scaleWarnings(asMm, 'mm')).toContain('too_small_for_a_space');
    expect(scaleWarnings(RECT_M, 'm')).toEqual([]);
    const huge = RECT_M.map(([x, y]) => [x * 1000, y * 1000] as const);
    expect(scaleWarnings(huge, 'm')).toContain('too_large_for_a_space');
  });

  it('reconciles rooms against the stated area with a 3% gate', () => {
    const rooms = [
      { code: 'A', areaSqm: 60 },
      { code: 'B', areaSqm: 45 },
      { code: 'C', areaSqm: 30 },
    ];
    const within = reconcileAreas(rooms, 137);
    expect(within.sumSqm).toBe(135);
    expect(within.verdict).toBe('within');

    const outside = reconcileAreas(rooms, 140); // 3.57%
    expect(outside.verdict).toBe('outside');
    expect(outside.deviationPct).toBe(0.0357);

    const noStatement = reconcileAreas(rooms, null);
    expect(noStatement.verdict).toBe('no_statement');
    expect(noStatement.statedSqm).toBeNull();
  });

  it('does not call a 3% difference "within" when the total is tiny', () => {
    // 0.4 m² on a 12 m² total is 3.3% — outside, and rightly so.
    const result = reconcileAreas([{ code: 'S', areaSqm: 12.4 }], 12);
    expect(result.verdict).toBe('outside');
  });
});

/** A three-flat floor as an exporter would emit it: two rects and one polygon. */
const FIXTURE_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="20000" height="12000" viewBox="0 0 20000 12000">
  <g id="layer-units">
    <rect id="101" data-label="Flat 101" x="0" y="0" width="6000" height="10000" />
    <rect id="102" data-label="Flat 102" x="6000" y="0" width="4500" height="10000" />
    <polygon id="103" data-label="Flat 103" points="10500,0 16500,0 16500,3000 10500,3000" />
    <polyline id="corridor" data-label="Corridor" points="0,10000 16500,10000 16500,10500 0,10500 0,10000" />
    <path id="stair" data-label="Stair" d="M 17000 0 L 19000 0 L 19000 2000 L 17000 2000 Z" />
    <path id="arc-wall" d="M 0 11000 C 500 11000 500 11500 0 11500 Z" />
    <polygon id="broken" points="1,1 2,2" />
    <polygon id="bowtie" points="0,0 4000,4000 4000,0 0,4000" />
  </g>
</svg>`;

describe('SVG plan reader', () => {
  const parsed = parseSvgPlan(FIXTURE_SVG, 'mm');

  it('reads every closed vector shape the exporter emitted', () => {
    const codes = parsed.shapes.map((shape) => shape.code);
    expect(codes).toEqual(['101', '102', '103', 'corridor', 'stair']);
  });

  it('converts millimetre geometry into square metres', () => {
    const byCode = new Map(parsed.shapes.map((shape) => [shape.code, shape.areaSqm]));
    expect(byCode.get('101')).toBe(60); // 6 x 10 m
    expect(byCode.get('102')).toBe(45); // 4.5 x 10 m
    expect(byCode.get('103')).toBe(18); // 6 x 3 m
    expect(byCode.get('corridor')).toBe(8.25);
    expect(byCode.get('stair')).toBe(4);
  });

  it('carries the label the architect wrote, so the console can show it', () => {
    expect(parsed.shapes.find((shape) => shape.code === '101')?.label).toBe('Flat 101');
  });

  it('refuses curves and malformed shapes rather than approximating them', () => {
    const reasons = new Map(parsed.skipped.map((skip) => [skip.code, skip.reason]));
    expect(reasons.get('arc-wall')).toBe('unsupported_curve');
    expect(reasons.get('broken')).toBe('not_enough_points');
    expect(reasons.get('bowtie')).toBe('self_intersecting');
  });

  it('reconciles the three flats against a stated total', () => {
    const units = parsed.shapes.filter((shape) => ['101', '102', '103'].includes(shape.code));
    const result = reconcileAreas(units, 123);
    expect(result.sumSqm).toBe(123); // 60 + 45 + 18
    expect(result.verdict).toBe('within');
  });

  it('handles relative path commands, which half the exporters emit', () => {
    const relative = `<svg><path id="r" d="m 0 0 l 6000 0 l 0 10000 l -6000 0 z"/></svg>`;
    const result = parseSvgPlan(relative, 'mm');
    expect(result.shapes[0]?.areaSqm).toBe(60);
  });
});
