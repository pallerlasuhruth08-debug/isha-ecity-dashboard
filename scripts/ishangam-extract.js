// Ishangam weekly sync — browser extractor.
// Run in a tab logged into https://ishangam.isha.in (Santosha - My Centers / Odoo).
// It reads volunteers + advanced-program completions for Electronic City via Odoo RPC,
// dedupes, and POSTs to the Supabase Edge Function `ishangam-sync`.
//
// The shared secret is NOT stored in this file. Paste it at runtime:
//   const SECRET = "..."   // same value as ISHANGAM_SYNC_SECRET on Supabase
//
// Sources (Electronic City center_id = 584):
//   Volunteers  -> volunteer_profiles + people.is_volunteer
//     - generic.txn         master_id = 781  (IE 7 Steps Vol)
//     - program.attendance  local_program_type_id = "Inner Engineering Ambassador"  (IE Ambassador / Yoga Veera)
//     - volunteering        center_id = 584  (Ashram Volunteering)
//   Advanced (completions) -> people.{bsp,shoonya,samyama}_date + is_meditator
//     - program.attendance  category in (Bhava Spandana, Shoonya, Samyama), reg_status = COMPLETED
//       date used = end_date (fallback start_date), latest per person.

const SECRET = "PASTE_ISHANGAM_SYNC_SECRET_HERE";
const FN = "https://oreljszgkligutxdwgxw.supabase.co/functions/v1/ishangam-sync";
const EC = 584;

const rpc = async (model, method, args = [], kwargs = {}) => {
  const r = await fetch("/web/dataset/call_kw/" + model + "/" + method, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", method: "call", params: { model, method, args, kwargs } }),
  });
  return (await r.json()).result;
};
const p10 = (v) => { const d = String(v || "").replace(/\D/g, ""); return d.length >= 10 ? d.slice(-10) : null; };
const sr = (m, dom, f) => rpc(m, "search_read", [dom, f], { limit: 5000 });

async function buildPayload() {
  const vol = {}, adv = {}, skipped = { vol: 0, adv: 0 };
  const addVol = (name, email, phone, gender, ie) => {
    const ph = p10(phone); if (!ph) { skipped.vol++; return; }
    const c = vol[ph] || { srcs: [] };
    c.name = c.name || (name || "").trim(); c.email = c.email || (email || "").trim().toLowerCase();
    c.gender = c.gender || gender || null; c.ie = c.ie || ie || ""; vol[ph] = c;
  };
  (await sr("generic.txn", [["master_id", "=", 781], ["center_id", "=", EC]],
    ["name", "email", "phone", "whatsapp_number", "gender", "ie_date"]))
    .forEach((r) => addVol(r.name, r.email, r.phone || r.whatsapp_number, r.gender, r.ie_date));
  (await sr("program.attendance", [["center_id", "=", EC], ["local_program_type_id", "=", "Inner Engineering Ambassador"]],
    ["record_name", "record_email", "record_phone", "whatsapp_number", "gender"]))
    .forEach((r) => addVol(r.record_name, r.record_email, r.record_phone || r.whatsapp_number, r.gender, ""));
  (await sr("volunteering", [["center_id", "=", EC]],
    ["record_name", "record_email", "record_phone", "whatsapp_number", "gender"]))
    .forEach((r) => addVol(r.record_name, r.record_email, r.record_phone || r.whatsapp_number, r.gender, ""));

  const catKey = { "Bhava Spandana": "bsp", "Shoonya": "sh", "Samyama": "sa" };
  (await sr("program.attendance",
    [["center_id", "=", EC], ["category", "in", Object.keys(catKey)], ["reg_status", "=", "COMPLETED"]],
    ["name", "email", "phone", "whatsapp_number", "gender", "category", "start_date", "end_date"]))
    .forEach((r) => {
      const ph = p10(r.phone || r.whatsapp_number); if (!ph) { skipped.adv++; return; }
      const k = catKey[r.category], dt = r.end_date || r.start_date || "";
      const c = adv[ph] || {};
      c.name = c.name || (r.name || "").trim(); c.email = c.email || (r.email || "").trim().toLowerCase();
      c.gender = c.gender || r.gender || null;
      if (dt && (!c[k] || dt > c[k])) c[k] = dt; adv[ph] = c;
    });

  return {
    vol: Object.entries(vol).map(([ph, v]) => [ph, v.name, v.email, v.gender, v.srcs.join("|"), v.ie || ""]),
    adv: Object.entries(adv).map(([ph, v]) => [ph, v.name, v.email, v.gender, v.bsp || "", v.sh || "", v.sa || ""]),
    skipped,
  };
}

async function run({ dryRun = true } = {}) {
  const P = await buildPayload();
  const r = await fetch(FN, { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret: SECRET, dryRun, vol: P.vol, adv: P.adv }) });
  const out = await r.json();
  console.log("skipped(no phone):", P.skipped, "\nresult:", JSON.stringify(out, null, 2));
  return out;
}

// Usage:
//   await run({ dryRun: true });   // preview counts, no writes
//   await run({ dryRun: false });  // commit
window.ishangamSync = run;
