-- ============================================================
-- ISHA E-CITY DASHBOARD  --  Migration June 2026 (part b)
-- RUN AFTER migration-2026-06.sql. Safe to re-run.
--
-- Adds richer meditator profile fields captured from Ishangam
-- (occupation, gender, date of birth, street address, city) and
-- makes import_people store them.
-- ============================================================

-- 1. Profile columns (email, pincode, area already exist)
alter table people add column if not exists occupation    text;
alter table people add column if not exists gender        text;
alter table people add column if not exists date_of_birth date;
alter table people add column if not exists street        text;
alter table people add column if not exists city          text;

-- 2. import_people: capture profile fields (and keep pending-new-meditator
--    + advanced date-stamping behaviour from migration-2026-06.sql)
create or replace function import_people(rows jsonb) returns jsonb
language plpgsql security definer set search_path = public as $$
declare r jsonb; pid uuid; ph text; inserted int := 0; skipped int := 0; jcount int := 0;
        knd text; prog text; pdate date; dob date;
begin
  if my_role() not in ('coordinator','rco') then
    raise exception 'Only coordinators/RCO can import';
  end if;
  for r in select * from jsonb_array_elements(rows) loop
    knd := r->>'kind';
    ph := regexp_replace(coalesce(r->>'phone',''), '\D', '', 'g');
    if length(ph) > 10 then ph := right(ph, 10); end if;
    if ph = '' then ph := null; end if;

    dob := null;
    begin dob := nullif(r->>'date_of_birth','')::date; exception when others then dob := null; end;

    select id into pid from people where phone = ph and ph is not null;
    if pid is null then
      insert into people (full_name, phone, email, pincode, area, occupation, gender,
                          date_of_birth, street, city, source, is_meditator, is_volunteer)
      values (coalesce(r->>'full_name','(no name)'), ph, r->>'email', r->>'pincode', r->>'area',
              nullif(r->>'occupation',''), nullif(r->>'gender',''), dob,
              nullif(r->>'street',''), nullif(r->>'city',''),
              coalesce(r->>'source','import'),
              knd in ('new_meditator','meditator','advanced'),
              knd = 'volunteer')
      returning id into pid;
      inserted := inserted + 1;
    else
      skipped := skipped + 1;
      update people set
        full_name     = coalesce(nullif(r->>'full_name',''), full_name),
        pincode       = coalesce(nullif(r->>'pincode',''), pincode),
        email         = coalesce(nullif(r->>'email',''), email),
        area          = coalesce(nullif(r->>'area',''), area),
        occupation    = coalesce(nullif(r->>'occupation',''), occupation),
        gender        = coalesce(nullif(r->>'gender',''), gender),
        date_of_birth = coalesce(dob, date_of_birth),
        street        = coalesce(nullif(r->>'street',''), street),
        city          = coalesce(nullif(r->>'city',''), city),
        is_meditator  = is_meditator or knd in ('new_meditator','meditator','advanced'),
        is_volunteer  = is_volunteer or knd = 'volunteer'
      where id = pid;
    end if;

    if knd in ('new_meditator','meditator','advanced') then
      pdate := coalesce((r->>'program_date')::date, current_date);
      if knd = 'advanced' then
        prog := lower(coalesce(r->>'program_name',''));
        if    prog like '%bsp%' or prog like '%bhava%' then update people set bsp_date       = pdate where id = pid;
        elsif prog like '%shoonya%' or prog like '%shunya%' then update people set shoonya_date = pdate where id = pid;
        elsif prog like '%samyama%' then update people set samyama_date   = pdate where id = pid;
        elsif prog like '%guru%'    then update people set guru_puja_date = pdate where id = pid;
        end if;
        if ph is not null then
          begin
            insert into advanced_seen values (ph, coalesce(r->>'program_name','Advanced'), pdate);
          exception when unique_violation then continue;
          end;
        end if;
      elsif knd = 'new_meditator' then
        -- stamp IE date on the person too (for the Meditators profile)
        update people set ie_date = pdate where id = pid and (ie_date is null or ie_date < pdate);
      end if;

      -- 'meditator' = directory entry only (no call journey, avoids flooding Today
      -- with thousands of calls on a bulk base import). new_meditator + advanced
      -- still create journeys.
      if knd <> 'meditator' then
        insert into journeys (person_id, type, program_name, program_date, status)
        values (pid,
                case knd when 'advanced' then 'advanced' else 'new_meditator' end,
                r->>'program_name', pdate,
                case when knd = 'new_meditator' then 'pending' else 'active' end)
        on conflict do nothing;
        jcount := jcount + 1;
      end if;

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

-- ============================================================
-- END migration-2026-06b.sql
-- ============================================================
