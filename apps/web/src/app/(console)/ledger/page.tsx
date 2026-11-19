import Link from 'next/link';
import { Card, Badge, EmptyState, MoneyText, Button } from '@aqar/ui';
import { deriveChargeStatus } from '@aqar/core';
import type { Charge, Allocation } from '@aqar/contracts';
import { getSessionUser } from '@/lib/auth';
import { getLocale, getMessages, t } from '@/i18n/server';
import { chargesForPeriod } from '@/lib/queries';
import { currentPeriod, shiftPeriod, isPeriod } from '@/lib/period';

const tone: Record<string, 'ok' | 'warn' | 'danger' | 'neutral'> = {
  paid: 'ok', partial: 'warn', overdue: 'danger', open: 'neutral',
};

export default async function LedgerPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await getSessionUser();
  if (user === null) return null;
  const locale = await getLocale();
  const m = await getMessages();
  const sp = await searchParams;
  const raw = typeof sp['period'] === 'string' ? sp['period'] : undefined;
  const period = isPeriod(raw) ? raw : currentPeriod();
  const oweOnly = sp['owe'] === '1';
  const rows = await chargesForPeriod(user.orgId, period);
  const today = new Date().toISOString().slice(0, 10);

  const enriched = rows.map((r) => {
    const charge: Charge = {
      id: r.id, leaseId: r.leaseId, period: r.period, kind: r.kind as Charge['kind'],
      amountFils: r.amountFils, dueDateISO: r.dueDate, proratedDays: null,
    };
    const allocations: Allocation[] = r.paidFils > 0
      ? [{ paymentId: 'aggregate', chargeId: r.id, amountFils: r.paidFils }]
      : [];
    const status = deriveChargeStatus(charge, allocations, today);
    return { ...r, status, balance: r.amountFils - r.paidFils };
  });
  const shown = oweOnly ? enriched.filter((r) => r.status !== 'paid') : enriched;
  const totalBilled = shown.reduce((s, r) => s + r.amountFils, 0);
  const totalBalance = shown.reduce((s, r) => s + r.balance, 0);

  return (
    <div style={{ display: 'grid', gap: 'var(--space-4)' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap' }}>
        <h1 style={{ fontSize: 'var(--text-xl)' }}>{t(m, 'ledger.title')}</h1>
        <div style={{ display: 'flex', gap: 4, alignItems: 'center', marginInlineStart: 'auto' }}>
          <Link href={`/ledger?period=${shiftPeriod(period, -1)}${oweOnly ? '&owe=1' : ''}`}><Button aria-label={t(m, 'common.prev')}>←</Button></Link>
          <strong className="tnum" style={{ paddingInline: 8 }}>{period}</strong>
          <Link href={`/ledger?period=${shiftPeriod(period, 1)}${oweOnly ? '&owe=1' : ''}`}><Button aria-label={t(m, 'common.next')}>→</Button></Link>
        </div>
        <Link href={oweOnly ? `/ledger?period=${period}` : `/ledger?period=${period}&owe=1`}>
          <Button variant={oweOnly ? 'primary' : 'secondary'}>{oweOnly ? t(m, 'ledger.all') : t(m, 'ledger.oweOnly')}</Button>
        </Link>
      </div>
      {shown.length === 0 ? (
        <EmptyState title={t(m, 'ledger.empty.title')} hint={t(m, 'ledger.empty.hint')} />
      ) : (
        <Card>
          <table className="money">
            <thead><tr>
              <th>{t(m, 'ledger.tenant')}</th><th>{t(m, 'ledger.unit')}</th>
              <th>{t(m, 'ledger.due')}</th><th>{t(m, 'ledger.amount')}</th>
              <th>{t(m, 'ledger.paid')}</th><th>{t(m, 'ledger.balance')}</th><th>{t(m, 'ledger.status')}</th>
            </tr></thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id}>
                  <td>{r.tenantName}</td>
                  <td>{r.unitLabel} · {r.propertyName}</td>
                  <td className="tnum">{r.dueDate}</td>
                  <td><MoneyText fils={r.amountFils} locale={locale} /></td>
                  <td><MoneyText fils={r.paidFils} locale={locale} /></td>
                  <td><MoneyText fils={r.balance} locale={locale} strong={r.balance > 0} /></td>
                  <td><Badge tone={tone[r.status] ?? 'neutral'}>{t(m, `status.${r.status}`)}</Badge></td>
                </tr>
              ))}
            </tbody>
            <tfoot><tr>
              <td colSpan={3}><strong>{t(m, 'ledger.total')}</strong></td>
              <td><MoneyText fils={totalBilled} locale={locale} strong /></td>
              <td />
              <td><MoneyText fils={totalBalance} locale={locale} strong /></td>
              <td />
            </tr></tfoot>
          </table>
        </Card>
      )}
    </div>
  );
}
