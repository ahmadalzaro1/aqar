import { z } from 'zod';

/**
 * The wire contract between `tools/plan-extractor` (Python) and the worker.
 *
 * It is frozen here rather than in the worker because the sidecar is a separate
 * process in a separate language: the only thing keeping the two honest is a
 * schema both sides are tested against. The Python program has its own tests; this
 * schema is what refuses a sidecar that drifted.
 */

export const planFormatSchema = z.enum(['dxf', 'pdf_vector']);
export type PlanFormat = z.infer<typeof planFormatSchema>;

export const planShapeSchema = z.object({
  code: z.string().min(1),
  layer: z.string().nullable().optional(),
  ring: z.array(z.tuple([z.number(), z.number()])).min(3),
  area_units: z.number().nonnegative(),
  area_sqm: z.number().positive().nullable(),
  area_sqm_unscaled_points2: z.number().nonnegative().optional(),
  room_kind: z.string().min(1),
  label: z.string().nullable(),
  labels: z.array(z.string()).optional(),
});
export type PlanShape = z.infer<typeof planShapeSchema>;

export const planTextSchema = z.object({
  text: z.string(),
  x: z.number(),
  y: z.number(),
  assigned_to: z.string().nullable().optional(),
});
export type PlanText = z.infer<typeof planTextSchema>;

export const planWarningSchema = z.object({ reason: z.string() }).catchall(z.unknown());
export type PlanWarning = z.infer<typeof planWarningSchema>;

export const planExtractionSchema = z.object({
  engine: z.string().min(1),
  engine_version: z.string().min(1),
  format: planFormatSchema,
  unit: z.string().min(1),
  unit_source: z.string().min(1),
  mm_per_unit: z.number().positive(),
  scale_known: z.boolean(),
  page: z.object({ width_pt: z.number(), height_pt: z.number(), pages: z.number() }).optional(),
  shapes: z.array(planShapeSchema),
  texts: z.array(planTextSchema),
  warnings: z.array(planWarningSchema),
  /**
   * Which reading the extractor used: closed rings as drawn, or the faces its wall
   * network encloses. Defaulted rather than required so the PDF lane — which only
   * ever has rings — did not have to change.
   */
  strategy: z.enum(['rings', 'walls']).default('rings'),
  stats: z.record(z.string(), z.number()),
});
export type PlanExtraction = z.infer<typeof planExtractionSchema>;

export const planExtractorErrorSchema = z.object({
  error: z.string().min(1),
  detail: z.string().optional(),
});
export type PlanExtractorError = z.infer<typeof planExtractorErrorSchema>;

export const planExtractRequestSchema = z.object({
  format: z.enum(['dxf', 'pdf', 'dwg']),
  filePath: z.string().min(1),
  unit: z.enum(['mm', 'cm', 'm', 'ft', 'in']).optional(),
  /** `x1,y1,x2,y2,metres` — the one thing a PDF cannot tell us by itself. */
  calibrate: z.string().regex(/^-?[\d.]+,-?[\d.]+,-?[\d.]+,-?[\d.]+,?[\d.]+$/).optional(),
});
export type PlanExtractRequest = z.infer<typeof planExtractRequestSchema>;

/* ------------------------------------------------------------------ raster ---- */

export const rasterSourceSchema = z.enum(['cubicas5k', 'mmdetection', 'manual_tracing']);
export type RasterSource = z.infer<typeof rasterSourceSchema>;

/**
 * One claim from a segmentation model: a polygon, a class, a confidence.
 *
 * `confidence` is `gt(0)` rather than `min(0)` on purpose — a room the model is
 * certain of nothing about is not a room, and the database refuses a raster row
 * without a confidence anyway (`plan_rooms_confidence_ck`).
 */
export const rasterRoomSchema = z.object({
  code: z.string().min(1),
  label: z.string().min(1).nullable().optional(),
  room_kind: z.string().min(1),
  confidence: z.number().gt(0).lte(1),
  polygon: z.array(z.tuple([z.number(), z.number()])).min(3),
  /** Optional: the model's own confidence for the class, when it reports two numbers. */
  class_confidence: z.number().gt(0).lte(1).optional(),
});
export type RasterRoomDocument = z.infer<typeof rasterRoomSchema>;

/**
 * The contract a raster pipeline must satisfy. Any model can fill it — CubiCasa5k
 * fine-tunes, MMDetection instance segmentation, or a person tracing a scan — and
 * the importer validates it before a single row is written.
 */
export const rasterImportSchema = z.object({
  source: rasterSourceSchema,
  model_id: z.string().min(1),
  image: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }),
  metres_per_pixel: z.number().positive(),
  rooms: z.array(rasterRoomSchema).min(1),
});
export type RasterImport = z.infer<typeof rasterImportSchema>;
