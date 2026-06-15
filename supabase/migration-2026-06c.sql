-- ============================================================
-- ISHA E-CITY DASHBOARD  --  Migration June 2026 (part c)
-- Run in Supabase -> SQL Editor. Safe to re-run.
--
-- Adds the IE Completion "Volunteer interest" list: people who ticked
-- Volunteer = yes on an IE completion form in Ishangam
-- (ie.completion, center = Electronic City, volunteer = true).
-- Shown as a dedicated tab in Volunteers, sorted by IE date (newest first).
-- ============================================================

create table if not exists ie_completion_volunteer (
  id           uuid primary key default gen_random_uuid(),
  full_name    text,
  phone        text unique,
  ie_date      date,
  program_name text,
  center_id    text default 'ecity',
  source       text default 'ishangam',
  status       text default 'new' check (status in ('new','contacted','active','done','dropped')),
  notes        text,
  created_at   timestamptz default now()
);
create index if not exists icv_ie_date_idx on ie_completion_volunteer (ie_date desc);

alter table ie_completion_volunteer enable row level security;
drop policy if exists icv_all on ie_completion_volunteer;
create policy icv_all on ie_completion_volunteer for all to authenticated
  using (my_role() in ('coordinator','rco'))
  with check (my_role() in ('coordinator','rco'));

-- ============================================================
-- END migration-2026-06c.sql
-- ============================================================
