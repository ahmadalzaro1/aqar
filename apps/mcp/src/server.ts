import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolContext } from './context.js';
import { registerActionTools } from './tools/actions.js';
import { registerPortfolioTools } from './tools/portfolio.js';
import { registerSystemTools } from './tools/system.js';
import { registerTenantTools } from './tools/tenants.js';
import { registerTicketTools } from './tools/tickets.js';

/**
 * The server instructions are part of the contract, not decoration: they are the
 * first thing a client sees, and they state the two rules a model must not infer
 * from tool descriptions alone — money is integer fils, and money-moving tools
 * only ever file proposals.
 */
const INSTRUCTIONS = `Aqar is a property-operations ledger for Jordan (currency JOD, 3 decimals).

Rules that are enforced by the server, not by good intentions:
- Money is integer fils (1 JOD = 1000 fils). Every amount comes back with both amountFils and a preformatted amountJod. Never compute, round or convert money yourself.
- You cannot move money, create charges, dispatch vendors, or message a tenant. Those tools file a proposal; a human approves it in the console and a server job executes it. Say "filed for approval", never "done".
- Emergencies are detected deterministically. If create_ticket returns emergency: true, relay the safety instruction immediately and tell the person a human is being paged.
- Tenant phone numbers are masked. Do not ask for full contact details through these tools.

Start a session with aqar_context to learn the organization, the mode, and the limits in force.`;

export function buildServer(ctx: ToolContext): McpServer {
  const server = new McpServer(
    { name: 'aqar', version: '0.1.0', title: 'Aqar property ledger' },
    { instructions: INSTRUCTIONS },
  );

  registerSystemTools(server, ctx);
  registerPortfolioTools(server, ctx);
  registerTenantTools(server, ctx);
  registerTicketTools(server, ctx);
  registerActionTools(server, ctx);

  return server;
}
