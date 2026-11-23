import Link from 'next/link';
import { Card, Badge, EmptyState } from '@aqar/ui';
import { occupancyRate, delinquencyRateBps, collectionRateBps } from '@aqar/core';
import { getSessionUser } from '@/lib/auth';
import { getLocale, getMessages, t } from '@/i18n/server';
import { atlasSites, ticketsForOrg, ticketCounts, collectionTotals } from '@/lib/queries';
import { currentPeriod } from '@/lib/period';
import { EstateAtlas } from '@/components/EstateAtlas';
import { EstateMap3DClient } from '@/components/EstateMap3DClient';

/**
 * Labels the atlas needs, translated once on the server. The atlas is a client
 * component only so a flat can be selected; the copy stays in the catalogue.
 */
const ATLAS_LABEL_KEYS = [
  'atlas.legend',
  'atlas.sites',
  'atlas.flats',
  'atlas.occupancy',
  'atlas.flatsLower',
  'atlas.rent',
  'atlas.rentLower',
  'atlas.arrearsLower',
  'atlas.landArea',
  'atlas.floors',
  'atlas.floor',
  'atlas.noFloor',
  'atlas.unit',
  'atlas.area',
  'atlas.beds',
  'atlas.tenant',
  'atlas.noTenant',
  'atlas.leaseEnd',
  'atlas.balance',
  'atlas.inspect',
  'atlas.pick',
  'atlas.noUnits',
  'atlas.viewMap',
  'atlas.viewPlan',
  'atlas.viewSwitch',
  'atlas.mapNote',
  'atlas.explode',
  'atlas.collapse',
  'atlas.explodeNote',
  'atlas.apron',
  'atlas.apronCredit',
  'atlas.mapLoading',
  'atlas.mapFailed',
  'atlas.noGeo',
  'nav.leases',
  'nav.ledger',
  'nav.tickets',
  'unitStatus.occupied',
  'unitStatus.vacant',
  'unitStatus.turnover',
  'unitStatus.unavailable',
  'assetKind.parcel',
  'assetKind.building',
  'assetKind.compound',
  'assetKind.tower',
  'assetKind.farm',
  'assetKind.mixed_use',
  'assetKind.infrastructure',
] as const;

export default async function DashboardPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  // Two views of one query: the drawn elevation is the default (no WebGL, no
  // tile download), the 3D map is opt-in via ?view=3d.
  const view = (await searchParams).view === '3d' ? '3d' : 'plan';
  const user = await getSessionUser();
  if (user === null) return null;
  const locale = await getLocale();
  const m = await getMessages();
  const sites = await atlasSites(user.orgId);
  const tickets = await ticketsForOrg(user.orgId, 8);
  const counts = await ticketCounts(user.orgId);
  const period = currentPeriod();
  const totals = await collectionTotals(user.orgId, period);

  if (sites.length === 0) {
    return (
      <EmptyState
        title={t(m, 'dash.empty.title')}
        hint={t(m, 'dash.empty.hint')}
        action={
          <code style={{ background: 'var(--surface-3)', padding: '4px 8px', borderRadius: 6 }}>
            {t(m, 'dash.empty.action')}
          </code>
        }
      />
    );
  }

  // KPIs are portfolio-wide; the atlas below is the same set of flats, drawn.
  const allUnits = sites.flatMap((s) => s.units);
  const occ = occupancyRate(allUnits.map((u) => ({ status: u.status })));
  const delinq = delinquencyRateBps(Math.max(0, totals.billed - totals.collected), totals.billed);
  const coll = collectionRateBps(totals.collected, totals.billed);
  // Same numeral system as the atlas below (Latin digits), so the strip and the
  // units it summarises are read the same way.
  const numLocale = locale === 'ar' ? 'ar-JO-u-nu-latn' : 'en-US';
  const nf = new Intl.NumberFormat(numLocale);
  const percent = new Intl.NumberFormat(numLocale, {
    style: 'percent',
    maximumFractionDigits: 1,
  });
  const pct = (bps: number) => percent.format(bps / 10000);
  const labels: Record<string, string> = Object.fromEntries(
    ATLAS_LABEL_KEYS.map((key) => [key, t(m, key)]),
  );

  const stats: Array<{ label: string; value: string; tone?: 'danger' | 'ok' | 'warn' }> = [
    { label: t(m, 'dash.occupancy'), value: pct(occ) },
    {
      label: t(m, 'dash.collection'),
      value: pct(coll),
      tone: coll >= 8000 ? 'ok' : coll < 5000 ? 'danger' : 'warn',
    },
    {
      label: t(m, 'dash.delinquency'),
      value: pct(delinq),
      ...(delinq > 0 ? { tone: 'danger' as const } : {}),
    },
    { label: t(m, 'dash.openTickets'), value: nf.format(counts.open) },
    {
      label: t(m, 'dash.emergencies'),
      value: nf.format(counts.emergencies),
      ...(counts.emergencies > 0 ? { tone: 'danger' as const } : {}),
    },
  ];

  return (
    <div
      style={{
        display: 'grid',
        gap: 'var(--space-4)',
        // The assistant dock is fixed at the bottom corner of every console page;
        // without this clearance it covers the last row of flats on a phone.
        paddingBlockEnd: 'calc(var(--space-10, 56px) + 40px)',
      }}
    >
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 'var(--space-3)',
          alignItems: 'baseline',
          justifyContent: 'space-between',
        }}
      >
        <h1 style={{ fontSize: 'var(--text-xl)', margin: 0 }}>{t(m, 'dash.title')}</h1>
        <p style={{ margin: 0, color: 'var(--muted)', fontSize: 'var(--text-sm)' }}>
          {period} · {nf.format(allUnits.length)} {t(m, 'dash.units')}
        </p>
      </div>

      {counts.emergencies > 0 && (
        <div
          role="alert"
          style={{
            background: 'var(--danger-soft)',
            color: 'var(--danger)',
            border: '1px solid var(--danger)',
            borderRadius: 'var(--radius)',
            padding: 'var(--space-3)',
            fontWeight: 600,
          }}
        >
          {t(m, 'tickets.emergencyBanner')} ({nf.format(counts.emergencies)})
        </div>
      )}

      {/* The portfolio is drawn before the numbers are counted: the first thing a
          guest should read on entry is land, buildings and the flats inside them. */}
      <nav
        aria-label={t(m, 'atlas.viewSwitch')}
        style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
      >
        {[
          { href: '?view=3d', key: 'atlas.viewMap', on: view === '3d' },
          { href: '?view=plan', key: 'atlas.viewPlan', on: view !== '3d' },
        ].map((item) => (
          <Link
            key={item.href}
            href={item.href}
            aria-current={item.on ? 'page' : undefined}
            prefetch={false}
            style={{
              padding: '5px 12px',
              borderRadius: 999,
              fontSize: 13,
              textDecoration: 'none',
              color: 'var(--ink)',
              border: `1px solid ${item.on ? 'var(--ok)' : 'var(--border)'}`,
              background: item.on ? 'var(--ok-soft)' : 'var(--surface)',
              fontWeight: item.on ? 600 : 400,
            }}
          >
            {t(m, item.key)}
          </Link>
        ))}
      </nav>

      {view === '3d' ? (
        <EstateMap3DClient sites={sites} locale={locale} labels={labels} />
      ) : (
        <EstateAtlas sites={sites} locale={locale} labels={labels} />
      )}

      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'stretch',
          padding: 'var(--space-2) var(--space-4)',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-1)',
        }}
      >
        {stats.map((s, i) => (
          <div
            key={s.label}
            style={{
              display: 'grid',
              gap: 2,
              flex: '1 1 0',
              minInlineSize: 88,
              paddingBlock: 'var(--space-2)',
              paddingInlineEnd: i === stats.length - 1 ? 0 : 'var(--space-4)',
              borderInlineEnd: i === stats.length - 1 ? undefined : '1px solid var(--border)',
            }}
          >
            <span
              style={{
                color: 'var(--muted)',
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: '0.04em',
              }}
            >
              {s.label}
            </span>
            <span
              className="tnum"
              style={{
                fontSize: 'var(--text-xl)',
                fontWeight: 650,
                lineHeight: 1.15,
                color:
                  s.tone === 'danger'
                    ? 'var(--danger)'
                    : s.tone === 'ok'
                      ? 'var(--ok)'
                      : s.tone === 'warn'
                        ? 'var(--warn)'
                        : 'var(--ink)',
              }}
            >
              {s.value}
            </span>
          </div>
        ))}
      </div>

      <Card
        title={t(m, 'dash.recentTickets')}
        action={<Link href="/tickets">{t(m, 'nav.tickets')}</Link>}
      >
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t(m, 'tickets.severity')}</th>
                <th>{t(m, 'tickets.category')}</th>
                <th>{t(m, 'ledger.unit')}</th>
                <th>{t(m, 'tickets.status')}</th>
                <th>{t(m, 'tickets.opened')}</th>
              </tr>
            </thead>
            <tbody>
              {tickets.map((tk) => (
                <tr key={tk.id}>
                  <td>
                    <Badge
                      tone={
                        tk.severity === 'emergency'
                          ? 'danger'
                          : tk.severity === 'high'
                            ? 'warn'
                            : 'neutral'
                      }
                    >
                      {tk.severity === null ? '—' : t(m, `sev.${tk.severity}`)}
                    </Badge>
                  </td>
                  <td>{tk.category ?? '—'}</td>
                  <td>
                    {tk.unitLabel ?? '—'} · {tk.propertyName}
                  </td>
                  <td>{t(m, `ticketStatus.${tk.status}`)}</td>
                  <td className="tnum">{tk.openedAt.slice(0, 10)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
