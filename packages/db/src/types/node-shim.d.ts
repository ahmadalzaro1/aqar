/**
 * Minimal ambient shims for the Node built-ins this package uses.
 *
 * Why: packages/db/package.json is frozen for this task and does not depend on
 * `@types/node`, so `process` and the `node:` module specifiers are unknown to
 * tsc. The declarations below cover exactly what migrate.ts / seed.ts / tests
 * touch and nothing more. If `@types/node` is added to the package, delete this
 * file — the real types are strictly better.
 */

declare const process: {
  env: Record<string, string | undefined>;
  argv: string[];
  exitCode?: number;
  cwd(): string;
  stdout: { write(chunk: string): boolean };
  stderr: { write(chunk: string): boolean };
};

declare const console: {
  log(...args: unknown[]): void;
  error(...args: unknown[]): void;
};

declare module 'node:fs' {
  export function readFileSync(path: string, encoding: 'utf8'): string;
  export function writeFileSync(path: string, data: string): void;
  export function existsSync(path: string): boolean;
  export function readdirSync(path: string): string[];
  export function mkdirSync(path: string, options?: { recursive?: boolean }): void;
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module 'node:path' {
  export function join(...parts: string[]): string;
  export function resolve(...parts: string[]): string;
  export function dirname(path: string): string;
  export function basename(path: string): string;
  export function extname(path: string): string;
  export function relative(from: string, to: string): string;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

declare module 'node:crypto' {
  export function createHash(algorithm: string): {
    update(data: string): {
      digest(encoding: 'hex'): string;
      digest(encoding: 'base64url'): string;
    };
    digest(encoding: 'hex'): string;
    digest(encoding: 'base64url'): string;
  };
  export function randomUUID(): string;
}
