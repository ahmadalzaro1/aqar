'use client';

// M6 wizard — three steps, all money math delegated to core via the server
// actions. The client never computes fils; it renders what the server derived.
import { useRef, useState } from 'react';
import Link from 'next/link';
import type { Locale } from '@aqar/contracts';
import { Badge, Button, Card, EmptyState, MoneyText, formatMoney } from '@aqar/ui';
import { analyzeBankImport, confirmBankImport } from './actions';
import { bankMessages, fill } from './i18n';
import { sumPlan } from './lib';
import type { AnalyzeResult, ConfirmResult, ImportRecord } from './lib';

type Step = 'input' | 'preview' | 'done';

export function BankWizard({ locale, recent }: { locale: Locale; recent: readonly ImportRecord[] }) {
  const s = bankMessages(locale);
  const t = (key: string) => s[key] ?? key;
  const [step, setStep] = useState<Step>('input');
  const [rawText, setRawText] = useState('');
  const [accountLabel, setAccountLabel] = useState('');
  const [fileName, setFileName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [analysis, setAnalysis] = useState<AnalyzeResult | null>(null);
  const [result, setResult] = useState<ConfirmResult | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const input = { rawText, accountLabel, fileName };

  async function analyze() {
    setBusy(true); setError(null);
    try {
      const r = await analyzeBankImport(input);
      if (r.status === 'unauthorized') { setError('unauthorized'); return; }
      setAnalysis(r); setStep('preview');
    } catch { setError('analyze failed'); } finally { setBusy(false); }
  }
  async function confirm() {
    setBusy(true); setError(null);
    try {
      const r = await confirmBankImport(input);
      if (r.status === 'unauthorized') { setError('unauthorized'); return; }
      setResult(r); setStep('done');
    } catch { setError('confirm failed'); } finally { setBusy(false); }
  }
  function reset() {
    setStep('input'); setAnalysis(null); setResult(null); setError(null);
    setRawText(''); setFileName('');
  }
  function onFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (file === undefined) return;
    setFileName(file.name);
    const reader = new FileReader();
    reader.onload = () => { setRawText(typeof reader.result === 'string' ? reader.result : ''); };
    reader.readAsText(file);
  }
  function issueText(code: string, row: number, value: string): string {
    return fill(t(`bank.error.${code}`), { row, value });
  }

  const kindTone: Record<string, 'ok' | 'warn' | 'danger' | 'neutral'> = {
    auto: 'ok', partial: 'warn', review: 'warn', ambiguous: 'danger', unknown_payer: 'neutral',
  };

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <div>
        <h1 style={{ fontSize: 'var(--text-xl)' }}>{t('bank.title')}</h1>
        <p style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>{t('bank.subtitle')}</p>
      </div>
      <ol aria-label={t('bank.step.current')} style={{ display: 'flex', gap: 'var(--space-3)', listStyle: 'none', padding: 0, margin: 0, flexWrap: 'wrap' }}>
        {(['bank.step1', 'bank.step2', 'bank.step3'] as const).map((key, i) => {
          const active = (step === 'input' && i === 0) || (step === 'preview' && i === 1) || (step === 'done' && i === 2);
          return <li key={key} aria-current={active ? 'step' : undefined} style={{ fontSize: 'var(--text-sm)', fontWeight: active ? 700 : 400, color: active ? 'var(--accent)' : 'var(--muted)' }}>{t(key)}</li>;
        })}
      </ol>
      {error !== null && <Card><p role="alert" style={{ color: 'var(--danger)' }}>{error}</p></Card>}

      {step === 'input' && (
        <Card>
          <div style={{ display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'minmax(0, 1fr)' }}>
            <div style={{ display: 'grid', gap: 4, minInlineSize: 0 }}>
              <label htmlFor="bank-account">{t('bank.accountLabel')}</label>
              <input id="bank-account" value={accountLabel} onChange={(e) => setAccountLabel(e.target.value)} placeholder={t('bank.accountPlaceholder')}
            style={{ inlineSize: '100%', maxInlineSize: '100%', minInlineSize: 0 }} />
            </div>
            <div style={{ display: 'grid', gap: 4, minInlineSize: 0 }}>
              <label htmlFor="bank-file">{t('bank.pickFile')}</label>
              {/* The native file control always renders in the browser's own language,
                  so it is visually replaced by a localized button + the chosen file name. */}
              <input id="bank-file" ref={fileRef} type="file" accept=".csv,text/csv" onChange={onFile}
                style={{ position: 'absolute', inlineSize: 1, blockSize: 1, opacity: 0, overflow: 'hidden' }} />
              <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center', flexWrap: 'wrap', minInlineSize: 0 }}>
                <Button onClick={() => fileRef.current?.click()}>{t('bank.pickFile')}</Button>
                <span style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)', overflowWrap: 'anywhere' }}>
                  {fileName.length === 0 ? t('bank.noFile') : fileName}
                </span>
              </div>
            </div>
            <div style={{ display: 'grid', gap: 4, minInlineSize: 0 }}>
              <label htmlFor="bank-paste">{t('bank.pasteLabel')}</label>
              <textarea id="bank-paste" rows={8} value={rawText} onChange={(e) => setRawText(e.target.value)} placeholder={'date,payer,amount,reference\n2026-11-01,Ahmad,125.500,rent'} style={{ fontFamily: 'monospace', fontSize: 'var(--text-sm)', inlineSize: '100%', maxInlineSize: '100%', minInlineSize: 0 }} />
              <span style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)' }}>{t('bank.pasteHint')}</span>
            </div>
            <div><Button variant="primary" onClick={analyze} disabled={busy || rawText.trim().length === 0}>{busy ? t('bank.analyzing') : t('bank.analyze')}</Button></div>
          </div>
        </Card>
      )}

      {step === 'preview' && analysis !== null && (
        <div style={{ display: 'grid', gap: 'var(--space-3)', gridTemplateColumns: 'minmax(0, 1fr)' }}>
          {analysis.status === 'reupload' && analysis.existingImport !== null && (
            <Card>
              <h2 style={{ fontSize: 'var(--text-lg)' }}>{t('bank.reupload.title')}</h2>
              <p>{fill(t('bank.reupload.body'), { hash: analysis.sourceHash.slice(0, 12) })}</p>
              <p style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>{fill(t('bank.reupload.meta'), { fileName: analysis.existingImport.fileName, accountLabel: analysis.existingImport.accountLabel, lineCount: analysis.existingImport.lineCount, importedAt: analysis.existingImport.importedAtISO.slice(0, 10) })}</p>
            </Card>
          )}
          {analysis.fatal !== null && (
            <Card><p role="alert" style={{ color: 'var(--danger)' }}>{fill(t(`bank.fatal.${analysis.fatal.code}`), { value: analysis.fatal.value })}</p></Card>
          )}
          {analysis.issues.length > 0 && (
            <Card>
              <h2 style={{ fontSize: 'var(--text-lg)' }}>{t('bank.issues.title')}</h2>
              <ul style={{ margin: 0, paddingInlineStart: 20 }}>
                {analysis.issues.map((issue) => <li key={`${String(issue.rowNumber)}-${issue.code}`} style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)' }}>{issueText(issue.code, issue.rowNumber, issue.value)}</li>)}
              </ul>
            </Card>
          )}
          <Card>
            <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'center' }}>
              <h2 style={{ fontSize: 'var(--text-lg)' }}>{t('bank.preview.title')}</h2>
              <span style={{ fontSize: 'var(--text-sm)', color: 'var(--muted)' }}>{fill(t('bank.preview.summary'), { total: analysis.totalLines, fresh: analysis.newLines, duplicates: analysis.duplicateLines, errors: analysis.issues.length })}</span>
            </div>
            {analysis.rows.length === 0 ? <EmptyState title={t('bank.preview.title')} hint={t('bank.issues.none')} /> : (
              <div className="table-scroll">
                <table className="money">
                  <thead><tr>
                    <th>{t('bank.col.row')}</th><th>{t('bank.col.date')}</th><th>{t('bank.col.payer')}</th>
                    <th>{t('bank.col.amount')}</th><th>{t('bank.col.status')}</th><th>{t('bank.col.kind')}</th>
                    <th>{t('bank.col.confidence')}</th><th>{t('bank.col.reason')}</th><th>{t('bank.col.allocation')}</th>
                  </tr></thead>
                  <tbody>
                    {analysis.rows.map((row) => (
                      <tr key={row.rowNumber}>
                        <td className="tnum">{row.rowNumber}</td>
                        <td className="tnum">{row.dateISO}</td>
                        <td title={row.payerName}>{row.payerName}</td>
                        <td><MoneyText fils={row.amountFils} locale={locale} /></td>
                        <td>{row.duplicateKind === null
                          ? <Badge tone="ok">{t('bank.status.new')}</Badge>
                          : <Badge tone="warn">{row.duplicateKind === 'existing'
                              ? fill(t('bank.status.duplicateExisting'), { date: row.duplicateOfDateISO ?? '—' })
                              : t('bank.status.duplicateInFile')}</Badge>}</td>
                        <td>{row.suggestion === null ? '—' : <Badge tone={kindTone[row.suggestion.kind] ?? 'neutral'}>{t(`bank.kind.${row.suggestion.kind}`)}</Badge>}</td>
                        <td className="tnum">{row.suggestion === null ? '—' : `${Math.round(row.suggestion.confidence * 100)}%`}</td>
                        <td style={{ fontSize: 'var(--text-xs)' }}>{row.suggestion?.reason ?? '—'}</td>
                        <td>{row.allocations.length === 0 ? t('bank.allocation.none')
                          : fill(t('bank.allocation.total'), { amount: formatMoney(sumPlan(row.allocations), locale) })}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)' }}>{t('bank.postable.note')}</p>
            <p style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)' }}>{t('bank.confirmHint')}</p>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <Button onClick={() => { setStep('input'); }}>{t('bank.back')}</Button>
              <Button variant="primary" onClick={confirm} disabled={busy || analysis.status !== 'ready'}>
                {busy ? t('bank.confirming') : t('bank.confirm')}
              </Button>
              {analysis.status === 'invalid' && <span style={{ fontSize: 'var(--text-sm)', color: 'var(--danger)' }}>{t('bank.confirmBlocked')}</span>}
            </div>
          </Card>
        </div>
      )}

      {step === 'done' && result !== null && (
        <Card>
          <div aria-live="polite" style={{ display: 'grid', gap: 'var(--space-2)' }}>
            <h2 style={{ fontSize: 'var(--text-lg)' }}>{result.status === 'imported' ? t('bank.done.title') : t('bank.already.title')}</h2>
            <p>{result.status === 'imported'
              ? fill(t('bank.done.body'), { id: result.importId ?? '—' })
              : fill(t('bank.already.body'), { hash: analysis?.sourceHash.slice(0, 12) ?? '—', id: result.importId ?? '—' })}</p>
            <ul style={{ margin: 0, paddingInlineStart: 20, fontSize: 'var(--text-sm)' }}>
              <li>{fill(t('bank.done.lines'), { count: result.insertedLines })}</li>
              <li>{fill(t('bank.done.duplicates'), { count: result.duplicateLines })}</li>
              <li>{fill(t('bank.done.suggestions'), { count: result.suggestions })}</li>
              <li>{fill(t('bank.done.payments'), { count: result.payments })}</li>
              <li>{fill(t('bank.done.allocations'), { count: result.allocations })}</li>
            </ul>
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <Button variant="primary" onClick={reset}>{t('bank.reset')}</Button>
              <Link href="/ledger"><Button>{t('bank.toLedger')}</Button></Link>
            </div>
          </div>
        </Card>
      )}

      <Card>
        <h2 style={{ fontSize: 'var(--text-lg)' }}>{t('bank.recent.title')}</h2>
        {recent.length === 0 ? <EmptyState title={t('bank.recent.title')} hint={t('bank.recent.empty')} /> : (
          <div className="table-scroll">
            <table className="money">
              <thead><tr><th>{t('bank.recent.col.file')}</th><th>{t('bank.recent.col.account')}</th><th>{t('bank.recent.col.lines')}</th><th>{t('bank.recent.col.at')}</th></tr></thead>
              <tbody>
                {recent.map((record) => (
                  <tr key={record.id}><td title={record.fileName}>{record.fileName}</td><td title={record.accountLabel}>{record.accountLabel}</td><td className="tnum">{record.lineCount}</td><td className="tnum">{record.importedAtISO.slice(0, 10)}</td></tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
