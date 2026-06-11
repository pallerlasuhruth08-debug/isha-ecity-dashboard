/**
 * Google Form → Supabase sync (free, automatic).
 *
 * SETUP (5 minutes):
 * 1. Open your Google Form's RESPONSE SHEET → Extensions → Apps Script.
 * 2. Paste this whole file. Fill in SUPABASE_URL / ANON_KEY / EMAIL / PASSWORD
 *    (use a coordinator account from the dashboard).
 * 3. Adjust FIELD_MAP so the left side matches your form's question titles.
 * 4. Run `syncAll` once (authorize when asked) to import existing responses.
 * 5. Triggers (clock icon) → Add Trigger → function `onFormSubmit`,
 *    event source "From spreadsheet", event type "On form submit".
 * Done — every new response lands in the dashboard instantly.
 */

const SUPABASE_URL = "https://YOUR-PROJECT-ref.supabase.co";
const ANON_KEY     = "YOUR-ANON-KEY";
const LOGIN_EMAIL  = "coordinator@example.com";
const LOGIN_PASS   = "password";

// form question title (lowercase) -> dashboard field
const FIELD_MAP = {
  "name": "full_name", "full name": "full_name",
  "phone": "phone", "phone number": "phone", "whatsapp number": "phone",
  "email": "email", "email address": "email",
  "pincode": "pincode", "pin code": "pincode",
  "area": "area", "locality": "area",
  "what activities interest you": "interests",
  "preferred timing": "preferred_timing",
  "online or offline": "mode",
  "can you offer space for sessions": "can_offer_space"
};

function getToken_() {
  const r = UrlFetchApp.fetch(SUPABASE_URL + "/auth/v1/token?grant_type=password", {
    method: "post", contentType: "application/json",
    headers: { apikey: ANON_KEY },
    payload: JSON.stringify({ email: LOGIN_EMAIL, password: LOGIN_PASS }),
    muteHttpExceptions: true
  });
  const j = JSON.parse(r.getContentText());
  if (!j.access_token) throw new Error("Login failed: " + r.getContentText());
  return j.access_token;
}

function rowToPayload_(headers, row) {
  const o = { kind: "volunteer", source: "gform" };
  headers.forEach((h, i) => {
    const f = FIELD_MAP[String(h).toLowerCase().trim()];
    if (!f || row[i] === "" || row[i] == null) return;
    let v = String(row[i]).trim();
    if (f === "interests") v = v.split(/,\s*/);
    if (f === "can_offer_space") v = /yes|true/i.test(v);
    if (f === "mode") v = /online/i.test(v) && /offline|both/i.test(v) ? "both" : /online/i.test(v) ? "online" : "offline";
    o[f] = v;
  });
  return (o.full_name || o.phone) ? o : null;
}

function push_(rows) {
  if (!rows.length) return;
  const token = getToken_();
  UrlFetchApp.fetch(SUPABASE_URL + "/rest/v1/rpc/import_people", {
    method: "post", contentType: "application/json",
    headers: { apikey: ANON_KEY, Authorization: "Bearer " + token },
    payload: JSON.stringify({ rows: rows })
  });
}

function onFormSubmit(e) {
  const sheet = e.range.getSheet();
  const headers = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  const p = rowToPayload_(headers, e.values);
  if (p) push_([p]);
}

function syncAll() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
  const data = sheet.getDataRange().getValues();
  const headers = data.shift();
  const rows = data.map(r => rowToPayload_(headers, r)).filter(Boolean);
  push_(rows);
  Logger.log("Pushed " + rows.length + " rows");
}
