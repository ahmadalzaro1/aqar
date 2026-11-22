import Link from 'next/link';
import { Badge, EmptyState } from '@aqar/ui';
import { getSessionUser } from '@/lib/auth';
import { getMessages, t } from '@/i18n/server';
import { floorPlansForOrg, propertiesForOrg } from '@/lib/plan-queries';
import { uploadPlanAction } from './actions';

const ERROR_TEXT: Record<string, string> = {
  no_file: 'plan.error.no_file',
  missing_fields: 'plan.error.missing_fields',
  bad_type: 'plan.error.bad_type',
  too_large: 'plan.error.too_large',
};

export default async function PlansPage({
  searchParams,
}: {
  searchParams: Promise<{ error?: string }>;
}) {
  const user = await getSessionUser();
  if (user === null) return null;
  const m = await getMessages();
  const [{ error }, plans, properties] = await Promise.all([
    searchParams,
    floorPlansForOrg(user.orgId),
    propertiesForOrg(user.orgId),
  ]);

  const errorKey = error === undefined ? undefined : ERROR_TEXT[error];

  return (
    <div style={{ display: 'grid', gap: 'var(--space-5)' }}>
      <header style={{ display: 'grid', gap: 'var(--space-1)' }}>
        <h1 style={{ fontSize: 'var(--text-xl)' }}>{t(m, 'plan.title')}</h1>
        <p style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-sm)' }}>
          {t(m, 'plan.subtitle')}
        </p>
      </header>

      {errorKey !== undefined && (
        <p style={{ color: 'var(--destructive, #b42318)', fontSize: 'var(--text-sm)' }}>
          {t(m, errorKey)}
        </p>
      )}
      {error !== undefined && errorKey === undefined && (
        <p style={{ color: 'var(--destructive, #b42318)', fontSize: 'var(--text-sm)' }}>{error}</p>
      )}

      <form
        id="plan-upload"
        action={uploadPlanAction}
        style={{
          display: 'grid',
          gap: 'var(--space-3)',
          padding: 'var(--space-4)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--radius-md, 10px)',
          background: 'var(--card)',
        }}
      >
        <strong style={{ fontSize: 'var(--text-sm)' }}>{t(m, 'plan.upload')}</strong>
        <div
          style={{ display: 'flex', gap: 'var(--space-3)', flexWrap: 'wrap', alignItems: 'end' }}
        >
          <label style={{ display: 'grid', gap: 4, fontSize: 'var(--text-xs)' }}>
            {t(m, 'plan.property')}
            <select
              name="propertyId"
              required
              defaultValue={properties[0]?.id ?? ''}
              style={{ minWidth: 220 }}
            >
              {properties.map((property) => (
                <option key={property.id} value={property.id}>
                  {property.name}
                </option>
              ))}
            </select>
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 'var(--text-xs)' }}>
            {t(m, 'plan.level')}
            <input name="level" required placeholder="ground" style={{ minWidth: 120 }} />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 'var(--text-xs)' }}>
            {t(m, 'plan.stated')}
            <input
              name="stated"
              type="number"
              step="0.01"
              min="0"
              placeholder="147"
              style={{ minWidth: 110 }}
            />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 'var(--text-xs)' }}>
            {t(m, 'plan.calibrate')}
            <input name="calibrate" placeholder="x1,y1,x2,y2,metres" style={{ minWidth: 190 }} />
          </label>
          <label style={{ display: 'grid', gap: 4, fontSize: 'var(--text-xs)' }}>
            {t(m, 'plan.file')}
            <input name="file" type="file" accept=".dxf,.dwg,.pdf" required />
          </label>
          <button
            type="submit"
            style={{ padding: '8px 16px', borderRadius: 8, border: '1px solid var(--border)' }}
          >
            {t(m, 'plan.submit')}
          </button>
        </div>
        <p style={{ color: 'var(--muted-foreground)', fontSize: 'var(--text-xs)' }}>
          {t(m, 'plan.upload.hint')}
        </p>
      </form>

      {plans.length === 0 ? (
        <EmptyState title={t(m, 'plan.empty.title')} hint={t(m, 'plan.empty.hint')} />
      ) : (
        <div className="table-scroll">
          <table>
            <thead>
              <tr>
                <th>{t(m, 'plan.property')}</th>
                <th>{t(m, 'plan.level')}</th>
                <th>{t(m, 'plan.format')}</th>
                <th>{t(m, 'plan.rooms')}</th>
                <th>{t(m, 'plan.lettable')}</th>
                <th>{t(m, 'plan.confirmed')}</th>
                <th>{t(m, 'plan.status')}</th>
              </tr>
            </thead>
            <tbody>
              {plans.map((plan) => (
                <tr key={plan.id}>
                  <td style={{ fontWeight: 600 }}>
                    <Link href={`/plans/${plan.id}`}>{plan.propertyName}</Link>
                  </td>
                  <td>{plan.level}</td>
                  <td>
                    {plan.format} · {plan.drawingUnit}
                  </td>
                  <td className="tnum">{plan.rooms}</td>
                  <td className="tnum">{plan.lettableSqm.toFixed(3)} m²</td>
                  <td className="tnum">
                    {plan.confirmed}/{plan.rooms}
                  </td>
                  <td>
                    <Badge
                      tone={plan.confirmed === plan.rooms && plan.rooms > 0 ? 'ok' : 'neutral'}
                    >
                      {plan.status}
                    </Badge>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
