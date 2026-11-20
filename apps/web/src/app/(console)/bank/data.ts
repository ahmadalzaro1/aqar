// Server-only data access for the bank-import wizard. Every read is scoped by
// organization_id; every write happens inside ONE transaction whose
// `app.organization_id` GUC is set (same contract as @aqar/db
// withOrganization). Nothing here parses money: @aqar/core owns that.
import { createHash, randomUUID } from 'node:crypto';
import type { BankLine, MatchSuggestion } from '@aqar/contracts';
import type { ChargesByLease, PayerProfile } from '@aqar/core';
import { sql } from '@/lib/db';
import {
  chargeAsBankLineInput,
  parseCsv,
  planDedupe,
  planMatch,
  remainingCharges,
  type AnalyzeResult,
  type ConfirmResult,
  type DedupeRow,
  type ImportRecord,
  type MatchPlan,
  type PlanEntry,
  type PreviewRow,
} from './lib';

const LEASE_CANCELLED = 'cancelled';

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isoDate(value: unknown): string {
  return (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10);
}

/** Row number of a not-yet-persisted line (ids are `pending:<n>` until insert). */
function rowNumberOf(lineId: string): number {
  return Number(lineId.slice('pending:'.length));
}

function isoDateTime(value: unknown): string {
  return value instanceof Date ? value.toISOString() : String(value);
}

export async function listImports(orgId: string): Promise<ImportRecord[]> {
  const rows = await sql`
    SELECT id, source_hash, file_name, account_label, line_count, imported_at
    FROM bank_imports
    WHERE organization_id = ${orgId}
    ORDER BY imported_at DESC, id`;
  return rows.map((r) => ({
    id: String(r['id']),
    sourceHash: String(r['source_hash']),
    fileName: String(r['file_name']),
    accountLabel: String(r['account_label']),
    lineCount: Number(r['line_count']),
    importedAtISO: isoDateTime(r['imported_at']),
  }));
}

export async function listExistingBankLines(orgId: string): Promise<BankLine[]> {
  const rows = await sql`
    SELECT id, statement_id, date, amount_fils, payer_name, payer_account, reference
    FROM bank_lines
    WHERE organization_id = ${orgId}`;
  return rows.map((r) => ({
    id: String(r['id']),
    statementId: String(r['statement_id']),
    dateISO: isoDate(r['date']),
    amountFils: Number(r['amount_fils']),
    payerName: String(r['payer_name']),
    payerAccount: r['payer_account'] === null ? null : String(r['payer_account']),
    reference: r['reference'] === null ? null : String(r['reference']),
  }));
}

/**
 * `confirmed` means a human has already accepted a match for this payer in this
 * org — the core engine's definition of a verified payer, never an assumption.
 */
export async function listPayerProfiles(orgId: string): Promise<PayerProfile[]> {
  const rows = await sql`
    SELECT t.id AS tenant_id, t.full_name_ar, t.full_name_en, l.id AS lease_id,
      EXISTS (
        SELECT 1 FROM match_suggestions ms
        WHERE ms.organization_id = t.organization_id
          AND ms.payer_id = t.id AND ms.accepted_at IS NOT NULL
      ) AS confirmed
    FROM tenants t
    JOIN lease_tenants lt ON lt.tenant_id = t.id
    JOIN leases l ON l.id = lt.lease_id
    WHERE t.organization_id = ${orgId} AND l.status <> ${LEASE_CANCELLED}
    ORDER BY l.id, t.id`;
  return rows.map((r) => {
    const names = [String(r['full_name_ar']), String(r['full_name_en'])].filter(
      (name) => name.trim().length > 0,
    );
    return {
      payerId: String(r['tenant_id']),
      leaseId: String(r['lease_id']),
      names,
      accounts: [],
      confirmed: Boolean(r['confirmed']),
    };
  });
}

/** Remaining (unallocated) charge balances, oldest-first planning inputs. */
export async function loadRemainingCharges(orgId: string): Promise<ChargesByLease> {
  const rows = await sql`
    SELECT c.id, c.lease_id, c.period, c.kind, c.due_date, c.amount_fils,
      COALESCE(a.paid_fils, 0)::int AS paid_fils
    FROM charges c
    LEFT JOIN LATERAL (
      SELECT SUM(x.amount_fils) AS paid_fils FROM payment_allocations x WHERE x.charge_id = c.id
    ) a ON true
    WHERE c.organization_id = ${orgId}`;
  return remainingCharges(
    rows.map((r) => ({
      id: String(r['id']),
      leaseId: String(r['lease_id']),
      period: String(r['period']),
      kind: String(r['kind']),
      dueDateISO: isoDate(r['due_date']),
      remainingFils: Number(r['amount_fils']) - Number(r['paid_fils']),
    })),
  );
}

export interface AnalysisEntry {
  readonly dedupe: DedupeRow;
  readonly match: MatchPlan | null;
}

export interface Analysis {
  readonly sourceHash: string;
  readonly result: AnalyzeResult;
  readonly entries: readonly AnalysisEntry[];
}

function toPreviewRow(entry: AnalysisEntry): PreviewRow {
  const { dedupe, match } = entry;
  return {
    rowNumber: rowNumberOf(dedupe.line.id),
    dateISO: dedupe.line.dateISO,
    payerName: dedupe.line.payerName,
    amountFils: dedupe.line.amountFils,
    reference: dedupe.line.reference,
    fingerprint: dedupe.fingerprint,
    duplicateKind: dedupe.duplicateKind,
    duplicateOfDateISO: dedupe.duplicateOf === null ? null : dedupe.duplicateOf.dateISO,
    suggestion: match === null ? null : match.suggestion,
    allocations: match === null ? [] : match.allocations,
    postable: match === null ? false : match.postable,
  };
}

/**
 * Read-only analysis. Re-upload detection runs BEFORE parsing (frozen order):
 * the raw file hash is compared to stored bank_imports first.
 */
export async function analyzeForOrg(orgId: string, rawText: string): Promise<Analysis> {
  const sourceHash = sha256Hex(rawText);
  const [imports, existing] = await Promise.all([listImports(orgId), listExistingBankLines(orgId)]);
  const prior = imports.find((record) => record.sourceHash === sourceHash);
  if (prior !== undefined) {
    return {
      sourceHash,
      entries: [],
      result: {
        status: 'reupload',
        sourceHash,
        totalLines: 0,
        newLines: 0,
        duplicateLines: 0,
        issues: [],
        fatal: null,
        existingImport: prior,
        rows: [],
      },
    };
  }

  const parsed = parseCsv(rawText);
  const dedupe = planDedupe(existing, parsed.lines);
  const duplicateLines = dedupe.filter((row) => row.duplicateKind !== null).length;

  const freshDedupe = dedupe.filter((row) => row.duplicateKind === null);
  const needMatch = freshDedupe.length > 0;
  const payers: readonly PayerProfile[] = needMatch ? await listPayerProfiles(orgId) : [];
  const charges: ChargesByLease = needMatch ? await loadRemainingCharges(orgId) : {};

  const matchByRow = new Map<number, MatchPlan>();
  for (const row of freshDedupe) {
    const line = chargeAsBankLineInput({
      rowNumber: rowNumberOf(row.line.id),
      dateISO: row.line.dateISO,
      payerName: row.line.payerName,
      amountFils: row.line.amountFils,
      reference: row.line.reference,
    });
    matchByRow.set(rowNumberOf(row.line.id), planMatch(line, payers, charges));
  }

  const entries: AnalysisEntry[] = dedupe.map((row) => ({
    dedupe: row,
    match: matchByRow.get(rowNumberOf(row.line.id)) ?? null,
  }));
  const invalid = parsed.fatal !== null || parsed.issues.length > 0;

  return {
    sourceHash,
    entries,
    result: {
      status: invalid ? 'invalid' : 'ready',
      sourceHash,
      totalLines: parsed.lines.length,
      newLines: freshDedupe.length,
      duplicateLines,
      issues: parsed.issues,
      fatal: parsed.fatal,
      existingImport: null,
      rows: entries.map(toPreviewRow),
    },
  };
}

interface PersistInput {
  readonly orgId: string;
  readonly userId: string;
  readonly accountLabel: string;
  readonly fileName: string;
  readonly analysis: Analysis;
}

const TRANSFER_METHOD = 'bank_transfer';

interface InsertedPayment {
  readonly paymentId: string;
  readonly lineId: string;
  readonly tenantId: string;
  readonly amountFils: number;
  readonly allocations: readonly PlanEntry[];
}

/**
 * One transaction: bank_imports → bank_lines → match_suggestions → payments →
 * payment_allocations → audit_events. `sourceHash` is the idempotency key; a
 * second confirm of the same file returns the stored import and writes nothing.
 */
export async function persistImport(input: PersistInput): Promise<ConfirmResult> {
  const { orgId, userId, accountLabel, fileName, analysis } = input;
  if (analysis.result.status !== 'ready') {
    return {
      status: 'invalid',
      importId: null,
      insertedLines: 0,
      duplicateLines: analysis.result.duplicateLines,
      suggestions: 0,
      payments: 0,
      allocations: 0,
      issues: analysis.result.issues,
    };
  }

  const hash = analysis.sourceHash;
  const fresh = analysis.entries.filter((entry) => entry.dedupe.duplicateKind === null);
  const now = new Date();

  return sql.begin(async (tx) => {
    await tx`SELECT set_config('app.organization_id', ${orgId}, true)`;

    const prior = await tx`
      SELECT id, line_count FROM bank_imports
      WHERE organization_id = ${orgId} AND source_hash = ${hash} LIMIT 1`;
    const priorRow = prior[0];
    if (priorRow !== undefined) {
      return {
        status: 'already_imported' as const,
        importId: String(priorRow['id']),
        insertedLines: Number(priorRow['line_count']),
        duplicateLines: analysis.result.duplicateLines,
        suggestions: 0,
        payments: 0,
        allocations: 0,
        issues: [],
      };
    }

    const importId = randomUUID();
    const insertedImport = await tx`
      INSERT INTO bank_imports
        (id, organization_id, account_label, file_name, imported_at, line_count, source_hash)
      VALUES
        (${importId}, ${orgId}, ${accountLabel}, ${fileName}, ${now}, ${fresh.length}, ${hash})
      ON CONFLICT (organization_id, source_hash) DO NOTHING
      RETURNING id`;
    if (insertedImport.length === 0) {
      const raced = await tx`
        SELECT id, line_count FROM bank_imports
        WHERE organization_id = ${orgId} AND source_hash = ${hash} LIMIT 1`;
      const racedRow = raced[0];
      return {
        status: 'already_imported' as const,
        importId: racedRow === undefined ? null : String(racedRow['id']),
        insertedLines: racedRow === undefined ? 0 : Number(racedRow['line_count']),
        duplicateLines: analysis.result.duplicateLines,
        suggestions: 0,
        payments: 0,
        allocations: 0,
        issues: [],
      };
    }

    const payments: InsertedPayment[] = [];
    let suggestions = 0;
    let allocations = 0;

    for (const entry of fresh) {
      const lineId = randomUUID();
      const line = entry.dedupe.line;
      await tx`
        INSERT INTO bank_lines
          (id, organization_id, statement_id, date, amount_fils, payer_name, payer_account,
           reference, fingerprint)
        VALUES
          (${lineId}, ${orgId}, ${importId}, ${line.dateISO}, ${line.amountFils},
           ${line.payerName}, ${line.payerAccount}, ${line.reference}, ${entry.dedupe.fingerprint})`;

      const match = entry.match;
      if (match === null) continue;
      const suggestion: MatchSuggestion = match.suggestion;

      await tx`
        INSERT INTO match_suggestions
          (id, organization_id, bank_line_id, kind, lease_ids, payer_id, amount_fils,
           confidence, reason)
        VALUES
          (${randomUUID()}, ${orgId}, ${lineId}, ${suggestion.kind},
           ${JSON.stringify(suggestion.leaseIds)}::jsonb, ${suggestion.payerId},
           ${suggestion.amountFils}, ${suggestion.confidence.toFixed(3)}, ${suggestion.reason})`;
      suggestions += 1;

      if (!match.postable || suggestion.payerId === null) continue;
      const paymentId = randomUUID();
      await tx`
        INSERT INTO payments
          (id, organization_id, payer_id, amount_fils, received_date, method,
           reference_period, reference_text, cheque_status, notes)
        VALUES
          (${paymentId}, ${orgId}, ${suggestion.payerId}, ${suggestion.amountFils},
           ${line.dateISO}, ${TRANSFER_METHOD}, NULL, ${line.reference}, NULL,
           ${`bank import ${importId} / row ${String(rowNumberOf(entry.dedupe.line.id))}`})`;
      for (const allocation of match.allocations) {
        await tx`
          INSERT INTO payment_allocations
            (id, organization_id, payment_id, charge_id, amount_fils, allocated_at)
          VALUES
            (${randomUUID()}, ${orgId}, ${paymentId}, ${allocation.chargeId},
             ${allocation.amountFils}, ${now})`;
        allocations += 1;
      }
      payments.push({
        paymentId,
        lineId,
        tenantId: suggestion.payerId,
        amountFils: suggestion.amountFils,
        allocations: match.allocations,
      });
    }

    const after = {
      sourceHash: hash,
      fileName,
      accountLabel,
      totalLines: analysis.result.totalLines,
      insertedLines: fresh.length,
      duplicatesSkipped: analysis.result.duplicateLines,
      duplicateFingerprints: analysis.entries
        .filter((entry) => entry.dedupe.duplicateKind !== null)
        .map((entry) => ({
          fingerprint: entry.dedupe.fingerprint,
          duplicateKind: entry.dedupe.duplicateKind,
          duplicateOfDateISO: entry.dedupe.duplicateOf === null ? null : entry.dedupe.duplicateOf.dateISO,
        })),
      suggestions,
      payments: payments.length,
      allocations,
    };
    const actor = { type: 'human', userId };
    await tx`
      INSERT INTO audit_events
        (id, organization_id, actor, action, entity_type, entity_id, before, after,
         model_id, prompt_version, confidence, idempotency_key, occurred_at, reversal_of)
      VALUES
        (${randomUUID()}, ${orgId}, ${JSON.stringify(actor)}::jsonb, 'bank_import.confirmed',
         'bank_import', ${importId}, NULL, ${JSON.stringify(after)}::jsonb,
         NULL, NULL, NULL, ${`${hash}:import`}, ${now}, NULL)`;

    for (const payment of payments) {
      const paymentAfter = {
        paymentId: payment.paymentId,
        bankImportId: importId,
        bankLineId: payment.lineId,
        payerId: payment.tenantId,
        amountFils: payment.amountFils,
        method: TRANSFER_METHOD,
        allocations: payment.allocations,
      };
      await tx`
        INSERT INTO audit_events
          (id, organization_id, actor, action, entity_type, entity_id, before, after,
           model_id, prompt_version, confidence, idempotency_key, occurred_at, reversal_of)
        VALUES
          (${randomUUID()}, ${orgId}, ${JSON.stringify(actor)}::jsonb, 'payment.recorded',
           'payment', ${payment.paymentId}, NULL, ${JSON.stringify(paymentAfter)}::jsonb,
           NULL, NULL, NULL, ${`${hash}:payment:${payment.lineId}`}, ${now}, NULL)`;
    }

    return {
      status: 'imported' as const,
      importId,
      insertedLines: fresh.length,
      duplicateLines: analysis.result.duplicateLines,
      suggestions,
      payments: payments.length,
      allocations,
      issues: [],
    };
  });
}
