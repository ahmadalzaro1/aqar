-- 0024 down — remove the expiry index and the two added columns.

begin;

drop index if exists documents_expiry_idx;

alter table documents
  drop column if exists expires_on,
  drop column if exists doc_type;

commit;
