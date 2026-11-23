/**
 * Documents — which papers exist for an entity, and which run out soon.
 *
 * The table models versions and ownership; 0024 added the two columns that make
 * the question askable (doc_type, expires_on). Most documents do not expire, so
 * expires_on is null for them and only dated ones appear in the expiry answer.
 */
import { z } from 'zod';
import type { ToolDef } from './registry.js';

const uuid = z.string().uuid();

const entityType = z.enum(['property', 'building', 'unit', 'lease', 'tenant', 'vendor', 'ticket']);

export const documentsDueSchema = z.object({
  withinDays: z.number().int().min(0).max(730).default(90),
  docType: z.string().min(2).max(40).optional().describe('e.g. insurance, permit, title_deed.'),
});

export const documentsDue: ToolDef = {
  name: 'documents_due',
  kind: 'read',
  title: 'Documents expiring soon',
  description:
    'Documents whose expiry date falls within N days (default 90), latest versions only — insurance certificates, permits, title deeds. Use for "أي وثائق تنتهي قريب", "which documents expire", "is our insurance valid". An empty answer means nothing dated is registered, which the tool says explicitly.',
  schema: documentsDueSchema,
  async run(ctx, raw) {
    const { withinDays, docType } = documentsDueSchema.parse(raw);

    const rows = await ctx.sql<
      {
        id: string;
        title: string;
        docType: string | null;
        entityType: string;
        entityId: string;
        status: string;
        expiresOn: string;
        daysUntil: number;
      }[]
    >`
      select d.id,
             d.title,
             d.doc_type as "docType",
             d.entity_type as "entityType",
             d.entity_id as "entityId",
             d.status::text as status,
             d.expires_on::text as "expiresOn",
             (d.expires_on - current_date)::int as "daysUntil"
        from documents d
       where d.organization_id = ${ctx.org.id}
         and d.is_latest
         and d.expires_on is not null
         and d.expires_on <= current_date + ${withinDays}::int
         and (${docType ?? null}::text is null or d.doc_type = ${docType ?? null}::text)
       order by d.expires_on asc
       limit 200
    `;

    const dated = await ctx.sql<{ n: number }[]>`
      select count(*)::int as n
        from documents
       where organization_id = ${ctx.org.id} and is_latest and expires_on is not null
    `;

    return {
      count: rows.length,
      withinDays,
      datedDocuments: dated[0]?.n ?? 0,
      rows,
      note:
        (dated[0]?.n ?? 0) === 0
          ? 'No document carries an expiry date, so nothing can be expiring. Recording expires_on on an insurance certificate or permit is what makes this answerable.'
          : null,
    };
  },
};

export const documentsForSchema = z.object({
  entityType,
  entityId: uuid,
  includeSuperseded: z.boolean().default(false),
});

export const documentsFor: ToolDef = {
  name: 'documents_for',
  kind: 'read',
  title: 'Documents for one record',
  description:
    'The documents attached to one property, unit, lease, tenant, vendor or ticket — title, kind, version, expiry, and whether a superseded version exists. Use for "شو وثائق هذا العقد", "show the documents for unit X", "do we have the title deed".',
  schema: documentsForSchema,
  async run(ctx, raw) {
    const { entityType: kind, entityId, includeSuperseded } = documentsForSchema.parse(raw);

    const rows = await ctx.sql<
      {
        id: string;
        title: string;
        docType: string | null;
        status: string;
        version: number;
        isLatest: boolean;
        expiresOn: string | null;
        mime: string | null;
        bytes: number | null;
        createdAt: string;
      }[]
    >`
      select d.id,
             d.title,
             d.doc_type as "docType",
             d.status::text as status,
             d.version,
             d.is_latest as "isLatest",
             d.expires_on::text as "expiresOn",
             d.mime,
             d.bytes,
             d.created_at::text as "createdAt"
        from documents d
       where d.organization_id = ${ctx.org.id}
         and d.entity_type = ${kind}
         and d.entity_id = ${entityId}
         and (${includeSuperseded}::boolean or d.is_latest)
       order by d.title, d.version desc
       limit 200
    `;

    return {
      count: rows.length,
      entityType: kind,
      entityId,
      rows,
      note:
        rows.length === 0
          ? 'No document is registered for this record. Nothing is missing from a list — the attachment itself was never entered.'
          : null,
    };
  },
};

export const documentTools: readonly ToolDef[] = [documentsDue, documentsFor];
