import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import {
  planExtractionSchema,
  planExtractRequestSchema,
  planExtractorErrorSchema,
  type PlanExtraction,
  type PlanExtractRequest,
} from '@aqar/contracts';
import type { Reconcilable } from '@aqar/core';

const run = promisify(execFile);

/**
 * Bridge to `tools/plan-extractor`, which reads the geometry out of a DXF or a
 * vector PDF. It is a separate process in Python for one reason: `ezdxf` is the
 * only maintained DXF reader and it has no JavaScript peer. Everything downstream
 * of this file is TypeScript, and nothing downstream believes a number this file
 * did not validate.
 */

export class PlanExtractionError extends Error {
  public constructor(
    public readonly code: string,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'PlanExtractionError';
  }
}

export interface ExtractorOptions {
  /** Absolute path to the Python interpreter with ezdxf + pymupdf installed. */
  readonly pythonPath?: string;
  readonly timeoutMs?: number;
}

function extractorRoot(): string {
  // `import.meta.url` is rewritten by bundlers, so the sidecar is located by
  // walking up from the working directory instead: the worker runs from
  // `apps/worker`, the web server from `apps/web`, and both find the same repo root.
  const fromEnv = process.env['AQAR_PLAN_EXTRACTOR_DIR'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  let directory = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(directory, 'tools', 'plan-extractor');
    if (existsSync(join(candidate, 'extract.py'))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  throw new PlanExtractionError(
    'extractor_missing',
    'could not locate tools/plan-extractor — set AQAR_PLAN_EXTRACTOR_DIR',
  );
}

function defaultPython(): string {
  const fromEnv = process.env['AQAR_PLAN_EXTRACTOR_PYTHON'];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return join(extractorRoot(), '.venv', 'bin', 'python');
}

function scriptPath(): string {
  return join(extractorRoot(), 'extract.py');
}

export async function runPlanExtractor(
  rawRequest: PlanExtractRequest,
  options: ExtractorOptions = {},
): Promise<PlanExtraction> {
  const request = planExtractRequestSchema.parse(rawRequest);
  const python = options.pythonPath ?? defaultPython();
  const script = scriptPath();

  if (!existsSync(script)) {
    throw new PlanExtractionError('extractor_missing', `plan extractor not found at ${script}`);
  }
  if (!existsSync(python)) {
    throw new PlanExtractionError(
      'extractor_env_missing',
      `python environment not found at ${python}; run: cd tools/plan-extractor && uv venv && uv pip install ezdxf ezdxf-shapely pymupdf shapely`,
    );
  }

  const args = [script, '--file', request.filePath, '--format', request.format];
  if (request.unit !== undefined) args.push('--unit', request.unit);
  if (request.calibrate !== undefined) args.push('--calibrate', request.calibrate);

  let stdout: string;
  try {
    const result = await run(python, args, {
      timeout: options.timeoutMs ?? 60_000,
      maxBuffer: 32 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      code?: number | string;
      killed?: boolean;
    };
    if (failure.killed === true) {
      throw new PlanExtractionError(
        'extractor_timeout',
        'the plan extractor exceeded its time budget',
      );
    }
    const parsedError = planExtractorErrorSchema.safeParse(parseJson(failure.stdout ?? ''));
    if (parsedError.success) {
      throw new PlanExtractionError(
        parsedError.data.error,
        parsedError.data.detail ?? parsedError.data.error,
        parsedError.data.detail,
      );
    }
    throw new PlanExtractionError(
      'extractor_failed',
      `plan extractor exited with ${String(failure.code)}`,
      (failure.stderr ?? '').slice(0, 2000),
    );
  }

  const parsed = planExtractionSchema.safeParse(parseJson(stdout));
  if (!parsed.success) {
    throw new PlanExtractionError(
      'extractor_contract_violation',
      'the plan extractor returned output the contract does not describe',
      parsed.error.issues
        .slice(0, 5)
        .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
        .join('; '),
    );
  }
  return parsed.data;
}

function parseJson(text: string): unknown {
  const trimmed = text.trim();
  if (trimmed === '') return {};
  try {
    return JSON.parse(trimmed);
  } catch {
    return {};
  }
}

/**
 * Only closed shapes with a real area can be reconciled. A drawing whose scale is
 * unknown produces `null` areas on purpose, and those are dropped here rather than
 * coerced to zero — a zero area would silently satisfy a sum.
 */
export function reconcilableShapes(extraction: PlanExtraction): readonly Reconcilable[] {
  return extraction.shapes
    .filter((shape): shape is typeof shape & { area_sqm: number } => shape.area_sqm !== null)
    .map((shape) => ({ code: shape.code, areaSqm: shape.area_sqm }));
}

/** True when this drawing is evidence a human must scale before any area is billable. */
export function needsCalibration(extraction: PlanExtraction): boolean {
  return !extraction.scale_known;
}
