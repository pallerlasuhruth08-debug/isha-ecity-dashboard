/* ============================================================
   Isha E-City Nurturing Dashboard — app logic (vanilla JS)
   ============================================================ */
const sb = supabase.createClient(APP_CONFIG.SUPABASE_URL, APP_CONFIG.SUPABASE_ANON_KEY);
let ME = null;            // my profile row
let SETTINGS = {};        // settings table cache
let CENTERS = [];
const $ = id => document.getElementById(id);
const view = () => $('view');
const esc = s => (s ?? '').toString().replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmtD = d => d ? new Date(d).toLocaleDateString('en-IN', {day:'numeric',month:'short'}) : '—';
const today = () => new Date().toISOString().slice(0,10);

function toast(m){ const t=$('toast'); t.textContent=m; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2600); }

/* ---------------- AUTH ---------------- */
async function doLogin(){
  const {error} = await sb.auth.signInWithPassword({email:$('login-email').value.trim(), password:$('login-pass').value});
  if(error) return toast(error.message);
  boot();
}
async function doSignup(){
  const email=$('login-email').value.trim(), password=$('login-pass').value;
  if(!email||password.length<6) return toast('Enter email + password (6+ chars)');
  const {error} = await sb.auth.signUp({email,password});
  if(error) return toast(error.message);
  toast('Account created — signing in…'); doLogin();
}
async function doLogout(){ await sb.auth.signOut(); location.reload(); }

async function boot(){
  const {data:{session}} = await sb.auth.getSession();
  if(!session){ $('login-view').classList.remove('hidden'); return; }
  const {data:prof} = await sb.from('profiles').select('*').eq('id', session.user.id).single();
  ME = prof;
  const [{data:set},{data:cen}] = await Promise.all([
    sb.from('settings').select('*'), sb.from('centers').select('*')]);
  (set||[]).forEach(r=>SETTINGS[r.key]=r.value);
  CENTERS = (cen||[]).filter(c=>c.id!=='unassigned');
  $('login-view').classList.add('hidden');
  $('app').classList.remove('hidden'); $('nav').classList.remove('hidden');
  $('who-name').textContent = ME.full_name || ME.email;
  $('who-role').textContent = roleLabel(ME.role) + (ME.role!=='rco' ? ' · '+centerName(ME.center_id) : ' · Sector');
  // volunteers see a simpler nav
  if(ME.role==='volunteer'){
    document.querySelectorAll('#nav [data-v="vols"],#nav [data-v="admin"]').forEach(b=>b.style.display='none');
  }
  go('today');
}
const roleLabel = r => ({volunteer:'Volunteer', coordinator:'Coordinator', rco:'RCO'}[r]||r);
const centerName = id => (CENTERS.find(c=>c.id===id)||{}).name || 'Unassigned';
const isCoord = () => ME.role==='coordinator' || ME.role==='rco';

/* ---------------- NAV ---------------- */
function go(v){
  document.querySelectorAll('#nav button').forEach(b=>b.classList.toggle('active', b.dataset.v===v));
  ({today:renderToday, people:renderPeople, vols:renderVols,
    insights:renderInsights, admin:renderAdmin}[v])();
}

/* ---------------- MODAL ---------------- */
function modal(html){
  $('modal-root').innerHTML =
    `<div class="modal-bg" onclick="if(event.target===this)closeModal()"><div class="modal">
       <button class="x" onclick="closeModal()">✕</button>${html}</div></div>`;
}
function closeModal(){ $('modal-root').innerHTML=''; }

/* ============================================================
   TODAY — calls due / overdue (the heart of the app)
   ============================================================ */
const JT = {new_meditator:'New Meditator', meditator:'Meditator', advanced:'Advanced Program', volunteer_nurture:'Volunteer'};
const WA_MSG = {
  new_meditator: n => `Namaskaram ${n} 🙏 This is from Isha Electronic City center. Hope your Shambhavi sadhana is going well! I wanted to check in and support you in any way. When is a good time to talk?`,
  meditator:     n => `Namaskaram ${n} 🙏 This is from Isha Electronic City center. We'd love to hear how your sadhana is going and share what's happening at the center. When is a good time to talk?`,
  advanced:      n => `Namaskaram ${n} 🙏 Congratulations on completing your program! We'd love to hear about your experience and share volunteering possibilities at your local center. When can we talk?`,
  volunteer_nurture: n => `Namaskaram ${n} 🙏 We heard you volunteered recently — wonderful! We'd love to hear how it was and tell you about possibilities at our center. When is a good time?`
};

async function fetchDueCalls(){
  let q = sb.from('calls')
    .select('id, call_no, due_date, journey_id, journeys!inner(id, type, program_name, program_date, center_id, assigned_to, status, people(id, full_name, phone, center_id))')
    .is('completed_at', null)
    .lte('due_date', today())
    .eq('journeys.status','active')
    .order('due_date');
  if(ME.role==='volunteer') q = q.eq('journeys.assigned_to', ME.id);
  const {data, error} = await q;
  if(error){ toast(error.message); return []; }
  return data||[];
}

async function renderToday(){
  view().innerHTML = '<div class="empty">Loading…</div>';
  const calls = await fetchDueCalls();
  const overdue = calls.filter(c=>c.due_date < today());
  let upQ = sb.from('calls')
    .select('id, call_no, due_date, journeys!inner(type, assigned_to, status, people(full_name))')
    .is('completed_at', null).gt('due_date', today()).eq('journeys.status','active')
    .order('due_date').limit(8);
  if(ME.role==='volunteer') upQ = upQ.eq('journeys.assigned_to', ME.id);
  const {data:upcoming} = await upQ;

  let h = '';
  if(overdue.length) h += `<div class="alert">🔴 ${overdue.length} overdue call${overdue.length>1?'s':''} — please catch up today</div>`;
  h += `<div class="card"><h2>Calls due today ${calls.length?`<span class="badge">${calls.length}</span>`:''}</h2>`;
  h += calls.length ? calls.map(callRow).join('') : '<div class="empty">🎉 All caught up — no calls due.</div>';
  h += '</div>';
  if(upcoming?.length){
    h += `<div class="card"><h2>Coming up</h2>` + upcoming.map(c=>
      `<div class="row"><div class="grow"><div class="name">${esc(c.journeys.people.full_name)}</div>
       <div class="sub">${JT[c.journeys.type]} · Call ${c.call_no} · due ${fmtD(c.due_date)}</div></div></div>`).join('') + '</div>';
  }
  view().innerHTML = h;
}

function dayInJourney(j){
  if(!j.program_date) return null;
  return Math.max(1, Math.round((Date.now() - new Date(j.program_date)) / 864e5));
}
function callRow(c){
  const j = c.journeys, p = j.people;
  const day = dayInJourney(j);
  const od = c.due_date < today();
  const wa = p.phone ? `https://wa.me/91${p.phone}?text=${encodeURIComponent((WA_MSG[j.type]||WA_MSG.meditator)(p.full_name.split(' ')[0]))}` : null;
  return `<div class="row">
    <div class="grow">
      <div class="name">${esc(p.full_name)} ${od?'<span class="badge red">overdue</span>':''}</div>
      <div class="sub">${JT[j.type]}${j.program_name?' · '+esc(j.program_name):''}
        · Call ${c.call_no}${j.type==='new_meditator'?'/3':''}${day?` · Day ${day} of journey`:''} · due ${fmtD(c.due_date)}</div>
    </div>
    ${p.phone?`<a class="iconbtn call" href="tel:+91${p.phone}">📞</a>`:''}
    ${wa?`<a class="iconbtn wa" href="${wa}" target="_blank">💬</a>`:''}
    <button class="btn small ghost" onclick='openLog(${JSON.stringify({id:c.id,call_no:c.call_no,jtype:j.type,name:p.full_name}).replace(/'/g,"&#39;")})'>Log</button>
  </div>`;
}

/* ---- call logging (two-layer status) ---- */
const SADHANA_OPTS = {
  new_meditator: ['Doing Well','Doing Regularly','Needs Support','Needs Support on Ishangam','Wants to Connect with Ishangam','Does Not Need Support','Stopped Sadhana','Not Sure'],
  meditator: ['Doing sadhana regularly','Irregular','Stopped','Wants to go to Ashram','Wants Sannidhi at home','Wants an advanced program','Needs practice correction','Other'],
  advanced: ['Great experience','Good, needs support','Wants to volunteer','Wants another program','Needs practice correction','Other'],
  volunteer_nurture: ['Great experience','Interested in local volunteering','Not interested now','Needs follow-up','Other']
};
let LOG = null;
function openLog(c){
  LOG = {...c, reach:null, status:null};
  modal(`<h3>Log call — ${esc(c.name)}</h3><p class="muted">Call ${c.call_no}</p>
    <label>Reachability</label>
    <div class="choices" id="lg-reach">
      ${[['answered','✅ Answered'],['not_reachable','📵 Not Reachable'],['will_call_back','🕐 Will Call Back']]
        .map(([v,l])=>`<button onclick="pickReach('${v}',this)">${l}</button>`).join('')}
    </div>
    <div id="lg-status-wrap" class="hidden">
      <label>Sadhana / status</label>
      <div class="choices" id="lg-status">
        ${(SADHANA_OPTS[c.jtype]||SADHANA_OPTS.meditator).map(s=>`<button onclick="pickStatus('${esc(s)}',this)">${esc(s)}</button>`).join('')}
      </div>
      <div id="lg-suggest" class="muted" style="margin-top:8px"></div>
    </div>
    <label>Remarks</label><textarea id="lg-remarks" placeholder="How did it go? Anything to remember…"></textarea>
    <button class="btn block" onclick="saveLog()">Save log</button>`);
}
function pickReach(v, btn){
  LOG.reach=v;
  document.querySelectorAll('#lg-reach button').forEach(b=>b.classList.remove('sel')); btn.classList.add('sel');
  $('lg-status-wrap').classList.toggle('hidden', v!=='answered');
}
function pickStatus(s, btn){
  LOG.status=s;
  document.querySelectorAll('#lg-status button').forEach(b=>b.classList.remove('sel')); btn.classList.add('sel');
  // suggested next actions (Module 4 config)
  const key = s.toLowerCase().includes('stopped')?'stopped'
    : s.toLowerCase().includes('irregular')?'irregular'
    : s.toLowerCase().includes('regular')?'regular'
    : s.toLowerCase().includes('ashram')?'wants_ashram'
    : s.toLowerCase().includes('sannidhi')?'wants_sannidhi'
    : s.toLowerCase().includes('advanced')||s.toLowerCase().includes('another program')?'wants_advanced'
    : s.toLowerCase().includes('correction')?'needs_correction':null;
  const acts = key && SETTINGS.next_action_map?.[key];
  $('lg-suggest').innerHTML = acts ? '💡 Suggested next: ' + acts.join(' · ') : '';
}
async function saveLog(){
  if(!LOG.reach) return toast('Select reachability');
  const {error} = await sb.from('calls').update({
    completed_at: new Date().toISOString(),
    reachability: LOG.reach,
    sadhana_status: LOG.reach==='answered' ? LOG.status : null,
    remarks: $('lg-remarks').value || null,
    logged_by: ME.id
  }).eq('id', LOG.id);
  if(error) return toast(error.message);
  closeModal(); toast('Saved 🙏'); renderToday();
}

/* ============================================================
   PEOPLE — journeys by module (Mod 1, 4, 5 + volunteer nurture)
   ============================================================ */
let PEOPLE_TAB = 'new_meditator';
async function renderPeople(tab){
  if(tab) PEOPLE_TAB = tab;
  view().innerHTML = '<div class="empty">Loading…</div>';
  let q = sb.from('journeys')
    .select('id, type, program_name, program_date, status, sadhana_status, assigned_to, center_id, people(id, full_name, phone, pincode, center_id), calls(id, call_no, due_date, completed_at)')
    .eq('type', PEOPLE_TAB).order('created_at', {ascending:false}).limit(400);
  if(ME.role==='volunteer') q = q.eq('assigned_to', ME.id);
  const {data:js, error} = await q;
  if(error){ view().innerHTML = `<div class="empty">${esc(error.message)}</div>`; return; }
  let vols = [];
  if(isCoord()){
    const {data:v} = await sb.from('profiles').select('id, full_name, email, role, center_id').eq('active', true);
    vols = v||[];
  }
  const tabs = [['new_meditator','New Meditators'],['meditator','Meditator Nurturing'],['advanced','Advanced Programs'],['volunteer_nurture','Ashram/SSB Volunteers']];
  let h = `<div class="tabs">${tabs.map(([v,l])=>`<button class="${PEOPLE_TAB===v?'active':''}" onclick="renderPeople('${v}')">${l}</button>`).join('')}</div>`;
  if(isCoord()) h += `<div style="display:flex;gap:8px;margin:6px 0">
    <button class="btn small ghost" onclick="openImport()">⬆️ Import CSV/Excel</button>
    <button class="btn small ghost" onclick="openAddPerson()">＋ Add person</button></div>`;
  h += `<div class="card">`;
  h += (js||[]).length ? js.map(j=>journeyRow(j, vols)).join('') : '<div class="empty">No one here yet.</div>';
  h += '</div>';
  view().innerHTML = h;
}
function journeyRow(j, vols){
  const p = j.people;
  const done = (j.calls||[]).filter(c=>c.completed_at).length, total=(j.calls||[]).length;
  const assignee = vols.find(v=>v.id===j.assigned_to);
  const assignSel = isCoord() ? `<select style="width:auto;font-size:.78rem;padding:6px" onchange="assignJourney('${j.id}', this.value)">
      <option value="">— assign —</option>
      ${vols.map(v=>`<option value="${v.id}" ${v.id===j.assigned_to?'selected':''}>${esc(v.full_name||v.email)}</option>`).join('')}
    </select>` : '';
  return `<div class="row">
    <div class="grow">
      <div class="name">${esc(p.full_name)}
        ${j.status==='completed'?'<span class="badge green">done</span>':''}
        ${p.center_id==='unassigned'?'<span class="badge gray">unassigned center</span>':''}</div>
      <div class="sub">${esc(j.program_name||'')} ${j.program_date?'· '+fmtD(j.program_date):''}
        · ${centerName(p.center_id)} · calls ${done}/${total}
        ${j.sadhana_status?` · <b>${esc(j.sadhana_status)}</b>`:''}
        ${assignee?` · 👤 ${esc(assignee.full_name||assignee.email)}`:''}</div>
    </div>
    ${p.phone?`<a class="iconbtn call" href="tel:+91${p.phone}">📞</a>`:''}
    ${assignSel}
  </div>`;
}
async function assignJourney(jid, uid){
  const {error} = await sb.from('journeys').update({assigned_to: uid||null}).eq('id', jid);
  toast(error ? error.message : 'Assigned ✔');
}

/* ---- manual add ---- */
function openAddPerson(){
  modal(`<h3>Add person</h3>
    <label>Full name</label><input id="ap-name">
    <label>Phone (10-digit)</label><input id="ap-phone" inputmode="numeric">
    <label>Pincode</label><input id="ap-pin" inputmode="numeric" placeholder="auto-routes to center">
    <label>Type</label>
    <select id="ap-kind">
      <option value="new_meditator">New meditator (3-call journey)</option>
      <option value="meditator">Older meditator (nurturing)</option>
      <option value="advanced">Advanced program completer</option>
      <option value="volunteer">Volunteer (interest)</option>
      <option value="ashram_ssb">Ashram/SSB volunteering record</option>
    </select>
    <label>Program / activity name</label><input id="ap-prog" placeholder="e.g. IE Online, BSP, Sannidhi seva">
    <label>Program / activity date</label><input id="ap-date" type="date" value="${today()}">
    <button class="btn block" onclick="saveAddPerson()">Save</button>`);
}
async function saveAddPerson(){
  const kind = $('ap-kind').value;
  if(kind==='ashram_ssb'){
    // plugin 1: record + auto volunteer_nurture journey via trigger
    const row = {full_name:$('ap-name').value, phone:$('ap-phone').value, pincode:$('ap-pin').value, kind:'volunteer', source:'manual'};
    const {data, error} = await sb.rpc('import_people', {rows:[row]});
    if(error) return toast(error.message);
    const {data:p} = await sb.from('people').select('id, center_id').eq('phone', $('ap-phone').value.replace(/\D/g,'').slice(-10)).single();
    if(p){
      const {error:e2} = await sb.from('volunteer_history').insert({person_id:p.id, activity:$('ap-prog').value||'Ashram/SSB volunteering', center_id:p.center_id, happened_on:$('ap-date').value, source:'ashram_ssb'});
      if(e2) return toast(e2.message);
    }
  } else {
    const row = {full_name:$('ap-name').value, phone:$('ap-phone').value, pincode:$('ap-pin').value,
      kind, program_name:$('ap-prog').value, program_date:$('ap-date').value, source:'manual'};
    const {error} = await sb.rpc('import_people', {rows:[row]});
    if(error) return toast(error.message);
  }
  closeModal(); toast('Added ✔'); renderPeople();
}

/* ---- CSV / Excel import (manual fallback for the extension) ---- */
function openImport(){
  modal(`<h3>Import CSV / Excel</h3>
    <p class="muted">Columns recognized (any order, header names flexible): <b>name, phone, email, pincode, area, program, date</b>.
    Duplicates are merged by phone; centers auto-route by pincode; call journeys auto-created.</p>
    <label>Import as</label>
    <select id="im-kind">
      <option value="new_meditator">New meditators (Module 1)</option>
      <option value="meditator">Older meditators (Module 4)</option>
      <option value="advanced">Advanced program completers (Module 5)</option>
      <option value="volunteer">Volunteers / interest list (Module 2)</option>
    </select>
    <label>File (.csv / .xlsx)</label><input id="im-file" type="file" accept=".csv,.xlsx,.xls">
    <button class="btn block" onclick="runImport()">Import</button>
    <div id="im-result" class="muted" style="margin-top:8px"></div>`);
}
const COLMAP = {full_name:['name','full name','full_name','participant','participant name'],
  phone:['phone','mobile','number','contact','phone number','mobile number','whatsapp'],
  email:['email','e-mail','mail'], pincode:['pincode','pin','pin code','postal','zip'],
  area:['area','locality','address','city'],
  program_name:['program','program name','course','activity','program_name'],
  program_date:['date','program date','completion date','initiation date','program_date','completed on']};
function mapRow(raw){
  const out = {};
  const keys = Object.keys(raw);
  for(const [field, aliases] of Object.entries(COLMAP)){
    const k = keys.find(k => aliases.includes(k.toLowerCase().trim()));
    if(k && raw[k]!=null && raw[k]!=='') out[field] = String(raw[k]).trim();
  }
  if(out.program_date){
    const d = new Date(out.program_date);
    out.program_date = isNaN(d) ? null : d.toISOString().slice(0,10);
  }
  return out;
}
async function runImport(){
  const f = $('im-file').files[0]; if(!f) return toast('Choose a file');
  const kind = $('im-kind').value;
  let rows = [];
  if(/\.csv$/i.test(f.name)){
    rows = await new Promise(res => Papa.parse(f, {header:true, skipEmptyLines:true, complete:r=>res(r.data)}));
  } else {
    const buf = await f.arrayBuffer();
    const wb = XLSX.read(buf); const ws = wb.Sheets[wb.SheetNames[0]];
    rows = XLSX.utils.sheet_to_json(ws, {defval:''});
  }
  const payload = rows.map(mapRow).filter(r=>r.full_name||r.phone).map(r=>({...r, kind, source:'csv'}));
  if(!payload.length) return toast('No usable rows found');
  $('im-result').textContent = `Importing ${payload.length} rows…`;
  // chunk to stay under payload limits
  let tot = {inserted:0, merged:0, journeys:0};
  for(let i=0;i<payload.length;i+=200){
    const {data, error} = await sb.rpc('import_people', {rows:payload.slice(i,i+200)});
    if(error){ $('im-result').textContent = 'Error: '+error.message; return; }
    tot.inserted+=data.inserted; tot.merged+=data.merged; tot.journeys+=data.journeys;
  }
  $('im-result').textContent = `✔ ${tot.inserted} new, ${tot.merged} merged with existing, ${tot.journeys} journeys created.`;
  toast('Import complete');
}

/* ============================================================
   VOLUNTEERS — Module 2 (intake, matching & dispatch)
   ============================================================ */
const INTERESTS = ['Online Calling','Online Operations','Offline Programs','Sadhguru Sannidhi','E-Media','Promotions','Devi Seva','Event Setup','Cooking/Annadanam','Transport'];
let VFILTER = {center:'', interest:'', mode:'', timing:'', space:false};
let SHORTLIST = [];

async function renderVols(){
  view().innerHTML = '<div class="empty">Loading…</div>';
  let q = sb.from('volunteer_profiles')
    .select('*, people!inner(id, full_name, phone, pincode, center_id)')
    .order('updated_at', {ascending:false}).limit(500);
  const {data:vps, error} = await q;
  if(error){ view().innerHTML=`<div class="empty">${esc(error.message)}</div>`; return; }
  const {data:hist} = await sb.from('volunteer_history').select('person_id, activity, happened_on').order('happened_on',{ascending:false}).limit(2000);
  const histBy = {};
  (hist||[]).forEach(r=>{ (histBy[r.person_id] ||= []).push(r); });

  const list = (vps||[]).filter(v=>{
    if(VFILTER.center && v.people.center_id!==VFILTER.center) return false;
    if(VFILTER.interest && !(v.interests||[]).includes(VFILTER.interest)) return false;
    if(VFILTER.mode && v.mode!==VFILTER.mode && v.mode!=='both') return false;
    if(VFILTER.timing && v.preferred_timing!==VFILTER.timing && v.preferred_timing!=='flexible') return false;
    if(VFILTER.space && !v.can_offer_space) return false;
    return true;
  });

  let h = `<div style="display:flex;gap:8px;margin:6px 0;flex-wrap:wrap">
    <button class="btn small ghost" onclick="openPaperOCR()">📷 Paper form (OCR)</button>
    <button class="btn small ghost" onclick="openVolForm()">＋ Add interest</button>
    <button class="btn small ghost" onclick="openGFormHelp()">🔗 Google Form</button>
    ${SHORTLIST.length?`<button class="btn small green" onclick="shareShortlist()">📤 Share shortlist (${SHORTLIST.length})</button>`:''}
  </div>
  <div class="card"><h2>Filter & match</h2>
    <div class="choices">
      <select style="width:auto" onchange="VFILTER.center=this.value;renderVols()">
        <option value="">All centers</option>${CENTERS.map(c=>`<option value="${c.id}" ${VFILTER.center===c.id?'selected':''}>${c.name}</option>`).join('')}</select>
      <select style="width:auto" onchange="VFILTER.interest=this.value;renderVols()">
        <option value="">Any activity</option>${INTERESTS.map(i=>`<option ${VFILTER.interest===i?'selected':''}>${i}</option>`).join('')}</select>
      <select style="width:auto" onchange="VFILTER.mode=this.value;renderVols()">
        <option value="">Online/Offline</option><option value="online" ${VFILTER.mode==='online'?'selected':''}>Online</option><option value="offline" ${VFILTER.mode==='offline'?'selected':''}>Offline</option></select>
      <select style="width:auto" onchange="VFILTER.timing=this.value;renderVols()">
        <option value="">Any timing</option><option value="weekday_morning" ${VFILTER.timing==='weekday_morning'?'selected':''}>Weekday AM</option>
        <option value="weekday_evening" ${VFILTER.timing==='weekday_evening'?'selected':''}>Weekday PM</option>
        <option value="weekend" ${VFILTER.timing==='weekend'?'selected':''}>Weekends</option></select>
      <button class="${VFILTER.space?'sel':''}" onclick="VFILTER.space=!VFILTER.space;renderVols()">🏠 Can offer space</button>
    </div></div>
  <div class="card"><h2>Volunteers <span class="badge">${list.length}</span></h2>`;
  h += list.length ? list.map(v=>volRow(v, histBy[v.person_id]||[])).join('') : '<div class="empty">No matches — adjust filters or add interest entries.</div>';
  h += '</div>';
  view().innerHTML = h;
}
function volRow(v, hist){
  const p = v.people;
  const wa = p.phone ? `https://wa.me/91${p.phone}?text=${encodeURIComponent(`Namaskaram ${p.full_name.split(' ')[0]} 🙏 There's a volunteering opportunity at Isha ${centerName(p.center_id)} that matches your interest${v.interests?.length?' in '+v.interests[0]:''}. Would you like to join? Reply and I'll share details!`)}` : null;
  const inSL = SHORTLIST.some(s=>s.id===p.id);
  return `<div class="row">
    <div class="grow" onclick='showVolHistory(${JSON.stringify({n:p.full_name,h:hist.slice(0,15)}).replace(/'/g,"&#39;")})'>
      <div class="name">${esc(p.full_name)} ${v.screened?'<span class="badge green">screened</span>':'<span class="badge gray">new</span>'}</div>
      <div class="sub">${centerName(p.center_id)} · ${(v.interests||[]).join(', ')||'no interests yet'}
        ${v.mode?' · '+v.mode:''}${v.can_offer_space?' · 🏠 space':''} · ${hist.length} past activit${hist.length===1?'y':'ies'}</div>
    </div>
    ${p.phone?`<a class="iconbtn call" href="tel:+91${p.phone}">📞</a>`:''}
    ${wa?`<a class="iconbtn wa" href="${wa}" target="_blank">💬</a>`:''}
    <button class="btn small ${inSL?'green':'gray'}" onclick='toggleShortlist(${JSON.stringify({id:p.id,name:p.full_name,phone:p.phone}).replace(/'/g,"&#39;")})'>${inSL?'✓':'＋'}</button>
  </div>`;
}
function showVolHistory(d){
  modal(`<h3>${esc(d.n)} — history</h3>` + (d.h.length
    ? `<table class="mini"><tr><th>Activity</th><th>Date</th></tr>${d.h.map(r=>`<tr><td>${esc(r.activity)}</td><td>${fmtD(r.happened_on)}</td></tr>`).join('')}</table>`
    : '<p class="muted">No volunteering history yet.</p>'));
}
function toggleShortlist(p){
  const i = SHORTLIST.findIndex(s=>s.id===p.id);
  i>=0 ? SHORTLIST.splice(i,1) : SHORTLIST.push(p);
  renderVols();
}
function shareShortlist(){
  const txt = `Volunteer shortlist (${SHORTLIST.length}):\n` + SHORTLIST.map(s=>`• ${s.name} — ${s.phone||'no phone'}`).join('\n');
  modal(`<h3>Share with program team</h3><textarea style="min-height:140px">${esc(txt)}</textarea>
    <a class="btn block" style="text-align:center;text-decoration:none;display:block" href="https://wa.me/?text=${encodeURIComponent(txt)}" target="_blank">📤 Share via WhatsApp</a>
    <button class="btn ghost block" onclick="navigator.clipboard.writeText(${JSON.stringify(txt)});toast('Copied')">Copy</button>
    <button class="btn gray block" onclick="exportShortlistCSV()">Download CSV</button>`);
}
function exportShortlistCSV(){
  const csv = 'Name,Phone\n' + SHORTLIST.map(s=>`"${s.name}","${s.phone||''}"`).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv],{type:'text/csv'})); a.download='shortlist.csv'; a.click();
}

/* ---- volunteer interest form (shared by manual + OCR) ---- */
function volFormHTML(pre={}){
  return `<label>Name</label><input id="vf-name" value="${esc(pre.name||'')}">
    <label>Phone</label><input id="vf-phone" inputmode="numeric" value="${esc(pre.phone||'')}">
    <label>Pincode</label><input id="vf-pin" inputmode="numeric">
    <label>Activities interested in</label>
    <div class="choices" id="vf-int">${INTERESTS.map(i=>`<button onclick="this.classList.toggle('sel')">${i}</button>`).join('')}</div>
    <label>Preferred timing</label>
    <select id="vf-timing"><option value="flexible">Flexible</option><option value="weekday_morning">Weekday mornings</option>
      <option value="weekday_evening">Weekday evenings</option><option value="weekend">Weekends</option></select>
    <label>Mode</label>
    <select id="vf-mode"><option value="both">Online + Offline</option><option value="online">Online only</option><option value="offline">Offline only</option></select>
    <label>Programs done (IE / advanced…)</label><input id="vf-progs" placeholder="e.g. IE Online 2025, BSP">
    <label>Languages</label><input id="vf-lang" placeholder="e.g. Kannada, Tamil, English">
    <div class="choices" style="margin-top:10px"><button id="vf-space" onclick="this.classList.toggle('sel')">🏠 Can offer space for sessions</button></div>
    <label>Notes</label><textarea id="vf-notes"></textarea>
    <button class="btn block" onclick="saveVolForm()">Save volunteer interest</button>`;
}
function openVolForm(pre){ modal(`<h3>Volunteer interest</h3>` + volFormHTML(pre||{})); }
async function saveVolForm(){
  const interests = [...document.querySelectorAll('#vf-int button.sel')].map(b=>b.textContent);
  const row = {full_name:$('vf-name').value, phone:$('vf-phone').value, pincode:$('vf-pin').value,
    kind:'volunteer', interests, preferred_timing:$('vf-timing').value, mode:$('vf-mode').value,
    can_offer_space:$('vf-space').classList.contains('sel'), source:'paper'};
  if(!row.full_name && !row.phone) return toast('Name or phone required');
  const {error} = await sb.rpc('import_people', {rows:[row]});
  if(error) return toast(error.message);
  // enrich profile with extra fields
  const ph = row.phone.replace(/\D/g,'').slice(-10);
  const {data:p} = await sb.from('people').select('id').eq('phone', ph).single();
  if(p) await sb.from('volunteer_profiles').update({
    programs_done:$('vf-progs').value||null, languages:$('vf-lang').value||null,
    screening_notes:$('vf-notes').value||null}).eq('person_id', p.id);
  closeModal(); toast('Saved 🙏'); renderVols();
}

/* ---- paper form OCR (Tesseract.js, lazy-loaded) ---- */
async function openPaperOCR(){
  modal(`<h3>📷 Paper form → OCR</h3>
    <p class="muted">Take a photo of the filled form. Name & phone are auto-extracted — check and correct, then save.</p>
    <input id="ocr-file" type="file" accept="image/*" capture="environment">
    <div id="ocr-status" class="muted" style="margin:8px 0"></div>
    <div id="ocr-form"></div>`);
  $('ocr-file').onchange = runOCR;
}
async function runOCR(){
  const f = $('ocr-file').files[0]; if(!f) return;
  $('ocr-status').textContent = 'Loading OCR engine…';
  if(!window.Tesseract){
    await new Promise((res,rej)=>{ const s=document.createElement('script');
      s.src='https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'; s.onload=res; s.onerror=rej;
      document.head.appendChild(s); });
  }
  $('ocr-status').textContent = 'Reading the photo… (10–20s)';
  try{
    const {data:{text}} = await Tesseract.recognize(f, 'eng');
    const phone = (text.match(/(?:\+?91[\s-]?)?([6-9]\d{4}[\s-]?\d{5})/)||[])[1]?.replace(/\D/g,'') || '';
    let name = '';
    const nm = text.match(/name\s*[:\-]?\s*([A-Za-z .]{3,40})/i);
    if(nm) name = nm[1].trim();
    else { const line = text.split('\n').map(l=>l.trim()).find(l=>/^[A-Za-z .]{3,40}$/.test(l)); if(line) name=line; }
    $('ocr-status').textContent = '✔ Extracted — please verify below';
    $('ocr-form').innerHTML = volFormHTML({name, phone});
  }catch(e){ $('ocr-status').textContent = 'OCR failed ('+e.message+') — fill manually:'; $('ocr-form').innerHTML = volFormHTML({}); }
}

function openGFormHelp(){
  modal(`<h3>Google Form intake</h3>
    <p class="muted">Two free ways to pull Google Form responses in:</p>
    <p style="margin:8px 0"><b>1. Quick (manual, 30s):</b> Open the form's response Sheet → File → Download → CSV → use <b>Import CSV</b> on the Meditators tab with type "Volunteers".</p>
    <p style="margin:8px 0"><b>2. Automatic:</b> Add the Apps Script in <code>/scripts/gform-sync.gs</code> to your response Sheet (Extensions → Apps Script), paste your Supabase URL+key, set a trigger on form submit. Every new response then lands here instantly.</p>`);
}

/* ============================================================
   INSIGHTS — Module 10
   ============================================================ */
async function renderInsights(){
  view().innerHTML = '<div class="empty">Loading…</div>';
  // scope enforced by RLS automatically
  const [{data:js},{data:calls},{data:vh}] = await Promise.all([
    sb.from('journeys').select('id, type, status, sadhana_status, center_id, assigned_to'),
    sb.from('calls').select('id, due_date, completed_at, reachability, journey_id'),
    sb.from('volunteer_history').select('id, person_id, activity, center_id, happened_on')
  ]);
  const J = js||[], C = calls||[], V = vh||[];
  const open = C.filter(c=>!c.completed_at), done = C.filter(c=>c.completed_at);
  const overdue = open.filter(c=>c.due_date < today());
  const answered = done.filter(c=>c.reachability==='answered');

  // sadhana status distribution
  const dist = {};
  J.filter(j=>j.sadhana_status).forEach(j=>dist[j.sadhana_status]=(dist[j.sadhana_status]||0)+1);

  // per-center status clusters → suggestions
  const rules = SETTINGS.suggestion_rules||[];
  const statusKey = s => { s=(s||'').toLowerCase();
    return s.includes('stopped')?'stopped' : s.includes('irregular')?'irregular'
      : s.includes('needs support')?'needs_support' : s.includes('correction')?'needs_correction'
      : s.includes('ashram')?'wants_ashram' : s.includes('sannidhi')?'wants_sannidhi'
      : s.includes('advanced')||s.includes('another program')?'wants_advanced' : null; };
  const clusters = {}; // center -> key -> n
  J.forEach(j=>{ const k=statusKey(j.sadhana_status); if(k) ((clusters[j.center_id] ||= {})[k] = (clusters[j.center_id][k]||0)+1); });
  const suggestions = [];
  for(const [cid, ks] of Object.entries(clusters))
    for(const r of rules)
      if((ks[r.when_status]||0) >= r.min_count)
        suggestions.push(`<b>${centerName(cid)}</b>: ${ks[r.when_status]} people "${r.when_status.replace(/_/g,' ')}" → ${esc(r.suggest)}`);

  // mandala completion (module 1)
  const m1 = J.filter(j=>j.type==='new_meditator');
  const m1done = m1.filter(j=>j.status==='completed').length;

  let h = `<div class="stats">
    <div class="stat"><div class="n">${m1.length}</div><div class="l">New meditators</div></div>
    <div class="stat"><div class="n">${m1done}</div><div class="l">Mandala journeys done</div></div>
    <div class="stat"><div class="n">${overdue.length}</div><div class="l">Overdue calls</div></div>
    <div class="stat"><div class="n">${done.length?Math.round(answered.length/done.length*100):0}%</div><div class="l">Answer rate</div></div>
    <div class="stat"><div class="n">${J.filter(j=>j.type==='advanced').length}</div><div class="l">Advanced completers</div></div>
    <div class="stat"><div class="n">${V.length}</div><div class="l">Volunteering records</div></div>
  </div>`;
  if(suggestions.length)
    h += `<div class="card"><h2>💡 Planning suggestions</h2>${suggestions.map(s=>`<div class="row"><div class="grow">${s}</div></div>`).join('')}</div>`;
  h += `<div class="card"><h2>Sadhana status distribution</h2><canvas id="ch-dist" height="220"></canvas></div>`;
  if(isCoord()) h += `<div class="card"><h2>Call completion by center</h2><canvas id="ch-center" height="200"></canvas></div>`;
  h += `<div class="card"><h2>Per-status counts</h2><table class="mini"><tr><th>Status</th><th>People</th></tr>
    ${Object.entries(dist).sort((a,b)=>b[1]-a[1]).map(([s,n])=>`<tr><td>${esc(s)}</td><td>${n}</td></tr>`).join('')||'<tr><td colspan=2 class="muted">No logged statuses yet</td></tr>'}</table></div>`;
  view().innerHTML = h;

  if(Object.keys(dist).length){
    new Chart($('ch-dist'), {type:'doughnut',
      data:{labels:Object.keys(dist), datasets:[{data:Object.values(dist),
        backgroundColor:['#c4622d','#3d8a5f','#d8a13a','#7a6bb5','#c92f2f','#4f8fc4','#8a8378','#5fae9c']}]},
      options:{plugins:{legend:{position:'bottom',labels:{boxWidth:12,font:{size:11}}}}}});
  }
  if(isCoord()){
    const byC = {};
    const jById = Object.fromEntries(J.map(j=>[j.id,j]));
    C.forEach(c=>{ const j=jById[c.journey_id]; if(!j) return;
      const b = (byC[j.center_id] ||= {done:0,open:0}); c.completed_at?b.done++:b.open++; });
    const labels = Object.keys(byC).map(centerName);
    new Chart($('ch-center'), {type:'bar',
      data:{labels, datasets:[
        {label:'Completed', data:Object.values(byC).map(b=>b.done), backgroundColor:'#3d8a5f'},
        {label:'Open', data:Object.values(byC).map(b=>b.open), backgroundColor:'#e0d6c8'}]},
      options:{scales:{x:{stacked:true},y:{stacked:true}},plugins:{legend:{position:'bottom'}}}});
  }
}

/* ============================================================
   ADMIN — roles, pincodes, activities/QR, settings, reminders
   ============================================================ */
async function renderAdmin(){
  if(!isCoord()){ view().innerHTML='<div class="empty">Coordinators only.</div>'; return; }
  view().innerHTML = '<div class="empty">Loading…</div>';
  const [{data:profs},{data:acts}] = await Promise.all([
    sb.from('profiles').select('*').order('created_at'),
    sb.from('activities').select('*').order('activity_date',{ascending:false}).limit(30)]);

  let h = '';
  // --- activities + QR ---
  h += `<div class="card"><h2>📋 Activities & attendance QR</h2>
    <button class="btn small ghost" onclick="openNewActivity()">＋ New activity</button>`;
  h += (acts||[]).map(a=>`<div class="row"><div class="grow">
      <div class="name">${esc(a.name)} ${a.is_open?'<span class="badge green">open</span>':'<span class="badge gray">closed</span>'}</div>
      <div class="sub">${centerName(a.center_id)} · ${fmtD(a.activity_date)}</div></div>
    <button class="btn small ghost" onclick="showQR('${a.qr_token}','${esc(a.name)}')">QR</button>
    <button class="btn small gray" onclick="toggleActivity('${a.id}',${!a.is_open})">${a.is_open?'Close':'Reopen'}</button>
    </div>`).join('') || '<div class="empty">No activities yet.</div>';
  h += `</div>`;

  // --- users & roles (RCO only edits) ---
  h += `<div class="card"><h2>👥 Users & roles</h2>`;
  h += (profs||[]).map(p=>`<div class="row"><div class="grow">
      <div class="name">${esc(p.full_name||p.email)}</div>
      <div class="sub">${esc(p.email||'')} · ${p.phone?esc(p.phone)+' · ':''}${roleLabel(p.role)} · ${centerName(p.center_id)}</div></div>
    ${ME.role==='rco'?`
      <select style="width:auto;font-size:.78rem;padding:6px" onchange="setRole('${p.id}','role',this.value)">
        ${['volunteer','coordinator','rco'].map(r=>`<option value="${r}" ${p.role===r?'selected':''}>${roleLabel(r)}</option>`).join('')}</select>
      <select style="width:auto;font-size:.78rem;padding:6px" onchange="setRole('${p.id}','center_id',this.value)">
        ${CENTERS.concat([{id:'unassigned',name:'Unassigned'}]).map(c=>`<option value="${c.id}" ${p.center_id===c.id?'selected':''}>${c.name}</option>`).join('')}</select>`:''}
    ${p.phone?`<a class="iconbtn wa" href="https://wa.me/91${p.phone}?text=${encodeURIComponent('Namaskaram 🙏 Gentle reminder — you have nurturing calls due on the dashboard. Please take a look when you can!')}" target="_blank" title="Nudge">💬</a>`:''}
    </div>`).join('');
  h += `<p class="muted" style="margin-top:8px">💬 = tap to nudge a volunteer on WhatsApp about pending calls.</p></div>`;

  // --- pincode map (RCO) ---
  if(ME.role==='rco'){
    const pm = SETTINGS.pincode_map||{};
    h += `<div class="card"><h2>📍 Pincode → center map</h2>
      <table class="mini"><tr><th>Pincode</th><th>Center</th><th></th></tr>
      ${Object.entries(pm).map(([pin,cid])=>`<tr><td>${pin}</td><td>${centerName(cid)}</td>
        <td><button class="btn small gray" onclick="delPin('${pin}')">✕</button></td></tr>`).join('')}</table>
      <div style="display:flex;gap:8px;margin-top:8px">
        <input id="pin-new" placeholder="560xxx" inputmode="numeric" style="flex:1">
        <select id="pin-center" style="flex:1">${CENTERS.map(c=>`<option value="${c.id}">${c.name}</option>`).join('')}</select>
        <button class="btn small" onclick="addPin()">Add</button></div></div>`;

    const rc = SETTINGS.reminder_config||{};
    h += `<div class="card"><h2>⏰ Reminder settings</h2>
      <label>Daily reminder email hour (IST, 0–23)</label>
      <input id="rc-hour" type="number" min="0" max="23" value="${rc.email_hour_ist??8}">
      <label>Treat calls as overdue after (days past due date)</label>
      <input id="rc-od" type="number" min="0" value="${rc.overdue_after_days??0}">
      <button class="btn block" onclick="saveReminderCfg()">Save</button>
      <p class="muted" style="margin-top:8px">Emails are sent by the <code>send-reminders</code> Edge Function — see README §6.</p></div>`;
  }
  view().innerHTML = h;
}
async function setRole(id, field, val){
  const {error} = await sb.from('profiles').update({[field]:val}).eq('id', id);
  toast(error?error.message:'Updated ✔');
}
async function addPin(){
  const pin = $('pin-new').value.trim(); if(!/^\d{6}$/.test(pin)) return toast('Enter a 6-digit pincode');
  const pm = {...(SETTINGS.pincode_map||{}), [pin]:$('pin-center').value};
  const {error} = await sb.from('settings').update({value:pm}).eq('key','pincode_map');
  if(error) return toast(error.message);
  SETTINGS.pincode_map = pm; renderAdmin(); toast('Added ✔');
}
async function delPin(pin){
  const pm = {...(SETTINGS.pincode_map||{})}; delete pm[pin];
  await sb.from('settings').update({value:pm}).eq('key','pincode_map');
  SETTINGS.pincode_map = pm; renderAdmin();
}
async function saveReminderCfg(){
  const v = {...(SETTINGS.reminder_config||{}), email_hour_ist:+$('rc-hour').value, overdue_after_days:+$('rc-od').value};
  const {error} = await sb.from('settings').update({value:v}).eq('key','reminder_config');
  if(error) return toast(error.message);
  SETTINGS.reminder_config = v; toast('Saved ✔');
}
function openNewActivity(){
  modal(`<h3>New activity</h3>
    <label>Name</label><input id="na-name" placeholder="e.g. Saturday Satsang setup">
    <label>Center</label><select id="na-center">${CENTERS.map(c=>`<option value="${c.id}">${c.name}</option>`).join('')}</select>
    <label>Date</label><input id="na-date" type="date" value="${today()}">
    <button class="btn block" onclick="saveActivity()">Create & show QR</button>`);
}
async function saveActivity(){
  const {data, error} = await sb.from('activities').insert({
    name:$('na-name').value||'Activity', center_id:$('na-center').value,
    activity_date:$('na-date').value, created_by:ME.id}).select().single();
  if(error) return toast(error.message);
  showQR(data.qr_token, data.name);
}
async function toggleActivity(id, open){
  await sb.from('activities').update({is_open:open}).eq('id',id); renderAdmin();
}
function showQR(token, name){
  const base = location.href.replace(/[^/]*$/,'');
  const url = `${base}checkin.html?t=${token}`;
  modal(`<h3>${esc(name)} — attendance QR</h3>
    <p class="muted">Print this and stick it at the venue. Volunteers scan to mark Time-In / Time-Out.</p>
    <div id="qr-box" style="display:flex;justify-content:center;padding:16px"></div>
    <p class="muted" style="word-break:break-all;text-align:center">${esc(url)}</p>
    <button class="btn ghost block" onclick="window.print()">🖨️ Print</button>`);
  new QRCode($('qr-box'), {text:url, width:220, height:220});
}

/* ---------------- start ---------------- */
boot();
