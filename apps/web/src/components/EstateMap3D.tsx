'use client';

/**
 * The portfolio as a place, not a table.
 *
 * The map is real (MapLibre + OpenFreeMap tiles, no key) and the coordinates are
 * the ones on the deed record, so nothing here invents geography. Everything
 * above ground level is *derived*: each storey is a slab, each flat is a box
 * whose footprint is its recorded `area_sqm`, and the floor count comes from
 * `buildings.floors`. No surveyed drawing is claimed — the note under the map
 * says so in both languages.
 *
 * One read feeds both views: the same `atlasSites()` rows that draw the 2D
 * elevation draw this model.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
// Aliased: a bare `Map` here would shadow the global Map constructor used by
// floorsOf(), which fails at runtime rather than at review time.
import MapView, { Layer, Source } from 'react-map-gl/maplibre';
import { Canvas, Coordinates, useMap } from 'react-three-map/maplibre';
import { useFrame } from '@react-three/fiber';
import { Edges } from '@react-three/drei';
import { Color, type Group, type Mesh } from 'three';
import type { FeatureCollection } from 'geojson';
import Link from 'next/link';
import type { AtlasSite, AtlasUnit } from '@/lib/queries';
import s from './EstateMap3D.module.css';

/** Storey-to-storey height, metres. Matches nothing in the schema: it is a
 *  modelling assumption, stated here once so it is not mistaken for data. */
const FLOOR_HEIGHT = 3.2;
const UNIT_HEIGHT = 2.85;
const UNIT_GAP = 0.35;
/** Air between plates in exploded mode. A display transform, not a measured
 *  distance: the schema records floor labels, never slab-to-slab gaps. */
const EXPLODE_GAP = 3.6;
/** How far a vacant flat rises out of its plate when exploded. */
const VACANT_LIFT = 2.4;
const ZOOM = 19.2;
const PITCH = 50;
const BEARING = -22;
/** Calm, keyless vector style: OpenFreeMap is OSM-derived and needs no key. */
const MAP_STYLE = 'https://tiles.openfreemap.org/styles/positron';

type Tone = 'occupied' | 'vacant' | 'turnover' | 'unavailable';

const STATUS_TONE: Record<string, Tone> = {
  occupied: 'occupied',
  vacant: 'vacant',
  turnover: 'turnover',
  unavailable: 'unavailable',
};

/** Read the design tokens once so the 3D masses match the 2D atlas, in both themes. */
function useStatusColours(): Record<Tone, string> {
  return useMemo(() => {
    const read = (name: string, fallback: string) => {
      if (typeof window === 'undefined') return fallback;
      const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
      return v === '' ? fallback : v;
    };
    return {
      occupied: read('--ok', '#067647'),
      vacant: read('--surface', '#ffffff'),
      turnover: read('--warn-soft', '#fef0c7'),
      unavailable: read('--surface-3', '#eef2f1'),
    };
  }, []);
}

interface FloorGroup {
  floor: string;
  units: AtlasUnit[];
}

/** Floors in climbing order, each holding the flats recorded on it. */
function floorsOf(site: AtlasSite): FloorGroup[] {
  const groups = new Map<string, AtlasUnit[]>();
  for (const unit of site.units) {
    const key = unit.floor === null || unit.floor.trim() === '' ? '—' : unit.floor;
    const list = groups.get(key);
    if (list === undefined) groups.set(key, [unit]);
    else list.push(unit);
  }
  return [...groups.entries()]
    .map(([floor, units]) => ({ floor, units }))
    .sort((a, b) => {
      const na = Number(a.floor);
      const nb = Number(b.floor);
      if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
      return a.floor.localeCompare(b.floor);
    });
}

/**
 * A plausible rectangle for one storey: the recorded areas tell us how much
 * floor there is, not what shape it is, so we assume a common depth ratio and
 * centre it on the site's coordinates.
 */
function footprintOf(floors: FloorGroup[]): { width: number; depth: number } {
  const ground = floors[0]?.units ?? [];
  const area = ground.reduce((sum, u) => sum + (u.areaSqm ?? 90), 0);
  const safe = Math.max(120, area);
  const width = Math.sqrt(safe * 1.35);
  return { width, depth: safe / width };
}

function Camera({ latitude, longitude }: { latitude: number; longitude: number }) {
  const map = useMap();
  const first = useRef(true);
  useEffect(() => {
    if (first.current === true) {
      first.current = false;
      return;
    }
    map.flyTo({
      center: [longitude, latitude],
      zoom: ZOOM,
      pitch: PITCH,
      bearing: BEARING,
      duration: 1100,
    });
  }, [map, latitude, longitude]);
  return null;
}

interface ModelProps {
  site: AtlasSite;
  colours: Record<Tone, string>;
  selectedId: string | null;
  onSelect: (unit: AtlasUnit) => void;
  exploded: boolean;
}

interface PlateProps extends Omit<ModelProps, 'site'> {
  group: FloorGroup;
  floorIndex: number;
  width: number;
  depth: number;
  hovered: string | null;
  onHover: (id: string | null) => void;
}

/**
 * One storey: a slab plus the flats recorded on it.
 *
 * Height is animated through useFrame and never re-derived from props on
 * re-render, so selecting a flat mid-transition cannot snap the stack back.
 */
function FloorPlate({
  group,
  floorIndex,
  width,
  depth,
  colours,
  selectedId,
  hovered,
  onHover,
  onSelect,
  exploded,
}: PlateProps) {
  const plate = useRef<Group>(null);
  const blocks = useRef(new Map<string, Mesh>());

  /** Flats fill the plate in proportion to their recorded area — no polygons. */
  const layout = useMemo(() => {
    const totalArea = group.units.reduce((sum, u) => sum + (u.areaSqm ?? 90), 0);
    let cursor = -width / 2;
    return group.units.map((unit) => {
      const share = (unit.areaSqm ?? 90) / totalArea;
      const unitWidth = Math.max(2.2, width * share - UNIT_GAP);
      const x = cursor + (width * share) / 2;
      cursor += width * share;
      return { unit, x, unitWidth };
    });
  }, [group, width]);

  useFrame((_, delta) => {
    const k = Math.min(1, delta * 7);
    const targetY = floorIndex * FLOOR_HEIGHT + (exploded ? floorIndex * EXPLODE_GAP : 0);
    if (plate.current !== null) {
      plate.current.position.y += (targetY - plate.current.position.y) * k;
      // Measured, not asserted: tests read these live group positions.
      const w = window as unknown as { __aqarPlates?: number[] };
      w.__aqarPlates = w.__aqarPlates ?? [];
      w.__aqarPlates[floorIndex] = plate.current.position.y;
    }
    for (const { unit } of layout) {
      const mesh = blocks.current.get(unit.id);
      if (mesh === undefined) continue;
      // Only vacancy lifts: an occupied flat staying put is the signal.
      const target =
        0.2 + UNIT_HEIGHT / 2 + (exploded && unit.status === 'vacant' ? VACANT_LIFT : 0);
      mesh.position.y += (target - mesh.position.y) * k;
      const u = window as unknown as {
        __aqarUnits?: Record<string, { y: number; floor: number; status: string }>;
      };
      u.__aqarUnits = u.__aqarUnits ?? {};
      u.__aqarUnits[unit.id] = {
        y: Math.round(mesh.position.y * 100) / 100,
        floor: floorIndex,
        status: unit.status,
      };
    }
  });

  return (
    <group ref={plate} position={[0, floorIndex * FLOOR_HEIGHT, 0]}>
      {/* the slab: what makes a stack read as storeys rather than as cells */}
      <mesh position={[0, 0.1, 0]}>
        <boxGeometry args={[width + 0.6, 0.2, depth + 0.6]} />
        <meshStandardMaterial color={colours.unavailable} />
        <Edges color={colours.occupied} threshold={15} opacity={0.5} transparent />
      </mesh>

      {layout.map(({ unit, x, unitWidth }) => {
        const tone = STATUS_TONE[unit.status] ?? 'unavailable';
        const active = unit.id === selectedId;
        const lifted = unit.id === hovered && selectedId === null;

        return (
          <mesh
            key={unit.id}
            ref={(mesh) => {
              if (mesh === null) blocks.current.delete(unit.id);
              else blocks.current.set(unit.id, mesh);
            }}
            position={[x, 0.2 + UNIT_HEIGHT / 2, active ? 1.15 : 0]}
            onPointerOver={(e) => {
              e.stopPropagation();
              onHover(unit.id);
              document.body.style.cursor = 'pointer';
            }}
            onPointerOut={() => {
              onHover(null);
              document.body.style.cursor = '';
            }}
            onClick={(e) => {
              e.stopPropagation();
              onSelect(unit);
            }}
          >
            <boxGeometry args={[unitWidth, UNIT_HEIGHT, depth - UNIT_GAP]} />
            <meshStandardMaterial
              color={new Color(colours[tone])}
              emissive={active ? colours[tone] : lifted ? colours.turnover : '#000000'}
              emissiveIntensity={active ? 0.6 : lifted ? 0.12 : 0}
              roughness={0.72}
              metalness={0.05}
            />
            <Edges
              color={active ? '#14201e' : colours.unavailable}
              threshold={15}
              opacity={active ? 1 : 0.55}
              transparent
            />
          </mesh>
        );
      })}
    </group>
  );
}

function Massing({ site, colours, selectedId, onSelect, exploded }: ModelProps) {
  const floors = useMemo(() => floorsOf(site), [site]);
  const { width, depth } = useMemo(() => footprintOf(floors), [floors]);
  const [hovered, setHovered] = useState<string | null>(null);

  const parcel = useMemo(() => {
    const area = site.landAreaSqm ?? width * depth * 2.2;
    const side = Math.sqrt(area);
    return { width: Math.max(side, width * 1.4), depth: Math.max(side, depth * 1.4) };
  }, [site.landAreaSqm, width, depth]);

  return (
    <Coordinates latitude={site.lat ?? 0} longitude={site.lng ?? 0}>
      <ambientLight intensity={0.85} />
      <directionalLight position={[width * 0.8, 60, depth]} intensity={1.5} />

      {/* The land itself: a plate under the building, with its boundary drawn. */}
      <mesh position={[0, -0.05, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[parcel.width, parcel.depth]} />
        <meshStandardMaterial color={colours.unavailable} transparent opacity={0.5} />
      </mesh>
      <mesh position={[0, 0.02, 0]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[parcel.width, parcel.depth]} />
        <meshBasicMaterial color={colours.occupied} transparent opacity={0.06} />
      </mesh>

      {floors.map((group, floorIndex) => (
        <FloorPlate
          key={group.floor}
          group={group}
          floorIndex={floorIndex}
          width={width}
          depth={depth}
          colours={colours}
          exploded={exploded}
          selectedId={selectedId}
          hovered={hovered}
          onHover={setHovered}
          onSelect={onSelect}
        />
      ))}
    </Coordinates>
  );
}

export interface EstateMap3DProps {
  sites: AtlasSite[];
  labels: Record<string, string>;
  locale: string;
}

export function EstateMap3D({ sites, labels, locale }: EstateMap3DProps) {
  const geoSites = useMemo(() => sites.filter((s) => s.lat !== null && s.lng !== null), [sites]);
  const [activeId, setActiveId] = useState<string | null>(geoSites[0]?.id ?? null);
  const [selected, setSelected] = useState<{ site: AtlasSite; unit: AtlasUnit } | null>(null);
  const [exploded, setExploded] = useState(false);
  const colours = useStatusColours();

  // Ground-level context: Overture footprints for a 320 m apron, generated
  // offline from the 2026-11-18.0 release. Height is absent for ~all of them,
  // so they are drawn flat and the legend says the height is not recorded.
  const [apron, setApron] = useState<FeatureCollection | null>(null);
  useEffect(() => {
    let alive = true;
    fetch('/geo/amman-context.geojson')
      .then((r) => (r.ok ? r.json() : null))
      .then((d: FeatureCollection | null) => {
        if (alive && d !== null) setApron(d);
      })
      .catch(() => {
        /* context is additive: its absence must not break the model */
      });
    return () => {
      alive = false;
    };
  }, []);

  const active = geoSites.find((s) => s.id === activeId) ?? geoSites[0] ?? null;

  // Same numeral system and money shape as the 2D atlas, so a flat reads the
  // same in both views (Latin digits are the identifier system here).
  const numLocale = locale === 'ar' ? 'ar-JO-u-nu-latn' : 'en-GB';
  const money = useMemo(
    () =>
      new Intl.NumberFormat(numLocale, {
        style: 'currency',
        currency: 'JOD',
        minimumFractionDigits: 3,
        maximumFractionDigits: 3,
      }),
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
  const nf = useMemo(() => new Intl.NumberFormat(numLocale), [numLocale]);
  const percent = useMemo(
    () => new Intl.NumberFormat(numLocale, { style: 'percent', maximumFractionDigits: 0 }),
    [numLocale],
  );

  const onSelect = useCallback(
    (unit: AtlasUnit) => {
      if (active === null) return;
      setSelected({ site: active, unit });
    },
    [active],
  );

  if (active === null) {
    return (
      <div style={{ padding: 'var(--space-4)', color: 'var(--ink)' }}>
        {labels['atlas.noGeo'] ?? 'This site has no coordinates on record.'}
      </div>
    );
  }

  const statuses: Tone[] = ['occupied', 'vacant', 'turnover', 'unavailable'];
  const occupied = active.units.filter((u) => u.status === 'occupied').length;

  return (
    <div className={s.map3d}>
      <div>
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 'var(--space-3)',
            marginBlockEnd: 'var(--space-2)',
          }}
        >
          {geoSites.map((site) => {
            const on = site.id === active.id;
            return (
              <button
                key={site.id}
                type="button"
                onClick={() => {
                  setActiveId(site.id);
                  setSelected(null);
                }}
                aria-pressed={on}
                data-site-chip={site.id}
                style={{
                  font: 'inherit',
                  cursor: 'pointer',
                  padding: '6px 12px',
                  borderRadius: 999,
                  border: `1px solid ${on ? 'var(--ok)' : 'var(--border)'}`,
                  background: on ? 'var(--ok-soft)' : 'var(--surface)',
                  color: 'var(--ink)',
                }}
              >
                {locale === 'ar' ? site.nameAr : site.name}
                <span
                  style={{ color: 'var(--muted, #5b6b68)', marginInlineStart: 8, fontSize: 12 }}
                >
                  <bdi dir="ltr">
                    {site.lat?.toFixed(4)}, {site.lng?.toFixed(4)}
                  </bdi>
                </span>
              </button>
            );
          })}
          <button
            type="button"
            data-explode-toggle
            aria-pressed={exploded}
            onClick={() => setExploded((v) => !v)}
            style={{
              font: 'inherit',
              cursor: 'pointer',
              padding: '6px 12px',
              borderRadius: 999,
              border: `1px solid ${exploded ? 'var(--ink)' : 'var(--border)'}`,
              background: exploded ? 'var(--ink)' : 'var(--surface)',
              color: exploded ? 'var(--surface)' : 'var(--ink)',
              marginInlineStart: 'auto',
            }}
          >
            {exploded ? labels['atlas.collapse'] : labels['atlas.explode']}
          </button>
        </div>

        <div data-map3d className={s.frame}>
          <MapView
            initialViewState={{
              latitude: active.lat ?? 0,
              longitude: active.lng ?? 0,
              zoom: ZOOM,
              pitch: PITCH,
              bearing: BEARING,
            }}
            mapStyle={MAP_STYLE}
            attributionControl={{ compact: true }}
            dragRotate
            touchZoomRotate
            maxPitch={70}
            onLoad={(event) => {
              (window as unknown as Record<string, unknown>)['__aqarMap'] = event.target;
            }}
            onError={(event) => {
              const w = window as unknown as Record<string, unknown>;
              const list = (w['__aqarMapErrors'] as string[] | undefined) ?? [];
              list.push(String((event as { error?: Error }).error?.message ?? event.type));
              w['__aqarMapErrors'] = list;
            }}
          >
            {apron === null ? null : (
              <Source
                id="apron"
                type="geojson"
                data={apron}
                attribution="Overture Maps Foundation (ODbL)"
              >
                <Layer
                  id="apron-fill"
                  type="fill"
                  filter={['==', ['get', 'site'], active.id]}
                  paint={{ 'fill-color': '#6f7d78', 'fill-opacity': 0.3 }}
                />
                <Layer
                  id="apron-line"
                  type="line"
                  filter={['==', ['get', 'site'], active.id]}
                  paint={{ 'line-color': '#3d4a45', 'line-width': 0.7, 'line-opacity': 0.55 }}
                />
              </Source>
            )}
            <Canvas latitude={active.lat ?? 0} longitude={active.lng ?? 0}>
              <Camera latitude={active.lat ?? 0} longitude={active.lng ?? 0} />
              <Massing
                site={active}
                colours={colours}
                selectedId={selected?.unit.id ?? null}
                onSelect={onSelect}
                exploded={exploded}
              />
            </Canvas>
          </MapView>
        </div>

        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            gap: 'var(--space-3)',
            alignItems: 'center',
            marginBlockStart: 'var(--space-2)',
            fontSize: 12,
            color: 'var(--ink)',
          }}
        >
          <strong style={{ fontSize: 12 }}>{labels['atlas.legend']}</strong>
          {statuses.map((tone) => (
            <span key={tone} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
              <span
                aria-hidden
                style={{
                  inlineSize: 10,
                  blockSize: 10,
                  borderRadius: 2,
                  background: colours[tone],
                  border: '1px solid var(--border)',
                  display: 'inline-block',
                }}
              />
              {labels[`unitStatus.${tone}`] ?? tone}
            </span>
          ))}
          <span
            data-map3d-note
            style={{ marginInlineStart: 'auto', color: 'var(--muted, #5b6b68)', textAlign: 'end' }}
          >
            {exploded ? `${labels['atlas.explodeNote']} ` : null}
            {apron === null ? null : `${labels['atlas.apron']}. `}
            {labels['atlas.mapNote']}
          </span>
          {apron === null ? null : (
            <span data-apron-credit style={{ color: 'var(--muted, #5b6b68)', fontSize: 11 }}>
              {labels['atlas.apronCredit']}
            </span>
          )}
        </div>
      </div>

      <aside
        style={{
          border: '1px solid var(--border)',
          borderRadius: 12,
          padding: 'var(--space-4)',
          background: 'var(--surface)',
          minInlineSize: 0,
        }}
        data-map3d-panel
      >
        {selected === null ? (
          <>
            <h2 style={{ fontSize: 15, margin: 0 }}>
              {locale === 'ar' ? active.nameAr : active.name}
            </h2>
            <p style={{ margin: '6px 0 12px', color: 'var(--muted, #5b6b68)', fontSize: 13 }}>
              {active.district} · {active.city}
            </p>
            <dl
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                gap: '6px 12px',
                margin: 0,
                fontSize: 13,
              }}
            >
              <dt style={{ color: 'var(--muted, #5b6b68)' }}>{labels['atlas.flats']}</dt>
              <dd style={{ margin: 0, textAlign: 'end' }}>{nf.format(active.units.length)}</dd>
              <dt style={{ color: 'var(--muted, #5b6b68)' }}>{labels['atlas.occupancy']}</dt>
              <dd style={{ margin: 0, textAlign: 'end' }}>
                {percent.format(active.units.length === 0 ? 0 : occupied / active.units.length)}
              </dd>
              <dt style={{ color: 'var(--muted, #5b6b68)' }}>{labels['atlas.floors']}</dt>
              <dd style={{ margin: 0, textAlign: 'end' }}>{nf.format(floorsOf(active).length)}</dd>
            </dl>
            <p style={{ marginBlockStart: 12, fontSize: 12, color: 'var(--muted, #5b6b68)' }}>
              {labels['atlas.pick']}
            </p>
          </>
        ) : (
          <>
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-between',
                gap: 8,
                alignItems: 'start',
              }}
            >
              <h2 style={{ fontSize: 15, margin: 0 }}>
                {labels['atlas.unit']} <bdi dir="ltr">{selected.unit.unitNumber}</bdi>
              </h2>
              <span
                style={{
                  fontSize: 11,
                  padding: '2px 8px',
                  borderRadius: 999,
                  background: colours[STATUS_TONE[selected.unit.status] ?? 'unavailable'],
                  color: '#14201e',
                  border: '1px solid var(--border)',
                }}
              >
                {labels[`unitStatus.${selected.unit.status}`] ?? selected.unit.status}
              </span>
            </div>
            <p style={{ margin: '4px 0 12px', color: 'var(--muted, #5b6b68)', fontSize: 12 }}>
              {locale === 'ar' ? selected.site.nameAr : selected.site.name}
            </p>
            <dl
              style={{
                display: 'grid',
                gridTemplateColumns: '1fr auto',
                gap: '7px 12px',
                margin: 0,
                fontSize: 13,
              }}
            >
              <dt style={{ color: 'var(--muted, #5b6b68)' }}>{labels['atlas.rent']}</dt>
              <dd style={{ margin: 0, textAlign: 'end' }}>
                <bdi dir="ltr">{money.format(selected.unit.marketRentFils / 1000)}</bdi>
              </dd>
              <dt style={{ color: 'var(--muted, #5b6b68)' }}>{labels['atlas.floor']}</dt>
              <dd style={{ margin: 0, textAlign: 'end' }}>
                <bdi dir="ltr">{selected.unit.floor ?? labels['atlas.noFloor']}</bdi>
              </dd>
              <dt style={{ color: 'var(--muted, #5b6b68)' }}>{labels['atlas.area']}</dt>
              <dd style={{ margin: 0, textAlign: 'end' }}>
                <bdi dir="ltr">
                  {selected.unit.areaSqm === null ? '—' : `${nf.format(selected.unit.areaSqm)} m²`}
                </bdi>
              </dd>
              <dt style={{ color: 'var(--muted, #5b6b68)' }}>{labels['atlas.beds']}</dt>
              <dd style={{ margin: 0, textAlign: 'end' }}>
                <bdi dir="ltr">
                  {selected.unit.bedrooms === null ? '—' : nf.format(selected.unit.bedrooms)}
                </bdi>
              </dd>
              <dt style={{ color: 'var(--muted, #5b6b68)' }}>{labels['atlas.tenant']}</dt>
              <dd style={{ margin: 0, textAlign: 'end' }}>
                {selected.unit.tenantName ?? labels['atlas.noTenant']}
              </dd>
              {selected.unit.leaseEnd === null ? null : (
                <>
                  <dt style={{ color: 'var(--muted, #5b6b68)' }}>{labels['atlas.leaseEnd']}</dt>
                  <dd style={{ margin: 0, textAlign: 'end' }}>
                    <bdi dir="ltr">
                      {date.format(new Date(`${selected.unit.leaseEnd}T00:00:00Z`))}
                    </bdi>
                  </dd>
                </>
              )}
              <dt style={{ color: 'var(--muted, #5b6b68)' }}>{labels['atlas.balance']}</dt>
              <dd
                style={{
                  margin: 0,
                  textAlign: 'end',
                  color: selected.unit.balanceFils > 0 ? 'var(--danger)' : 'inherit',
                }}
              >
                <bdi dir="ltr">{money.format(selected.unit.balanceFils / 1000)}</bdi>
              </dd>
            </dl>
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 10,
                marginBlockStart: 14,
                fontSize: 13,
              }}
            >
              <Link href="/leases">{labels['nav.leases']}</Link>
              <Link href="/ledger">{labels['nav.ledger']}</Link>
              <Link href={`/tickets?unit=${selected.unit.id}`}>{labels['nav.tickets']}</Link>
            </div>
            <button
              type="button"
              onClick={() => setSelected(null)}
              style={{
                marginBlockStart: 14,
                font: 'inherit',
                fontSize: 12,
                cursor: 'pointer',
                background: 'transparent',
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '4px 10px',
                color: 'var(--ink)',
              }}
            >
              ← {locale === 'ar' ? active.nameAr : active.name}
            </button>
          </>
        )}
      </aside>
    </div>
  );
}

export default EstateMap3D;
