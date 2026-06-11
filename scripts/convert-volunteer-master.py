#!/usr/bin/env python3
"""
Converts "Ecity Volunteer Master.xlsx" (Name/Phone/Category/.../Programs
Volunteered/Address) into:
  data/volunteers-import.csv   -> import in the app (Volunteers tab works too)
  data/seed-history.sql        -> run ONCE in Supabase SQL Editor to load
                                  past volunteering history per person

Usage:  python3 convert-volunteer-master.py "/path/to/Ecity Volunteer Master.xlsx"
"""
import csv, os, re, sys
import openpyxl

MONTHS = {m: i+1 for i, m in enumerate(
    ["jan","feb","mar","apr","may","jun","jul","aug","sep","oct","nov","dec"])}

def guess_date(item, first_seen, last_seen):
    """'Mar 27 Hall Setup' -> a date; month Dec..May maps to Dec 2025..May 2026."""
    m = re.match(r'\s*([A-Za-z]{3,9})\s*(\d{1,2})?', item)
    if m and m.group(1).lower()[:3] in MONTHS:
        mon = MONTHS[m.group(1).lower()[:3]]
        day = int(m.group(2)) if m.group(2) else 15
        year = 2025 if mon == 12 else 2026
        try:
            return f"{year}-{mon:02d}-{min(day,28):02d}"
        except Exception:
            pass
    return str(last_seen or first_seen or "")[:10] or None

def main(path):
    wb = openpyxl.load_workbook(path, read_only=True)
    ws = wb.worksheets[0]
    rows = list(ws.iter_rows(values_only=True))
    head = [str(h or "").lower() for h in rows[0]]
    ix = {k: head.index(k) for k in
          ["name", "phone", "programs volunteered", "first seen", "last seen", "address"]
          if k in head}

    os.makedirs("data", exist_ok=True)
    sql = ["-- Seed: people + volunteer_history from Ecity Volunteer Master",
           "-- Run once in Supabase SQL Editor (after schema.sql)."]
    esc = lambda s: str(s).replace("'", "''")

    with open("data/volunteers-import.csv", "w", newline="", encoding="utf-8") as f:
        w = csv.writer(f)
        w.writerow(["name", "phone", "area"])
        for r in rows[1:]:
            name = r[ix["name"]]
            phone = re.sub(r"\D", "", str(r[ix["phone"]] or ""))[-10:]
            if not name and not phone:
                continue
            area = r[ix.get("address", 0)] if "address" in ix else ""
            w.writerow([name, phone, area or ""])
            if not phone:
                continue
            sql.append(
                f"insert into people (full_name, phone, area, source, is_volunteer) "
                f"values ('{esc(name)}','{phone}','{esc(area or '')}','import',true) "
                f"on conflict (phone) do update set is_volunteer = true;")
            progs = str(r[ix.get("programs volunteered", 0)] or "")
            for item in [p.strip() for p in progs.split(",") if p.strip()]:
                d = guess_date(item, r[ix.get("first seen", 0)], r[ix.get("last seen", 0)])
                if not d:
                    continue
                sql.append(
                    f"insert into volunteer_history (person_id, activity, happened_on, source) "
                    f"select id, '{esc(item)}', '{d}', 'import' from people where phone='{phone}' "
                    f"and not exists (select 1 from volunteer_history vh, people p "
                    f"where vh.person_id=p.id and p.phone='{phone}' "
                    f"and vh.activity='{esc(item)}' and vh.happened_on='{d}');")

    with open("data/seed-history.sql", "w", encoding="utf-8") as f:
        f.write("\n".join(sql))
    print(f"Wrote data/volunteers-import.csv and data/seed-history.sql ({len(sql)-2} statements)")

if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else "Ecity Volunteer Master.xlsx")
