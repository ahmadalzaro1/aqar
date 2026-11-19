// Tool registry — buildium-style category gating. Tools are grouped by module
// and opt-in per agent role; an agent never loads all write tools. Money-moving
// tools require a human approval token. This registry is the permission layer;
// handlers are bound by the worker with DB ports.
import { z } from 'zod';

export const toolCategorySchema = z.enum(['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9']);
export type ToolCategory = z.infer<typeof toolCategorySchema>;
export type ToolKind = 'read' | 'write' | 'money';

export interface ToolSpec {
  name: string;
  category: ToolCategory;
  kind: ToolKind;
  description: string;
}

export const TOOL_REGISTRY: readonly ToolSpec[] = [
  { name: 'summarize_portfolio', category: 'm1', kind: 'read', description: 'Read-only portfolio summary' },
  { name: 'flag_long_vacancy', category: 'm1', kind: 'write', description: 'Flag a unit as long-vacant (task, not rent change)' },
  { name: 'suggest_market_rent', category: 'm1', kind: 'read', description: 'Suggestion only; never writes rent' },
  { name: 'answer_inquiry', category: 'm2', kind: 'write', description: 'Bilingual reply from listing facts only' },
  { name: 'schedule_showing', category: 'm2', kind: 'write', description: 'Propose a showing slot' },
  { name: 'pre_screen_application', category: 'm2', kind: 'read', description: 'Checklist completeness; never a deny decision' },
  { name: 'chase_missing_documents', category: 'm2', kind: 'write', description: 'Reminder for missing applicant documents' },
  { name: 'extract_lease_terms', category: 'm3', kind: 'read', description: 'Proposal with per-field confidence; human confirms' },
  { name: 'track_expirations', category: 'm3', kind: 'read', description: 'Lease expiry pipeline' },
  { name: 'draft_renewal_offer', category: 'm3', kind: 'write', description: 'Draft only; human approves' },
  { name: 'reconcile_statement', category: 'm4', kind: 'write', description: 'Propose matches; never posts without policy pass' },
  { name: 'draft_late_reminder', category: 'm4', kind: 'write', description: 'Draft reminder; human approves send' },
  { name: 'explain_balance', category: 'm4', kind: 'read', description: 'Prose over core output; never produces numbers' },
  { name: 'flag_anomaly', category: 'm4', kind: 'write', description: 'Raise an anomaly task' },
  { name: 'post_payment', category: 'm4', kind: 'money', description: 'Post a payment — human approval token required' },
  { name: 'create_charge', category: 'm4', kind: 'money', description: 'Create charges — human approval token required' },
  { name: 'classify_ticket', category: 'm5', kind: 'read', description: 'Classification proposal' },
  { name: 'troubleshoot', category: 'm5', kind: 'write', description: 'Bounded question rounds (max 3)' },
  { name: 'dispatch_vendor', category: 'm5', kind: 'write', description: 'Dispatch proposal; NTE + approval gated' },
  { name: 'match_vendor', category: 'm6', kind: 'read', description: 'Trade + coverage + availability + score' },
  { name: 'request_quotes', category: 'm6', kind: 'write', description: 'Ask vendors for quotes' },
  { name: 'award_work', category: 'm6', kind: 'money', description: 'Award above limit — human approval token required' },
  { name: 'draft_owner_statement', category: 'm7', kind: 'read', description: 'Draft statement; never moves money' },
  { name: 'propose_distribution', category: 'm7', kind: 'money', description: 'Distribution proposal — N-of-M + token required' },
  { name: 'extract_document_fields', category: 'm8', kind: 'read', description: 'Field extraction proposal' },
  { name: 'draft_notice', category: 'm8', kind: 'write', description: 'Draft only; human-approved before send' },
  { name: 'answer_portfolio_question', category: 'm9', kind: 'read', description: 'Read-only parameterised query; cites rows' },
];

export type AgentRole = 'classifier' | 'triage' | 'leasing' | 'collections' | 'dispatcher' | 'owner-accounting' | 'compliance' | 'reporting';

const ROLE_CATEGORIES: Record<AgentRole, readonly ToolCategory[]> = {
  classifier: ['m5'],
  triage: ['m5', 'm6'],
  leasing: ['m2', 'm3'],
  collections: ['m4'],
  dispatcher: ['m5', 'm6'],
  'owner-accounting': ['m7'],
  compliance: ['m8'],
  reporting: ['m1', 'm9'],
};

const ROLE_KINDS: Record<AgentRole, readonly ToolKind[]> = {
  classifier: ['read'],
  triage: ['read', 'write'],
  leasing: ['read', 'write'],
  collections: ['read', 'write', 'money'],
  dispatcher: ['read', 'write', 'money'],
  'owner-accounting': ['read', 'money'],
  compliance: ['read', 'write'],
  reporting: ['read'],
};

export function toolsForRole(role: AgentRole): ToolSpec[] {
  const cats = ROLE_CATEGORIES[role];
  const kinds = ROLE_KINDS[role];
  return TOOL_REGISTRY.filter((t) => cats.includes(t.category) && kinds.includes(t.kind));
}

export class ToolDeniedError extends Error {
  constructor(message: string) { super(message); this.name = 'ToolDeniedError'; }
}

/** Fail-closed gate: unknown tool, wrong role, or money without a human token ⇒ deny. */
export function assertToolAllowed(role: AgentRole, toolName: string, opts: { humanApprovalTokenPresent: boolean }): ToolSpec {
  const spec = TOOL_REGISTRY.find((t) => t.name === toolName);
  if (spec === undefined) throw new ToolDeniedError(`unknown tool: ${toolName}`);
  const allowed = toolsForRole(role);
  if (!allowed.some((t) => t.name === toolName)) throw new ToolDeniedError(`role ${role} may not use ${toolName} (${spec.category}/${spec.kind})`);
  if (spec.kind === 'money' && !opts.humanApprovalTokenPresent) throw new ToolDeniedError(`${toolName} moves money and requires a human approval token`);
  return spec;
}
