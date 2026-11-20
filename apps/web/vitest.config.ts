import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

// Workspace packages are consumed as TS sources with NodeNext `.js` specifiers
// (same contract as the Next.js webpack extensionAlias). Vitest needs the
// equivalent rewrite so offline lib tests can import @aqar/core directly.
export default defineConfig({
  plugins: [
    {
      name: 'nodenext-js-to-ts',
      resolveId(source, importer) {
        if (importer !== undefined && source.startsWith('.') && source.endsWith('.js')) {
          const ts = resolve(dirname(importer), `${source.slice(0, -3)}.ts`);
          if (existsSync(ts)) return ts;
        }
        return null;
      },
    },
  ],
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
