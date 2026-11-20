/**
 * The raster half of the drawing lane.
 *
 * Geometry that came from a file is arithmetic. Geometry that came from pixels is
 * testimony: a segmentation model asserts "this region is a bedroom" and it can be
 * wrong in ways no amount of arithmetic fixes. So this module never decides that a
 * room exists — it decides what a claim *measures*, and whether the claim is
 * coherent enough to show a human.
 *
 * Three rules, and they are the whole design:
 *   * every raster room carries a confidence, and the database refuses one that
 *     does not (`plan_rooms_confidence_ck`);
 *   * a room can be stored without being accepted, because "the model found
 *     something at 0.31" is information a reviewer needs;
 *   * nothing here is confirmed. `confirmed_by` is a person's name or it is null.
 */

import { bounds, ringArea, selfIntersects, scaleWarningsForMetres, type Ring, type ScaleWarning } from './geometry.js';

export const RASTER_SOURCES = ['cubicas5k', 'mmdetection', 'manual_tracing'] as const;
export type RasterSource = (typeof RASTER_SOURCES)[number];

/**
 * Below this, the claim is recorded and refused. Half is not a scientific number:
 * it is the point past which a reviewer should be looking at the overlay instead of
 * trusting the row.
 */
export const CONFIDENCE_FLOOR = 0.5;

export interface RasterRoomInput {
  readonly code: string;
  readonly room_kind: string;
  readonly confidence: number;
  /** Ring in image pixels. Pixel origin is top-left, but area does not care. */
  readonly polygon: Ring;
  readonly label?: string | null;
}

export type RasterFlag =
  | ScaleWarning
  | 'self_intersecting'
  | 'outside_image'
  | 'low_confidence';

export interface RasterRoomArea {
  readonly code: string;
  readonly room_kind: string;
  readonly confidence: number;
  readonly areaSqm: number;
  readonly flags: readonly RasterFlag[];
  /** True when the claim is coherent enough to store as a room. */
  readonly accepted: boolean;
}

export interface ImageSize {
  readonly width: number;
  readonly height: number;
}

/** Flags that make a claim unstoreable rather than merely doubtful. */
const FATAL: ReadonlySet<RasterFlag> = new Set<RasterFlag>([
  'degenerate',
  'self_intersecting',
  'outside_image',
  'low_confidence',
]);

/**
 * Measures every claim in square metres.
 *
 * The scale is the caller's assertion — metres per pixel, from a calibration line on
 * the scan or from the scanner's own DPI. It is required and it is not guessed: a
 * raster floor plan has no intrinsic size, and inventing one produces a confident
 * number that is 30% wrong.
 */
export function rasterRoomAreas(
  rooms: readonly RasterRoomInput[],
  metresPerPixel: number,
  image?: ImageSize,
): RasterRoomArea[] {
  if (!Number.isFinite(metresPerPixel) || metresPerPixel <= 0) {
    throw new RangeError('metresPerPixel must be a positive, finite number');
  }
  return rooms.map((room) => {
    const flags: RasterFlag[] = [];
    const size = bounds(room.polygon);
    const widthM = size.width * metresPerPixel;
    const heightM = size.height * metresPerPixel;
    const areaRaw = ringArea(room.polygon) * metresPerPixel * metresPerPixel;

    for (const warning of scaleWarningsForMetres(areaRaw, widthM, heightM)) flags.push(warning);
    if (selfIntersects(room.polygon)) flags.push('self_intersecting');
    if (image !== undefined) {
      const outside =
        size.minX < 0 || size.minY < 0 || size.maxX > image.width || size.maxY > image.height;
      if (outside) flags.push('outside_image');
    }
    if (!(room.confidence >= CONFIDENCE_FLOOR)) flags.push('low_confidence');

    return {
      code: room.code,
      room_kind: room.room_kind,
      confidence: room.confidence,
      areaSqm: Math.round(areaRaw * 1000) / 1000,
      flags,
      accepted: !flags.some((flag) => FATAL.has(flag)),
    };
  });
}
