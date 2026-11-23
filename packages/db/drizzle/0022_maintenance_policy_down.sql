-- 0022 down — drop maintenance_policy and the two enums it introduced.

begin;

drop index if exists maintenance_policy_lookup_idx;
drop index if exists maintenance_policy_active_uniq;
drop table if exists maintenance_policy;

drop type if exists wear_basis;
drop type if exists maintenance_responsibility;

commit;
