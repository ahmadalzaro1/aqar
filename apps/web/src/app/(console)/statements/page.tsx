import Link from 'next/link';
import { Badge, Button, Card, EmptyState, MoneyText, formatPercentBps } from '@aqar/ui';
import { getSessionUser } from '@/lib/auth';
import { getLocale } from '@/i18n/server';
import { shiftPeriod } from '@/lib/period';
import {
  computeStatement, distributionDrafts, ownerShareAmount, parseStatementPeriod,
} from './lib';
import { statementStrings, periodLabel, issuedLabel } from './dict';
import {
  existingStatement, expenseLines, feeBasisBps, latestDataPeriod, listOwners,
  listProperties, propertyShares, rentLines,
} from './queries';
import { IssuePanel } from './IssuePanel';

export default async function StatementsPage({ searchParams }: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await getSessionUser();
  if (user === null) return null;
  const locale = await getLocale();
  const s = statementStrings(locale);
  const sp = await searchParams;
  const pick = (key: string): string | undefined => {
    const v = sp[key];
    return typeof v === 'string' ? v : undefined;
  };

  const [owners, properties, dataPeriod] = await Promise.all([
    listOwners(user.orgId), listProperties(user.orgId), latestDataPeriod(user.orgId),
  ]);
  const propertyId = pick('property') ?? properties[0]?.id ?? '';
  const ownerId = pick('owner') ?? owners[0]?.id ?? '';
  const period = parseStatementPeriod(pick('period')) ?? parseStatementPeriod(dataPeriod ?? undefined) ?? '2026-01';
  if (propertyId === '') {
    return <EmptyState title={s.title} hint={s.emptyRent} />;
  }

  const [rent, expenses, shares, fee, issued] = await Promise.all([
    rentLines(user.orgId, propertyId, period),
    expenseLines(user.orgId, propertyId, period),
    propertyShares(user.orgId, propertyId),
    feeBasisBps(user.orgId, propertyId),
    existingStatement(user.orgId, propertyId, period),
  ]);
  const draft = computeStatement({ propertyId, period, rentLines: rent, expenseLines: expenses, shares, feeBasisBps: fee.bps });
  const ownerName = (id: string): string => {
    const o = owners.find((x) => x.id === id);
    return o === undefined ? id : locale === 'ar' ? o.nameAr : o.nameEn;
  };
  const propertyName = properties.find((p) => p.id === propertyId)?.name ?? propertyId;
  const drafts = distributionDrafts(draft);
  const blockedText = draft.blocked === null ? null
    : draft.blocked.code === 'shortfall' ? s.blockedShortfall
    : draft.blocked.code === 'no-owners' ? s.blockedNoOwners
    : s.blockedInvalidShares;
  const qs = (p: string) => `/statements?property=${propertyId}&owner=${ownerId}&period=${p}`;

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <div className="no-print">
        <h1 style={{ fontSize: 'var(--text-xl)' }}>{s.title}</h1>
        <p style={{ color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>{s.subtitle}</p>
      </div>

      <form className="no-print" method="GET" action="/statements" style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'end', minInlineSize: 0, maxInlineSize: '100%' }}>
        <label style={{ display: 'grid', gap: 4, fontSize: 'var(--text-sm)', minInlineSize: 0, maxInlineSize: '100%' }}>{s.property}
          <select name="property" defaultValue={propertyId} style={{ inlineSize: '100%', maxInlineSize: '100%', minInlineSize: 0 }}>
            {properties.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 'var(--text-sm)', minInlineSize: 0, maxInlineSize: '100%' }}>{s.owner}
          <select name="owner" defaultValue={ownerId} style={{ inlineSize: '100%', maxInlineSize: '100%', minInlineSize: 0 }}>
            {owners.map((o) => <option key={o.id} value={o.id}>{locale === 'ar' ? o.nameAr : o.nameEn}</option>)}
          </select>
        </label>
        <label style={{ display: 'grid', gap: 4, fontSize: 'var(--text-sm)', minInlineSize: 0, maxInlineSize: '100%' }}>{s.period}
          <input name="period" defaultValue={period} pattern="[0-9]{4}-(0[1-9]|1[0-2])" style={{ inlineSize: '100%', maxInlineSize: '100%', minInlineSize: 0 }} />
        </label>
        <Button type="submit">{s.refresh}</Button>
        <Link href={qs(shiftPeriod(period, -1))}><Button aria-label={s.prevPeriod}>←</Button></Link>
        <Link href={qs(shiftPeriod(period, 1))}><Button aria-label={s.nextPeriod}>→</Button></Link>
      </form>

      <Card>
        <div style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'center' }}>
          <h2 style={{ fontSize: 'var(--text-lg)' }}>{propertyName} · {periodLabel(period, locale)}</h2>
          {issued !== null && <Badge tone="ok">{s.issuedBadge} · {issuedLabel(issued.issuedAtISO, locale)}</Badge>}
        </div>

        <h3 style={{ fontSize: 'var(--text-md)', marginBlockStart: 'var(--space-3)' }}>{s.rentSection}</h3>
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)' }}>{s.rentHint}</p>
        {rent.length === 0 ? <EmptyState title={s.rentSection} hint={s.emptyRent} /> : (
          <div className="table-scroll">
            <table className="money">
              <thead><tr><th>{s.colUnit}</th><th>{s.tenant}</th><th>{s.colBilled}</th><th>{s.colCollected}</th></tr></thead>
              <tbody>
                {rent.map((r) => (
                  <tr key={r.leaseId}>
                    <td>{r.unitLabel}</td><td>{r.tenantName}</td>
                    <td><MoneyText fils={r.billedFils} locale={locale} /></td>
                    <td><MoneyText fils={r.collectedFils} locale={locale} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr>
                <td colSpan={2}><strong>{s.totalRow}</strong></td>
                <td><MoneyText fils={draft.billedRentFils} locale={locale} strong /></td>
                <td><MoneyText fils={draft.grossCollectedFils} locale={locale} strong /></td>
              </tr></tfoot>
            </table>
          </div>
        )}

        <h3 style={{ fontSize: 'var(--text-md)', marginBlockStart: 'var(--space-3)' }}>{s.deductions}</h3>
        <div className="table-scroll">
          <table className="money">
            <tbody>
              <tr><td>{s.grossCollected}</td><td><MoneyText fils={draft.grossCollectedFils} locale={locale} /></td></tr>
              <tr><td>{s.billedRent} · {s.collectionRate} {formatPercentBps(draft.collectionRateBps, locale)}</td><td><MoneyText fils={draft.billedRentFils} locale={locale} /></td></tr>
              <tr>
                <td>{s.feeLine} ({s.feeRate} {formatPercentBps(draft.feeBps, locale)} — {fee.recorded ? s.feeRecorded : s.feeComputed})</td>
                <td>−<MoneyText fils={draft.managementFeeFils} locale={locale} /></td>
              </tr>
              <tr>
                <td>{s.expensesLine} ({s.expensesHint})</td>
                <td>−<MoneyText fils={draft.expensesFils} locale={locale} /></td>
              </tr>
              {expenses.length === 0 && <tr><td colSpan={2} style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)' }}>{s.emptyExpenses}</td></tr>}
              {expenses.map((e) => (
                <tr key={e.workOrderId}><td style={{ fontSize: 'var(--text-xs)' }}>{e.label} · {e.completedISO}</td><td><MoneyText fils={e.costFils} locale={locale} /></td></tr>
              ))}
              <tr><td>{s.reserveLine}</td><td>−<MoneyText fils={draft.reserveFils} locale={locale} /></td></tr>
              <tr>
                <td><strong>{s.netLine}</strong></td>
                <td>{draft.netFils === null ? <Badge tone="danger">{s.blockedTitle}</Badge> : <MoneyText fils={draft.netFils} locale={locale} strong />}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {blockedText !== null && <p role="alert" style={{ color: 'var(--danger)', fontSize: 'var(--text-sm)', overflowWrap: 'anywhere' }}>{blockedText}: {draft.blocked?.detail}</p>}

        <h3 style={{ fontSize: 'var(--text-md)', marginBlockStart: 'var(--space-3)' }}>{s.shareSection}</h3>
        {draft.ownerShares.length === 0 ? <EmptyState title={s.shareSection} hint={s.ownerNoShare} /> : (
          <div className="table-scroll">
            <table className="money">
              <thead><tr><th>{s.owner}</th><th>{s.shareOwnership}</th><th>{s.shareAmount}</th></tr></thead>
              <tbody>
                {draft.ownerShares.map((sh) => (
                  <tr key={sh.ownerId} style={sh.ownerId === ownerId ? { background: 'var(--accent-soft)' } : undefined}>
                    <td>{ownerName(sh.ownerId)}</td>
                    <td className="tnum">{formatPercentBps(sh.shareBps, locale)}</td>
                    <td><MoneyText fils={sh.amountFils} locale={locale} strong={sh.ownerId === ownerId} /></td>
                  </tr>
                ))}
              </tbody>
              <tfoot><tr>
                <td colSpan={2}><strong>{s.shareTotal}</strong></td>
                <td><MoneyText fils={draft.netFils ?? 0} locale={locale} strong /></td>
              </tr></tfoot>
            </table>
          </div>
        )}
        <p style={{ fontSize: 'var(--text-xs)', color: 'var(--muted)' }}>
          {s.distributionPreview}: {drafts.length} · {s.distributionHint}
        </p>
        {ownerId !== '' && draft.blocked === null && (
          <p style={{ fontSize: 'var(--text-sm)' }}><strong>{ownerName(ownerId)}</strong>: <MoneyText fils={ownerShareAmount(draft, ownerId)} locale={locale} strong /></p>
        )}
      </Card>

      <IssuePanel propertyId={propertyId} period={period} s={s} alreadyIssued={issued !== null} blocked={draft.blocked !== null} />
    </div>
  );
}
