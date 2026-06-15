-- ============================================================
-- ISHA E-CITY DASHBOARD  --  Migration June 2026
-- Run this WHOLE file ONCE in Supabase -> SQL Editor -> New query.
-- Safe to re-run (idempotent).
--
-- Adds:
--   * Guru Puja completion column + ensures all advanced-program
--     date columns / tags exist on people
--   * advanced_interest table (paper "willing to do" intake) + RPC
--   * nurturer-controlled new-meditator calling (journeys can be
--     'pending'; calls only schedule when a nurturer activates them)
--   * import_people now stamps the matching completion date per
--     program, and imports new meditators as 'pending'
--   * advanced_sync settings + weekly-sync marker RPC
-- ============================================================

-- ---------- 1. PEOPLE: ensure advanced-program columns exist ----------
alter table people add column if not exists tags           text[] default '{}';
alter table people add column if not exists ie_date        date;
alter table people add column if not exists bsp_date       date;
alter table people add column if not exists shoonya_date   date;
alter table people add column if not exists samyama_date   date;
alter table people add column if not exists guru_puja_date date;

-- ---------- 2. JOURNEYS: allow a 'pending' state ----------
-- pending = imported but the nurturer has not yet chosen to start calling
alter table journeys drop constraint if exists journeys_status_check;
alter table journeys add  constraint journeys_status_check
  check (status in ('pending','active','completed','dropped'));

-- ---------- 3. Only schedule calls for ACTIVE journeys ----------
create or replace function journeys_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare sched jsonb; k text; v text; base date;
begin
  update journeys j set center_id = p.center_id
    from people p where p.id = new.person_id and j.id = new.id;

  -- pending / non-active journeys get NO calls until activated
  if new.status <> 'active' then
    return new;
  end if;

  base := coalesce(new.program_date, current_date);
  if new.type = 'new_meditator' then
    select value into sched from settings where key = 'call_schedule_days';
    for k, v in select * from jsonb_each_text(coalesce(sched, '{"1":1,"2":15,"3":40}')) loop
      insert into calls (journey_id, call_no, due_date)
      values (new.id, k::int, base + v::int);
    end loop;
  elsif new.type in ('advanced','volunteer_nurture') then
    insert into calls (journey_id, call_no, due_date) values (new.id, 1, base + 2);
  elsif new.type = 'meditator' then
    insert into calls (journey_id, call_no, due_date) values (new.id, 1, current_date);
  end if;
  return new;
end $$;

-- ---------- 4. Activate a pending journey (nurturer picks who to call) ----------
create or replace function activate_journey(j_id uuid) returns void
language plpgsql security definer set search_path = public as $$
declare j journeys%rowtype; sched jsonb; k text; v text; base date;
begin
  if my_role() not in ('coordinator','rco') then
    raise exception 'Only coordinators/RCO can activate journeys';
  end if;
  select * into j from journeys where id = j_id;
  if j.id is null or j.status = 'active' then return; end if;
  -- guard against double scheduling
  if exists (select 1 from calls where journey_id = j_id) then
    update journeys set status = 'active' where id = j_id;
    return;
  end if;
  update journeys set status = 'active' where id = j_id;
  base := coalesce(j.program_date, current_date);
  if j.type = 'new_meditator' then
    select value into sched from settings where key = 'call_schedule_days';
    for k, v in select * from jsonb_each_text(coalesce(sched, '{"1":1,"2":15,"3":40}')) loop
      insert into calls (journey_id, call_no, due_date) values (j_id, k::int, base + v::int);
    end loop;
  else
    insert into calls (journey_id, call_no, due_date) values (j_id, 1, current_date);
  end if;
end $$;
grant execute on function activate_journey(uuid) to authenticated;

-- ---------- 5. import_people: stamp program dates + import new meditators as pending ----------
create or replace function import_people(rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; pid uuid; ph text; inserted int := 0; skipped int := 0; jcount int := 0;
        knd text; prog text; pdate date;
begin
  if my_role() not in ('coordinator','rco') then
    raise exception 'Only coordinators/RCO can import';
  end if;
  for r in select * from jsonb_array_elements(rows) loop
    knd := r->>'kind';
    ph := regexp_replace(coalesce(r->>'phone',''), '\D', '', 'g');
    if length(ph) > 10 then ph := right(ph, 10); end if;
    if ph = '' then ph := null; end if;

    select id into pid from people where phone = ph and ph is not null;
    if pid is null then
      insert into people (full_name, phone, email, pincode, area, source, is_meditator, is_volunteer)
      values (coalesce(r->>'full_name','(no name)'), ph, r->>'email', r->>'pincode', r->>'area',
              coalesce(r->>'source','import'),
              knd in ('new_meditator','meditator','advanced'),
              knd = 'volunteer')
      returning id into pid;
      inserted := inserted + 1;
    else
      skipped := skipped + 1;
      update people set
        full_name    = coalesce(nullif(r->>'full_name',''), full_name),
        pincode      = coalesce(nullif(r->>'pincode',''), pincode),
        is_meditator = is_meditator or knd in ('new_meditator','meditator','advanced'),
        is_volunteer = is_volunteer or knd = 'volunteer'
      where id = pid;
    end if;

    if knd in ('new_meditator','meditator','advanced') then
      pdate := coalesce((r->>'program_date')::date, current_date);

      if knd = 'advanced' then
        -- stamp the matching completion-date column on the person
        prog := lower(coalesce(r->>'program_name',''));
        if    prog like '%bsp%' or prog like '%bhava%' then update people set bsp_date       = pdate where id = pid;
        elsif prog like '%shoonya%' or prog like '%shunya%' then update people set shoonya_date = pdate where id = pid;
        elsif prog like '%samyama%' then update people set samyama_date   = pdate where id = pid;
        elsif prog like '%guru%'    then update people set guru_puja_date = pdate where id = pid;
        end if;
        -- date-based dedupe: only create a journey if newly seen
        if ph is not null then
          begin
            insert into advanced_seen values (ph, coalesce(r->>'program_name','Advanced'), pdate);
          exception when unique_violation then continue;
          end;
        end if;
      end if;

      insert into journeys (person_id, type, program_name, program_date, status)
      values (pid,
              case knd when 'advanced' then 'advanced'
                       when 'meditator' then 'meditator'
                       else 'new_meditator' end,
              r->>'program_name', pdate,
              case when knd = 'new_meditator' then 'pending' else 'active' end)
      on conflict do nothing;
      jcount := jcount + 1;

    elsif knd = 'volunteer' then
      insert into volunteer_profiles (person_id, interests, preferred_timing, mode, can_offer_space, interest_source)
      values (pid,
              coalesce((select array_agg(x) from jsonb_array_elements_text(r->'interests') x), '{}'),
              r->>'preferred_timing', r->>'mode',
              coalesce((r->>'can_offer_space')::boolean, false),
              coalesce(r->>'source','import'))
      on conflict (person_id) do update set
        interests  = (select array(select distinct unnest(volunteer_profiles.interests || excluded.interests))),
        updated_at = now();
    end if;
  end loop;
  return jsonb_build_object('inserted', inserted, 'merged', skipped, 'journeys', jcount);
end $$;

-- ---------- 6. ADVANCED-PROGRAM INTEREST (paper "willing to do" intake) ----------
create table if not exists advanced_interest (
  id            uuid primary key default gen_random_uuid(),
  person_id     uuid not null references people(id) on delete cascade,
  program       text not null check (program in ('bsp','shoonya','samyama','guru_puja')),
  interest_date date not null default current_date,
  source        text default 'paper',
  notes         text,
  status        text default 'new' check (status in ('new','contacted','registered','done','dropped')),
  created_by    uuid references profiles(id),
  created_at    timestamptz default now(),
  unique (person_id, program)
);
create index if not exists adv_interest_prog_idx on advanced_interest(program);

alter table advanced_interest enable row level security;
drop policy if exists adv_interest_all on advanced_interest;
create policy adv_interest_all on advanced_interest for all to authenticated
  using (my_role() in ('coordinator','rco'))
  with check (my_role() in ('coordinator','rco'));

-- add a paper interest record (upserts the person by phone)
create or replace function add_advanced_interest(
  p_name text, p_phone text, p_program text,
  p_notes text default null, p_pincode text default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare pid uuid; ph text;
begin
  if my_role() not in ('coordinator','rco') then
    raise exception 'Only coordinators/RCO can add interest';
  end if;
  if p_program not in ('bsp','shoonya','samyama','guru_puja') then
    return jsonb_build_object('error','Invalid program');
  end if;
  ph := regexp_replace(coalesce(p_phone,''), '\D','','g');
  if length(ph) > 10 then ph := right(ph,10); end if;
  if ph = '' then ph := null; end if;

  if ph is not null then select id into pid from people where phone = ph; end if;
  if pid is null then
    insert into people (full_name, phone, pincode, source, is_meditator)
    values (coalesce(nullif(p_name,''),'(no name)'), ph, p_pincode, 'paper', true)
    returning id into pid;
  else
    update people set full_name = coalesce(nullif(p_name,''), full_name),
                      pincode   = coalesce(nullif(p_pincode,''), pincode)
     where id = pid;
  end if;

  insert into advanced_interest (person_id, program, source, notes, created_by)
  values (pid, p_program, 'paper', p_notes, auth.uid())
  on conflict (person_id, program) do update set
     notes         = coalesce(excluded.notes, advanced_interest.notes),
     interest_date = current_date,
     status        = 'new';
  return jsonb_build_object('ok', true, 'person_id', pid);
end $$;
grant execute on function add_advanced_interest(text,text,text,text,text) to authenticated;

-- ---------- 7. WEEKLY SYNC WINDOW (for "completed this week") ----------
insert into settings (key, value) values
  ('advanced_sync', jsonb_build_object(
     'go_live_date',   current_date::text,
     'last_sync_date', current_date::text,
     'prev_sync_date', current_date::text))
on conflict (key) do nothing;

-- mark "synced today": shifts the weekly window forward
create or replace function mark_advanced_sync() returns jsonb
language plpgsql security definer set search_path = public as $$
declare cur jsonb;
begin
  if my_role() not in ('coordinator','rco') then raise exception 'Not allowed'; end if;
  select value into cur from settings where key = 'advanced_sync';
  cur := coalesce(cur, '{}'::jsonb);
  cur := cur
       || jsonb_build_object('prev_sync_date', coalesce(cur->>'last_sync_date', current_date::text))
       || jsonb_build_object('last_sync_date', current_date::text)
       || jsonb_build_object('go_live_date',   coalesce(cur->>'go_live_date', current_date::text));
  if exists (select 1 from settings where key = 'advanced_sync') then
    update settings set value = cur, updated_at = now() where key = 'advanced_sync';
  else
    insert into settings (key, value) values ('advanced_sync', cur);
  end if;
  return cur;
end $$;
grant execute on function mark_advanced_sync() to authenticated;

-- ============================================================
-- END migration-2026-06.sql
-- ============================================================
