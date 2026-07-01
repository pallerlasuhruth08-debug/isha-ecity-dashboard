# Ishangam weekly sync

Pulls **volunteers** and **advanced-program completions** for Electronic City from
Ishangam (Odoo, `Santosha - My Centers`) and upserts them into Supabase via the
`ishangam-sync` Edge Function. Browser automation only — never enters credentials;
the operator must already be logged into https://ishangam.isha.in.

## Pieces
- `scripts/ishangam-extract.js` — runs in the logged-in Ishangam tab; extracts via Odoo
  RPC (`/web/dataset/call_kw/...`), dedupes by phone, POSTs to the function.
- `supabase/functions/ishangam-sync/index.ts` — service-role writer, shared-secret guarded,
  supports `dryRun`. Deployed to project `oreljszgkligutxdwgxw`.

## Secret
Function reads `ISHANGAM_SYNC_SECRET` from Supabase env (Edge Functions → Manage secrets).
The extractor sends the same value. **Not** stored in this repo.

## Sources (Electronic City `center_id = 584`)

| Purpose | Odoo model | Filter | -> Supabase |
|---|---|---|---|
| Volunteers | `generic.txn` | `master_id = 781` (IE 7 Steps Vol) | `volunteer_profiles` + `people.is_volunteer` |
| Volunteers | `program.attendance` | `local_program_type_id = "Inner Engineering Ambassador"` (IE Ambassador / Yoga Veera) | same |
| Volunteers | `volunteering` | `center_id = 584` (Ashram Volunteering) | same |
| Advanced | `program.attendance` | `category in (Bhava Spandana, Shoonya, Samyama)` + `reg_status = COMPLETED` | `people.{bsp,shoonya,samyama}_date` + `is_meditator` |

Notes
- Match key: **phone** normalised to last 10 digits (`people_before_write` also normalises).
- Advanced completion date = `end_date` (fallback `start_date`), latest per person; sets
  `last_advanced_date = max(bsp,shoonya,samyama)`.
- `center_id` set to `ecity`; the `apply_pincode_center` trigger still wins where a pincode maps.
- `volunteer_profiles` upsert uses `ignoreDuplicates` -> never resets a screened volunteer to `new`.
- Everything tagged `source = 'ishangam'` for reversibility.
- Odoo action domains were read live from `odoo.__WOWL_DEBUG__.root.env.services.action.currentController.action.domain`
  (direct `ir.actions.act_window` reads are access-blocked).

## Run
1. Log into Ishangam; open `Santosha - My Centers`.
2. Paste `scripts/ishangam-extract.js` into the tab console, set `SECRET`.
3. `await ishangamSync({ dryRun: true })` -> review counts.
4. `await ishangamSync({ dryRun: false })` -> commit.

## Baseline (last run, 2026-07-01)
People touched 916 (23 new, 893 updated); volunteers 360 (176 new profiles);
advanced people 730 (BSP 604 / Shoonya 471 / Samyama 211).
