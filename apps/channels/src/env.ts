import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Minimal, dependency-free `.env` loader for the repo root file.
 *
 * Lives here (rather than adding dotenv) because apps/channels is a leaf
 * producer with a short dependency list. Rules:
 *  - never overrides an existing process.env value
 *  - skips blank lines, `#` comments and any line without `KEY=`
 *    (the repo root `.env` has one such stray line, so a strict parser
 *    would abort)
 *  - strips a single layer of matching quotes
 */
export function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** Repo root = three levels up from apps/channels/src. */
export function repoRootFromModule(): string {
  return join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
}

/**
 * Loads the repo root `.env` into process.env without overriding anything that
 * is already set. Safe to call repeatedly.
 */
export function loadRepoEnv(envPath: string = join(repoRootFromModule(), '.env')): void {
  let contents: string;
  try {
    contents = readFileSync(envPath, 'utf8');
  } catch {
    return;
  }
  const parsed = parseEnvFile(contents);
  for (const [key, value] of Object.entries(parsed)) {
    if (value.length === 0) continue;
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
