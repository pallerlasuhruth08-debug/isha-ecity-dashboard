/* ============================================================
   Isha E-City Nurturing Dashboard -- app logic (vanilla JS)
   ============================================================ */
const sb = supabase.createClient(APP_CONFIG.SUPABASE_URL, APP_CONFIG.SUPABASE_ANON_KEY);
let ME = null;
let SETTINGS = {};
let CENTERS = [];
const $ = id => document.getElementById(id);
const view = () => $('view');
const esc = s => (s ?? '').toString().replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
const fmtD = d => d ? new Date(d).toLocaleDateString('en-IN', {day:'numeric',month:'short',year:'2-digit'}) : '--';
const today = () => new Date().toISOString().slice(0,10);

function toast(m){ const t=$('toast'); t.textContent=m; t.classList.add('show');
  setTimeout(()=>t.classList.remove('show'), 2600); }

/* Fetch EVERY matching row, paging past Supabase's 1000-row-per-request cap.
   makeQuery() must return a fresh query builder each call (so .range() can be re-applied). */
async function fetchAll(makeQuery, pageSize=1000){
  let from = 0, all = [];
  for(;;){
    const {data, error} = await makeQuery().range(from, from + pageSize - 1);
    if(error){ toast(error.message); break; }
    all = all.concat(data||[]);
    if(!data || data.length < pageSize) break;
    from += pageSize;
  }
  return all;
}

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
  toast('Account created -- signing in...'); doLogin();
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
  $('who-role').textContent = roleLabel(ME.role) + (ME.role!=='rco' ? ' - '+centerName(ME.center_id) : ' - Sector');
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
       <button class="x" onclick="closeModal()">x</button>${html}</div></div>`;
}
function closeModal(){ $('modal-root').innerHTML=''; }

/* ============================================================
   TODAY -- calls due / overdue
   ============================================================ */
const JT = {new_meditator:'New Meditator', meditator:'Meditator', advanced:'Advanced Program', volunteer_nurture:'Volunteer'};
const WA_MSG = {
  new_meditator: n => `Namaskaram ${n} -- This is from Isha Electronic City center. Hope your Shambhavi sadhana is going well! I wanted to check in and support you. When is a good time to talk?`,
  meditator:     n => `Namaskaram ${n} -- This is from Isha Electronic City center. We'd love to hear how your sadhana is going. When is a good time to talk?`,
  advanced:      n => `Namaskaram ${n} -- Congratulations on completing your program! We'd love to hear about your experience. When can we talk?`,
  volunteer_nurture: n => `Namaskaram ${n} -- We heard you volunteered recently -- wonderful! We'd love to hear how it was. When is a good time?`
};

async function fetchDueCalls(){
  let q = sb.from('calls')
    .select('id, call_no, due_date, journey_id, journeys!inner(id, type, program_name, program_date, center_id, assigned_to, status, people(id, full_name, phone, center_id))')
    .is('completed_at', null).lte('due_date', today()).eq('journeys.status','active').order('due_date');
  if(ME.role==='volunteer') q = q.eq('journeys.assigned_to', ME.id);
  const {data, error} = await q;
  if(error){ toast(error.message); return []; }
  return data||[];
}

async function renderToday(){
  view().innerHTML = '<div class="empty">Loading...</div>';
  const calls = await fetchDueCalls();
  const overdue = calls.filter(c=>c.due_date < today());
  let upQ = sb.from('calls')
    .select('id, call_no, due_date, journeys!inner(type, assigned_to, status, people(full_name))')
    .is('completed_at', null).gt('due_date', today()).eq('journeys.status','active')
    .order('due_date').limit(8);
  if(ME.role==='volunteer') upQ = upQ.eq('journeys.assigned_to', ME.id);
  const {data:upcoming} = await upQ;

  let h = '';
  if(overdue.length) h += `<div class="alert">⚠️ ${overdue.length} overdue call${overdue.length>1?'s':''} -- please catch up today</div>`;
  h += `<div class="card"><h2>📞 Calls due today ${calls.length?`<span class="badge">${calls.length}</span>`:''}</h2>`;
  h += calls.length ? calls.map(callRow).join('') : '<div class="empty">🎉 All caught up -- no calls due.</div>';
  h += '</div>';
  if(upcoming?.length){
    h += `<div class="card"><h2>⏭️ Coming up</h2>` + upcoming.map(c=>
      `<div class="row"><div class="grow"><div class="name">${esc(c.journeys.people.full_name)}</div>
       <div class="sub">${JT[c.journeys.type]} - Call ${c.call_no} - due ${fmtD(c.due_date)}</div></div></div>`).join('') + '</div>';
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
      <div class="sub">${JT[j.type]}${j.program_name?' - '+esc(j.program_name):''}
        - Call ${c.call_no}${j.type==='new_meditator'?'/3':''}${day?` - Day ${day}`:''}  - due ${fmtD(c.due_date)}</div>
    </div>
    ${p.phone?`<a class="iconbtn call" href="tel:+91${p.phone}">Call</a>`:''}
    ${wa?`<a class="iconbtn wa" href="${wa}" target="_blank">WA</a>`:''}
    <button class="btn small ghost" onclick='openLog(${JSON.stringify({id:c.id,call_no:c.call_no,jtype:j.type,name:p.full_name}).replace(/'/g,"&#39;")})'>Log</button>
  </div>`;
}

/* ---- call logging ---- */
const SADHANA_OPTS = {
  new_meditator: ['Doing Well','Doing Regularly','Needs Support','Needs Support on Ishangam','Wants to Connect with Ishangam','Does Not Need Support','Stopped Sadhana','Not Sure'],
  meditator: ['Doing sadhana regularly','Irregular','Stopped','Wants to go to Ashram','Wants Sannidhi at home','Wants an advanced program','Needs practice correction','Other'],
  advanced: ['Great experience','Good, needs support','Wants to volunteer','Wants another program','Needs practice correction','Other'],
  volunteer_nurture: ['Great experience','Interested in local volunteering','Not interested now','Needs follow-up','Other']
};
let LOG = null;
function openLog(c){
  LOG = {...c, reach:null, status:null};
  modal(`<h3>Log call -- ${esc(c.name)}</h3><p class="muted">Call ${c.call_no}</p>
    <label>Reachability</label>
    <div class="choices" id="lg-reach">
      ${[['answered','Answered'],['not_reachable','Not Reachable'],['will_call_back','Will Call Back']]
        .map(([v,l])=>`<button onclick="pickReach('${v}',this)">${l}</button>`).join('')}
    </div>
    <div id="lg-status-wrap" class="hidden">
      <label>Sadhana / status</label>
      <div class="choices" id="lg-status">
        ${(SADHANA_OPTS[c.jtype]||SADHANA_OPTS.meditator).map(s=>`<button onclick="pickStatus('${esc(s)}',this)">${esc(s)}</button>`).join('')}
      </div>
      <div id="lg-suggest" class="muted" style="margin-top:8px"></div>
    </div>
    <label>Remarks</label><textarea id="lg-remarks" placeholder="How did it go?..."></textarea>
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
  const key = s.toLowerCase().includes('stopped')?'stopped'
    : s.toLowerCase().includes('irregular')?'irregular'
    : s.toLowerCase().includes('regular')?'regular'
    : s.toLowerCase().includes('ashram')?'wants_ashram'
    : s.toLowerCase().includes('sannidhi')?'wants_sannidhi'
    : s.toLowerCase().includes('advanced')||s.toLowerCase().includes('another program')?'wants_advanced'
    : s.toLowerCase().includes('correction')?'needs_correction':null;
  const acts = key && SETTINGS.next_action_map?.[key];
  $('lg-suggest').innerHTML = acts ? 'Suggested next: ' + acts.join(' - ') : '';
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
  closeModal(); toast('Saved!'); renderToday();
}

/* ============================================================
   PEOPLE -- 4 tabs
   ============================================================ */
let PEOPLE_TAB = 'new_meditator';

// Per-tab filter state
const PF = {
  new_meditator: { center:'', status:'pending', dateFrom:'', dateTo:'', search:'' },
  meditator:     { center:'', tag:'', dateFrom:'', dateTo:'', search:'' },
  advanced:      { program:'bsp', view:'completed', window:'week', center:'', search:'' },
  volunteer_nurture: { center:'', search:'' }
};

// Advanced programs: [key, label, completion-date column on people]
const ADV_PROGS = [
  ['bsp','BSP','bsp_date'], ['shoonya','Shoonya','shoonya_date'],
  ['samyama','Samyama','samyama_date'], ['guru_puja','Guru Puja','guru_puja_date']
];
const advSync = () => SETTINGS.advanced_sync || {go_live_date:today(), last_sync_date:today(), prev_sync_date:today()};

// New-meditator selection (nurturer chooses who to start calling)
const NM_SEL = new Set();

// Common Ishangam tags to filter by
// Ishangam Program Tags (what we sync onto meditator profiles) — used in the Meditators tag filter
const COMMON_TAGS = [
  'IE','IEO','FMF','IEO-R','IE-R','BSP','EOE-R','IECSO-R','Shoonya','LOM','Yogasanas','Samyama',
  'Surya Kriya','MoM 1st Int','Angamardana','Bhuta Shuddhi','Guru Pooja','Uyir Nokkam',
  'Free Yoga','SP','CYW','MoM Only'
];

async function renderPeople(tab){
  if(tab) PEOPLE_TAB = tab;
  view().innerHTML = '<div class="empty">Loading...</div>';

  // Ashram/SSB volunteers moved to the Volunteers tab.
  if(PEOPLE_TAB==='volunteer_nurture') PEOPLE_TAB = 'new_meditator';

  const tabDefs = [
    ['new_meditator','🌱 New Meditators'],
    ['meditator','🧘 Meditators'],
    ['advanced','⭐ Advanced Programs']
  ];

  const tabBar = `<div class="tabs">${tabDefs.map(([v,l])=>
    `<button class="${PEOPLE_TAB===v?'active':''}" onclick="renderPeople('${v}')">${l}</button>`).join('')}</div>`;

  if(PEOPLE_TAB==='new_meditator') await renderNewMeditators(tabBar);
  else if(PEOPLE_TAB==='meditator') await renderMeditatorsList(tabBar);
  else await renderAdvancedList(tabBar);
}

/* ---- New Meditators (nurturer chooses who to call -- nothing is automatic) ---- */
async function renderNewMeditators(tabBar){
  const f = PF.new_meditator;
  const centerOpts = `<option value="">All Centers</option>${CENTERS.map(c=>`<option value="${c.id}" ${f.center===c.id?'selected':''}>${c.name}</option>`).join('')}`;
  const statusOpts = `
    <option value="pending" ${f.status==='pending'?'selected':''}>Not yet calling</option>
    <option value="active" ${f.status==='active'?'selected':''}>Calling now</option>
    <option value="completed" ${f.status==='completed'?'selected':''}>Calls done</option>
    <option value="" ${f.status===''?'selected':''}>All</option>`;

  let h = tabBar;
  if(isCoord()) h += `<div style="display:flex;gap:8px;margin:6px 0;flex-wrap:wrap">
    <button class="btn small ghost" onclick="openImport()">📥 Import</button>
    <button class="btn small ghost" onclick="openAddPerson()">➕ Add person</button>
  </div>`;
  h += `<div class="card" style="padding:10px">
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <select style="width:auto" onchange="PF.new_meditator.center=this.value;renderPeople()">
        ${centerOpts}</select>
      <select style="width:auto" title="Calling status" onchange="PF.new_meditator.status=this.value;renderPeople()">
        ${statusOpts}</select>
      <input placeholder="Search name/phone" style="flex:1;min-width:140px" value="${esc(f.search)}"
        oninput="PF.new_meditator.search=this.value" onkeydown="if(event.key==='Enter')renderPeople()">
      <input type="date" title="IE date from (or single date)" value="${f.dateFrom}"
        onchange="PF.new_meditator.dateFrom=this.value;renderPeople()" style="width:130px">
      <input type="date" title="IE date to (leave blank for a single date)" value="${f.dateTo}"
        onchange="PF.new_meditator.dateTo=this.value;renderPeople()" style="width:130px">
      <button class="btn small ghost" onclick="renderPeople()">Search</button>
      ${(f.dateFrom||f.dateTo||f.search)?`<button class="btn small gray" onclick="PF.new_meditator.dateFrom='';PF.new_meditator.dateTo='';PF.new_meditator.search='';renderPeople()">Clear</button>`:''}
    </div>
    <p class="muted" style="font-size:.76rem;margin-top:6px">Pick an IE date (or a from–to range) to load new meditators for that period.</p>
  </div>`;

  // Date-gate: don't dump the whole base. Require a date (or a search).
  const effFrom = f.dateFrom || f.dateTo;   // single date if only one box is filled
  const effTo   = f.dateTo   || f.dateFrom;
  if(!effFrom && !f.search){
    view().innerHTML = h + `<div class="card"><div class="empty">📅 Choose an IE date or a date range above to see new meditators.<br>This keeps the list focused on the people you want to call — it won't show everyone at once.</div></div>`;
    return;
  }

  let rows = await fetchAll(() => {
    let q = sb.from('journeys')
      .select('id, type, program_name, program_date, status, sadhana_status, assigned_to, center_id, people(*), calls(id, call_no, due_date, completed_at)')
      .eq('type', 'new_meditator').order('program_date', {ascending:false});
    if(ME.role==='volunteer') q = q.eq('assigned_to', ME.id);
    if(f.center) q = q.eq('center_id', f.center);
    if(f.status) q = q.eq('status', f.status);
    if(effFrom) q = q.gte('program_date', effFrom);
    if(effTo) q = q.lte('program_date', effTo);
    return q;
  });
  if(f.search){
    const s = f.search.toLowerCase();
    rows = rows.filter(j=>j.people?.full_name?.toLowerCase().includes(s)||j.people?.phone?.includes(s));
  }

  let vols = [];
  if(isCoord()){
    const {data:v} = await sb.from('profiles').select('id, full_name, email, role, center_id').eq('active', true);
    vols = v||[];
  }

  const pendingShown = rows.filter(r=>r.status==='pending').length;
  h += `<div class="card"><h2>🌱 New Meditators <span class="badge">${rows.length}</span></h2>
    <p class="muted" style="font-size:.8rem;margin-bottom:8px">Tick the meditators you want to start nurturing calls for, then press <b>Start calling</b>. Nobody is added to calls automatically.</p>`;
  if(isCoord() && pendingShown){
    h += `<div class="row" style="position:sticky;top:0;background:var(--card-bg);z-index:5;flex-wrap:wrap;gap:6px;padding:8px;border:1px solid var(--border);border-radius:10px;margin-bottom:8px">
      <button class="btn small ghost" onclick="nmSelectAllShown()">Select all shown</button>
      <button class="btn small ghost" onclick="nmClearSel()">Clear</button>
      <select id="nm-assign" style="width:auto;font-size:.78rem;padding:4px 6px">
        <option value="">(assign later)</option>
        ${vols.map(v=>`<option value="${v.id}">${esc(v.full_name||v.email)}</option>`).join('')}
      </select>
      <button class="btn small green" onclick="nmStartCalling()">📞 Start calling (<span id="nm-count">${NM_SEL.size}</span>)</button>
    </div>`;
  }
  h += rows.length ? rows.map(j=>newMeditatorRow(j, vols)).join('') : '<div class="empty">No records matching filters.</div>';
  h += '</div>';
  view().innerHTML = h;
}

function nmToggle(id,on){ on?NM_SEL.add(id):NM_SEL.delete(id); const c=$('nm-count'); if(c)c.textContent=NM_SEL.size; }
function nmSelectAllShown(){
  document.querySelectorAll('#view input.nm-cb').forEach(cb=>{ cb.checked=true; NM_SEL.add(cb.dataset.jid); });
  const c=$('nm-count'); if(c)c.textContent=NM_SEL.size;
}
function nmClearSel(){
  NM_SEL.clear();
  document.querySelectorAll('#view input.nm-cb').forEach(cb=>cb.checked=false);
  const c=$('nm-count'); if(c)c.textContent=0;
}
async function nmStartCalling(){
  if(!NM_SEL.size) return toast('Tick at least one meditator first');
  const assign = $('nm-assign')?.value || '';
  const ids = [...NM_SEL];
  toast('Starting nurturing...');
  for(const id of ids){
    const {error} = await sb.rpc('activate_journey', {j_id:id});
    if(error) return toast(error.message);
    if(assign) await sb.from('journeys').update({assigned_to:assign}).eq('id', id);
  }
  NM_SEL.clear();
  toast(`Calling started for ${ids.length} meditator${ids.length>1?'s':''}`);
  renderPeople();
}

function newMeditatorRow(j, vols){
  const p = j.people;
  const done = (j.calls||[]).filter(c=>c.completed_at).length;
  const total = (j.calls||[]).length;
  const tags = (p?.tags||[]).slice(0,3).map(t=>`<span class="badge gray" style="font-size:.7rem">${esc(t)}</span>`).join(' ');
  const assignee = vols.find(v=>v.id===j.assigned_to);
  const isPending = j.status==='pending';
  const statusBadge = isPending ? '<span class="badge gray">not calling</span>'
    : j.status==='completed' ? '<span class="badge green">done</span>'
    : '<span class="badge">calling</span>';
  const cb = (isCoord() && isPending)
    ? `<input type="checkbox" class="nm-cb" data-jid="${j.id}" ${NM_SEL.has(j.id)?'checked':''} onchange="nmToggle('${j.id}',this.checked)" style="width:20px;height:20px;flex-shrink:0;margin-right:4px">`
    : '';
  const assignSel = (isCoord() && !isPending) ? `<select style="width:auto;font-size:.78rem;padding:4px 6px" onchange="assignJourney('${j.id}', this.value)">
    <option value="">-- assign --</option>
    ${vols.map(v=>`<option value="${v.id}" ${v.id===j.assigned_to?'selected':''}>${esc(v.full_name||v.email)}</option>`).join('')}
  </select>` : '';
  const wa = p?.phone ? `https://wa.me/91${p.phone}?text=${encodeURIComponent(WA_MSG.new_meditator(p.full_name.split(' ')[0]))}` : null;
  const prof = JSON.stringify({n:p?.full_name,ph:p?.phone,email:p?.email,occ:p?.occupation,gender:p?.gender,dob:p?.date_of_birth,area:p?.area,city:p?.city,street:p?.street,pin:p?.pincode,ctr:p?.center_id,ie:p?.ie_date||j.program_date,tags:p?.tags||[]}).replace(/'/g,"&#39;").replace(/"/g,'&quot;');
  return `<div class="row">
    ${cb}
    <div class="grow" style="cursor:pointer" onclick="showPersonProfile(${prof})">
      <div class="name">${esc(p?.full_name||'?')} ${statusBadge} ${tags}</div>
      <div class="sub">IE: ${fmtD(p?.ie_date||j.program_date)} - ${centerName(p?.center_id)}${isPending?'':` - calls ${done}/${total}`}
        ${j.sadhana_status?` - <b>${esc(j.sadhana_status)}</b>`:''}
        ${assignee?` - ${esc(assignee.full_name||assignee.email)}`:''} <span class="muted" style="font-size:.7rem">· tap for profile</span></div>
    </div>
    ${p?.phone?`<a class="iconbtn call" href="tel:+91${p.phone}">Call</a>`:''}
    ${wa?`<a class="iconbtn wa" href="${wa}" target="_blank">WA</a>`:''}
    ${assignSel}
  </div>`;
}

/* ---- Meditators (ALL is_meditator=true people) ---- */
async function renderMeditatorsList(tabBar){
  const f = PF.meditator;
  const centerOpts = `<option value="">All Centers</option>${CENTERS.map(c=>`<option value="${c.id}" ${f.center===c.id?'selected':''}>${c.name}</option>`).join('')}`;
  const tagOpts = `<option value="">All Tags</option>${COMMON_TAGS.map(t=>`<option value="${t}" ${f.tag===t?'selected':''}>${esc(t)}</option>`).join('')}`;

  let h = tabBar;
  if(isCoord()) h += `<div style="display:flex;gap:8px;margin:6px 0;flex-wrap:wrap">
    <button class="btn small ghost" onclick="openImport()">📥 Import</button>
    <button class="btn small ghost" onclick="openAddPerson()">➕ Add person</button>
  </div>`;

  h += `<div class="card" style="padding:10px">
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <select style="width:auto" onchange="PF.meditator.center=this.value;renderPeople()">
        ${centerOpts}</select>
      <select style="width:auto" onchange="PF.meditator.tag=this.value;renderPeople()">
        ${tagOpts}</select>
      <input type="date" title="IE date from" value="${f.dateFrom}"
        onchange="PF.meditator.dateFrom=this.value;renderPeople()" style="width:130px">
      <input type="date" title="IE date to" value="${f.dateTo}"
        onchange="PF.meditator.dateTo=this.value;renderPeople()" style="width:130px">
      <input placeholder="Search name/phone" style="flex:1;min-width:140px" value="${esc(f.search)}"
        oninput="PF.meditator.search=this.value" onkeydown="if(event.key==='Enter')renderPeople()">
      <button class="btn small ghost" onclick="renderPeople()">Search</button>
    </div>
  </div>`;

  let rows = await fetchAll(() => {
    let q = sb.from('people').select('*')
      .eq('is_meditator', true).order('ie_date', {ascending:false});
    if(f.center) q = q.eq('center_id', f.center);
    if(f.tag) q = q.contains('tags', [f.tag]);
    if(f.dateFrom) q = q.gte('ie_date', f.dateFrom);
    if(f.dateTo) q = q.lte('ie_date', f.dateTo);
    return q;
  });
  if(f.search){
    const s = f.search.toLowerCase();
    rows = rows.filter(p=>p.full_name?.toLowerCase().includes(s)||p.phone?.includes(s));
  }

  h += `<div class="card"><h2>🧘 Meditators <span class="badge">${rows.length}</span></h2>`;
  h += rows.length ? rows.map(p=>meditatorDetailRow(p)).join('') : '<div class="empty">No meditators matching filters.</div>';
  h += '</div>';
  view().innerHTML = h;
}

function meditatorDetailRow(p){
  const tags = (p.tags||[]).slice(0,4).map(t=>`<span class="badge gray" style="font-size:.68rem">${esc(t)}</span>`).join(' ');
  const adv = [p.bsp_date&&`BSP: ${fmtD(p.bsp_date)}`, p.shoonya_date&&`Shoonya:${fmtD(p.shoonya_date)}`, p.samyama_date&&`Samyama:${fmtD(p.samyama_date)}`, p.guru_puja_date&&`Guru Puja:${fmtD(p.guru_puja_date)}`].filter(Boolean).join(' - ');
  const wa = p.phone ? `https://wa.me/91${p.phone}?text=${encodeURIComponent(WA_MSG.meditator(p.full_name.split(' ')[0]))}` : null;
  return `<div class="row">
    <div class="grow" style="cursor:pointer" onclick="showMeditatorDetail(${JSON.stringify({id:p.id,n:p.full_name,ph:p.phone,email:p.email,occ:p.occupation,gender:p.gender,dob:p.date_of_birth,area:p.area,city:p.city,street:p.street,pin:p.pincode,ie:p.ie_date,bsp:p.bsp_date,sh:p.shoonya_date,sam:p.samyama_date,gp:p.guru_puja_date,tags:p.tags||[],ctr:p.center_id}).replace(/'/g,"&#39;").replace(/"/g,'&quot;')})">
      <div class="name">${esc(p.full_name)} ${tags}</div>
      <div class="sub">IE: ${fmtD(p.ie_date)} - ${centerName(p.center_id)}${adv?' - '+adv:''} <span class="muted" style="font-size:.7rem">· tap for profile</span></div>
    </div>
    ${p.phone?`<a class="iconbtn call" href="tel:+91${p.phone}">Call</a>`:''}
    ${wa?`<a class="iconbtn wa" href="${wa}" target="_blank">WA</a>`:''}
    ${isCoord()?`<button class="btn small ghost" onclick='startNurturing(${JSON.stringify({pid:p.id,name:p.full_name}).replace(/'/g,"&#39;")})'>Nurture</button>`:''}
  </div>`;
}

// Shared full-profile card (used by New Meditators + Meditators rows)
function profileBody(d){
  const tags = (d.tags||[]).map(t=>`<span class="badge gray">${esc(t)}</span>`).join(' ');
  const addr = [d.street,d.area,d.city].filter(Boolean).map(esc).join(', ');
  const progs = [d.bsp&&`BSP ${fmtD(d.bsp)}`, d.sh&&`Shoonya ${fmtD(d.sh)}`, d.sam&&`Samyama ${fmtD(d.sam)}`, d.gp&&`Guru Puja ${fmtD(d.gp)}`].filter(Boolean).join(' · ');
  return `
    ${d.ph?`<p>📞 ${esc(d.ph)}</p>`:''}
    ${d.email?`<p>✉️ ${esc(d.email)}</p>`:''}
    <p>🏠 ${addr||'<span class="muted">address not on record</span>'}${d.pin?` · ${esc(d.pin)}`:''}</p>
    <p>🏢 Center: ${centerName(d.ctr)}</p>
    ${d.occ?`<p>💼 Occupation: ${esc(d.occ)}</p>`:''}
    ${d.gender?`<p>🧍 Gender: ${esc(d.gender)}</p>`:''}
    ${d.dob?`<p>🎂 Date of birth: ${fmtD(d.dob)}</p>`:''}
    ${d.ie?`<p>🪷 IE date: ${fmtD(d.ie)}</p>`:''}
    ${progs?`<p>⭐ Advanced: ${progs}</p>`:''}
    ${tags?`<p style="margin-top:8px">🏷️ ${tags}</p>`:''}`;
}
function showPersonProfile(d){
  modal(`<h3>${esc(d.n)}</h3>${profileBody(d)}`);
}
function showMeditatorDetail(d){
  modal(`<h3>${esc(d.n)}</h3>${profileBody(d)}
    ${isCoord()?`<button class="btn block" style="margin-top:14px" onclick='closeModal();startNurturing(${JSON.stringify({pid:d.id,name:d.n}).replace(/'/g,"&#39;")})'>Add to nurturing calls</button>`:''}
  `);
}

async function startNurturing(d){
  modal(`<h3>Add to nurturing calls</h3>
    <p>${esc(d.name)}</p>
    <label>Type</label>
    <select id="nt-type">
      <option value="meditator">Meditator nurturing</option>
      <option value="advanced">Advanced program follow-up</option>
    </select>
    <label>Program name (optional)</label>
    <input id="nt-prog" placeholder="e.g. BSP, Shoonya, Inner Engineering">
    <label>Program / initiation date</label>
    <input id="nt-date" type="date" value="${today()}">
    <button class="btn block" onclick="saveNurturing('${d.pid}')">Create journey</button>`);
}
async function saveNurturing(pid){
  const {error} = await sb.from('journeys').insert({
    person_id:pid, type:$('nt-type').value,
    program_name:$('nt-prog').value||null,
    program_date:$('nt-date').value||null
  });
  if(error) return toast(error.message);
  closeModal(); toast('Journey created -- will appear in Today\'s calls');
}

/* ---- Advanced Programs (per-program: Completed this week + Interested) ---- */
async function renderAdvancedList(tabBar){
  const f = PF.advanced;
  const meta = ADV_PROGS.find(p=>p[0]===f.program) || ADV_PROGS[0];
  const col = meta[2], label = meta[1];
  const sync = advSync();
  const centerOpts = `<option value="">All Centers</option>${CENTERS.map(c=>`<option value="${c.id}" ${f.center===c.id?'selected':''}>${c.name}</option>`).join('')}`;

  let h = tabBar;
  // program picker
  const progEmoji = {bsp:'🌀', shoonya:'🕉️', samyama:'🧘', guru_puja:'🙏'};
  h += `<div class="tabs">${ADV_PROGS.map(([v,l])=>
    `<button class="${f.program===v?'active':''}" onclick="PF.advanced.program='${v}';renderPeople()">${progEmoji[v]||''} ${l}</button>`).join('')}</div>`;
  // completed vs interested
  h += `<div class="choices" style="margin:8px 0;gap:6px">
    <button class="${f.view==='completed'?'sel':''}" onclick="PF.advanced.view='completed';renderPeople()">✅ Completed</button>
    <button class="${f.view==='interested'?'sel':''}" onclick="PF.advanced.view='interested';renderPeople()">✋ Interested</button>
  </div>`;
  // common filters
  h += `<div class="card" style="padding:10px">
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <select style="width:auto" onchange="PF.advanced.center=this.value;renderPeople()">${centerOpts}</select>
      <input placeholder="Search name/phone" style="flex:1;min-width:140px" value="${esc(f.search)}"
        oninput="PF.advanced.search=this.value" onkeydown="if(event.key==='Enter')renderPeople()">
      <button class="btn small ghost" onclick="renderPeople()">Search</button>
    </div>
  </div>`;

  if(f.view === 'completed'){
    h += `<div class="card" style="padding:10px">
      <div class="choices" style="gap:6px">
        <button class="${f.window==='week'?'sel':''}" onclick="PF.advanced.window='week';renderPeople()">New this week</button>
        <button class="${f.window==='all'?'sel':''}" onclick="PF.advanced.window='all';renderPeople()">All completers</button>
      </div>
      <p class="muted" style="font-size:.78rem;margin-top:8px">Completed ${esc(label)} from Ishangam. Last synced: <b>${fmtD(sync.last_sync_date)}</b>.
        ${isCoord()?`<button class="btn small ghost" onclick="markSynced()" style="margin-left:6px">🔄 I synced today</button>`:''}</p>
    </div>`;
    const winStart = f.window==='week' ? sync.prev_sync_date : null;   // 'all' = every completer, any date
    let rows = await fetchAll(() => {
      let q = sb.from('people').select(`id, full_name, phone, center_id, tags, ${col}`)
        .eq('is_meditator', true).not(col,'is',null).order(col,{ascending:false});
      if(winStart) q = q.gte(col, winStart);
      if(f.center) q = q.eq('center_id', f.center);
      return q;
    });
    if(f.search){ const s=f.search.toLowerCase(); rows = rows.filter(p=>p.full_name?.toLowerCase().includes(s)||p.phone?.includes(s)); }
    h += `<div class="card"><h2>✅ Completed ${esc(label)} <span class="badge">${rows.length}</span></h2>`;
    h += rows.length ? rows.map(p=>advCompletedRow(p,col,label)).join('')
      : `<div class="empty">No ${esc(label)} completions in this window.<br>Run the weekly Ishangam scrape, then press "I synced today".</div>`;
    h += '</div>';
  } else {
    if(isCoord()) h += `<div style="margin:6px 0"><button class="btn small green" onclick="openAddInterest('${f.program}')">✋ Add interested (from paper)</button></div>`;
    let rows = await fetchAll(() => sb.from('advanced_interest')
      .select('id, program, interest_date, status, notes, people!inner(id, full_name, phone, center_id, tags)')
      .eq('program', f.program).order('interest_date',{ascending:false}));
    if(f.center) rows = rows.filter(r=>r.people?.center_id===f.center);
    if(f.search){ const s=f.search.toLowerCase(); rows = rows.filter(r=>r.people?.full_name?.toLowerCase().includes(s)||r.people?.phone?.includes(s)); }
    h += `<div class="card"><h2>✋ Interested in ${esc(label)} <span class="badge">${rows.length}</span></h2>
      <p class="muted" style="font-size:.78rem;margin-bottom:6px">People interested in ${esc(label)} — from Ishangam willingness + paper sign-ups. Reach out and help them register.</p>`;
    h += rows.length ? rows.map(r=>advInterestRow(r,label)).join('')
      : `<div class="empty">No interest entries yet. Use "+ Add interested" to enter your paper list.</div>`;
    h += '</div>';
  }
  view().innerHTML = h;
}

function advCompletedRow(p, col, label){
  const wa = p.phone ? `https://wa.me/91${p.phone}?text=${encodeURIComponent(WA_MSG.advanced(p.full_name.split(' ')[0]))}` : null;
  return `<div class="row">
    <div class="grow">
      <div class="name">${esc(p.full_name)}</div>
      <div class="sub">${esc(label)}: ${fmtD(p[col])} - ${centerName(p.center_id)}</div>
    </div>
    ${p.phone?`<a class="iconbtn call" href="tel:+91${p.phone}">Call</a>`:''}
    ${wa?`<a class="iconbtn wa" href="${wa}" target="_blank">WA</a>`:''}
    ${isCoord()?`<button class="btn small ghost" onclick='startNurturing(${JSON.stringify({pid:p.id,name:p.full_name}).replace(/'/g,"&#39;")})'>Nurture</button>`:''}
  </div>`;
}

function advInterestRow(r, label){
  const p = r.people || {};
  const wa = p.phone ? `https://wa.me/91${p.phone}?text=${encodeURIComponent('Namaskaram '+(p.full_name||'').split(' ')[0]+' -- You had expressed interest in '+label+'. We would love to help you register. When is a good time to talk?')}` : null;
  const statusSel = isCoord() ? `<select style="width:auto;font-size:.75rem;padding:4px 6px" onchange="setInterestStatus('${r.id}',this.value)">
    ${['new','contacted','registered','done','dropped'].map(s=>`<option value="${s}" ${r.status===s?'selected':''}>${s}</option>`).join('')}
  </select>` : '';
  return `<div class="row">
    <div class="grow">
      <div class="name">${esc(p.full_name||'?')} <span class="badge ${r.status==='registered'||r.status==='done'?'green':'gray'}">${esc(r.status)}</span></div>
      <div class="sub">Interested: ${fmtD(r.interest_date)} - ${centerName(p.center_id)}${r.notes?' - '+esc(r.notes):''}</div>
    </div>
    ${p.phone?`<a class="iconbtn call" href="tel:+91${p.phone}">Call</a>`:''}
    ${wa?`<a class="iconbtn wa" href="${wa}" target="_blank">WA</a>`:''}
    ${statusSel}
  </div>`;
}

function openAddInterest(program){
  const label = (ADV_PROGS.find(p=>p[0]===program)||[])[1] || program;
  modal(`<h3>Add interest -- ${esc(label)}</h3>
    <p class="muted">Enter a person from your paper list who wants to do ${esc(label)}.</p>
    <label>Full name</label><input id="ai-name">
    <label>Phone (10-digit)</label><input id="ai-phone" inputmode="numeric">
    <label>Pincode (optional)</label><input id="ai-pin" inputmode="numeric" placeholder="auto-routes to center">
    <label>Notes (optional)</label><textarea id="ai-notes" placeholder="e.g. wants the June batch"></textarea>
    <button class="btn block" onclick="saveAddInterest('${program}')">Save</button>`);
}
async function saveAddInterest(program){
  const name = $('ai-name').value.trim(), phone = $('ai-phone').value.trim();
  if(!name && !phone) return toast('Name or phone required');
  const {data, error} = await sb.rpc('add_advanced_interest', {
    p_name:name, p_phone:phone, p_program:program,
    p_notes:$('ai-notes').value||null, p_pincode:$('ai-pin').value||null});
  if(error) return toast(error.message);
  if(data?.error) return toast(data.error);
  closeModal(); toast('Interest saved'); renderPeople();
}
async function setInterestStatus(id, status){
  const {error} = await sb.from('advanced_interest').update({status}).eq('id', id);
  toast(error?error.message:'Updated');
}
async function markSynced(){
  const {data, error} = await sb.rpc('mark_advanced_sync');
  if(error) return toast(error.message);
  if(data) SETTINGS.advanced_sync = data;
  toast('Marked synced today'); renderPeople();
}

/* ---- Ashram/SSB Volunteers ---- */
async function renderVolunteerNurture(tabBar){
  const f = PF.volunteer_nurture;
  const centerOpts = `<option value="">All Centers</option>${CENTERS.map(c=>`<option value="${c.id}" ${f.center===c.id?'selected':''}>${c.name}</option>`).join('')}`;

  let h = tabBar;
  h += `<div class="card" style="padding:10px">
    <div style="display:flex;gap:8px;flex-wrap:wrap;align-items:center">
      <select style="width:auto" onchange="PF.volunteer_nurture.center=this.value;renderPeople()">
        ${centerOpts}</select>
      <input placeholder="Search name/phone" style="flex:1;min-width:140px" value="${esc(f.search)}"
        oninput="PF.volunteer_nurture.search=this.value" onkeydown="if(event.key==='Enter')renderPeople()">
      <button class="btn small ghost" onclick="renderPeople()">Search</button>
    </div>
  </div>`;

  let q = sb.from('journeys')
    .select('id, type, program_name, program_date, status, sadhana_status, assigned_to, center_id, people(id, full_name, phone, center_id), calls(id, call_no, due_date, completed_at)')
    .eq('type', 'volunteer_nurture').order('program_date', {ascending:false}).limit(300);
  if(ME.role==='volunteer') q = q.eq('assigned_to', ME.id);
  if(f.center) q = q.eq('center_id', f.center);

  const {data:js} = await q;
  let rows = js||[];
  if(f.search){
    const s = f.search.toLowerCase();
    rows = rows.filter(j=>j.people?.full_name?.toLowerCase().includes(s)||j.people?.phone?.includes(s));
  }

  let vols = [];
  if(isCoord()){
    const {data:v} = await sb.from('profiles').select('id, full_name, email, role, center_id').eq('active', true);
    vols = v||[];
  }

  h += `<div class="card"><h2>🙏 Ashram/SSB Volunteers <span class="badge">${rows.length}</span></h2>`;
  h += rows.length ? rows.map(j=>journeyRow(j, vols)).join('') : '<div class="empty">No volunteer nurturing journeys yet.</div>';
  h += '</div>';
  view().innerHTML = h;
}

function journeyRow(j, vols){
  const p = j.people;
  const done = (j.calls||[]).filter(c=>c.completed_at).length, total=(j.calls||[]).length;
  const assignee = vols.find(v=>v.id===j.assigned_to);
  const assignSel = isCoord() ? `<select style="width:auto;font-size:.78rem;padding:4px 6px" onchange="assignJourney('${j.id}', this.value)">
    <option value="">-- assign --</option>
    ${vols.map(v=>`<option value="${v.id}" ${v.id===j.assigned_to?'selected':''}>${esc(v.full_name||v.email)}</option>`).join('')}
  </select>` : '';
  const wa = p?.phone ? `https://wa.me/91${p.phone}?text=${encodeURIComponent(WA_MSG.volunteer_nurture(p.full_name.split(' ')[0]))}` : null;
  return `<div class="row">
    <div class="grow">
      <div class="name">${esc(p?.full_name||'?')}
        ${j.status==='completed'?'<span class="badge green">done</span>':''}</div>
      <div class="sub">${esc(j.program_name||'')} ${j.program_date?'- '+fmtD(j.program_date):''}
        - ${centerName(p?.center_id||j.center_id)} - calls ${done}/${total}
        ${j.sadhana_status?` - <b>${esc(j.sadhana_status)}</b>`:''}
        ${assignee?` - ${esc(assignee.full_name||assignee.email)}`:''}</div>
    </div>
    ${p?.phone?`<a class="iconbtn call" href="tel:+91${p.phone}">Call</a>`:''}
    ${wa?`<a class="iconbtn wa" href="${wa}" target="_blank">WA</a>`:''}
    ${assignSel}
  </div>`;
}

async function assignJourney(jid, uid){
  const {error} = await sb.from('journeys').update({assigned_to: uid||null}).eq('id', jid);
  toast(error ? error.message : 'Assigned');
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
    <label>Program / activity name</label><input id="ap-prog" placeholder="e.g. IE Online, BSP">
    <label>Program / activity date</label><input id="ap-date" type="date" value="${today()}">
    <button class="btn block" onclick="saveAddPerson()">Save</button>`);
}
async function saveAddPerson(){
  const kind = $('ap-kind').value;
  if(kind==='ashram_ssb'){
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
  closeModal(); toast('Saved!'); renderPeople();
}

/* ---- CSV / Excel import ---- */
function openImport(){
  modal(`<h3>Import CSV / Excel</h3>
    <p class="muted">Columns: <b>name, phone, pincode, program, date</b>. Duplicates merged by phone.</p>
    <label>Import as</label>
    <select id="im-kind">
      <option value="new_meditator">New meditators</option>
      <option value="meditator">Older meditators</option>
      <option value="advanced">Advanced program completers</option>
      <option value="volunteer">Volunteers</option>
    </select>
    <label>File (.csv / .xlsx)</label><input id="im-file" type="file" accept=".csv,.xlsx,.xls">
    <button class="btn block" onclick="runImport()">Import</button>
    <div id="im-result" class="muted" style="margin-top:8px"></div>`);
}
const COLMAP = {full_name:['name','full name','full_name','participant','participant name'],
  phone:['phone','mobile','number','contact','phone number','mobile number','whatsapp','whatsapp number'],
  email:['email','e-mail','mail','email address'], pincode:['pincode','pin','pin code','postal','zip'],
  area:['area','locality','sector/district','sector','district','mapped city'],
  street:['address','street','street2','street address'],
  city:['city','town','mapped city'],
  gender:['gender','sex'],
  occupation:['occupation','profession','job','work'],
  date_of_birth:['date of birth','dob','date_of_birth','birth date','birthdate'],
  program_name:['program','program name','course','activity','program_name'],
  program_date:['date','program date','completion date','initiation date','program_date','completed on','ie date','ie_date']};
function mapRow(raw){
  const out = {};
  const keys = Object.keys(raw);
  for(const [field, aliases] of Object.entries(COLMAP)){
    const k = keys.find(k => aliases.includes(k.toLowerCase().trim()));
    if(k && raw[k]!=null && raw[k]!=='') out[field] = String(raw[k]).trim();
  }
  const toISO = v => { if(!v) return null;
    let m = String(v).match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/); // DD/MM/YYYY
    if(m) return `${m[3]}-${m[2].padStart(2,'0')}-${m[1].padStart(2,'0')}`;
    const d = new Date(v); return isNaN(d) ? null : d.toISOString().slice(0,10); };
  if(out.program_date) out.program_date = toISO(out.program_date);
  if(out.date_of_birth) out.date_of_birth = toISO(out.date_of_birth);
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
  $('im-result').textContent = `Importing ${payload.length} rows...`;
  let tot = {inserted:0, merged:0, journeys:0};
  for(let i=0;i<payload.length;i+=200){
    const {data, error} = await sb.rpc('import_people', {rows:payload.slice(i,i+200)});
    if(error){ $('im-result').textContent = 'Error: '+error.message; return; }
    tot.inserted+=data.inserted; tot.merged+=data.merged; tot.journeys+=data.journeys;
  }
  $('im-result').textContent = `Done: ${tot.inserted} new, ${tot.merged} merged, ${tot.journeys} journeys created.`;
  toast('Import complete');
}

/* ============================================================
   VOLUNTEERS -- Module 2 + Event/Attendance
   ============================================================ */
const INTERESTS = ['Online Calling','Online Operations','Offline Programs','Sadhguru Sannidhi','E-Media','Promotions','Devi Seva','Event Setup','Cooking/Annadanam','Transport'];
let VFILTER = {center:'', interest:'', mode:'', timing:'', space:false};
let SHORTLIST = [];
let VOL_TAB = 'new';   // 'new' = new volunteer interest | 'all' = all existing volunteers
// "New interest" = only fresh submissions (added via form / photo OCR / CSV), marked status 'new'.
const isNewInterest = v => v.status==='new';

function icvRow(r){
  const ph = r.phone;
  const wa = ph ? `https://wa.me/91${ph}?text=${encodeURIComponent('Namaskaram '+((r.full_name||'').split(' ')[0])+' -- You had expressed interest to volunteer when you completed Inner Engineering. We would love to have you involved at Isha Electronic City. When is a good time to talk?')}` : null;
  const sel = isCoord() ? `<select style="width:auto;font-size:.75rem;padding:4px 6px" onchange="setIcvStatus('${r.id}',this.value)">${['new','contacted','active','done','dropped'].map(s=>`<option value="${s}" ${r.status===s?'selected':''}>${s}</option>`).join('')}</select>` : '';
  return `<div class="row">
    <div class="grow">
      <div class="name">${esc(r.full_name||'?')} <span class="badge ${r.status==='active'||r.status==='done'?'green':'gray'}">${esc(r.status||'new')}</span></div>
      <div class="sub">🪷 IE: ${fmtD(r.ie_date)}${r.program_name?' - '+esc(r.program_name):''} - ${centerName(r.center_id)}</div>
    </div>
    ${ph?`<a class="iconbtn call" href="tel:+91${ph}">Call</a>`:''}
    ${wa?`<a class="iconbtn wa" href="${wa}" target="_blank">WA</a>`:''}
    ${sel}
  </div>`;
}
async function setIcvStatus(id, status){ const {error}=await sb.from('ie_completion_volunteer').update({status}).eq('id', id); toast(error?error.message:'Updated'); }

async function renderVols(){
  view().innerHTML = '<div class="empty">Loading...</div>';
  const vps = await fetchAll(() => sb.from('volunteer_profiles')
    .select('*, people!inner(id, full_name, phone, pincode, center_id)')
    .order('updated_at', {ascending:false}));
  const hist = await fetchAll(() => sb.from('volunteer_history')
    .select('person_id, activity, happened_on').order('happened_on',{ascending:false}));
  const histBy = {};
  (hist||[]).forEach(r=>{ (histBy[r.person_id] ||= []).push(r); });

  // split into the two folders the team asked for
  const newCount = (vps||[]).filter(isNewInterest).length;
  const allCount = (vps||[]).length;

  const list = (vps||[]).filter(v=>{
    if(VOL_TAB==='new' && !isNewInterest(v)) return false;
    if(VFILTER.center && v.people.center_id!==VFILTER.center) return false;
    if(VFILTER.interest && !(v.interests||[]).includes(VFILTER.interest)) return false;
    if(VFILTER.mode && v.mode!==VFILTER.mode && v.mode!=='both') return false;
    if(VFILTER.timing && v.preferred_timing!==VFILTER.timing && v.preferred_timing!=='flexible') return false;
    if(VFILTER.space && !v.can_offer_space) return false;
    return true;
  });

  // Ashram/SSB volunteering follow-up journeys (moved here from Meditators)
  const ashram = await fetchAll(() => {
    let q = sb.from('journeys')
      .select('id, type, program_name, program_date, status, sadhana_status, assigned_to, center_id, people(id, full_name, phone, center_id), calls(id, call_no, due_date, completed_at)')
      .eq('type', 'volunteer_nurture').order('program_date', {ascending:false});
    if(ME.role==='volunteer') q = q.eq('assigned_to', ME.id);
    return q;
  });

  // fetch recent activities for event management
  const {data:acts} = await sb.from('activities').select('id, name, activity_type, activity_date, is_open, qr_token, center_id').order('activity_date',{ascending:false}).limit(10);

  // IE Completion volunteer-interest (from Ishangam ie.completion, volunteer=true). Guarded: table may not exist pre-migration.
  let icvCount = 0;
  const icvCntRes = await sb.from('ie_completion_volunteer').select('*', {count:'exact', head:true});
  if(!icvCntRes.error) icvCount = icvCntRes.count || 0;

  let h = `<div style="display:flex;gap:8px;margin:6px 0;flex-wrap:wrap">
    <button class="btn small ghost" onclick="openPaperOCR()">📄 Paper Form (OCR)</button>
    <button class="btn small ghost" onclick="openVolForm()">➕ Add interest</button>
    <button class="btn small ghost" onclick="openGFormHelp()">📝 Google Form</button>
    <button class="btn small green" onclick="openNewActivity()">🎉 Create Event</button>
    ${SHORTLIST.length?`<button class="btn small green" onclick="shareShortlist()">📤 Share shortlist (${SHORTLIST.length})</button>`:''}
  </div>`;

  // three folders: new volunteer interest | all existing volunteers | Ashram/SSB follow-up
  h += `<div class="tabs" style="flex-wrap:wrap;overflow:visible">
    <button class="${VOL_TAB==='new'?'active':''}" onclick="VOL_TAB='new';renderVols()">✨ New interest <span class="badge">${newCount}</span></button>
    <button class="${VOL_TAB==='all'?'active':''}" onclick="VOL_TAB='all';renderVols()">🙌 All volunteers <span class="badge">${allCount}</span></button>
    <button class="${VOL_TAB==='ashram'?'active':''}" onclick="VOL_TAB='ashram';renderVols()">🙏 Ashram/SSB <span class="badge">${ashram.length}</span></button>
    <button class="${VOL_TAB==='ie_completion'?'active':''}" onclick="VOL_TAB='ie_completion';renderVols()">🪷 IE Completion <span class="badge">${icvCount}</span></button>
  </div>`;

  // IE Completion volunteer-interest folder (sorted by IE date, newest first)
  if(VOL_TAB==='ie_completion'){
    let rows = await fetchAll(() => sb.from('ie_completion_volunteer').select('*').order('ie_date',{ascending:false,nullsFirst:false}));
    if(VFILTER.search){ const s=VFILTER.search.toLowerCase(); rows = rows.filter(r=>r.full_name?.toLowerCase().includes(s)||r.phone?.includes(s)); }
    h += `<div class="card" style="padding:10px">
      <input placeholder="Search name/phone" style="width:100%" value="${esc(VFILTER.search||'')}"
        oninput="VFILTER.search=this.value" onkeydown="if(event.key==='Enter')renderVols()">
    </div>`;
    h += `<div class="card"><h2>🪷 IE Completion — Volunteer Interest <span class="badge">${rows.length}</span></h2>
      <p class="muted" style="font-size:.78rem;margin-bottom:6px">People who ticked "Volunteer" on an IE completion form in Ishangam (Electronic City). Newest IE first.</p>`;
    h += rows.length ? rows.map(icvRow).join('') : '<div class="empty">No records yet — run the IE-completion sync.</div>';
    h += '</div>';
    view().innerHTML = h;
    return;
  }

  // Ashram/SSB folder: post Ashram/IYC/SSB volunteering follow-up calls
  if(VOL_TAB==='ashram'){
    let vols = [];
    if(isCoord()){ const {data:v} = await sb.from('profiles').select('id, full_name, email, role, center_id').eq('active', true); vols = v||[]; }
    let rows = ashram;
    if(VFILTER.center) rows = rows.filter(j=>(j.people?.center_id||j.center_id)===VFILTER.center);
    h += `<div class="card" style="padding:10px">
      <select style="width:auto" onchange="VFILTER.center=this.value;renderVols()">
        <option value="">All centers</option>${CENTERS.map(c=>`<option value="${c.id}" ${VFILTER.center===c.id?'selected':''}>${c.name}</option>`).join('')}</select>
    </div>`;
    h += `<div class="card"><h2>🙏 Ashram / SSB / IYC volunteers <span class="badge">${rows.length}</span></h2>
      <p class="muted" style="font-size:.78rem;margin-bottom:6px">Follow-up calls for people who volunteered at the Ashram, SSB, or IYC.</p>`;
    h += rows.length ? rows.map(j=>journeyRow(j, vols)).join('') : '<div class="empty">No Ashram/SSB volunteering follow-ups yet.</div>';
    h += '</div>';
    view().innerHTML = h;
    return;
  }

  // Recent events (compact)
  if(acts?.length){
    h += `<div class="card"><h2>📅 Recent Events</h2>`;
    h += acts.map(a=>`<div class="row"><div class="grow">
      <div class="name">${esc(a.name)} ${a.is_open?'<span class="badge green">open</span>':'<span class="badge gray">closed</span>'}
        ${a.activity_type&&a.activity_type!=='general'?`<span class="badge">${esc(a.activity_type)}</span>`:''}</div>
      <div class="sub">${centerName(a.center_id)} - ${fmtD(a.activity_date)}</div></div>
      <button class="btn small ghost" onclick="showQR('${a.qr_token}','${esc(a.name)}')">QR</button>
      <button class="btn small ghost" onclick="viewAttendees('${a.id}','${esc(a.name)}')">Attendees</button>
      <button class="btn small gray" onclick="toggleActivity('${a.id}',${!a.is_open})">${a.is_open?'Close':'Open'}</button>
    </div>`).join('');
    h += `</div>`;
  }

  h += `<div class="card"><h2>🔍 Filter & match volunteers</h2>
    <div class="choices" style="flex-wrap:wrap;gap:6px">
      <select style="width:auto" onchange="VFILTER.center=this.value;renderVols()">
        <option value="">All centers</option>${CENTERS.map(c=>`<option value="${c.id}" ${VFILTER.center===c.id?'selected':''}>${c.name}</option>`).join('')}</select>
      <select style="width:auto" onchange="VFILTER.interest=this.value;renderVols()">
        <option value="">Any activity</option>${INTERESTS.map(i=>`<option ${VFILTER.interest===i?'selected':''}>${i}</option>`).join('')}</select>
      <select style="width:auto" onchange="VFILTER.mode=this.value;renderVols()">
        <option value="">Online/Offline</option><option value="online" ${VFILTER.mode==='online'?'selected':''}>Online</option><option value="offline" ${VFILTER.mode==='offline'?'selected':''}>Offline</option></select>
      <select style="width:auto" onchange="VFILTER.timing=this.value;renderVols()">
        <option value="">Any timing</option><option value="weekday_morning">Weekday AM</option>
        <option value="weekday_evening">Weekday PM</option><option value="weekend">Weekends</option></select>
      <button class="${VFILTER.space?'sel':''}" onclick="VFILTER.space=!VFILTER.space;renderVols()">Can offer space</button>
    </div></div>
  <div class="card"><h2>${VOL_TAB==='new'?'New volunteer interest':'All existing volunteers'} <span class="badge">${list.length}</span></h2>`;
  h += list.length ? list.map(v=>volRow(v, histBy[v.person_id]||[])).join('') : '<div class="empty">No matches.</div>';
  h += '</div>';
  view().innerHTML = h;
}

async function viewAttendees(actId, actName){
  const {data:att} = await sb.from('attendance')
    .select('id, time_in, time_out, pincode, photo_url, activity_detail, people(full_name, phone, center_id)')
    .eq('activity_id', actId).order('time_in');
  const rows = att||[];
  modal(`<h3>${esc(actName)} -- Attendees (${rows.length})</h3>
    ${rows.length ? `<div style="overflow-y:auto;max-height:60vh">` +
    rows.map(a=>{
      const p = a.people;
      return `<div class="row" style="align-items:flex-start;gap:10px;padding:8px 0;border-bottom:1px solid var(--border)">
        ${a.photo_url?`<img src="${esc(a.photo_url)}" style="width:48px;height:48px;border-radius:50%;object-fit:cover;flex-shrink:0" onerror="this.style.display='none'">`
          :`<div style="width:48px;height:48px;border-radius:50%;background:var(--card-bg);display:flex;align-items:center;justify-content:center;font-size:.85rem;flex-shrink:0;color:var(--muted)">--</div>`}
        <div style="flex:1;min-width:0">
          <div class="name">${esc(p?.full_name||'?')}</div>
          <div class="sub">${p?.phone||''} ${a.activity_detail?'- '+esc(a.activity_detail):''}</div>
          <div class="sub">In: ${fmtD(a.time_in)} ${a.time_out?'- Out: '+fmtD(a.time_out):''} ${a.pincode?'- '+a.pincode:''}</div>
        </div>
      </div>`;
    }).join('') + `</div>`
    : '<div class="empty">No attendees yet -- share the QR code.</div>'}`);
}

function volRow(v, hist){
  const p = v.people;
  const wa = p.phone ? `https://wa.me/91${p.phone}?text=${encodeURIComponent(`Namaskaram ${p.full_name.split(' ')[0]} -- There's a volunteering opportunity at Isha ${centerName(p.center_id)} that matches your interest${v.interests?.length?' in '+v.interests[0]:''}. Would you like to join?`)}` : null;
  const inSL = SHORTLIST.some(s=>s.id===p.id);
  return `<div class="row">
    <div class="grow" onclick='showVolHistory(${JSON.stringify({n:p.full_name,h:hist.slice(0,15)}).replace(/'/g,"&#39;")})'>
      <div class="name">${esc(p.full_name)} ${v.screened?'<span class="badge green">screened</span>':'<span class="badge gray">new</span>'}</div>
      <div class="sub">${centerName(p.center_id)} - ${(v.interests||[]).join(', ')||'no interests yet'}
        ${v.mode?' - '+v.mode:''}${v.can_offer_space?' | space avail.':''} - ${hist.length} activit${hist.length===1?'y':'ies'}</div>
    </div>
    ${p.phone?`<a class="iconbtn call" href="tel:+91${p.phone}">Call</a>`:''}
    ${wa?`<a class="iconbtn wa" href="${wa}" target="_blank">WA</a>`:''}
    <button class="btn small ${inSL?'green':'gray'}" onclick='toggleShortlist(${JSON.stringify({id:p.id,name:p.full_name,phone:p.phone}).replace(/'/g,"&#39;")})'>${inSL?'Added':'+'}</button>
  </div>`;
}
function showVolHistory(d){
  modal(`<h3>${esc(d.n)} -- history</h3>` + (d.h.length
    ? `<table class="mini"><tr><th>Activity</th><th>Date</th></tr>${d.h.map(r=>`<tr><td>${esc(r.activity)}</td><td>${fmtD(r.happened_on)}</td></tr>`).join('')}</table>`
    : '<p class="muted">No volunteering history yet.</p>'));
}
function toggleShortlist(p){
  const i = SHORTLIST.findIndex(s=>s.id===p.id);
  i>=0 ? SHORTLIST.splice(i,1) : SHORTLIST.push(p);
  renderVols();
}
function shareShortlist(){
  const txt = 'Volunteer shortlist (' + SHORTLIST.length + '):\n' + SHORTLIST.map(s=>'- ' + s.name + ' -- ' + (s.phone||'no phone')).join('\n');
  modal('<h3>Share shortlist</h3><textarea style="min-height:140px">' + esc(txt) + '</textarea>' +
    '<a class="btn block" style="text-align:center;text-decoration:none;display:block" href="https://wa.me/?text=' + encodeURIComponent(txt) + '" target="_blank">Share via WhatsApp</a>' +
    '<button class="btn ghost block" onclick="navigator.clipboard.writeText(' + JSON.stringify(txt) + ');toast(\'Copied\')">Copy text</button>');
}

/* ---- volunteer interest form (INTERESTS declared once near top) ---- */
function volFormHTML(pre){
  pre = pre || {};
  return '<label>Name</label><input id="vf-name" value="' + esc(pre.name||'') + '">' +
    '<label>Phone</label><input id="vf-phone" inputmode="numeric" value="' + esc(pre.phone||'') + '">' +
    '<label>Pincode</label><input id="vf-pin" inputmode="numeric">' +
    '<label>Activities interested in</label>' +
    '<div class="choices" id="vf-int">' + INTERESTS.map(i=>'<button onclick="this.classList.toggle(\'sel\')">' + i + '</button>').join('') + '</div>' +
    '<label>Preferred timing</label>' +
    '<select id="vf-timing"><option value="flexible">Flexible</option><option value="weekday_morning">Weekday mornings</option>' +
    '<option value="weekday_evening">Weekday evenings</option><option value="weekend">Weekends</option></select>' +
    '<label>Mode</label>' +
    '<select id="vf-mode"><option value="both">Online + Offline</option><option value="online">Online only</option><option value="offline">Offline only</option></select>' +
    '<label>Programs done</label><input id="vf-progs" placeholder="e.g. IE Online 2025, BSP">' +
    '<label>Languages</label><input id="vf-lang" placeholder="e.g. Kannada, Tamil, English">' +
    '<div class="choices" style="margin-top:10px"><button id="vf-space" onclick="this.classList.toggle(\'sel\')">Can offer space</button></div>' +
    '<label>Notes</label><textarea id="vf-notes"></textarea>' +
    '<button class="btn block" onclick="saveVolForm()">Save</button>';
}
function openVolForm(pre){ modal('<h3>Volunteer interest</h3>' + volFormHTML(pre||{})); }
async function saveVolForm(){
  const interests = [...document.querySelectorAll('#vf-int button.sel')].map(b=>b.textContent);
  const row = {full_name:$('vf-name').value, phone:$('vf-phone').value, pincode:$('vf-pin').value,
    kind:'volunteer', interests, preferred_timing:$('vf-timing').value, mode:$('vf-mode').value,
    can_offer_space:$('vf-space').classList.contains('sel'), source:'paper'};
  if(!row.full_name && !row.phone) return toast('Name or phone required');
  const {error} = await sb.rpc('import_people', {rows:[row]});
  if(error) return toast(error.message);
  const ph = row.phone.replace(/\D/g,'').slice(-10);
  const {data:p} = await sb.from('people').select('id').eq('phone', ph).single();
  if(p) await sb.from('volunteer_profiles').update({
    programs_done:$('vf-progs').value||null, languages:$('vf-lang').value||null,
    screening_notes:$('vf-notes').value||null, status:'new'}).eq('person_id', p.id);
  closeModal(); toast('Saved!'); renderVols();
}

async function openPaperOCR(){
  modal('<h3>Paper Form -- OCR</h3>' +
    '<p class="muted">Take a photo of the filled form. Name and phone are auto-extracted -- check and correct, then save.</p>' +
    '<input id="ocr-file" type="file" accept="image/*" capture="environment">' +
    '<div id="ocr-status" class="muted" style="margin:8px 0"></div>' +
    '<div id="ocr-form"></div>');
  $('ocr-file').onchange = runOCR;
}
async function runOCR(){
  const f = $('ocr-file').files[0]; if(!f) return;
  $('ocr-status').textContent = 'Loading OCR engine...';
  if(!window.Tesseract){
    await new Promise((res,rej)=>{ const s=document.createElement('script');
      s.src='https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js'; s.onload=res; s.onerror=rej;
      document.head.appendChild(s); });
  }
  $('ocr-status').textContent = 'Reading the photo... (10-20s)';
  try{
    const {data:{text}} = await Tesseract.recognize(f, 'eng');
    const phone = (text.match(/(?:\+?91[\s-]?)?([6-9]\d{4}[\s-]?\d{5})/)||[])[1]?.replace(/\D/g,'') || '';
    let name = '';
    const nm = text.match(/name\s*[:\-]?\s*([A-Za-z .]{3,40})/i);
    if(nm) name = nm[1].trim();
    else { const line = text.split('\n').map(l=>l.trim()).find(l=>/^[A-Za-z .]{3,40}$/.test(l)); if(line) name=line; }
    $('ocr-status').textContent = 'Extracted -- please verify';
    $('ocr-form').innerHTML = volFormHTML({name, phone});
  }catch(e){ $('ocr-status').textContent = 'OCR failed -- fill manually:'; $('ocr-form').innerHTML = volFormHTML({}); }
}
function openGFormHelp(){
  modal('<h3>Google Form intake</h3>' +
    '<p><b>Manual (30s):</b> Open the form\'s response Sheet -- File -- Download -- CSV -- Import CSV above.</p>' +
    '<p><b>Automatic:</b> Add the Apps Script in <code>/scripts/gform-sync.gs</code> to your Sheet, paste your Supabase URL+key, set a trigger on form submit.</p>');
}

/* ============================================================
   INSIGHTS
   ============================================================ */
async function renderInsights(){
  view().innerHTML = '<div class="empty">Loading...</div>';
  // Exclude 'dropped' journeys (e.g. cleared stale backlog) from all insights.
  const [J, C, V] = await Promise.all([
    fetchAll(()=> sb.from('journeys').select('id, type, status, sadhana_status, center_id, assigned_to').neq('status','dropped')),
    fetchAll(()=> sb.from('calls').select('id, due_date, completed_at, reachability, journey_id, journeys!inner(status)').neq('journeys.status','dropped')),
    fetchAll(()=> sb.from('volunteer_history').select('id, person_id, activity, center_id, happened_on'))
  ]);
  const open = C.filter(c=>!c.completed_at), done = C.filter(c=>c.completed_at);
  const overdue = open.filter(c=>c.due_date < today());
  const answered = done.filter(c=>c.reachability==='answered');
  const dist = {};
  J.filter(j=>j.sadhana_status).forEach(j=>dist[j.sadhana_status]=(dist[j.sadhana_status]||0)+1);
  const rules = SETTINGS.suggestion_rules||[];
  const statusKey = s => { s=(s||'').toLowerCase();
    return s.includes('stopped')?'stopped':s.includes('irregular')?'irregular'
      :s.includes('needs support')?'needs_support':s.includes('correction')?'needs_correction'
      :s.includes('ashram')?'wants_ashram':s.includes('sannidhi')?'wants_sannidhi'
      :s.includes('advanced')||s.includes('another program')?'wants_advanced':null; };
  const clusters = {};
  J.forEach(j=>{ const k=statusKey(j.sadhana_status); if(k) ((clusters[j.center_id] ||= {})[k] = (clusters[j.center_id][k]||0)+1); });
  const suggestions = [];
  for(const [cid, ks] of Object.entries(clusters))
    for(const r of rules)
      if((ks[r.when_status]||0) >= r.min_count)
        suggestions.push('<b>' + centerName(cid) + '</b>: ' + ks[r.when_status] + ' people "' + r.when_status.replace(/_/g,' ') + '" -- ' + esc(r.suggest));
  const m1 = J.filter(j=>j.type==='new_meditator');
  const m1done = m1.filter(j=>j.status==='completed').length;

  let h = '<div class="stats">' +
    '<div class="stat"><div class="n">' + m1.length + '</div><div class="l">🌱 New meditators</div></div>' +
    '<div class="stat"><div class="n">' + m1done + '</div><div class="l">✅ Mandala journeys done</div></div>' +
    '<div class="stat"><div class="n">' + overdue.length + '</div><div class="l">⏰ Overdue calls</div></div>' +
    '<div class="stat"><div class="n">' + (done.length?Math.round(answered.length/done.length*100):0) + '%</div><div class="l">📈 Answer rate</div></div>' +
    '<div class="stat"><div class="n">' + J.filter(j=>j.type==='advanced').length + '</div><div class="l">⭐ Advanced completers</div></div>' +
    '<div class="stat"><div class="n">' + V.length + '</div><div class="l">🙌 Volunteering records</div></div>' +
    '</div>';
  if(suggestions.length)
    h += '<div class="card"><h2>💡 Planning Suggestions</h2>' + suggestions.map(s=>'<div class="row"><div class="grow">' + s + '</div></div>').join('') + '</div>';
  h += '<div class="card"><h2>🧘 Sadhana status distribution</h2><canvas id="ch-dist" height="220"></canvas></div>';
  if(isCoord()) h += '<div class="card"><h2>📊 Call completion by center</h2><canvas id="ch-center" height="200"></canvas></div>';
  h += '<div class="card"><h2>📋 Per-status counts</h2><table class="mini"><tr><th>Status</th><th>People</th></tr>' +
    (Object.entries(dist).sort((a,b)=>b[1]-a[1]).map(([s,n])=>'<tr><td>' + esc(s) + '</td><td>' + n + '</td></tr>').join('')||'<tr><td colspan=2 class="muted">No logged statuses yet</td></tr>') +
    '</table></div>';
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
    new Chart($('ch-center'), {type:'bar',
      data:{labels:Object.keys(byC).map(centerName), datasets:[
        {label:'Completed', data:Object.values(byC).map(b=>b.done), backgroundColor:'#3d8a5f'},
        {label:'Open', data:Object.values(byC).map(b=>b.open), backgroundColor:'#e0d6c8'}]},
      options:{scales:{x:{stacked:true},y:{stacked:true}},plugins:{legend:{position:'bottom'}}}});
  }
}

/* ============================================================
   ADMIN
   ============================================================ */
async function renderAdmin(){
  if(!isCoord()){ view().innerHTML='<div class="empty">Coordinators only.</div>'; return; }
  view().innerHTML = '<div class="empty">Loading...</div>';
  const [{data:profs},{data:acts}] = await Promise.all([
    sb.from('profiles').select('*').order('created_at'),
    sb.from('activities').select('*').order('activity_date',{ascending:false}).limit(30)]);

  let h = '';
  h += '<div class="card"><h2>🎉 Activities & Attendance QR</h2>' +
    '<button class="btn small ghost" onclick="openNewActivity()">➕ New activity</button>';
  h += (acts||[]).map(a=>'<div class="row"><div class="grow">' +
      '<div class="name">' + esc(a.name) + ' ' + (a.is_open?'<span class="badge green">open</span>':'<span class="badge gray">closed</span>') + '</div>' +
      '<div class="sub">' + centerName(a.center_id) + ' - ' + fmtD(a.activity_date) + (a.activity_type&&a.activity_type!=='general'?' - '+esc(a.activity_type):'') + '</div></div>' +
    '<button class="btn small ghost" onclick="showQR(\'' + a.qr_token + '\',\'' + esc(a.name) + '\')">QR</button>' +
    '<button class="btn small ghost" onclick="viewAttendees(\'' + a.id + '\',\'' + esc(a.name) + '\')">Attendees</button>' +
    '<button class="btn small gray" onclick="toggleActivity(\'' + a.id + '\',' + (!a.is_open) + ')">' + (a.is_open?'Close':'Reopen') + '</button>' +
    '</div>').join('') || '<div class="empty">No activities yet.</div>';
  h += '</div>';

  h += '<div class="card"><h2>👥 Users & Roles</h2>';
  h += (profs||[]).map(p=>'<div class="row"><div class="grow">' +
      '<div class="name">' + esc(p.full_name||p.email) + '</div>' +
      '<div class="sub">' + esc(p.email||'') + ' - ' + roleLabel(p.role) + ' - ' + centerName(p.center_id) + '</div></div>' +
    (ME.role==='rco'?
      '<select style="width:auto;font-size:.78rem;padding:6px" onchange="setRole(\'' + p.id + '\',\'role\',this.value)">' +
        ['volunteer','coordinator','rco'].map(r=>'<option value="' + r + '" ' + (p.role===r?'selected':'') + '>' + roleLabel(r) + '</option>').join('') + '</select>' +
      '<select style="width:auto;font-size:.78rem;padding:6px" onchange="setRole(\'' + p.id + '\',\'center_id\',this.value)">' +
        CENTERS.concat([{id:'unassigned',name:'Unassigned'}]).map(c=>'<option value="' + c.id + '" ' + (p.center_id===c.id?'selected':'') + '>' + c.name + '</option>').join('') + '</select>'
      :'') +
    (p.phone?'<a class="iconbtn wa" href="https://wa.me/91' + p.phone + '?text=' + encodeURIComponent('Namaskaram - Gentle reminder: you have nurturing calls due on the dashboard. Please take a look when you can!') + '" target="_blank">WA</a>':'') +
    '</div>').join('');
  h += '</div>';

  if(ME.role==='rco'){
    const pm = SETTINGS.pincode_map||{};
    h += '<div class="card"><h2>📍 Pincode -- Center Map</h2>' +
      '<table class="mini"><tr><th>Pincode</th><th>Center</th><th></th></tr>' +
      Object.entries(pm).map(([pin,cid])=>'<tr><td>' + pin + '</td><td>' + centerName(cid) + '</td>' +
        '<td><button class="btn small gray" onclick="delPin(\'' + pin + '\')">Remove</button></td></tr>').join('') + '</table>' +
      '<div style="display:flex;gap:8px;margin-top:8px">' +
        '<input id="pin-new" placeholder="560xxx" inputmode="numeric" style="flex:1">' +
        '<select id="pin-center" style="flex:1">' + CENTERS.map(c=>'<option value="' + c.id + '">' + c.name + '</option>').join('') + '</select>' +
        '<button class="btn small" onclick="addPin()">Add</button></div></div>';
    const rc = SETTINGS.reminder_config||{};
    h += '<div class="card"><h2>🔔 Reminder Settings</h2>' +
      '<label>Daily reminder email hour (IST, 0-23)</label>' +
      '<input id="rc-hour" type="number" min="0" max="23" value="' + (rc.email_hour_ist??8) + '">' +
      '<label>Overdue after (days past due)</label>' +
      '<input id="rc-od" type="number" min="0" value="' + (rc.overdue_after_days??0) + '">' +
      '<button class="btn block" onclick="saveReminderCfg()">Save</button></div>';
  }
  view().innerHTML = h;
}

async function setRole(id, field, val){
  const {error} = await sb.from('profiles').update({[field]:val}).eq('id', id);
  toast(error?error.message:'Updated');
}
async function addPin(){
  const pin = $('pin-new').value.trim(); if(!/^\d{6}$/.test(pin)) return toast('Enter a 6-digit pincode');
  const pm = {...(SETTINGS.pincode_map||{}), [pin]:$('pin-center').value};
  const {error} = await sb.from('settings').update({value:pm}).eq('key','pincode_map');
  if(error) return toast(error.message);
  SETTINGS.pincode_map = pm; renderAdmin(); toast('Added');
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
  SETTINGS.reminder_config = v; toast('Saved');
}

/* ---- Events / QR ---- */
const ACTIVITY_TYPES = ['general','satsang','program_support','calling_seva','annadanam','event_setup','ashram_visit','other'];
function openNewActivity(){
  modal('<h3>Create Activity</h3>' +
    '<label>Activity name</label><input id="na-name" placeholder="e.g. Monthly Satsang -- June 2026">' +
    '<label>Activity type</label>' +
    '<select id="na-type">' + ACTIVITY_TYPES.map(t=>'<option value="' + t + '">' + t.replace(/_/g,' ') + '</option>').join('') + '</select>' +
    '<label>Center</label>' +
    '<select id="na-center">' + CENTERS.map(c=>'<option value="' + c.id + '">' + c.name + '</option>').join('') + '</select>' +
    '<label>Date</label><input id="na-date" type="date" value="' + today() + '">' +
    '<label>Description (optional)</label><textarea id="na-desc" placeholder="Brief description for volunteers..." style="height:60px"></textarea>' +
    '<button class="btn block" onclick="saveActivity()">Create & show QR</button>');
}
async function saveActivity(){
  const name = $('na-name').value||'Activity';
  const {data, error} = await sb.from('activities').insert({
    name, center_id:$('na-center').value,
    activity_type:$('na-type').value||'general',
    activity_date:$('na-date').value,
    description:$('na-desc').value||null,
    created_by:ME.id}).select().single();
  if(error) return toast(error.message);
  closeModal();
  showQR(data.qr_token, name);
}
async function toggleActivity(id, open){
  await sb.from('activities').update({is_open:open}).eq('id',id);
  if(document.querySelector('#nav button.active')?.dataset.v === 'vols') renderVols();
  else renderAdmin();
}
function showQR(token, name){
  const base = location.href.replace(/[^/]*$/,'');
  const url = base + 'checkin.html?t=' + token;
  modal('<h3>' + esc(name) + '</h3>' +
    '<p class="muted">Share this QR or link with volunteers. They can mark attendance, choose their seva, and upload a selfie.</p>' +
    '<div id="qr-box" style="display:flex;justify-content:center;padding:12px"></div>' +
    '<p class="muted" style="word-break:break-all;text-align:center;font-size:.78rem">' + esc(url) + '</p>' +
    '<div style="display:flex;gap:8px;justify-content:center;margin-top:8px">' +
      '<button class="btn ghost" onclick="navigator.clipboard.writeText(\'' + esc(url) + '\');toast(\'Link copied!\')">Copy link</button>' +
      '<a class="btn ghost" href="https://wa.me/?text=' + encodeURIComponent('Join us! Mark your attendance here: ' + url) + '" target="_blank">Share via WhatsApp</a>' +
    '</div>');
  new QRCode($('qr-box'), {text:url, width:200, height:200});
}

/* ---------------- start ---------------- */
boot();
