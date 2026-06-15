# E-City Dashboard — June 2026 update

## Deploy in 2 steps

1. **Run the database migration** (one time):
   Supabase → SQL Editor → New query → paste all of
   `supabase/migration-2026-06.sql` → Run.
   This is safe to re-run.

2. **Ship the new code**: deploy `docs/app.js` (GitHub Pages auto-deploys
   from `docs/` on the `main` branch). No other files changed.

## What changed

### 1. All meditators now load (no more 1,000 cap)
Supabase returns at most 1,000 rows per request. A new `fetchAll()` helper
pages through every row, so the **Meditators**, **New Meditators** and
**Advanced** lists now show the full count, not just 1,000.

### 2. Volunteers split into two folders
The Volunteers tab now has **New volunteer interest** (anyone not yet
screened / status "new") and **All existing volunteers**.

### 3. New-meditator calling is nurturer-controlled
Imported new meditators now arrive as **"not calling"** (pending). Nobody is
auto-dialed. In **People → New Meditators**, filter the list, tick the people
you want, optionally pick an assignee, and press **Start calling**. Only then
are the 3 Mandala calls scheduled. (Existing active journeys are untouched.)

### 4. Advanced programs: per-program Completed + Interested
The Advanced tab now has a program picker — **BSP, Shoonya, Samyama,
Guru Puja** — and for each:

- **Completed** — pulled from the Ishangam dates. Defaults to **"New this
  week"** (completions since your last sync); toggle to **"All since go-live"**.
  No old data: only completions dated on/after the day you run the migration
  appear. Press **"I synced today"** after each weekly Ishangam scrape to roll
  the weekly window forward.
- **Interested (paper)** — enter your paper sign-up list with
  **"+ Add interested"** (name + phone). Track each person's status
  (new → contacted → registered → done).

The weekly Ishangam scrape (existing Chrome extension) now stamps the matching
completion date per program automatically, including Guru Puja.

### 5. Bug fix
Removed a duplicate `const INTERESTS` declaration that could break the app.

## Files
- `docs/app.js` — all UI/logic changes
- `supabase/migration-2026-06.sql` — schema + RPCs (run once)
