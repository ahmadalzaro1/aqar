/**
 * The tool core. Adapters import from here only.
 *
 *   MCP     → registers each tool over stdio/HTTP for remote agents
 *   chat    → runs a tool in-process, same code, same validation
 */
import { makeRegistry, type ToolDef } from './registry.js';
import { systemTools } from './system.js';
import { portfolioTools } from './portfolio.js';
import { tenantsTools } from './tenants.js';
import { ticketsTools } from './tickets.js';

export const toolDefs: readonly ToolDef[] = [
  ...systemTools,
  ...portfolioTools,
  ...tenantsTools,
  ...ticketsTools,
];

export const registry = makeRegistry(toolDefs);

export { aqarContext, systemTools } from './system.js';
export {
  portfolioSummary,
  listVacantUnits,
  listExpiringLeases,
  portfolioTools,
} from './portfolio.js';
export { searchTenants, listArrears, tenantStatement, tenantsTools } from './tenants.js';
export { listOpenTickets, getTicket, ticketsTools } from './tickets.js';
export { makeRegistry } from './registry.js';
export type { Registry, ToolDef, ToolKind, ToolSummary } from './registry.js';
export { ToolNotFoundError, toParameters, rawShape } from './registry.js';
export { ToolFailure, isToolFailure } from './errors.js';
export type { OrganizationRef, ToolContext, ToolPolicy } from './context.js';
