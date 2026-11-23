'use client';

/**
 * The operator chat, mounted once by `Shell` so it survives navigation across
 * every console route (see docs/CHAT.md). Read-only tools only: it can answer
 * from the ledger, and cannot move money — money changes go through proposals
 * approved by a human (S3).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { Locale } from '@aqar/contracts';
import { Bot, Send, X, ChevronDown, Loader2 } from 'lucide-react';
import type { ChatColumnKey, ToolTrace } from '@/lib/toolTable';

interface ToolTable {
  tool: string;
  columns: { key: string; labelKey: string; align: 'start' | 'end' }[];
  rows: Record<string, string>[];
  totalLabelKey?: string | undefined;
  total?: string | undefined;
  count: number;
}

interface Turn {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  tools?: ToolTrace[];
  table?: ToolTable | null;
  meta?: { model: string; lane: string; latencyMs: number; costUsd: number };
  failed?: boolean;
}

interface ApiReply {
  answer: string;
  model: string;
  lane: string;
  latencyMs: number;
  costUsd: number;
  tools: ToolTrace[];
  table?: ToolTable | null;
  strongAvailable: boolean;
}

const LABELS = {
  ar: {
    title: 'مساعد العمليات',
    placeholder: 'اسأل عن المحفظة، المتأخرات، التذاكر…',
    empty: 'الأرقام تأتي من قاعدة البيانات عبر أدوات، لا من النموذج. جرّب: «كم وحدة شاغرة؟»',
    thinking: 'يعمل…',
    local: 'محلي',
    strong: 'سحابي',
    error: 'تعذّر إكمال الطلب',
    open: 'المساعد',
    cols: {
      'chat.col.tenant': 'المستأجر',
      'chat.col.unit': 'الوحدة',
      'chat.col.property': 'العقار',
      'chat.col.outstanding': 'المستحق (د.أ)',
      'chat.col.since': 'أقدم استحقاق',
      'chat.col.floor': 'الطابق',
      'chat.col.area': 'المساحة (م²)',
      'chat.col.total': 'الإجمالي (د.أ)',
      'chat.col.units': 'الوحدات',
      'chat.col.occupied': 'المشغول',
      'chat.col.occupancy': 'الإشغال %',
      'chat.col.tickets': 'تذاكر مفتوحة',
      'chat.col.endDate': 'ينتهي',
      'chat.col.daysLeft': 'باقي (يوم)',
      'chat.col.rent': 'الإيجار (د.أ)',
      'chat.col.period': 'الفترة',
      'chat.col.charged': 'المستحق (د.أ)',
      'chat.col.collected': 'المحصّل (د.أ)',
      'chat.col.rate': 'نسبة التحصيل %',
      'chat.col.status': 'الحالة',
      'chat.col.deposit': 'التأمين (د.أ)',
      'chat.col.leaseEnd': 'ينتهي العقد',
      'chat.col.arrears': 'المتأخرات (د.أ)',
      'chat.col.gross': 'الإجمالي (د.أ)',
      'chat.col.expenses': 'المصاريف (د.أ)',
      'chat.col.fee': 'أتعاب الإدارة (د.أ)',
      'chat.col.net': 'الصافي (د.أ)',
    } satisfies Record<ChatColumnKey, string>,
  },
  en: {
    title: 'Operations assistant',
    placeholder: 'Ask about occupancy, arrears, tickets…',
    empty:
      'Numbers come from the database through tools, never from the model. Try: “How many units are vacant?”',
    thinking: 'Working…',
    local: 'Local',
    strong: 'Cloud',
    error: 'Request failed',
    open: 'Assistant',
    cols: {
      'chat.col.tenant': 'Tenant',
      'chat.col.unit': 'Unit',
      'chat.col.property': 'Property',
      'chat.col.outstanding': 'Outstanding (JOD)',
      'chat.col.since': 'Oldest due',
      'chat.col.floor': 'Floor',
      'chat.col.area': 'Area (m²)',
      'chat.col.total': 'Total (JOD)',
      'chat.col.units': 'Units',
      'chat.col.occupied': 'Occupied',
      'chat.col.occupancy': 'Occupancy %',
      'chat.col.tickets': 'Open tickets',
      'chat.col.endDate': 'Ends',
      'chat.col.daysLeft': 'Days left',
      'chat.col.rent': 'Rent (JOD)',
      'chat.col.period': 'Period',
      'chat.col.charged': 'Charged (JOD)',
      'chat.col.collected': 'Collected (JOD)',
      'chat.col.rate': 'Collection %',
      'chat.col.status': 'Status',
      'chat.col.deposit': 'Deposit (JOD)',
      'chat.col.leaseEnd': 'Lease ends',
      'chat.col.arrears': 'Arrears (JOD)',
      'chat.col.gross': 'Gross (JOD)',
      'chat.col.expenses': 'Expenses (JOD)',
      'chat.col.fee': 'Mgmt fee (JOD)',
      'chat.col.net': 'Net (JOD)',
    } satisfies Record<ChatColumnKey, string>,
  },
} as const;

/**
 * The table is rendered from the tool's own fields, never re-typed by the model.
 * The currency lives in the column header so cells stay bare numbers — that is
 * what stops "885,000 FILS / 885.000 JOD" from appearing side by side.
 */
function ToolTableView({ table, locale }: { table: ToolTable; locale: Locale }) {
  const cols = LABELS[locale].cols as Record<string, string>;
  const cellStyle = (align: 'start' | 'end') => ({
    textAlign: align === 'end' ? ('end' as const) : ('start' as const),
    padding: '3px 6px',
    borderBlockEnd: '1px solid var(--border)',
    whiteSpace: 'nowrap' as const,
    fontVariantNumeric: 'tabular-nums' as const,
  });
  return (
    <div style={{ overflowX: 'auto', maxInlineSize: '100%' }}>
      <table
        data-chat-table={table.tool}
        style={{ borderCollapse: 'collapse', inlineSize: '100%', fontSize: 11 }}
      >
        <thead>
          <tr>
            {table.columns.map((column) => (
              <th
                key={column.key}
                scope="col"
                style={{
                  ...cellStyle(column.align),
                  color: 'var(--muted)',
                  fontWeight: 600,
                  borderBlockEnd: '1px solid var(--border)',
                }}
              >
                {cols[column.labelKey] ?? column.labelKey}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, index) => (
            <tr key={`${table.tool}-${index}`}>
              {table.columns.map((column) => (
                <td key={column.key} style={cellStyle(column.align)}>
                  <bdi>{row[column.key] ?? '—'}</bdi>
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {table.total !== undefined && table.totalLabelKey !== undefined && (
          <tfoot>
            <tr>
              <th
                scope="row"
                colSpan={table.columns.length - 1}
                style={{ ...cellStyle('end'), color: 'var(--muted)' }}
              >
                {cols[table.totalLabelKey] ?? table.totalLabelKey}
              </th>
              <td style={{ ...cellStyle('end'), fontWeight: 700 }}>
                <bdi>{table.total}</bdi>
              </td>
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
}

export function ChatDock({ locale }: { locale: Locale }) {
  const L = LABELS[locale];
  const [open, setOpen] = useState(false);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [lane, setLane] = useState<'local' | 'strong'>('local');
  const [strongAvailable, setStrongAvailable] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'j') {
        e.preventDefault();
        setOpen((v) => !v);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => {
    const el = listRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [turns, busy]);

  // A hard reload is a new React tree; the thread should not vanish with it.
  // (Route changes inside the console never remount this component, so this only
  // matters for reloads and tab restores.)
  useEffect(() => {
    try {
      const raw = window.sessionStorage.getItem('aqar.chat.turns');
      if (raw !== null) setTurns(JSON.parse(raw) as Turn[]);
      if (window.sessionStorage.getItem('aqar.chat.open') === '1') setOpen(true);
    } catch {
      // storage disabled or holding garbage — start with an empty thread
    }
  }, []);
  useEffect(() => {
    try {
      window.sessionStorage.setItem('aqar.chat.turns', JSON.stringify(turns.slice(-20)));
      window.sessionStorage.setItem('aqar.chat.open', open ? '1' : '0');
    } catch {
      // out of quota or storage disabled — the thread still works for this page
    }
  }, [turns, open]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (text.length === 0 || busy) return;
    const history = [...turns, { id: crypto.randomUUID(), role: 'user' as const, content: text }];
    setTurns(history);
    setDraft('');
    setBusy(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          lane,
          locale,
          messages: history
            .filter((t) => t.failed !== true)
            .map((t) => ({ role: t.role, content: t.content })),
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = (await res.json()) as ApiReply;
      setStrongAvailable(data.strongAvailable);
      setTurns((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          content: data.answer,
          tools: data.tools,
          table: data.table ?? null,
          meta: data,
        },
      ]);
    } catch (err) {
      setTurns((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: 'assistant',
          failed: true,
          content: `${L.error} — ${err instanceof Error ? err.message : String(err)}`,
        },
      ]);
    } finally {
      setBusy(false);
    }
  }, [draft, busy, turns, lane, L.error]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        aria-label={L.open}
        title={`${L.open} (⌘J)`}
        className="no-print"
        style={{
          position: 'fixed',
          insetBlockEnd: 20,
          insetInlineEnd: 20,
          zIndex: 60,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          minHeight: 44,
          paddingInline: 16,
          borderRadius: 999,
          border: '1px solid var(--border)',
          background: 'var(--accent)',
          color: 'var(--accent-ink, #fff)',
          boxShadow: 'var(--shadow-2)',
          cursor: 'pointer',
          fontSize: 'var(--text-sm)',
          fontWeight: 600,
        }}
      >
        <Bot size={16} /> {L.open}
      </button>
    );
  }

  return (
    <section
      className="no-print"
      aria-label={L.title}
      style={{
        position: 'fixed',
        insetBlockEnd: 20,
        insetInlineEnd: 20,
        zIndex: 60,
        inlineSize: 380,
        maxInlineSize: 'calc(100vw - 24px)',
        blockSize: 'min(620px, 72vh)',
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        background: 'var(--surface)',
        border: '1px solid var(--border)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-2)',
      }}
    >
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          paddingBlock: 10,
          paddingInline: 12,
          borderBlockEnd: '1px solid var(--border)',
          background: 'var(--surface-2)',
        }}
      >
        <Bot size={16} />
        <strong style={{ fontSize: 'var(--text-sm)' }}>{L.title}</strong>
        {strongAvailable && (
          <button
            onClick={() => setLane((v) => (v === 'local' ? 'strong' : 'local'))}
            title={lane === 'local' ? L.local : L.strong}
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              marginInlineStart: 4,
              border: '1px solid var(--border)',
              borderRadius: 999,
              background: 'transparent',
              color: 'var(--muted)',
              fontSize: 11,
              padding: '2px 8px',
              cursor: 'pointer',
              minHeight: 24,
            }}
          >
            {lane === 'local' ? L.local : L.strong} <ChevronDown size={11} />
          </button>
        )}
        <button
          onClick={() => setOpen(false)}
          aria-label="close"
          style={{
            marginInlineStart: 'auto',
            background: 'transparent',
            border: 'none',
            color: 'var(--muted)',
            cursor: 'pointer',
            minHeight: 32,
            minWidth: 32,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <X size={16} />
        </button>
      </header>

      <div
        ref={listRef}
        aria-live="polite"
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: 12,
          display: 'flex',
          flexDirection: 'column',
          gap: 10,
          fontSize: 'var(--text-sm)',
          lineHeight: 1.5,
        }}
      >
        {turns.length === 0 && (
          <p style={{ margin: 0, color: 'var(--muted)', fontSize: 'var(--text-xs)' }}>{L.empty}</p>
        )}
        {turns.map((turn) => (
          <div
            key={turn.id}
            style={{
              display: 'flex',
              flexDirection: 'column',
              gap: 4,
              alignItems: turn.role === 'user' ? 'flex-end' : 'flex-start',
            }}
          >
            <div
              style={{
                maxInlineSize: '92%',
                paddingBlock: 8,
                paddingInline: 10,
                borderRadius: 'var(--radius)',
                whiteSpace: 'pre-wrap',
                overflowWrap: 'anywhere',
                background: turn.role === 'user' ? 'var(--accent-soft)' : 'var(--surface-2)',
                color: turn.failed === true ? 'var(--danger, #b42318)' : 'var(--ink)',
                borderInlineStart:
                  turn.role === 'assistant' ? '2px solid var(--accent)' : undefined,
              }}
            >
              {turn.content}
            </div>
            {turn.table != null && <ToolTableView table={turn.table} locale={locale} />}
            {turn.tools !== undefined && turn.tools.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                {turn.tools.map((tool, i) => (
                  <span
                    key={`${turn.id}-${i}`}
                    title={tool.ok ? 'ok' : 'failed'}
                    style={{
                      fontSize: 10,
                      padding: '1px 6px',
                      borderRadius: 999,
                      border: '1px solid var(--border)',
                      color: 'var(--muted)',
                      fontFamily: 'ui-monospace, monospace',
                    }}
                  >
                    {tool.name} · {tool.ms}ms
                  </span>
                ))}
              </div>
            )}
            {turn.meta !== undefined && (
              <span style={{ fontSize: 10, color: 'var(--muted)' }}>
                {turn.meta.model} · {turn.meta.latencyMs}ms ·{' '}
                {turn.meta.costUsd === 0 ? 'free' : `$${turn.meta.costUsd.toFixed(5)}`}
              </span>
            )}
          </div>
        ))}
        {busy && (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              color: 'var(--muted)',
              fontSize: 'var(--text-xs)',
            }}
          >
            <Loader2 size={13} className="animate-spin" /> {L.thinking}
          </span>
        )}
      </div>

      <form
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
        style={{
          display: 'flex',
          gap: 6,
          padding: 8,
          borderBlockStart: '1px solid var(--border)',
          background: 'var(--surface-2)',
        }}
      >
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder={L.placeholder}
          aria-label={L.placeholder}
          style={{
            flex: 1,
            resize: 'none',
            font: 'inherit',
            fontSize: 'var(--text-sm)',
            padding: '6px 8px',
            border: '1px solid var(--border)',
            borderRadius: 'var(--radius)',
            background: 'var(--surface)',
            color: 'var(--ink)',
          }}
        />
        <button
          type="submit"
          disabled={busy || draft.trim().length === 0}
          aria-label="send"
          style={{
            alignSelf: 'flex-end',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            minHeight: 36,
            minWidth: 36,
            borderRadius: 'var(--radius)',
            border: '1px solid var(--border)',
            background: busy || draft.trim().length === 0 ? 'var(--surface)' : 'var(--accent)',
            color: busy || draft.trim().length === 0 ? 'var(--muted)' : 'var(--accent-ink, #fff)',
            cursor: busy || draft.trim().length === 0 ? 'not-allowed' : 'pointer',
          }}
        >
          <Send size={15} />
        </button>
      </form>
    </section>
  );
}
