/**
 * TypeScript 6 rejects side-effect imports of non-module files (TS2882) unless a
 * declaration exists, and Next injects global CSS through `import './globals.css'`.
 * The declarations below are intentionally untyped — CSS carries no usable types
 * for us, and every import of these is a side-effect import.
 */
declare module '*.css';
declare module '*.scss';
declare module '*.sass';
