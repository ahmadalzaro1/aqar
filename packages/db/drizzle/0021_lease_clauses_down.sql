drop view if exists lease_clauses_confirmed;
alter table leases drop column if exists auto_renew;
drop index if exists lease_clauses_org_key_idx;
drop index if exists lease_clauses_lease_idx;
drop table if exists lease_clauses;
drop table if exists lease_clause_types;
