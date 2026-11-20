import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@aqar/ui', '@aqar/contracts', '@aqar/core', '@aqar/drawings'],
  // A DXF from a surveyor is often 5–15 MB. The default 1 MB server-action body
  // limit would reject a perfectly ordinary drawing with a form error nobody can
  // interpret; 25 MB matches the upload action's own cap.
  experimental: { serverActions: { bodySizeLimit: '26mb' } },
  serverExternalPackages: ['@node-rs/argon2', 'postgres'],
  typescript: { ignoreBuildErrors: false },
  // Next 16 removed the `eslint` config key (and `next lint`) — builds never
  // lint any more, which is what this project wants: lint is its own CI gate.
  devIndicators: false, // keep committed screenshots free of the dev badge
  // Next 16 writes apps/web/AGENTS.md on every dev/build for AI coding agents.
  // Generated files don't belong in git and drift with the Next version, so the
  // generator is off; agent-facing guidance lives in docs/ instead.
  agentRules: false,
  // Next 16 builds with Turbopack by default. We stay on webpack deliberately:
  // the workspace packages are NodeNext ESM, so their internal imports use
  // `.js` specifiers that only exist on disk as `.ts`. Turbopack resolves those
  // as missing modules ("the module has no exports at all"), and the supported
  // workaround is the extensionAlias below, which only webpack implements.
  // The Turbopack-era fix is to emit real `.js` from packages/* via tsc and
  // point `exports` at dist — tracked in docs/DECISIONS.md.
  webpack: (cfg) => {
    cfg.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return cfg;
  },
};
export default config;
