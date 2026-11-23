'use client';

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { Locale } from '@aqar/contracts';
import { Badge } from '@aqar/ui';
import type { AtlasSite, AtlasUnit } from '@/lib/queries';
import { cn } from '@aqar/ui';
import styles from './EstateAtlas.module.css';

type Tone = 'neutral' | 'accent' | 'danger' | 'warn' | 'ok';

const STATUS_TONE: Record<string, Tone> = {
  occupied: 'ok',
  vacant: 'warn',
  turnover: 'warn',
  unavailable: 'neutral',
};

/** A row that fails this never reaches `formatDate`, which throws on Invalid Date. */
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Land → building → floors → flats, drawn from the ledger itself. Every tile is
 * a button: the atlas is a way into a unit, not decoration behind a table.
 * Floors render top-down (4 above 3) and each floor keeps its own cell row, so
 * the shape on screen matches the shape of the asset.
 */
export function EstateAtlas({
  sites,
  locale,
  labels,
}: {
  sites: AtlasSite[];
  locale: Locale;
  labels: Record<string, string>;
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  // Latin digits on purpose: unit numbers and dates are Latin identifiers, and a
  // finance screen that mixes ٢٠١ with 201 makes the reader convert mid-scan.
  const numLocale = locale === 'ar' ? 'ar-JO-u-nu-latn' : 'en-GB';
  const nf = useMemo(() => new Intl.NumberFormat(numLocale), [numLocale]);
  const pct = useMemo(
    () => new Intl.NumberFormat(numLocale, { style: 'percent', maximumFractionDigits: 1 }),
    [numLocale],
  );
  const date = useMemo(
    () =>
      new Intl.DateTimeFormat(numLocale, {
        day: 'numeric',
        month: 'short',
        year: 'numeric',
        timeZone: 'UTC',
      }),
    [numLocale],
  );
  const money = useMemo(
    () =>
      new Intl.NumberFormat(numLocale, {
        style: 'currency',
        currency: 'JOD',
        minimumFractionDigits: 3,
      }),
    [numLocale],
  );
  const rtl = locale === 'ar';
  const t = (key: string) => labels[key] ?? key;

  // Whole-JOD figures on a tile: 545.000 fils-decimal precision belongs in the
  // inspector, not in a 44px window.
  const jod = (fils: number) => nf.format(Math.round(fils / 1000));

  const selected = useMemo(() => {
    for (const site of sites) {
      for (const unit of site.units) {
        if (unit.id === selectedId) return { site, unit };
      }
    }
    return null;
  }, [sites, selectedId]);

  const totals = useMemo(() => {
    const units = sites.reduce((s, x) => s + x.units.length, 0);
    const occupied = sites.reduce(
      (s, x) => s + x.units.filter((u) => u.status === 'occupied').length,
      0,
    );
    const rent = sites.reduce((s, x) => s + x.units.reduce((a, u) => a + u.marketRentFils, 0), 0);
    const arrears = sites.reduce((s, x) => s + x.units.reduce((a, u) => a + u.balanceFils, 0), 0);
    return { units, occupied, rent, arrears };
  }, [sites]);

  /** Arrow keys walk the elevation: up/down a floor, start/end across a floor. */
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const el = event.target;
    if (!(el instanceof HTMLElement) || el.dataset['atlasTile'] === undefined) return;
    const site = Number(el.dataset['site']);
    const floor = Number(el.dataset['floor']);
    const col = Number(el.dataset['col']);
    const find = (f: number, c: number) =>
      gridRef.current?.querySelector<HTMLElement>(
        `[data-atlas-tile][data-site="${site}"][data-floor="${f}"][data-col="${c}"]`,
      ) ?? null;

    // Every branch below assigns or returns, so no initialiser is needed.
    let target: HTMLElement | null;
    switch (event.key) {
      case 'ArrowUp':
        target = find(floor - 1, col);
        break;
      case 'ArrowDown':
        target = find(floor + 1, col);
        break;
      case 'ArrowRight':
        target = find(floor, rtl ? col - 1 : col + 1);
        break;
      case 'ArrowLeft':
        target = find(floor, rtl ? col + 1 : col - 1);
        break;
      case 'Home':
        target = find(floor, 0);
        break;
      case 'End': {
        let last = col;
        while (find(floor, last + 1) !== null) last += 1;
        target = find(floor, last);
        break;
      }
      default:
        return;
    }
    // No neighbour in that direction: keep the key inert rather than scrolling.
    event.preventDefault();
    target?.focus();
  }

  function ariaLabel(site: AtlasSite, unit: AtlasUnit): string {
    const parts = [
      `${t('atlas.unit')} ${unit.unitNumber}`,
      locale === 'ar' ? site.nameAr : site.name,
      t(`unitStatus.${unit.status}`),
      `${t('atlas.rent')} ${jod(unit.marketRentFils)}`,
    ];
    if (unit.floor !== null) parts.push(`${t('atlas.floor')} ${unit.floor}`);
    if (unit.tenantName !== null) parts.push(unit.tenantName);
    return parts.join(' · ');
  }

  const floorGroups = (site: AtlasSite) => {
    const map = new Map<string, AtlasUnit[]>();
    for (const unit of site.units) {
      const key = unit.floor ?? t('atlas.noFloor');
      map.set(key, [...(map.get(key) ?? []), unit]);
    }
    return [...map.entries()]
      .map(([key, units]) => ({
        key,
        units: [...units].sort((a, b) => a.unitNumber.localeCompare(b.unitNumber)),
      }))
      .sort((a, b) => {
        const fa = Number(a.key);
        const fb = Number(b.key);
        if (Number.isNaN(fa) || Number.isNaN(fb)) return b.key.localeCompare(a.key);
        return fb - fa;
      });
  };

  return (
    <div className={styles.atlas}>
      <div className={styles.head}>
        <ul className={styles.legend} aria-label={t('atlas.legend')}>
          {(['occupied', 'vacant', 'turnover', 'unavailable'] as const).map((status) => (
            <li key={status} className={styles.legendItem}>
              <span className={styles.swatch} data-status={status} aria-hidden="true" />
              {t(`unitStatus.${status}`)}
            </li>
          ))}
        </ul>
        <p className={styles.totals}>
          {nf.format(sites.length)} {t('atlas.sites')} ·{' '}
          <bdi dir="ltr" className="tnum">
            {nf.format(totals.occupied)}/{nf.format(totals.units)}
          </bdi>{' '}
          {t('atlas.flatsLower')} · <bdi dir="ltr">{money.format(totals.rent / 1000)}</bdi>{' '}
          {t('atlas.rentLower')}
          {totals.arrears > 0 && (
            <>
              {' · '}
              <span className={styles.arrears}>
                <bdi dir="ltr">{money.format(totals.arrears / 1000)}</bdi> {t('atlas.arrearsLower')}
              </span>
            </>
          )}
        </p>
      </div>

      <div className={styles.body}>
        <div className={styles.sites} ref={gridRef} onKeyDown={onKeyDown}>
          {sites.map((site, si) => {
            const occupied = site.units.filter((u) => u.status === 'occupied').length;
            const occBps =
              site.units.length === 0 ? 0 : Math.round((occupied / site.units.length) * 10000);
            const rent = site.units.reduce((a, u) => a + u.marketRentFils, 0);
            const groups = floorGroups(site);
            return (
              <article key={site.id} className={styles.site} aria-labelledby={`site-name-${si}`}>
                <header className={styles.siteHead}>
                  <div className={styles.siteIdent}>
                    <h2 id={`site-name-${si}`} className={styles.siteName}>
                      {locale === 'ar' ? site.nameAr : site.name}
                    </h2>
                    <p className={styles.siteMeta}>
                      {site.district} · {site.city}
                      {site.landAreaSqm !== null && (
                        <>
                          {' · '}
                          {t('atlas.landArea')} {nf.format(site.landAreaSqm)} m²
                        </>
                      )}
                      {' · '}
                      {t(`assetKind.${site.assetKind}`)}
                    </p>
                  </div>
                  <dl className={styles.siteNums}>
                    <div>
                      <dt>{t('atlas.flats')}</dt>
                      <dd className="tnum">{nf.format(site.units.length)}</dd>
                    </div>
                    <div>
                      <dt>{t('atlas.occupancy')}</dt>
                      <dd className="tnum">{pct.format(occBps / 10000)}</dd>
                    </div>
                    <div>
                      <dt>{t('atlas.rent')}</dt>
                      <dd className="tnum">{jod(rent)}</dd>
                    </div>
                  </dl>
                </header>

                <div className={styles.plate}>
                  <div className={styles.plot}>
                    {site.units.length === 0 ? (
                      <p className={styles.bareLand}>{t('atlas.noUnits')}</p>
                    ) : (
                      <div className={styles.building}>
                        <div className={styles.roof} aria-hidden="true" />
                        {groups.map((group, fi) => (
                          <div className={styles.floor} key={group.key}>
                            <span className={styles.floorLabel} aria-hidden="true">
                              {group.key}
                            </span>
                            <div className={styles.cells}>
                              {group.units.map((unit, ci) => (
                                <button
                                  key={unit.id}
                                  type="button"
                                  className={styles.tile}
                                  data-status={unit.status}
                                  data-atlas-tile=""
                                  data-site={si}
                                  data-floor={fi}
                                  data-col={ci}
                                  aria-pressed={selectedId === unit.id}
                                  aria-label={ariaLabel(site, unit)}
                                  onClick={() =>
                                    setSelectedId((prev) => (prev === unit.id ? null : unit.id))
                                  }
                                >
                                  <span className={styles.tileNum}>{unit.unitNumber}</span>
                                  <span className={styles.tileRent}>
                                    {jod(unit.marketRentFils)}
                                  </span>
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                        <div className={styles.ground} aria-hidden="true">
                          <span className={styles.door} />
                        </div>
                      </div>
                    )}
                    <p className={styles.plotMeta}>
                      <bdi>{site.buildingName ?? site.name}</bdi> ·{' '}
                      {nf.format(site.floors ?? groups.length)} {t('atlas.floors')}
                    </p>
                  </div>
                </div>
              </article>
            );
          })}
        </div>

        <aside
          className={cn(styles.inspector, selected === null && styles.inspectorIdle)}
          aria-live="polite"
        >
          {selected === null ? (
            <>
              <h2 className={styles.inspectorTitle}>{t('atlas.inspect')}</h2>
              <p className={styles.inspectorHint}>{t('atlas.pick')}</p>
            </>
          ) : (
            <>
              <p className={styles.inspectorKicker}>
                {locale === 'ar' ? selected.site.nameAr : selected.site.name}
              </p>
              <div className={styles.inspectorHead}>
                <p className={styles.inspectorUnit}>
                  {t('atlas.unit')} {selected.unit.unitNumber}
                </p>
                <Badge tone={STATUS_TONE[selected.unit.status] ?? 'neutral'}>
                  {t(`unitStatus.${selected.unit.status}`)}
                </Badge>
              </div>
              <dl className={styles.rows}>
                <div>
                  <dt>{t('atlas.rent')}</dt>
                  <dd>
                    <bdi dir="ltr">{money.format(selected.unit.marketRentFils / 1000)}</bdi>
                  </dd>
                </div>
                {selected.unit.floor !== null && (
                  <div>
                    <dt>{t('atlas.floor')}</dt>
                    <dd>{selected.unit.floor}</dd>
                  </div>
                )}
                {selected.unit.areaSqm !== null && (
                  <div>
                    <dt>{t('atlas.area')}</dt>
                    <dd className="tnum">
                      <bdi dir="ltr">{nf.format(selected.unit.areaSqm)} m²</bdi>
                    </dd>
                  </div>
                )}
                {selected.unit.bedrooms !== null && (
                  <div>
                    <dt>{t('atlas.beds')}</dt>
                    <dd className="tnum">{nf.format(selected.unit.bedrooms)}</dd>
                  </div>
                )}
                <div>
                  <dt>{t('atlas.tenant')}</dt>
                  <dd>{selected.unit.tenantName ?? t('atlas.noTenant')}</dd>
                </div>
                {selected.unit.leaseEnd !== null && ISO_DATE.test(selected.unit.leaseEnd) && (
                  <div>
                    <dt>{t('atlas.leaseEnd')}</dt>
                    <dd>
                      <bdi dir="ltr">
                        {date.format(new Date(`${selected.unit.leaseEnd}T00:00:00Z`))}
                      </bdi>
                    </dd>
                  </div>
                )}
                <div>
                  <dt>{t('atlas.balance')}</dt>
                  <dd className={selected.unit.balanceFils > 0 ? styles.owed : undefined}>
                    <bdi dir="ltr">{money.format(selected.unit.balanceFils / 1000)}</bdi>
                  </dd>
                </div>
              </dl>
              <div className={styles.inspectorLinks}>
                <Link href="/leases">{t('nav.leases')}</Link>
                <Link href="/ledger">{t('nav.ledger')}</Link>
                <Link href="/tickets">{t('nav.tickets')}</Link>
              </div>
            </>
          )}
        </aside>
      </div>
    </div>
  );
}
