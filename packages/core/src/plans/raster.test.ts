import { describe, expect, it } from 'vitest';
import { CONFIDENCE_FLOOR, rasterRoomAreas, type RasterRoomInput } from './raster.js';
import type { Ring } from './geometry.js';

/** 1 cm per pixel, so a pixel rectangle's area is readable straight off its sides. */
const MPP = 0.01;

function rect(x: number, y: number, width: number, height: number): Ring {
  return [
    [x, y],
    [x + width, y],
    [x + width, y + height],
    [x, y + height],
  ];
}

function room(code: string, polygon: Ring, confidence = 0.9, kind = 'unit'): RasterRoomInput {
  return { code, room_kind: kind, confidence, polygon };
}

describe('raster rooms', () => {
  it('measures the three flats at 1 cm per pixel', () => {
    const measured = rasterRoomAreas(
      [
        room('A', rect(0, 0, 600, 1000)),
        room('B', rect(1000, 0, 450, 1000)),
        room('C', rect(2000, 0, 600, 300)),
      ],
      MPP,
    );
    expect(measured.map((entry) => entry.areaSqm)).toEqual([60, 45, 18]);
    expect(measured.every((entry) => entry.accepted)).toBe(true);
  });

  it('is winding-agnostic, because a model may return either direction', () => {
    const clockwise = rasterRoomAreas([room('A', rect(0, 0, 600, 1000).slice().reverse())], MPP);
    expect(clockwise[0]?.areaSqm).toBe(60);
  });

  it('stores a low-confidence claim but refuses to accept it', () => {
    const measured = rasterRoomAreas(
      [room('A', rect(0, 0, 600, 300), CONFIDENCE_FLOOR - 0.09)],
      MPP,
    );
    expect(measured[0]?.areaSqm).toBe(18);
    expect(measured[0]?.flags).toContain('low_confidence');
    expect(measured[0]?.accepted).toBe(false);
  });

  it('refuses a bow-tie instead of reporting its cancelling area', () => {
    const bowTie: Ring = [
      [0, 0],
      [600, 300],
      [600, 0],
      [0, 300],
    ];
    const measured = rasterRoomAreas([room('X', bowTie)], MPP);
    expect(measured[0]?.flags).toContain('self_intersecting');
    expect(measured[0]?.accepted).toBe(false);
  });

  it('refuses a ring with no area', () => {
    const line: Ring = [
      [0, 0],
      [600, 0],
      [1200, 0],
    ];
    expect(rasterRoomAreas([room('L', line)], MPP)[0]?.flags).toContain('degenerate');
  });

  it('flags a claim that leaves the image it was traced in', () => {
    const measured = rasterRoomAreas([room('A', rect(0, 0, 600, 1000))], MPP, {
      width: 500,
      height: 500,
    });
    expect(measured[0]?.flags).toContain('outside_image');
    expect(measured[0]?.accepted).toBe(false);
  });

  it('treats an implausible size as a scale problem, not a room', () => {
    const tiny = rasterRoomAreas([room('T', rect(0, 0, 20, 20))], MPP)[0];
    const huge = rasterRoomAreas([room('H', rect(0, 0, 30000, 30000))], MPP)[0];
    expect(tiny?.flags).toContain('too_small_for_a_space');
    expect(huge?.flags).toContain('too_large_for_a_space');
  });

  it('refuses a scale it cannot believe', () => {
    expect(() => rasterRoomAreas([room('A', rect(0, 0, 10, 10))], 0)).toThrow(RangeError);
    expect(() => rasterRoomAreas([room('A', rect(0, 0, 10, 10))], Number.NaN)).toThrow(RangeError);
  });
});
