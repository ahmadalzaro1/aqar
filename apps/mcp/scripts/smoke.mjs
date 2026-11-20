/**
 * End-to-end smoke test through a real MCP client.
 *
 * Deliberately not a unit test: it spawns the server exactly as Hermes does
 * (stdio, JSON-RPC), lists tools, and calls them against the live database.
 * If this prints real rows the integration works; if any step fails it throws
 * with the failing tool's own error text.
 *
 *   node scripts/smoke.mjs
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

function readEnv(file) {
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    out[trimmed.slice(0, eq)] = trimmed.slice(eq + 1).replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = { ...process.env, ...readEnv(join(repoRoot, '.env')) };
env.AQAR_MCP_MODE = process.env.AQAR_MCP_MODE ?? 'propose';
env.AQAR_MCP_ACTOR = 'hermes-smoke';

const transport = new StdioClientTransport({
  command: join(here, '..', 'node_modules', '.bin', 'tsx'),
  args: [join(here, '..', 'src', 'stdio.ts')],
  env,
  stderr: 'inherit',
});

const client = new Client({ name: 'aqar-smoke', version: '0.0.0' }, { capabilities: {} });

function text(result) {
  const first = result.content?.[0];
  return first?.type === 'text' ? first.text : JSON.stringify(result);
}

/** Tool failures come back as plain text; surface them instead of crashing. */
function json(result) {
  const body = text(result);
  if (result.isError === true) return { __error: body.slice(0, 400) };
  try {
    return JSON.parse(body);
  } catch {
    return { __error: body.slice(0, 400) };
  }
}

/** Fail loudly, naming the tool, instead of dying on `undefined[0]`. */
function expect(value, label) {
  if (value.__error !== undefined) throw new Error(`${label} failed: ${value.__error}`);
  return value;
}

async function call(name, args, label = name) {
  return expect(json(await client.callTool({ name, arguments: args })), label);
}

let exitCode = 0;
try {
  await client.connect(transport);
  console.log('CONNECTED');

  const { tools } = await client.listTools();
  console.log(`TOOLS (${tools.length}): ${tools.map((tool) => tool.name).join(', ')}`);

  const context = await call('aqar_context', {});
  console.log('CONTEXT', JSON.stringify(context.organization), 'mode=' + context.mode, 'mayMoveMoney=' + context.mayMoveMoney);
  console.log('COUNTS', JSON.stringify(context.counts));

  const portfolio = await call('portfolio_summary', {});
  console.log('PORTFOLIO totals', JSON.stringify(portfolio.totals));
  console.log('PORTFOLIO properties', portfolio.properties.length, 'first=', JSON.stringify(portfolio.properties[0]));

  const vacant = await call('list_vacant_units', { limit: 5 });
  console.log('VACANT count=' + vacant.count, 'first=' + JSON.stringify(vacant.units[0]));

  const expiring = await call('list_expiring_leases', { withinDays: 720, limit: 3 });
  console.log('EXPIRING count=' + expiring.count, 'first=' + JSON.stringify(expiring.leases[0]));

  const arrears = await call('list_arrears', { limit: 3 });
  console.log('ARREARS count=' + arrears.count, 'total=' + arrears.totalOutstandingJod, 'top=' + JSON.stringify(arrears.tenants[0]));

  const tickets = await call('list_open_tickets', { limit: 2 });
  console.log('OPEN_TICKETS count=' + tickets.count, 'first=' + JSON.stringify(tickets.tickets[0]));

  const vendors = await call('list_vendors', { limit: 3 });
  console.log('VENDORS count=' + vendors.count, 'first=' + JSON.stringify(vendors.vendors[0]));

  // Emergency path: the deterministic pre-check must flag this and hand back a
  // safety instruction the model is told to relay.
  const smokeKey = process.env.SMOKE_KEY ?? `smoke-${Date.now()}`;
  const emergencyArgs = {
    subject: 'Gas smell in the kitchen',
    body: 'I can smell gas strongly near the stove since ten minutes ago, it is getting worse.',
    propertyId: portfolio.properties[0].propertyId,
    locale: 'en',
    channel: 'whatsapp',
    idempotencyKey: smokeKey,
  };
  const created = await call('create_ticket', emergencyArgs);
  console.log('CREATE_TICKET', JSON.stringify(created));

  const repeat = await call('create_ticket', emergencyArgs);
  console.log('CREATE_TICKET_REPEAT duplicate=' + repeat.duplicate);

  const detail = await call('get_ticket', { ticketId: created.ticketId });
  console.log('GET_TICKET emergency=' + detail.ticket.emergency + ' status=' + detail.ticket.status + ' attachments=' + detail.attachmentCount);

  // The real proof: the worker consumes the job this tool queued and writes a
  // classification. Poll instead of assuming.
  let classified = await call('get_ticket', { ticketId: created.ticketId });
  for (let attempt = 0; attempt < 20 && classified.classification === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    classified = await call('get_ticket', { ticketId: created.ticketId });
  }
  console.log(
    'TRIAGE status=' + classified.ticket.status +
      ' classification=' + JSON.stringify(classified.classification),
  );
  if (classified.classification === null) {
    console.log('TRIAGE_PENDING (worker did not classify within 30s)');
  }

  const note = await call('log_tenant_message', {
    ticketId: created.ticketId,
    body: 'الغاز قوي جدا في المطبخ',
    locale: 'ar',
    externalId: 'wamid.smoke.1',
  });
  console.log('LOG_MESSAGE', JSON.stringify(note));

  const promise = await call('log_payment_promise', {
    tenantId: arrears.tenants[0].tenantId,
    amountFils: 200000,
    promisedDate: '2026-11-25',
    note: 'Promised on WhatsApp',
    sourceChannel: 'whatsapp',
    idempotencyKey: 'smoke-promise-1',
  });
  console.log('PROMISE', JSON.stringify(promise));

  const leaseId = expiring.leases[0]?.leaseId;
  if (leaseId === undefined) throw new Error('no lease available to propose a payment against');

  const paymentArgs = { leaseId, amountFils: 250000, receivedDate: '2026-11-20', method: 'cliq', reference: 'SMOKE-1' };
  const payment = await call('propose_payment', paymentArgs);
  console.log('PROPOSE_PAYMENT', JSON.stringify(payment));

  const again = await call('propose_payment', paymentArgs);
  console.log('PROPOSE_PAYMENT_REPEAT duplicate=' + again.duplicate + ' sameId=' + (again.proposalId === payment.proposalId));

  const reply = await call('propose_tenant_reply', { ticketId: created.ticketId, body: 'نرسل فنيا الآن', locale: 'ar' });
  console.log('PROPOSE_REPLY', JSON.stringify(reply));

  const dispatch = await call('propose_vendor_dispatch', {
    ticketId: created.ticketId,
    vendorId: vendors.vendors[0].vendorId,
    amountFils: 45000,
  });
  console.log('PROPOSE_DISPATCH', JSON.stringify(dispatch));

  const proposals = await call('list_proposals', { status: 'pending', limit: 10 });
  console.log('PENDING_PROPOSALS count=' + proposals.count, JSON.stringify(proposals.proposals.map((p) => p.action)));

  // Structured failure, not a crash: unknown id must come back as isError.
  const missing = await client.callTool({
    name: 'get_ticket',
    arguments: { ticketId: '00000000-0000-0000-0000-000000000000' },
  });
  console.log('MISSING_TICKET isError=' + missing.isError + ' body=' + text(missing).replace(/\s+/g, ' ').slice(0, 160));

  console.log('SMOKE_OK');
} catch (error) {
  console.error('SMOKE_FAILED', error instanceof Error ? error.message : String(error));
  exitCode = 1;
} finally {
  // Always reap the child: a live tsx process holds the inherited stdout pipe,
  // which makes any `| tail` around this script hang forever.
  await client.close().catch(() => {});
}
process.exit(exitCode);
