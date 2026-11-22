/**
 * ESLint reference configuration — kept ONLY for the coverage-probation oracle.
 *
 * ESLint is no longer a project dependency; scripts/ci/lint-parity.mjs installs
 * it at a pinned version, runs this config, and fails if oxlint misses anything
 * ESLint reports. Delete this file and the oracle on 2026-12-05 when probation
 * ends. Do not add rules here — the real configuration is .oxlintrc.json.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import globals from 'globals';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', '**/coverage/**', '**/playwright-report/**', '**/test-results/**', '**/drizzle/**', '**/next-env.d.ts'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      'no-console': ['warn', { allow: ['warn', 'error', 'info'] }],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    rules: { 'no-console': 'off' },
  },
);
