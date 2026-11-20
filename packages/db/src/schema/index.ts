/**
 * Schema barrel — the single source drizzle-kit reads (drizzle.config.ts points here).
 * Table order mirrors the nine modules in the product spec.
 */
export * from './common.js';
export * from './enums.js';
export * from './organizations.js';
export * from './auth.js';
export * from './m1-property.js';
export * from './m2-leasing.js';
export * from './m3-leases.js';
export * from './m4-finance.js';
export * from './vendors.js';
export * from './m5-maintenance.js';
export * from './m6-vendor-ops.js';
export * from './m7-owners.js';
export * from './m8-compliance.js';
export * from './m9-views.js';
export * from './taxonomy.js';
