import { createClient } from "jsr:@supabase/supabase-js@2";

// Shared-secret guard. Set the value in Supabase → Edge Functions → Manage secrets:
//   ISHANGAM_SYNC_SECRET = <your secret>
// The browser extractor (scripts/ishangam-extract.js) must send the same value.
// Never hard-code the secret here or in the public repo.
const SECRET = Deno.env.get("ISHANGAM_SYNC_SECRET") ?? "";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (o: unknown, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { ...cors, "content-type": "application/json" } });

const tend = (v: unknown) => String(v ?? "").replace(/\D/g, "").slice(-10);
const d = (v: unknown) => { const m = String(v ?? "").match(/^(\d{4})-(\d{2})-(\d{2})$/); return m ? m[0] : null; };
const s = (v: unknown) => { const t = (v == null ? "" : String(v)).trim(); return t ? t : null; };
const maxd = (...xs: (string | null)[]) => { const f = xs.filter(Boolean).sort(); return f.length ? f[f.length - 1] : null; };

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "bad json" }, 400); }
  if (!SECRET || body?.secret !== SECRET) return json({ error: "unauthorized" }, 401);

  const VOL: any[] = Array.isArray(body.vol) ? body.vol : []; // [phone,name,email,gender,srcs,ie_date]
  const ADV: any[] = Array.isArray(body.adv) ? body.adv : []; // [phone,name,email,gender,bsp,shoonya,samyama]
  const dryRun = !!body.dryRun;
  if (VOL.length > 5000 || ADV.length > 5000) return json({ error: "payload too large" }, 413);

  const sb = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  const errs: string[] = [];

  // advanced people (dedupe by phone)
  const advMap = new Map<string, any>();
  for (const a of ADV) {
    const phone = tend(a[0]); if (phone.length !== 10) continue;
    const bsp = d(a[4]), sh = d(a[5]), sa = d(a[6]);
    advMap.set(phone, { phone, full_name: s(a[1]) ?? "(no name)", email: s(a[2]), gender: s(a[3]),
      bsp_date: bsp, shoonya_date: sh, samyama_date: sa, last_advanced_date: maxd(bsp, sh, sa),
      is_meditator: true, center_id: "ecity", source: "ishangam" });
  }
  // volunteer people (dedupe by phone)
  const volMap = new Map<string, any>();
  for (const a of VOL) {
    const phone = tend(a[0]); if (phone.length !== 10) continue;
    volMap.set(phone, { phone, full_name: s(a[1]) ?? "(no name)", email: s(a[2]), gender: s(a[3]),
      ie_date: d(a[5]), is_volunteer: true, center_id: "ecity", source: "ishangam" });
  }

  const allPhones = [...new Set([...advMap.keys(), ...volMap.keys()])];
  const existing = new Set<string>();
  for (let i = 0; i < allPhones.length; i += 300) {
    const { data, error } = await sb.from("people").select("id,phone").in("phone", allPhones.slice(i, i + 300));
    if (error) { errs.push("lookup:" + error.message); break; }
    (data || []).forEach((p: any) => existing.add(p.phone));
  }

  const summary = {
    dryRun,
    people_total: allPhones.length,
    people_existing: allPhones.filter((p) => existing.has(p)).length,
    people_new: allPhones.filter((p) => !existing.has(p)).length,
    volunteers: volMap.size,
    advanced_people: advMap.size,
    adv_bsp: [...advMap.values()].filter((x) => x.bsp_date).length,
    adv_shoonya: [...advMap.values()].filter((x) => x.shoonya_date).length,
    adv_samyama: [...advMap.values()].filter((x) => x.samyama_date).length,
  };
  if (dryRun) return json({ ok: errs.length === 0, summary, errors: errs });

  // Pass A: advanced -> people (dates + is_meditator). Does not touch ie_date/is_volunteer.
  const advArr = [...advMap.values()]; let advOk = 0;
  for (let i = 0; i < advArr.length; i += 500) {
    const { error } = await sb.from("people").upsert(advArr.slice(i, i + 500), { onConflict: "phone" });
    if (error) { errs.push("people_adv:" + error.message); break; }
    advOk += Math.min(500, advArr.length - i);
  }
  // Pass B: volunteers -> people (is_volunteer + identity + ie_date). Does not touch advanced dates.
  const volArr = [...volMap.values()]; let volPeopleOk = 0;
  for (let i = 0; i < volArr.length; i += 500) {
    const { error } = await sb.from("people").upsert(volArr.slice(i, i + 500), { onConflict: "phone" });
    if (error) { errs.push("people_vol:" + error.message); break; }
    volPeopleOk += Math.min(500, volArr.length - i);
  }
  // volunteer_profiles (status 'new'; never downgrade already-screened volunteers)
  let vpOk = 0;
  const volPhones = [...volMap.keys()];
  const idp: Record<string, string> = {};
  for (let i = 0; i < volPhones.length; i += 300) {
    const { data } = await sb.from("people").select("id,phone").in("phone", volPhones.slice(i, i + 300));
    (data || []).forEach((p: any) => (idp[p.phone] = p.id));
  }
  const today = new Date().toISOString().slice(0, 10);
  const vps = volPhones.filter((p) => idp[p]).map((p) => ({ person_id: idp[p], interest_source: "ishangam", interest_date: today, status: "new" }));
  for (let i = 0; i < vps.length; i += 500) {
    const { error } = await sb.from("volunteer_profiles").upsert(vps.slice(i, i + 500), { onConflict: "person_id", ignoreDuplicates: true });
    if (error) { errs.push("vp:" + error.message); break; }
    vpOk += Math.min(500, vps.length - i);
  }

  return json({ ok: errs.length === 0, summary, committed: { people_advanced: advOk, people_volunteers: volPeopleOk, volunteer_profiles_attempted: vpOk }, errors: errs });
});
