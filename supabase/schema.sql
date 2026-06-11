-- ============================================================
-- ISHA E-CITY SECTOR NURTURING & VOLUNTEER COORDINATION
-- Supabase Postgres schema. Run this whole file ONCE in the
-- Supabase SQL Editor (Dashboard -> SQL Editor -> New query).
-- Safe to re-run: uses IF NOT EXISTS / OR REPLACE everywhere.
-- ============================================================

-- ---------- 0. EXTENSIONS ----------
create extension if not exists pgcrypto;

-- ---------- 1. CENTERS ----------
create table if not exists centers (
  id          text primary key,            -- 'ecity' | 'begur' | 'chandapura' | 'unassigned'
  name        text not null,
  created_at  timestamptz default now()
);

insert into centers (id, name) values
  ('ecity',      'Electronic City'),
  ('begur',      'Begur-Singasandra'),
  ('chandapura', 'Chandapura'),
  ('unassigned', 'Unassigned')
on conflict (id) do nothing;

-- ---------- 2. SETTINGS (editable config: pincode map, reminders, suggestion rules) ----------
create table if not exists settings (
  key        text primary key,
  value      jsonb not null,
  updated_at timestamptz default now()
);

insert into settings (key, value) values
  ('pincode_map', '{
     "560100": "ecity",
     "560068": "begur",  "560114": "begur",
     "562106": "chandapura", "562107": "chandapura",
     "560099": "chandapura", "560105": "chandapura", "560081": "chandapura"
   }'),
  ('call_schedule_days', '{"1": 1, "2": 15, "3": 40}'),
  ('reminder_config', '{"overdue_after_days": 0, "email_hour_ist": 8, "remind_before_days": 0}'),
  ('suggestion_rules', '[
     {"when_status": "stopped",            "min_count": 5,  "suggest": "Organize a Practice Correction session / restart satsang"},
     {"when_status": "needs_support",      "min_count": 5,  "suggest": "Consider a Patanjali sangha or group sadhana support session"},
     {"when_status": "irregular",          "min_count": 5,  "suggest": "Invite cluster to Monthly Satsang"},
     {"when_status": "wants_advanced",     "min_count": 3,  "suggest": "Coordinate a group for BSP/Shoonya registration"},
     {"when_status": "wants_ashram",       "min_count": 3,  "suggest": "Organize a group Ashram (IYC) trip"},
     {"when_status": "wants_sannidhi",     "min_count": 3,  "suggest": "Plan Sadhguru Sannidhi visit / Guru Sannidhi at home support"},
     {"when_status": "needs_correction",   "min_count": 3,  "suggest": "Schedule a Practice Correction session"}
   ]'),
  ('next_action_map', '{
     "regular":          ["Invite to volunteer at center", "Invite to Monthly Satsang"],
     "irregular":        ["Invite to satsang", "Offer practice correction session"],
     "stopped":          ["Invite to satsang", "Practice correction session", "Patanjali sangha", "Meet with Isha volunteer"],
     "wants_ashram":     ["Share IYC visit details", "Connect to group Ashram trip"],
     "wants_sannidhi":   ["Share Sadhguru Sannidhi Bengaluru schedule", "Guru Sannidhi at home info"],
     "wants_advanced":   ["Share upcoming BSP/Shoonya/Samyama dates", "Connect to program team"],
     "needs_correction": ["Book practice correction slot"],
     "other":            ["Note and follow up"]
   }')
on conflict (key) do nothing;

-- ---------- 3. PROFILES (app users) ----------
-- role: 'volunteer' | 'coordinator' | 'rco'
create table if not exists profiles (
  id         uuid primary key references auth.users(id) on delete cascade,
  full_name  text not null default '',
  phone      text,
  email      text,
  role       text not null default 'volunteer' check (role in ('volunteer','coordinator','rco')),
  center_id  text references centers(id) default 'unassigned',
  active     boolean not null default true,
  created_at timestamptz default now()
);

-- auto-create a profile row on signup
create or replace function handle_new_user() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'full_name',''))
  on conflict (id) do nothing;
  return new;
end $$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- helper fns used by RLS (security definer so they can read profiles)
create or replace function my_role() returns text
language sql stable security definer set search_path = public as
$$ select coalesce((select role from profiles where id = auth.uid()), 'volunteer') $$;

create or replace function my_center() returns text
language sql stable security definer set search_path = public as
$$ select coalesce((select center_id from profiles where id = auth.uid()), 'unassigned') $$;

-- ---------- 4. PINCODE ROUTING ----------
create or replace function center_for_pincode(p text) returns text
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select value->>trim(p) from settings where key = 'pincode_map'),
    'unassigned')
$$;

-- ---------- 5. PEOPLE (unified person registry: meditators + volunteers) ----------
create table if not exists people (
  id            uuid primary key default gen_random_uuid(),
  full_name     text not null,
  phone         text,                              -- normalized 10-digit where possible
  email         text,
  pincode       text,
  area          text,
  center_id     text references centers(id) default 'unassigned',
  is_meditator  boolean default false,
  is_volunteer  boolean default false,
  source        text,                              -- 'ishangam' | 'csv' | 'paper_ocr' | 'gform' | 'manual' | 'attendance'
  created_at    timestamptz default now(),
  updated_at    timestamptz default now(),
  unique (phone)
);
create index if not exists people_center_idx on people(center_id);

-- normalize phone + route center on insert/update
create or replace function people_before_write() returns trigger
language plpgsql as $$
begin
  if new.phone is not null then
    new.phone := regexp_replace(new.phone, '\D', '', 'g');
    if length(new.phone) > 10 then new.phone := right(new.phone, 10); end if;
    if new.phone = '' then new.phone := null; end if;
  end if;
  if (new.center_id is null or new.center_id = 'unassigned') and new.pincode is not null then
    new.center_id := center_for_pincode(new.pincode);
  end if;
  new.updated_at := now();
  return new;
end $$;

drop trigger if exists people_bw on people;
create trigger people_bw before insert or update on people
  for each row execute function people_before_write();

-- ---------- 6. JOURNEYS + CALLS (all nurturing flows share this) ----------
-- journey types:
--  'new_meditator'    Module 1 (3-call mandala journey)
--  'meditator'        Module 4 (older meditators, open-ended)
--  'advanced'         Module 5 (post advanced-program call)
--  'volunteer_nurture' Plugin 1 (post Ashram/SSB volunteering call)
create table if not exists journeys (
  id              uuid primary key default gen_random_uuid(),
  person_id       uuid not null references people(id) on delete cascade,
  type            text not null check (type in ('new_meditator','meditator','advanced','volunteer_nurture')),
  program_name    text,
  program_date    date,                 -- initiation / completion date
  center_id       text references centers(id) default 'unassigned',
  assigned_to     uuid references profiles(id),
  status          text not null default 'active' check (status in ('active','completed','dropped')),
  sadhana_status  text,                 -- latest known status (denormalized for insights)
  created_at      timestamptz default now(),
  unique (person_id, type, program_name, program_date)
);
create index if not exists journeys_assigned_idx on journeys(assigned_to);
create index if not exists journeys_center_idx on journeys(center_id);

create table if not exists calls (
  id              uuid primary key default gen_random_uuid(),
  journey_id      uuid not null references journeys(id) on delete cascade,
  call_no         int  not null default 1,
  due_date        date not null,
  completed_at    timestamptz,
  reachability    text check (reachability in ('answered','not_reachable','will_call_back')),
  sadhana_status  text,   -- see app for full vocabulary per module
  remarks         text,
  logged_by       uuid references profiles(id),
  created_at      timestamptz default now()
);
create index if not exists calls_due_idx on calls(due_date) where completed_at is null;
create index if not exists calls_journey_idx on calls(journey_id);

-- inherit center from person; auto-create scheduled calls
create or replace function journeys_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
declare sched jsonb; k text; v text; base date;
begin
  update journeys j set center_id = p.center_id
    from people p where p.id = new.person_id and j.id = new.id;

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

drop trigger if exists journeys_ai on journeys;
create trigger journeys_ai after insert on journeys
  for each row execute function journeys_after_insert();

-- when a call is logged: update journey status; schedule follow-ups
create or replace function calls_after_update() returns trigger
language plpgsql security definer set search_path = public as $$
declare jt text; remaining int;
begin
  if new.completed_at is not null and old.completed_at is null then
    select type into jt from journeys where id = new.journey_id;
    if new.sadhana_status is not null then
      update journeys set sadhana_status = new.sadhana_status where id = new.journey_id;
    end if;
    -- "will call back" => clone a retry call due in 2 days
    if new.reachability in ('will_call_back','not_reachable') then
      insert into calls (journey_id, call_no, due_date)
      values (new.journey_id, new.call_no, current_date + 2);
    end if;
    -- mark journey completed when no open calls remain (3-call journeys)
    select count(*) into remaining from calls
      where journey_id = new.journey_id and completed_at is null;
    if remaining = 0 then
      update journeys set status = 'completed' where id = new.journey_id;
    end if;
  end if;
  return new;
end $$;

drop trigger if exists calls_au on calls;
create trigger calls_au after update on calls
  for each row execute function calls_after_update();

-- ---------- 7. VOLUNTEER PROFILES (Module 2) ----------
create table if not exists volunteer_profiles (
  person_id        uuid primary key references people(id) on delete cascade,
  interests        text[] default '{}',   -- e.g. {Online Calling, Offline Programs, E-Media, ...}
  preferred_timing text,                  -- 'weekday_morning' | 'weekday_evening' | 'weekend' | 'flexible'
  mode             text,                  -- 'online' | 'offline' | 'both'
  can_offer_space  boolean default false,
  occupation       text,
  languages        text,
  programs_done    text,                  -- IE / advanced programs done (screening)
  screened         boolean default false,
  screening_notes  text,
  interest_source  text,                  -- 'paper' | 'gform' | 'odoo' | 'import'
  interest_date    date default current_date,
  status           text default 'new' check (status in ('new','contacted','matched','active','inactive')),
  updated_at       timestamptz default now()
);

-- ---------- 8. ACTIVITIES + ATTENDANCE + HISTORY (Modules 2/3) ----------
create table if not exists activities (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  center_id  text references centers(id) not null,
  activity_date date not null default current_date,
  qr_token   text not null default encode(gen_random_bytes(8),'hex'),
  is_open    boolean default true,
  created_by uuid references profiles(id),
  created_at timestamptz default now()
);

create table if not exists attendance (
  id          uuid primary key default gen_random_uuid(),
  activity_id uuid not null references activities(id) on delete cascade,
  person_id   uuid not null references people(id),
  time_in     timestamptz default now(),
  time_out    timestamptz,
  unique (activity_id, person_id)
);

create table if not exists volunteer_history (
  id          uuid primary key default gen_random_uuid(),
  person_id   uuid not null references people(id) on delete cascade,
  activity    text not null,
  center_id   text references centers(id),
  happened_on date not null default current_date,
  hours       numeric,
  source      text default 'manual',  -- 'attendance' | 'import' | 'manual' | 'ashram_ssb'
  notes       text,
  created_at  timestamptz default now()
);
create index if not exists vh_person_idx on volunteer_history(person_id);

-- attendance time_out => write a history row automatically
create or replace function attendance_after_update() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.time_out is not null and old.time_out is null then
    insert into volunteer_history (person_id, activity, center_id, happened_on, hours, source)
    select new.person_id, a.name, a.center_id, a.activity_date,
           round(extract(epoch from (new.time_out - new.time_in))/3600.0, 1), 'attendance'
    from activities a where a.id = new.activity_id;
    update people set is_volunteer = true where id = new.person_id;
  end if;
  return new;
end $$;

drop trigger if exists attendance_au on attendance;
create trigger attendance_au after update on attendance
  for each row execute function attendance_after_update();

-- Plugin 1: Ashram/SSB volunteering record fires a volunteer_nurture journey
create or replace function vh_after_insert() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if new.source = 'ashram_ssb' then
    insert into journeys (person_id, type, program_name, program_date)
    values (new.person_id, 'volunteer_nurture', new.activity, new.happened_on)
    on conflict do nothing;
  end if;
  return new;
end $$;

drop trigger if exists vh_ai on volunteer_history;
create trigger vh_ai after insert on volunteer_history
  for each row execute function vh_after_insert();

-- ---------- 9. ADVANCED PROGRAM dedupe ledger (Module 5 daily scrape) ----------
create table if not exists advanced_seen (
  phone           text,
  program_name    text,
  completion_date date,
  primary key (phone, program_name, completion_date)
);

-- ---------- 10. IMPORT RPC (used by extension + CSV upload; dedupes & routes) ----------
-- rows: [{full_name, phone, email, pincode, area, program_name, program_date, kind}]
-- kind: 'new_meditator' | 'meditator' | 'advanced' | 'volunteer'
create or replace function import_people(rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; pid uuid; ph text; inserted int := 0; skipped int := 0; jcount int := 0;
begin
  if my_role() not in ('coordinator','rco') then
    raise exception 'Only coordinators/RCO can import';
  end if;
  for r in select * from jsonb_array_elements(rows) loop
    ph := regexp_replace(coalesce(r->>'phone',''), '\D', '', 'g');
    if length(ph) > 10 then ph := right(ph, 10); end if;
    if ph = '' then ph := null; end if;

    select id into pid from people where phone = ph and ph is not null;
    if pid is null then
      insert into people (full_name, phone, email, pincode, area, source,
                          is_meditator, is_volunteer)
      values (coalesce(r->>'full_name','(no name)'), ph, r->>'email',
              r->>'pincode', r->>'area', coalesce(r->>'source','import'),
              (r->>'kind') in ('new_meditator','meditator','advanced'),
              (r->>'kind') = 'volunteer')
      returning id into pid;
      inserted := inserted + 1;
    else
      skipped := skipped + 1;
      update people set
        full_name = coalesce(nullif(r->>'full_name',''), full_name),
        pincode   = coalesce(nullif(r->>'pincode',''), pincode),
        is_meditator = is_meditator or (r->>'kind') in ('new_meditator','meditator','advanced'),
        is_volunteer = is_volunteer or (r->>'kind') = 'volunteer'
      where id = pid;
    end if;

    if (r->>'kind') in ('new_meditator','meditator','advanced') then
      -- advanced: only journey if newly seen (date-based dedupe)
      if (r->>'kind') = 'advanced' then
        if ph is not null then
          begin
            insert into advanced_seen values (ph, coalesce(r->>'program_name','Advanced'),
                                              coalesce((r->>'program_date')::date, current_date));
          exception when unique_violation then continue;
          end;
        end if;
      end if;
      insert into journeys (person_id, type, program_name, program_date)
      values (pid,
              case (r->>'kind') when 'advanced' then 'advanced'
                                when 'meditator' then 'meditator'
                                else 'new_meditator' end,
              r->>'program_name',
              coalesce((r->>'program_date')::date, current_date))
      on conflict do nothing;
      jcount := jcount + 1;
    elsif (r->>'kind') = 'volunteer' then
      insert into volunteer_profiles (person_id, interests, preferred_timing, mode,
                                      can_offer_space, interest_source)
      values (pid,
              coalesce((select array_agg(x) from jsonb_array_elements_text(r->'interests') x), '{}'),
              r->>'preferred_timing', r->>'mode',
              coalesce((r->>'can_offer_space')::boolean, false),
              coalesce(r->>'source','import'))
      on conflict (person_id) do update set
        interests = (select array(select distinct unnest(volunteer_profiles.interests || excluded.interests))),
        updated_at = now();
    end if;
  end loop;
  return jsonb_build_object('inserted', inserted, 'merged', skipped, 'journeys', jcount);
end $$;

-- ---------- 11. QR CHECK-IN RPCs (anonymous, token-gated) ----------
create or replace function checkin(p_token text, p_name text, p_phone text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare act activities%rowtype; pid uuid; ph text;
begin
  select * into act from activities where qr_token = p_token and is_open;
  if act.id is null then return jsonb_build_object('error','Invalid or closed activity'); end if;
  ph := regexp_replace(coalesce(p_phone,''), '\D','','g');
  if length(ph) > 10 then ph := right(ph,10); end if;
  if length(ph) < 10 then return jsonb_build_object('error','Enter a valid 10-digit phone'); end if;

  select id into pid from people where phone = ph;
  if pid is null then
    insert into people (full_name, phone, source, is_volunteer, center_id)
    values (coalesce(nullif(p_name,''),'(no name)'), ph, 'attendance', true, act.center_id)
    returning id into pid;
  end if;
  insert into attendance (activity_id, person_id) values (act.id, pid)
  on conflict (activity_id, person_id) do nothing;
  return jsonb_build_object('ok', true, 'activity', act.name, 'action', 'in');
end $$;

create or replace function checkout(p_token text, p_phone text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare act activities%rowtype; pid uuid; ph text;
begin
  select * into act from activities where qr_token = p_token;
  if act.id is null then return jsonb_build_object('error','Invalid activity'); end if;
  ph := right(regexp_replace(coalesce(p_phone,''), '\D','','g'), 10);
  select id into pid from people where phone = ph;
  if pid is null then return jsonb_build_object('error','Phone not found — check in first'); end if;
  update attendance set time_out = now()
   where activity_id = act.id and person_id = pid and time_out is null;
  return jsonb_build_object('ok', true, 'activity', act.name, 'action', 'out');
end $$;

-- expose activity name to the check-in page without auth
create or replace function activity_by_token(p_token text) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(
    (select jsonb_build_object('name', name, 'date', activity_date, 'open', is_open)
       from activities where qr_token = p_token),
    jsonb_build_object('error','not found'))
$$;

grant execute on function checkin(text,text,text)  to anon;
grant execute on function checkout(text,text)      to anon;
grant execute on function activity_by_token(text)  to anon;

-- ---------- 12. ROW LEVEL SECURITY ----------
alter table profiles           enable row level security;
alter table people             enable row level security;
alter table journeys           enable row level security;
alter table calls              enable row level security;
alter table volunteer_profiles enable row level security;
alter table activities         enable row level security;
alter table attendance         enable row level security;
alter table volunteer_history  enable row level security;
alter table settings           enable row level security;
alter table centers            enable row level security;
alter table advanced_seen      enable row level security;

-- centers + settings: readable by all logged-in users; writable by RCO
drop policy if exists centers_read on centers;
create policy centers_read on centers for select to authenticated using (true);
drop policy if exists settings_read on settings;
create policy settings_read on settings for select to authenticated using (true);
drop policy if exists settings_write on settings;
create policy settings_write on settings for all to authenticated
  using (my_role() = 'rco') with check (my_role() = 'rco');

-- profiles: read own + (coordinator: center, rco: all); RCO manages roles
drop policy if exists profiles_read on profiles;
create policy profiles_read on profiles for select to authenticated using (
  id = auth.uid()
  or my_role() = 'rco'
  or (my_role() = 'coordinator' and center_id = my_center())
);
drop policy if exists profiles_self_update on profiles;
create policy profiles_self_update on profiles for update to authenticated
  using (id = auth.uid() or my_role() = 'rco')
  with check (
    my_role() = 'rco'
    or (id = auth.uid() and role = (select role from profiles where id = auth.uid()))
  );

-- people: volunteer sees only people on journeys assigned to them;
-- coordinator sees their center; rco sees all
drop policy if exists people_read on people;
create policy people_read on people for select to authenticated using (
  my_role() = 'rco'
  or (my_role() = 'coordinator' and center_id = my_center())
  or exists (select 1 from journeys j where j.person_id = people.id and j.assigned_to = auth.uid())
);
drop policy if exists people_write on people;
create policy people_write on people for insert to authenticated
  with check (my_role() in ('coordinator','rco'));
drop policy if exists people_update on people;
create policy people_update on people for update to authenticated
  using (my_role() = 'rco' or (my_role() = 'coordinator' and center_id = my_center()));

-- journeys
drop policy if exists journeys_read on journeys;
create policy journeys_read on journeys for select to authenticated using (
  my_role() = 'rco'
  or (my_role() = 'coordinator' and center_id = my_center())
  or assigned_to = auth.uid()
);
drop policy if exists journeys_write on journeys;
create policy journeys_write on journeys for insert to authenticated
  with check (my_role() in ('coordinator','rco'));
drop policy if exists journeys_update on journeys;
create policy journeys_update on journeys for update to authenticated using (
  my_role() = 'rco'
  or (my_role() = 'coordinator' and center_id = my_center())
  or assigned_to = auth.uid()
);

-- calls: visible/loggable when you can see the journey
drop policy if exists calls_read on calls;
create policy calls_read on calls for select to authenticated using (
  exists (select 1 from journeys j where j.id = calls.journey_id and (
    my_role() = 'rco'
    or (my_role() = 'coordinator' and j.center_id = my_center())
    or j.assigned_to = auth.uid()))
);
drop policy if exists calls_update on calls;
create policy calls_update on calls for update to authenticated using (
  exists (select 1 from journeys j where j.id = calls.journey_id and (
    my_role() in ('coordinator','rco') and (my_role()='rco' or j.center_id = my_center())
    or j.assigned_to = auth.uid()))
);
drop policy if exists calls_insert on calls;
create policy calls_insert on calls for insert to authenticated
  with check (my_role() in ('coordinator','rco'));

-- volunteer_profiles / history / activities / attendance: coordinator+ scope
drop policy if exists vp_all on volunteer_profiles;
create policy vp_all on volunteer_profiles for all to authenticated using (
  my_role() = 'rco' or (my_role() = 'coordinator' and exists
    (select 1 from people p where p.id = person_id and p.center_id = my_center()))
) with check (my_role() in ('coordinator','rco'));

drop policy if exists vh_all on volunteer_history;
create policy vh_all on volunteer_history for all to authenticated using (
  my_role() = 'rco' or (my_role() = 'coordinator' and center_id = my_center())
) with check (my_role() in ('coordinator','rco'));

drop policy if exists act_all on activities;
create policy act_all on activities for all to authenticated using (
  my_role() = 'rco' or (my_role() = 'coordinator' and center_id = my_center())
) with check (my_role() in ('coordinator','rco'));

drop policy if exists att_read on attendance;
create policy att_read on attendance for select to authenticated using (
  my_role() = 'rco' or exists
    (select 1 from activities a where a.id = activity_id and a.center_id = my_center())
);

drop policy if exists adv_seen on advanced_seen;
create policy adv_seen on advanced_seen for all to authenticated
  using (my_role() in ('coordinator','rco')) with check (my_role() in ('coordinator','rco'));

-- ---------- 13. PROMOTE FIRST RCO ----------
-- After you sign up in the app, run (replace with your email):
-- update profiles set role='rco', center_id='ecity'
--   where email = 'pallerlasuhruth08@gmail.com';
