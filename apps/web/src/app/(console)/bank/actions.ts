'use server';

// Thin server boundary for the bank wizard. Both actions re-check the session
// and re-derive the analysis from the raw text: the client's preview is never
// trusted, and the confirm action is the only place that writes.
import { revalidatePath } from 'next/cache';
import { getSessionUser } from '@/lib/auth';
import { analyzeForOrg, persistImport } from './data';
import type { AnalyzeResult, ConfirmResult } from './lib';

export interface AnalyzeInput {
  readonly rawText: string;
  readonly accountLabel: string;
  readonly fileName: string;
}

const EMPTY_ISSUES: readonly [] = [];

function unauthorizedAnalysis(): AnalyzeResult {
  return {
    status: 'unauthorized',
    sourceHash: '',
    totalLines: 0,
    newLines: 0,
    duplicateLines: 0,
    issues: EMPTY_ISSUES,
    fatal: null,
    existingImport: null,
    rows: [],
  };
}

export async function analyzeBankImport(input: AnalyzeInput): Promise<AnalyzeResult> {
  const user = await getSessionUser();
  if (user === null) return unauthorizedAnalysis();
  const analysis = await analyzeForOrg(user.orgId, input.rawText);
  return analysis.result;
}

export async function confirmBankImport(input: AnalyzeInput): Promise<ConfirmResult> {
  const user = await getSessionUser();
  if (user === null) {
    return {
      status: 'unauthorized',
      importId: null,
      insertedLines: 0,
      duplicateLines: 0,
      suggestions: 0,
      payments: 0,
      allocations: 0,
      issues: EMPTY_ISSUES,
    };
  }
  const accountLabel =
    input.accountLabel.trim().length > 0 ? input.accountLabel.trim() : 'Unlabelled account';
  const fileName = input.fileName.trim().length > 0 ? input.fileName.trim() : 'pasted.csv';
  const analysis = await analyzeForOrg(user.orgId, input.rawText);
  const result = await persistImport({
    orgId: user.orgId,
    userId: user.id,
    accountLabel,
    fileName,
    analysis,
  });
  if (result.status === 'imported') revalidatePath('/bank');
  return result;
}
