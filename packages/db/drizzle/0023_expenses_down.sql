-- 0023 down — drop expenses and its enum.

begin;

drop index if exists expenses_property_idx;
drop index if exists expenses_org_incurred_idx;
drop table if exists expenses;
drop type if exists expense_category;

commit;
