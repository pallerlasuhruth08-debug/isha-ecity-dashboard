// Supabase Edge Function: send-reminders
// Emails each volunteer a list of their due/overdue calls via Resend (free tier).
// Schedule it daily (see README §6). Secrets needed:
//   RESEND_API_KEY  — from https://resend.com (free: 100 emails/day)
//   FROM_EMAIL      — e.g. "E-City Nurturing <onboarding@resend.dev>"
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY are injected automatically.

import { createClient } from "npm:@supabase/supabase-js@2";

Deno.serve(async () => {
  const sb = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  );

  const today = new Date().toISOString().slice(0, 10);

  // overdue grace from settings
  const { data: cfgRow } = await sb.from("settings").select("value")
    .eq("key", "reminder_config").single();
  const grace = cfgRow?.value?.overdue_after_days ?? 0;
  // include calls due up to `grace` days in the future (0 = due today or earlier)
  const cutoff = new Date(Date.now() + grace * 864e5).toISOString().slice(0, 10);

  const { data: calls, error } = await sb
    .from("calls")
    .select("id, call_no, due_date, journeys!inner(type, assigned_to, status, people(full_name, phone))")
    .is("completed_at", null)
    .lte("due_date", cutoff)
    .eq("journeys.status", "active");
  if (error) return new Response(error.message, { status: 500 });

  // group by assigned volunteer
  const byVol: Record<string, any[]> = {};
  for (const c of calls ?? []) {
    const uid = (c as any).journeys.assigned_to;
    if (!uid) continue;
    (byVol[uid] ??= []).push(c);
  }
  const uids = Object.keys(byVol);
  if (!uids.length) return Response.json({ sent: 0, note: "no due calls assigned" });

  const { data: vols } = await sb.from("profiles")
    .select("id, full_name, email").in("id", uids);

  const RESEND = Deno.env.get("RESEND_API_KEY");
  const FROM = Deno.env.get("FROM_EMAIL") ?? "E-City Nurturing <onboarding@resend.dev>";
  let sent = 0;

  for (const v of vols ?? []) {
    if (!v.email) continue;
    const list = byVol[v.id];
    const overdue = list.filter((c: any) => c.due_date < today).length;
    const rows = list.map((c: any) =>
      `<li><b>${c.journeys.people.full_name}</b> — call ${c.call_no}, due ${c.due_date}${c.due_date < today ? " <span style='color:#c92f2f'>(overdue)</span>" : ""}</li>`
    ).join("");
    const html = `
      <div style="font-family:sans-serif;max-width:520px">
        <h2 style="color:#c4622d">🪷 Namaskaram ${v.full_name || ""}</h2>
        <p>You have <b>${list.length}</b> nurturing call${list.length > 1 ? "s" : ""} waiting${overdue ? ` (${overdue} overdue)` : ""}:</p>
        <ul>${rows}</ul>
        <p>Open the dashboard to call and log in two taps. 🙏</p>
      </div>`;
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${RESEND}` },
      body: JSON.stringify({ from: FROM, to: v.email, subject: `🪷 ${list.length} nurturing call${list.length > 1 ? "s" : ""} due${overdue ? ` — ${overdue} overdue` : ""}`, html }),
    });
    if (r.ok) sent++;
  }
  return Response.json({ sent, volunteers: uids.length, calls: (calls ?? []).length });
});
