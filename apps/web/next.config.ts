import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@aqar/ui', '@aqar/contracts', '@aqar/core'],
  serverExternalPackages: ['@node-rs/argon2', 'postgres'],
  eslint: { ignoreDuringBuilds: true }, // lint runs as its own CI gate, not inside next build
  typescript: { ignoreBuildErrors: false },
  webpack: (cfg) => {
    // Workspace packages use NodeNext-style .js specifiers pointing at .ts sources.
    cfg.resolve.extensionAlias = {
      '.js': ['.ts', '.tsx', '.js'],
      '.mjs': ['.mts', '.mjs'],
    };
    return cfg;
  },
};
export default config;
