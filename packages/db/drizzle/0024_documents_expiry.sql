-- 0024 — documents: what kind it is, and when it expires.
--
-- The table already models versions (version, is_latest), the owning entity
-- (entity_type, entity_id) and the stored object (s3_key, mime, bytes, sha256).
-- What it could not express is the two questions a property manager actually
-- asks: "what kind of paper is this" and "which of them run out soon". A lease
-- copy, an insurance certificate and a title deed are all documents, but only
-- the certificate has a date after which it is worthless.
--
-- expires_on is nullable on purpose: most documents do not expire, and a
-- default date would be an invented fact.

begin;

alter table documents
  add column if not exists doc_type text,
  add column if not exists expires_on date;

comment on column documents.doc_type is
  'Free-text kind: lease, insurance, title_deed, permit, inspection, id, other. Free text so a new kind needs no migration.';
comment on column documents.expires_on is
  'The date after which this document no longer serves. Null = does not expire.';

-- Expiry questions read latest versions only; stale versions keep their date.
create index if not exists documents_expiry_idx
  on documents (organization_id, expires_on)
  where expires_on is not null and is_latest;

commit;
