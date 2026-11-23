'use client';

/**
 * Loads the map view only when it is asked for. three.js + MapLibre are roughly
 * 800 kB gzipped together, and the plan view has to stay fast — so nothing here
 * is fetched until `?view=3d` renders this wrapper.
 *
 * If WebGL or the tile style fails, the boundary sends the visitor to the plan
 * view instead of leaving a grey rectangle on the demo screen.
 */

import { Component, type ReactNode } from 'react';
import dynamic from 'next/dynamic';
import type { AtlasSite } from '@/lib/queries';
import 'maplibre-gl/dist/maplibre-gl.css';

const Inner = dynamic(() => import('./EstateMap3D'), {
  ssr: false,
  loading: () => <Loading />,
});

function Loading() {
  return (
    <div
      style={{
        blockSize: 460,
        borderRadius: 12,
        border: '1px solid var(--border)',
        background: 'var(--surface-3)',
        display: 'grid',
        placeItems: 'center',
        color: 'var(--ink)',
        fontSize: 13,
      }}
      data-map3d-loading
    >
      <span className="tnum">…</span>
    </div>
  );
}

interface BoundaryProps {
  children: ReactNode;
  fallback: ReactNode;
}

class Boundary extends Component<BoundaryProps, { failed: boolean }> {
  constructor(props: BoundaryProps) {
    super(props);
    this.state = { failed: false };
  }

  static getDerivedStateFromError() {
    return { failed: true };
  }

  override render() {
    if (this.state.failed) return this.props.fallback;
    return this.props.children;
  }
}

export interface EstateMap3DClientProps {
  sites: AtlasSite[];
  labels: Record<string, string>;
  locale: string;
}

export function EstateMap3DClient({ sites, labels, locale }: EstateMap3DClientProps) {
  return (
    <Boundary
      fallback={
        <div
          role="alert"
          style={{
            padding: 'var(--space-4)',
            border: '1px solid var(--border)',
            borderRadius: 12,
            background: 'var(--surface)',
            color: 'var(--ink)',
            fontSize: 13,
          }}
        >
          {labels['atlas.mapFailed'] ?? 'The 3D view is unavailable in this browser.'}{' '}
          <a href="?view=plan">{labels['atlas.viewPlan'] ?? 'Plan'}</a>
        </div>
      }
    >
      <Inner sites={sites} labels={labels} locale={locale} />
    </Boundary>
  );
}

export default EstateMap3DClient;
