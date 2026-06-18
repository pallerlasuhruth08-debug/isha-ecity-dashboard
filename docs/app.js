/* ============================================================
   Isha E-City Nurturing Dashboard -- app logic (vanilla JS)
   ============================================================ */
const sb = supabase.createClient(APP_CONFIG.SUPABASE_URL, APP_CONFIG.SUPABASE_ANON_KEY);
// Any write invalidates the session read-cache so the next view pulls fresh data.
(function wrapWrites(){
  const _from = sb.from.bind(sb);
  sb.from = (t)=>{ const qb=_from(t);
    ['insert','update','upsert','delete'].forEach(m=>{ const o=qb[m];
      if(typeof o==='function') qb[m]=(...a)=>{ try{cacheBust();}catch(e){} return o.apply(qb,a); }; });
    return qb; };
  const _rpc = sb.rpc.bind(sb);
  sb.rpc = (...a)=>{ try{cacheBust();}catch(e){} return _rpc(...a); };
})();
let ME = null;
let SETTINGS = {};
let CENTERS = [];        // real centers only (for data filters)
let CENTERS_ALL = [];    // includes 'all' and 'unassigned' (for naming/assignment)
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
  // Page 1 tells us whether there's more; remaining pages are fetched in
  // parallel waves so a 6,000-row table is ~2 round-trips instead of 6+.
  const first = await makeQuery().range(0, pageSize-1);
  if(first.error){ toast(first.error.message); return []; }
  let all = first.data || [];
  if(all.length < pageSize) return all;
  let page = 1;
  const WAVE = 6;
  for(;;){
    const reqs = [];
    for(let k=0;k<WAVE;k++){ const from=(page+k)*pageSize; reqs.push(makeQuery().range(from, from+pageSize-1)); }
    const res = await Promise.all(reqs);
    let lastFull = false;
    for(const r of res){ if(r.error) continue; const d=r.data||[]; all=all.concat(d); }
    lastFull = (res[res.length-1].data||[]).length === pageSize;
    page += WAVE;
    if(!lastFull) break;
  }
  return all;
}

/* Lazy-load a CDN script once (keeps initial page load light). */
const _scripts = {};
function loadScript(src){
  if(_scripts[src]) return _scripts[src];
  _scripts[src] = new Promise((res,rej)=>{ const s=document.createElement('script');
    s.src=src; s.onload=res; s.onerror=()=>rej(new Error('load failed '+src)); document.head.appendChild(s); });
  return _scripts[src];
}
const CDN = {
  chart:'https://cdn.jsdelivr.net/npm/chart.js@4.4.1/dist/chart.umd.min.js',
  xlsx:'https://cdn.jsdelivr.net/npm/xlsx@0.18.5/dist/xlsx.full.min.js',
  papa:'https://cdn.jsdelivr.net/npm/papaparse@5.4.1/papaparse.min.js',
  qrcode:'https://cdn.jsdelivr.net/npm/qrcodejs@1.0.0/qrcode.min.js',
  autoanimate:'https://cdn.jsdelivr.net/npm/@formkit/auto-animate@0.8.2/index.global.js',
  lottie:'https://cdn.jsdelivr.net/npm/lottie-web@5.12.2/build/player/lottie_light.min.js'
};
// Play a Lottie animation (docs/lottie/<name>.json) into a container. Returns false if the file
// isn't present yet — callers keep their SVG/CSS fallback, so dropping files in "just works".
let LOTTIE = null;
async function playLottie(container, path, opts){
  opts = opts||{}; if(!container) return false;
  try{
    const res = await fetch(path, {cache:'force-cache'}); if(!res.ok) return false;
    const data = await res.json();
    if(!LOTTIE){ await loadScript(CDN.lottie).catch(()=>{}); LOTTIE = window.lottie||null; }
    if(!LOTTIE) return false;
    container.innerHTML='';
    LOTTIE.loadAnimation({container, renderer:'svg', loop:opts.loop!==false, autoplay:true, animationData:data});
    return true;
  }catch(e){ return false; }
}
// shimmer skeleton placeholder shown while a view loads
function skel(rows){ rows=rows||5;
  let r=''; for(let i=0;i<rows;i++) r+='<div class="sk-row"><div class="sk-av"></div><div class="sk-lines"><div class="sk-line"></div><div class="sk-line short"></div></div></div>';
  return (typeof LOTUS_LOADER!=='undefined'?LOTUS_LOADER:'') + `<div class="card sk-card">${r}</div>`;
}
// fluid list animation: AutoAnimate if it loaded, otherwise a GPU CSS stagger (always smooth)
let AA = null;   // auto-animate fn once loaded
function animateList(host){
  if(!host) return;
  if(AA && !host.dataset.aa){ try{ AA(host,{duration:180,easing:'cubic-bezier(.2,.8,.2,1)'}); host.dataset.aa='1'; return; }catch(e){} }
  if(!AA){ host.classList.add('staggered'); }
}

/* Session cache: load each dataset once, reuse on tab switches. cacheBust()
   clears it (the Refresh button) so the next view pulls fresh data. */
let CACHE = {};
async function cached(key, loader){
  if(CACHE[key] !== undefined) return CACHE[key];
  CACHE[key] = await loader();
  return CACHE[key];
}
function cacheBust(){ CACHE = {}; }

/* Windowed list rendering: paint a small first batch instantly, then append
   more as the user scrolls near the end. Keeps the DOM light even for 6,000+
   rows so the first open is fast. items=array, rowFn(item)->html string. */
function mountList(host, items, rowFn, batch=80){
  if(window.__listScroll){ window.removeEventListener('scroll', window.__listScroll); window.__listScroll=null; }
  let n = 0;
  function chunk(){
    if(n >= items.length) return;
    const t = document.createElement('template');
    t.innerHTML = items.slice(n, n+batch).map(rowFn).join('');
    host.appendChild(t.content);
    n += batch;
  }
  function onScroll(){
    if(n >= items.length){ window.removeEventListener('scroll', onScroll); window.__listScroll=null; return; }
    if(window.innerHeight + window.scrollY >= document.body.offsetHeight - 1200) chunk();
  }
  window.__listScroll = onScroll;
  window.addEventListener('scroll', onScroll, {passive:true});
  chunk(); // first batch paints immediately
  // ensure the page is tall enough to scroll (so more can load), without rendering everything
  let guard = 0;
  while(n < items.length && document.body.offsetHeight <= window.innerHeight + 1200 && guard++ < 80) chunk();
}
async function refreshNow(){ const a=document.querySelector('.avatar'); if(a) a.open=false; const y=window.scrollY; cacheBust(); toast('Refreshing...'); await go(CURRENT_VIEW||'today'); window.scrollTo(0,y); toast('Up to date'); }
// shrink the header once the user scrolls a little
window.addEventListener('scroll', ()=>{ const hb=document.getElementById('topbar'); if(hb) hb.classList.toggle('slim', window.scrollY>40); }, {passive:true});

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
  // Pending approval: new sign-ups are inactive until a Central Coordinator approves.
  if(!ME || ME.active === false){
    $('login-view').classList.add('hidden');
    $('app').classList.add('hidden'); $('nav').classList.add('hidden');
    let pv = document.getElementById('pending-view');
    if(!pv){ pv = document.createElement('div'); pv.id='pending-view'; pv.className='login-wrap'; document.body.appendChild(pv); }
    pv.classList.remove('hidden');
    pv.innerHTML = `<h1>🪷 Isha E-City</h1>
      <div class="card" style="text-align:center">
        <div style="font-size:2.4rem;margin-bottom:6px">⏳</div>
        <h2 style="margin-bottom:8px">Awaiting approval</h2>
        <p class="muted">Namaskaram ${esc((ME&&(ME.full_name||ME.email))||'')} 🙏<br><br>
        Your account has been created and is waiting for a coordinator to approve access and assign your people. You'll be able to sign in normally once that's done.</p>
        <button class="btn ghost block" style="margin-top:14px" onclick="doLogout()">Sign out</button>
      </div>`;
    return;
  }
  const [{data:set},{data:cen}] = await Promise.all([
    sb.from('settings').select('*'), sb.from('centers').select('*')]);
  (set||[]).forEach(r=>SETTINGS[r.key]=r.value);
  CENTERS_ALL = cen||[];
  CENTERS = (cen||[]).filter(c=>c.id!=='unassigned' && c.id!=='all');
  $('login-view').classList.add('hidden');
  const pv=document.getElementById('pending-view'); if(pv) pv.classList.add('hidden');
  $('app').classList.remove('hidden'); $('nav').classList.remove('hidden');
  $('who-name').textContent = ME.full_name || ME.email;
  const scopeLabel = (ME.role==='admin'||ME.role==='sector_nurturer'||ME.center_id==='all') ? 'All Centers' : centerName(ME.center_id);
  $('who-role').textContent = roleLabel(ME.role) + ' - ' + scopeLabel;
  // Non-coordinators ("others") get a Profile tab in place of Admin; coordinators keep Admin
  // and reach their profile from the avatar menu.
  const adminBtn = document.querySelector('#nav [data-v="admin"]');
  if(!isCoord()){
    const volBtn = document.querySelector('#nav [data-v="vols"]'); if(volBtn) volBtn.style.display='none';
    if(adminBtn){ adminBtn.dataset.v='profile'; adminBtn.setAttribute('onclick',"go('profile')");
      adminBtn.innerHTML='<span class="ico">🙏</span><span>Profile</span>'; }
  }
  $('quotebar').classList.remove('hidden');
  $('quotebar').innerHTML = `<span class="qlotus">${LOTUS_MINI}</span><span class="qtext">“${esc(VOL_QUOTE)}”</span><span class="qexp">tap ›</span>`;
  // load AutoAnimate (fluid list add/remove); harmless if it fails — lists fall back to a CSS stagger
  loadScript(CDN.autoanimate).then(()=>{ AA = window.autoAnimate || (window.formkit&&window.formkit.autoAnimate) || null; }).catch(()=>{});
  loadScript(CDN.lottie).then(()=>{ LOTTIE = window.lottie||null; }).catch(()=>{});
  go('profile');           // land on Profile after the opening quote
  showQuote(true);         // opening Sadhguru photo + volunteering quote
}
/* ============================================================
   Sadhguru volunteering quote — splash + expandable banner
   (drop the photo into docs/sadhguru-quote.jpg to show it; a styled
    text version is shown if the image isn't present)
   ============================================================ */
const VOL_QUOTE = 'How deep you touch another life is how rich your life is.';
const VOL_QUOTE_BY = '— Sadhguru';
const SPLASH_IMG = 'sadhguru-quote.jpg';
// animated lotus (pure SVG + CSS — blooms then gently glows; no external/Lottie dependency)
const LOTUS_SVG = `<svg class="lotus-svg" viewBox="0 0 100 64" width="88" height="56" aria-hidden="true"><g>
  <ellipse cx="50" cy="44" rx="7" ry="22" fill="#f3e6cf"/>
  <ellipse cx="50" cy="44" rx="7" ry="22" fill="#efddbf" transform="rotate(34 50 44)"/>
  <ellipse cx="50" cy="44" rx="7" ry="22" fill="#efddbf" transform="rotate(-34 50 44)"/>
  <ellipse cx="50" cy="44" rx="6.5" ry="18" fill="#e7cfa6" transform="rotate(66 50 44)"/>
  <ellipse cx="50" cy="44" rx="6.5" ry="18" fill="#e7cfa6" transform="rotate(-66 50 44)"/>
  <ellipse cx="50" cy="44" rx="6" ry="13" fill="#dcbf90" transform="rotate(96 50 44)"/>
  <ellipse cx="50" cy="44" rx="6" ry="13" fill="#dcbf90" transform="rotate(-96 50 44)"/>
</g></svg>`;
// small lotus for the top quote banner — blooms once + gentle glow
const LOTUS_MINI = `<svg class="lotus-svg lotus-mini" viewBox="0 0 100 64" width="30" height="20" aria-hidden="true"><g>
  <ellipse cx="50" cy="44" rx="7" ry="22" fill="#f6ead4"/>
  <ellipse cx="50" cy="44" rx="7" ry="22" fill="#efddbf" transform="rotate(34 50 44)"/>
  <ellipse cx="50" cy="44" rx="7" ry="22" fill="#efddbf" transform="rotate(-34 50 44)"/>
  <ellipse cx="50" cy="44" rx="6.5" ry="17" fill="#e7cfa6" transform="rotate(66 50 44)"/>
  <ellipse cx="50" cy="44" rx="6.5" ry="17" fill="#e7cfa6" transform="rotate(-66 50 44)"/>
</g></svg>`;
let QUOTE_T = null;
function quoteOverlayHTML(splash){
  return `<div class="quote-card">
    <div class="quote-lottie"></div>
    <div class="lotus">${LOTUS_SVG}</div>
    <img src="${SPLASH_IMG}" alt="Sadhguru on volunteering" class="quote-img"
      onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
    <div class="quote-fallback" style="display:none">
      <blockquote>“${esc(VOL_QUOTE)}”</blockquote>
      <div class="qby">${esc(VOL_QUOTE_BY)}</div>
    </div>
    <div class="quote-hint">${splash?'tap to enter ›':'tap anywhere to close'}</div>
  </div>`;
}
function showQuote(splash){
  let ov=document.getElementById('quoteov');
  if(!ov){ ov=document.createElement('div'); ov.id='quoteov'; document.body.appendChild(ov); }
  // if docs/lottie/splash.json is present, play it above the photo (else the photo/lotus stays)
  setTimeout(()=>playLottie(ov.querySelector('.quote-lottie'),'lottie/splash.json'),30);
  ov.className='quoteov'; ov.innerHTML=quoteOverlayHTML(splash);
  ov.onclick=()=>dismissQuote();
  requestAnimationFrame(()=>ov.classList.add('show'));
  clearTimeout(QUOTE_T);
  if(splash) QUOTE_T=setTimeout(dismissQuote, 4500);   // auto-enter after a few seconds
}
function dismissQuote(){
  clearTimeout(QUOTE_T);
  const ov=document.getElementById('quoteov'); if(!ov) return;
  ov.classList.remove('show');
  setTimeout(()=>{ if(ov&&ov.parentNode) ov.remove(); }, 350);
}
// lotus loader — plays the lotus-blooming video on a loop while loading
const LOTUS_LOADER = `<div class="lotus-loader">
  <video class="ll-video" src="lotus-loom.mp4" autoplay loop muted playsinline preload="auto"
    onerror="this.closest('.lotus-loader').classList.add('ll-fallback')"></video></div>`;
// quick celebratory lotus + check pulse on a successful action
function celebrate(label){
  if(matchMedia('(prefers-reduced-motion:reduce)').matches) return;
  const el=document.createElement('div'); el.className='celebrate';
  el.innerHTML=`<div class="celebrate-card"><div class="lotus celebrate-anim">${LOTUS_SVG}</div>
    <div class="celebrate-check">✓</div>${label?`<div class="celebrate-label">${esc(label)}</div>`:''}</div>`;
  document.body.appendChild(el);
  requestAnimationFrame(()=>el.classList.add('show'));
  // upgrade to a Lottie burst if docs/lottie/success.json is present (else the SVG lotus stays)
  playLottie(el.querySelector('.celebrate-anim'), 'lottie/success.json', {loop:false});
  setTimeout(()=>{ el.classList.remove('show'); setTimeout(()=>el.remove(),300); }, 1150);
}

/* ============================================================
   PROFILE (self) — view + edit name / email / phone / photo + volunteering history
   ============================================================ */
function nameParts(full){ const p=(full||'').trim().split(/\s+/); return {first:p[0]||'', last:p.slice(1).join(' ')}; }
async function renderProfile(){
  view().innerHTML = skel(4);
  // link to a people record (for volunteering history) by email then phone
  let person=null;
  if(ME.email){ const {data}=await sb.from('people').select('id,full_name,phone,photo_url').ilike('email', ME.email).limit(1); if(data&&data[0]) person=data[0]; }
  if(!person && ME.phone){ const ph=(ME.phone||'').replace(/\D/g,'').slice(-10);
    if(ph){ const {data}=await sb.from('people').select('id,full_name,phone,photo_url').eq('phone', ph).limit(1); if(data&&data[0]) person=data[0]; } }
  PF_PERSON = person;
  const photo = ME.photo_url || person?.photo_url || '';
  const {first,last} = nameParts(ME.full_name);
  const initial = esc((ME.full_name||ME.email||'?').trim().charAt(0).toUpperCase());
  const scope = (ME.center_id==='all'||ME.role==='admin'||ME.role==='sector_nurturer')?'All Centers':centerName(ME.center_id);
  const avatar = photo
    ? `<img class="pf-photo" src="${esc(photo)}" alt="" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
       <div class="pf-photo pf-ph" style="display:none">${initial}</div>`
    : `<div class="pf-photo pf-ph">${initial}</div>`;
  // body of the collapsible "Profile" section — view rows, or the edit form
  let body;
  if(PF_EDIT){
    body = `<button class="btn small ghost" onclick="pickPhoto()">📷 Change photo</button>
      <label>First name</label><input id="pf-first" value="${esc(first)}">
      <label>Last name</label><input id="pf-last" value="${esc(last)}">
      <label>Email</label><input id="pf-email" type="email" value="${esc(ME.email||'')}">
      <label>Phone</label><input id="pf-phone" inputmode="numeric" value="${esc(ME.phone||'')}">
      <p class="muted" style="font-size:.74rem;margin-top:6px">Changing your email updates your sign-in address — you'll get a confirmation link at the new address.</p>
      <button class="btn block" style="margin-top:12px" onclick="saveProfile()">💾 Save changes</button>
      <button class="btn ghost block" style="margin-top:8px" onclick="PF_EDIT=false;renderProfile()">Cancel</button>`;
  } else {
    body = `<div class="pf-row"><span class="pf-k">Name</span><span class="pf-v">${esc(ME.full_name||'—')}</span></div>
      <div class="pf-row"><span class="pf-k">Email</span><span class="pf-v">${esc(ME.email||'—')}</span></div>
      <div class="pf-row"><span class="pf-k">Phone</span><span class="pf-v">${esc(ME.phone||'—')}</span></div>
      <div class="pf-row"><span class="pf-k">Role</span><span class="pf-v">${roleLabel(ME.role)} · ${scope}</span></div>
      <button class="btn block" style="margin-top:14px" onclick="PF_EDIT=true;renderProfile()">✏️ Edit profile</button>`;
  }
  // Default: photo + a tappable "Profile" header (details hidden). Volunteering journey always open below.
  let h = `<div class="card profile-card">
      <div class="pf-photo-wrap">${avatar}</div>
      <details class="acc" id="pf-acc" ${PF_EDIT?'open':''}>
        <summary>👤 Profile</summary>
        <div class="acc-body">${body}</div>
      </details>
    </div>
    <div class="card"><h2>🙌 My volunteering journey</h2><div id="pf-hist"><div class="empty">Loading…</div></div></div>`;
  view().innerHTML = h;
  pfHistory();   // always-open journey loads right away
}
let PF_PERSON=null, PF_EDIT=false;
async function pfHistory(){
  const host=$('pf-hist'); if(!host) return; if(host.dataset.loaded) return;
  if(!PF_PERSON){ host.innerHTML='<div class="empty">No volunteering record is linked to your account yet.</div>'; return; }
  host.innerHTML='<div class="empty">Loading…</div>';
  const [{data:vh},{data:att}] = await Promise.all([
    sb.from('volunteer_history').select('activity,center_id,happened_on').eq('person_id',PF_PERSON.id).order('happened_on',{ascending:false}),
    sb.from('attendance').select('time_in, activities(name,center_id,activity_date)').eq('person_id',PF_PERSON.id).order('time_in',{ascending:false})
  ]);
  const rows=[...(vh||[]).map(r=>({name:r.activity||'Volunteering',center:r.center_id,date:r.happened_on})),
    ...(att||[]).map(a=>({name:a.activities?.name||'Activity',center:a.activities?.center_id,date:a.activities?.activity_date||a.time_in}))]
    .filter(r=>r.date).sort((a,b)=>String(b.date).localeCompare(String(a.date)));
  host.dataset.loaded='1';
  host.innerHTML = rows.length
    ? `<p class="muted" style="font-size:.8rem;margin:2px 2px 8px">${rows.length} activit${rows.length===1?'y':'ies'}</p>`+
      rows.map(r=>`<div class="row simple"><div class="grow"><div class="name">${esc(r.name)}</div><div class="sub">${centerName(r.center)} · ${fmtD(r.date)}</div></div></div>`).join('')
    : '<div class="empty">No volunteering activities recorded yet.</div>';
}
function pickPhoto(){
  const i=document.createElement('input'); i.type='file'; i.accept='image/*';
  i.onchange=()=>{ const f=i.files&&i.files[0]; if(!f) return;
    const r=new FileReader(); r.onload=()=>{ const img=new Image();
      img.onload=async()=>{ const max=320; let w=img.width,h=img.height; const sc=Math.min(1,max/Math.max(w,h));
        w=Math.round(w*sc); h=Math.round(h*sc); const c=document.createElement('canvas'); c.width=w;c.height=h;
        c.getContext('2d').drawImage(img,0,0,w,h); const url=c.toDataURL('image/jpeg',0.82);
        const {error}=await sb.from('profiles').update({photo_url:url}).eq('id',ME.id);
        if(error) return toast(error.message); ME.photo_url=url; toast('Photo updated'); renderProfile(); };
      img.src=r.result; }; r.readAsDataURL(f); };
  i.click();
}
async function saveProfile(){
  const first=$('pf-first').value.trim(), last=$('pf-last').value.trim();
  const full=(first+' '+last).trim(); const phone=$('pf-phone').value.trim(); const email=$('pf-email').value.trim();
  const upd={};
  if(full && full!==(ME.full_name||'')) upd.full_name=full;
  if(phone!==(ME.phone||'')) upd.phone=phone||null;
  if(Object.keys(upd).length){ const {error}=await sb.from('profiles').update(upd).eq('id',ME.id); if(error) return toast(error.message); Object.assign(ME,upd); }
  if(email && email!==(ME.email||'')){
    const {error}=await sb.auth.updateUser({email});
    if(error) return toast(error.message);
    await sb.from('profiles').update({email}).eq('id',ME.id); ME.email=email;
    toast('Saved — check your new email to confirm the change');
  } else if(Object.keys(upd).length){ toast('Profile saved'); }
  else { toast('Nothing to update'); }
  $('who-name').textContent = ME.full_name || ME.email;
  PF_EDIT=false;
  renderProfile();
}
const roleLabel = r => ({nurturer:'Nurturer', center_coordinator:'Center Co-ordinator', sector_nurturer:'Sector Nurturer', admin:'Admin'}[r]||r);
const ROLES = ['nurturer','center_coordinator','sector_nurturer','admin'];
const centerName = id => (CENTERS_ALL.find(c=>c.id===id)||{}).name || (id==='all'?'All Centers':'Unassigned');
// coordinator+ = anyone who can see/allocate beyond their own assignments
const isCoord = () => ['center_coordinator','sector_nurturer','admin'].includes(ME.role);
const isAdmin = () => ME.role==='admin';
const isSector = () => ['sector_nurturer','admin'].includes(ME.role);   // can_all() roles
// Center for a person: use the stored center if set, else derive it from the
// pincode -> center map (Admin page). Lets us segregate by center even when
// center_id hasn't been written yet.
function derivedCenter(p){
  if(!p) return 'unassigned';
  if(p.center_id && p.center_id!=='unassigned') return p.center_id;
  const pm = SETTINGS.pincode_map||{};
  return pm[(p.pincode||'').trim()] || 'unassigned';
}
// Short profile summary line shown under a volunteer's name.
function profileSummary(p){
  if(!p) return '';
  const adv=[p.bsp_date&&'BSP', p.shoonya_date&&'Shoonya', p.samyama_date&&'Samyama', p.guru_puja_date&&'Guru Puja'].filter(Boolean);
  return [
    '🏢 '+centerName(derivedCenter(p)),
    p.pincode?('📍 '+esc(p.pincode)):null,
    p.ie_date?('🪷 IE '+fmtD(p.ie_date)):null,
    adv.length?('⭐ '+adv.join('/')):null,
    p.occupation?('💼 '+esc(p.occupation)):null
  ].filter(Boolean).join(' · ');
}
// Build the data object profileBody() expects from a people row.
const personToProfile = p => ({n:p.full_name,ph:p.phone,email:p.email,occ:p.occupation,gender:p.gender,dob:p.date_of_birth,area:p.area,city:p.city,street:p.street,pin:p.pincode,ctr:derivedCenter(p),ie:p.ie_date,bsp:p.bsp_date,sh:p.shoonya_date,sam:p.samyama_date,gp:p.guru_puja_date,tags:p.tags||[],photo:p.photo_url});

/* ---------------- NAV ---------------- */
let CURRENT_VIEW = 'today';
function go(v){
  CURRENT_VIEW = v;
  document.querySelectorAll('#nav button').forEach(b=>b.classList.toggle('active', b.dataset.v===v));
  const map={today:renderToday, people:renderPeople, vols:renderVols,
    insights:renderInsights, admin:renderAdmin, profile:renderProfile};
  const run=()=>{ try{ map[v](); }catch(e){} };
  // View Transitions API → smooth crossfade between tabs/sections (Chrome).
  // We don't return the async render promise, so a slow data load can't freeze the transition;
  // each render paints a shimmer skeleton synchronously, then fills in.
  if(document.startViewTransition && !matchMedia('(prefers-reduced-motion:reduce)').matches){
    document.startViewTransition(run);
  } else { return map[v](); }
}
// Tap an Insights number to jump straight to the matching list (optionally pre-filtered).
function drillTo(v, tab, opt){
  if(tab && PF[tab]){
    if(opt) Object.assign(PF[tab], opt);
    if(opt && opt.status==='completed' && !PF[tab].dateFrom){ PF[tab].dateFrom='2018-01-01'; PF[tab].dateTo=today(); }
  }
  if(tab) PEOPLE_TAB = tab;
  go(v);
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
  if(ME.role==='nurturer') q = q.eq('journeys.assigned_to', ME.id);
  const {data, error} = await q;
  if(error){ toast(error.message); return []; }
  return data||[];
}

async function renderToday(){
  view().innerHTML = skel();
  const {calls, upcoming} = await cached('today', async()=>{
    const calls = await fetchDueCalls();
    let upQ = sb.from('calls')
      .select('id, call_no, due_date, journeys!inner(type, assigned_to, status, people(full_name))')
      .is('completed_at', null).gt('due_date', today()).eq('journeys.status','active')
      .order('due_date').limit(8);
    if(ME.role==='nurturer') upQ = upQ.eq('journeys.assigned_to', ME.id);
    const {data:upcoming} = await upQ;
    return {calls, upcoming: upcoming||[]};
  });
  const td = today();
  // overdue first (most-late at the top), then today's calls
  const overdue = calls.filter(c=>c.due_date < td).sort((a,b)=>a.due_date.localeCompare(b.due_date));
  const dueToday = calls.filter(c=>c.due_date >= td);
  // load the user's first nurturing template so each call's WA button uses it
  DEFAULT_NURTURE_TPL = (await tplsFor('nurture'))[0]?.body || null;

  let h = '';
  h += `<div style="display:flex;gap:8px;margin:6px 0;flex-wrap:wrap">
    <button class="btn small green" onclick="openMessageAll()">✉️ Message all</button>
    <button class="btn small ghost" onclick="openTemplates()">📝 Templates</button>
  </div>`;
  if(!calls.length){
    h += `<div class="card"><div class="empty"><div class="empty-anim" id="today-empty"></div>🎉 All caught up — no calls due.</div></div>`;
  } else {
    if(overdue.length){
      h += `<details class="acc" open><summary>⚠️ Overdue <span class="badge red">${overdue.length}</span></summary>
        <div class="acc-body"><div id="today-od-host"></div></div></details>`;
    }
    h += `<details class="acc" ${overdue.length?'':'open'}><summary>📞 Due today <span class="badge">${dueToday.length}</span></summary>
      <div class="acc-body">${dueToday.length?'<div id="today-due-host"></div>':'<div class="empty">Nothing else due today.</div>'}</div></details>`;
  }
  if(upcoming?.length){
    h += `<details class="acc"><summary>⏭️ Coming up <span class="badge">${upcoming.length}</span></summary><div class="acc-body">` + upcoming.map(c=>
      `<div class="row"><div class="grow"><div class="name">${esc(c.journeys.people.full_name)}</div>
       <div class="sub">${JT[c.journeys.type]} - Call ${c.call_no} - due ${fmtD(c.due_date)}</div></div></div>`).join('') + '</div></details>';
  }
  view().innerHTML = h;
  if(!calls.length) playLottie($('today-empty'), 'lottie/empty.json');   // animated empty state if file present
  const callCfg = { rowFn:callRow, idOf:c=>c.id, personOf:c=>({full_name:c.journeys.people.full_name, phone:c.journeys.people.phone}), aud:'nurture', assignable:false };
  if(overdue.length)  bulkMount('today_od',  $('today-od-host'),  overdue,  callCfg);
  if(dueToday.length) bulkMount('today_due', $('today-due-host'), dueToday, callCfg);
}

function dayInJourney(j){
  if(!j.program_date) return null;
  return Math.max(1, Math.round((Date.now() - new Date(j.program_date)) / 864e5));
}
function callRow(c){
  const j = c.journeys, p = j.people;
  const day = dayInJourney(j);
  const od = c.due_date < today();
  const first0 = p.full_name.split(' ')[0];
  // Use the user's first nurturing template if they have one; else the built-in context message.
  const msg = DEFAULT_NURTURE_TPL ? applyTpl(DEFAULT_NURTURE_TPL, p.full_name)
                                  : decorateMsg((WA_MSG[j.type]||WA_MSG.meditator)(first0), first0);
  const log = `<button class="actbtn log" onclick='openLog(${JSON.stringify({id:c.id,call_no:c.call_no,jtype:j.type,name:p.full_name,jid:j.id,pid:p.id}).replace(/"/g,'&quot;').replace(/'/g,"&#39;")})'>Log</button>`;
  return simpleRow({name:p.full_name, phone:p.phone, msg, extra:log});
}

/* ---- call logging ---- */
const SADHANA_OPTS = {
  new_meditator: ['Doing Well','Doing Regularly','Needs Support','Needs Support on Ishangam','Wants to Connect with Ishangam','Does Not Need Support','Stopped Sadhana','Not Sure'],
  meditator: ['Doing sadhana regularly','Irregular','Stopped','Wants to go to Ashram','Wants Sannidhi at home','Wants an advanced program','Needs practice correction','Other'],
  advanced: ['Great experience','Good, needs support','Wants to volunteer','Wants another program','Needs practice correction','Other'],
  volunteer_nurture: ['Great experience','Interested in local volunteering','Not interested now','Needs follow-up','Other']
};
let LOG = null;
async function openLog(c){
  LOG = {...c, reach:null, status:null};
  let hist = [];
  if(c.jid){
    const {data} = await sb.from('call_logs').select('logged_at,reachability,sadhana_status,remarks')
      .eq('journey_id', c.jid).order('logged_at',{ascending:false});
    hist = data||[];
  }
  const reachLabel = {answered:'Answered', not_reachable:'Not reachable', will_call_back:'Will call back'};
  const histHtml = hist.length ? `<div class="card" style="padding:10px;margin-bottom:10px;max-height:30vh;overflow:auto">
      <div class="muted" style="font-size:.76rem;margin-bottom:4px">📜 Past call logs (${hist.length}) — newest first</div>` +
      hist.map(l=>`<div style="border-bottom:1px solid var(--line);padding:7px 0">
        <div style="font-size:.84rem"><b>${fmtD(l.logged_at)}</b> · ${esc(reachLabel[l.reachability]||l.reachability||'-')}${l.sadhana_status?' · '+esc(l.sadhana_status):''}</div>
        ${l.remarks?`<div class="sub" style="white-space:pre-wrap">${esc(l.remarks)}</div>`:''}</div>`).join('') + `</div>` : '';
  modal(`<h3>Log call -- ${esc(c.name)}</h3><p class="muted">${c.call_no?('Call '+c.call_no):'Follow-up call'}</p>
    ${histHtml}
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
    <button class="btn block" onclick="saveLog(true)">Save log</button>
    <button class="btn block ghost" style="margin-top:6px" onclick="saveLog(false)">Save &amp; log another call</button>`);
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
async function saveLog(close){
  if(!LOG.reach) return toast('Select reachability');
  const remarks = $('lg-remarks').value || null;
  const status = LOG.reach==='answered' ? LOG.status : null;
  // append-only history (never overwrites earlier logs)
  if(LOG.jid){
    const {error} = await sb.from('call_logs').insert({
      journey_id: LOG.jid, person_id: LOG.pid||null, call_id: LOG.id||null,
      reachability: LOG.reach, sadhana_status: status, remarks, logged_by: ME.id });
    if(error) return toast(error.message);
  }
  // also complete the scheduled call (keeps Today behaviour + latest status for insights)
  if(LOG.id){
    await sb.from('calls').update({ completed_at:new Date().toISOString(), reachability:LOG.reach,
      sadhana_status:status, remarks, logged_by:ME.id }).eq('id', LOG.id);
  }
  toast('Saved!'); celebrate('Call logged 🙏');
  if(close){ closeModal(); renderToday(); }
  else { openLog({...LOG, id:null, reach:null, status:null}); }  // reopen: history grows, fresh ad-hoc log
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
  view().innerHTML = skel();

  // Ashram/SSB volunteers moved to the Volunteers tab.
  if(PEOPLE_TAB==='volunteer_nurture') PEOPLE_TAB = 'new_meditator';

  const tabDefs = [
    ['new_meditator','🌱 New Meditators'],
    ['meditator','🧘 Meditators'],
    ['advanced','⭐ Advanced Programs']
  ];

  const tabBar = `<select class="section-sel" onchange="renderPeople(this.value)">${tabDefs.map(([v,l])=>
    `<option value="${v}" ${PEOPLE_TAB===v?'selected':''}>${l}</option>`).join('')}</select>`;

  if(PEOPLE_TAB==='new_meditator') await renderNewMeditators(tabBar);
  else if(PEOPLE_TAB==='meditator') await renderMeditatorsList(tabBar);
  else await renderAdvancedList(tabBar);
}

/* ---- New Meditators: nothing loads until an IE date range (or search) is chosen ---- */
let NM_VOLS=[];
const ieOfJ = j => (j.people?.ie_date || '');
async function renderNewMeditators(tabBar){
  const f = PF.new_meditator;
  const centerOpts = `<option value="">All Centers</option>${CENTERS.map(c=>`<option value="${c.id}" ${f.center===c.id?'selected':''}>${c.name}</option>`).join('')}`;
  const activeF = [f.center,f.dateFrom,f.dateTo,f.search].filter(Boolean).length;
  // section dropdown + Message + Add all on one row (incl. mobile)
  let h = `<div class="ptoolbar">${tabBar}
    <details class="menu"><summary class="btn small green">✉️ Msg ▾</summary>
      <div class="menu-pop">
        <button class="btn small green" onclick="newMedMessageAll()">✉️ Message all shown</button>
        <button class="btn small ghost" onclick="openTemplates('new_meditator')">📝 Templates</button>
      </div></details>
    ${isCoord()?`<details class="menu"><summary class="btn small ghost">＋ Add ▾</summary>
      <div class="menu-pop">
        <button class="btn small ghost" onclick="openImport()">📥 Import</button>
        <button class="btn small ghost" onclick="openAddPerson()">➕ Add person</button>
      </div></details>`:''}
  </div>`;
  h += `<details class="card vfilters" open>
    <summary>🔍 Filters &amp; date range${activeF?` <span class="badge">${activeF}</span>`:''}</summary>
    <input placeholder="🔍 Search name/phone" style="width:100%;margin-top:10px" value="${esc(f.search)}"
      oninput="PF.new_meditator.search=this.value" onkeydown="if(event.key==='Enter')renderPeople()">
    <div class="choices" style="flex-wrap:wrap;gap:6px;margin-top:8px;align-items:center">
      <select style="width:auto" onchange="PF.new_meditator.center=this.value;renderPeople()">${centerOpts}</select>
      <input type="date" title="IE date from (or single date)" value="${f.dateFrom}"
        onchange="PF.new_meditator.dateFrom=this.value;renderPeople()" style="width:130px">
      <input type="date" title="IE date to (leave blank for a single date)" value="${f.dateTo}"
        onchange="PF.new_meditator.dateTo=this.value;renderPeople()" style="width:130px">
      <button class="btn small ghost" onclick="renderPeople()">Search</button>
      ${activeF?`<button class="btn small gray" onclick="PF.new_meditator.dateFrom='';PF.new_meditator.dateTo='';PF.new_meditator.search='';PF.new_meditator.center='';renderPeople()">Clear</button>`:''}
    </div>
    <p class="muted" style="font-size:.76rem;margin-top:6px">Pick an IE date (or a from–to range) to load new meditators for that period — or search by name/phone.</p>
  </details>`;

  // Date-gate: load nothing until a date (or search) is chosen — keeps it fast.
  const effFrom = f.dateFrom || f.dateTo;
  const effTo   = f.dateTo   || f.dateFrom;
  const term = (f.search||'').trim();
  if(!effFrom && !term){
    view().innerHTML = h + `<div class="card"><div class="empty">📅 Choose an IE date or a date range above (or search by name/phone) to load new meditators.<br>Nothing loads until you do — that keeps this page fast.</div></div>`;
    return;
  }

  // fetch ONLY the matching records (scoped server-side by IE date / search); cached per query
  const role = ME.role;
  const key = 'newmed_'+(effFrom||'')+'_'+(effTo||'')+'_'+(f.center||'')+'_'+term;
  let rows = await cached(key, async()=>{
    let q = sb.from('journeys')
      .select('id, type, program_name, program_date, status, sadhana_status, assigned_to, center_id, people!inner(id,full_name,phone,email,occupation,gender,date_of_birth,area,city,street,pincode,center_id,ie_date,bsp_date,shoonya_date,samyama_date,guru_puja_date,tags,photo_url)')
      .eq('type','new_meditator').limit(800);
    if(role==='nurturer') q = q.eq('assigned_to', ME.id);
    if(f.center) q = q.eq('center_id', f.center);
    if(effFrom) q = q.gte('people.ie_date', effFrom).lte('people.ie_date', effTo);
    if(term){ const isDigit=/^[\d\s+]+$/.test(term);
      if(isDigit) q = q.ilike('people.phone', '%'+term.replace(/\D/g,'')+'%');
      else q = q.ilike('people.full_name', '%'+term+'%'); }
    const {data,error} = await q; if(error){ toast(error.message); return []; }
    return data||[];
  });
  const isAdv = j=>{const p=j.people||{};return !!(p.bsp_date||p.shoonya_date||p.samyama_date||p.guru_puja_date);};
  rows = rows.filter(j=> !isAdv(j) && ieOfJ(j)).sort((a,b)=> ieOfJ(b).localeCompare(ieOfJ(a)));
  NM_VOLS = isCoord() ? await cached('nm_vols', async()=>{ const {data}=await sb.from('profiles').select('id, full_name, email, role, center_id').eq('active',true); return data||[]; }) : [];
  NEWMED_PEOPLE = rows.map(j=>({full_name:j.people?.full_name, phone:j.people?.phone})).filter(p=>p.phone);

  h += `<div class="card"><h2>🌱 New Meditators <span class="badge">${rows.length}</span></h2>
    <p class="muted" style="font-size:.8rem;margin-bottom:8px">${isCoord()?'Tick people and press <b>📞 Start calling</b> to add them to nurturing calls.':'These are the new meditators assigned to you.'}</p><div id="nm-host"></div></div>`;
  view().innerHTML = h;
  nmMount(rows);
}
function nmMountCfg(){ return {externalRange:false, rowFn:newMeditatorRow, idOf:j=>j.id, personOf:j=>({full_name:j.people?.full_name,phone:j.people?.phone}), aud:'new_meditator', assignable:false, bulkActions: isCoord()?[{label:'📞 Start calling', fn:'nmStartSelected'}]:[]}; }
function nmMount(rows){ bulkMount('newmed', $('nm-host'), rows, nmMountCfg()); }

let NEWMED_PEOPLE=[];
function newMedMessageAll(){ if(!NEWMED_PEOPLE.length) return toast('No new meditators with phone numbers in view'); openMsgAll('new_meditator', NEWMED_PEOPLE, 'Message new meditators'); }

async function nmStartSelected(ctx){
  const s=BL[ctx]; if(!s) return;
  const pend = s.items.filter(j=>s.sel.has(j.id) && j.status==='pending');
  if(!pend.length) return toast('Tick people who are "not calling" yet');
  modal(`<h3>Start calling — ${pend.length} meditator${pend.length>1?'s':''}</h3>
    <p class="muted">They'll be added to nurturing calls (3-call Mandala journey).</p>
    <label>Assign caller (optional)</label>
    <select id="nm-assign"><option value="">(assign later)</option>${NM_VOLS.map(v=>`<option value="${v.id}">${esc(v.full_name||v.email)}</option>`).join('')}</select>
    <button class="btn block" style="margin-top:12px" onclick="nmStartConfirm('${ctx}')">📞 Start calling</button>`);
}
async function nmStartConfirm(ctx){
  const s=BL[ctx]; if(!s) return;
  const assign = $('nm-assign')?.value || '';
  const pend = s.items.filter(j=>s.sel.has(j.id) && j.status==='pending');
  toast('Starting nurturing...');
  for(const j of pend){
    const {error} = await sb.rpc('activate_journey', {j_id:j.id});
    if(error) return toast(error.message);
    if(assign) await sb.from('journeys').update({assigned_to:assign}).eq('id', j.id);
  }
  s.sel.clear(); closeModal();
  toast(`Calling started for ${pend.length} meditator${pend.length>1?'s':''}`);
  celebrate('Calling started 📞');
  renderPeople();
}

function newMeditatorRow(j){
  const p = j.people;
  const isPending = j.status==='pending';
  // small status badge so pending vs calling vs done is clear (the bulk checkbox handles selection)
  const badge = isPending ? '<span class="badge gray">not calling</span>'
    : j.status==='completed' ? '<span class="badge green">done</span>'
    : '<span class="badge">calling</span>';
  const extra = (isCoord() && p?.id) ? `<button class="actbtn assign" onclick="quickAssign('${p.id}','${esc(p.full_name||'')}')">Assign</button>` : '';
  const prof = JSON.stringify({n:p?.full_name,ph:p?.phone,email:p?.email,occ:p?.occupation,gender:p?.gender,dob:p?.date_of_birth,area:p?.area,city:p?.city,street:p?.street,pin:p?.pincode,ctr:p?.center_id,ie:p?.ie_date||j.program_date,tags:p?.tags||[],photo:p?.photo_url});
  const msg = WA_MSG.new_meditator((p?.full_name||'').split(' ')[0]);
  return simpleRow({photo:p?.photo_url, name:p?.full_name, badge, onclick:`showPersonProfile(${prof})`, phone:p?.phone, msg, extra});
}

/* ---- Meditators (ALL is_meditator=true people) ---- */
let MED_SCOPE_SET=false;
async function renderMeditatorsList(tabBar){
  // everyone lands on "My meditators" first; "All meditators" is one tap away
  if(!MED_SCOPE_SET){ MED_SCOPE = 'mine'; MED_SCOPE_SET=true; }
  const f = PF.meditator;
  const centerOpts = `<option value="">All Centers</option>${CENTERS.map(c=>`<option value="${c.id}" ${f.center===c.id?'selected':''}>${c.name}</option>`).join('')}`;
  const tagOpts = `<option value="">All Tags</option>${COMMON_TAGS.map(t=>`<option value="${t}" ${f.tag===t?'selected':''}>${esc(t)}</option>`).join('')}`;

  const activeF = [f.center,f.tag,f.dateFrom,f.dateTo,f.search].filter(Boolean).length;
  let h = tabBar;
  h += `<div style="display:flex;gap:8px;margin:6px 0;flex-wrap:wrap;align-items:center">
    <details class="menu"><summary class="btn small green">✉️ Message ▾</summary>
      <div class="menu-pop">
        <button class="btn small green" onclick="medMessageAll('meditator')">✉️ Message all shown</button>
        <button class="btn small ghost" onclick="medMessageAll('satsang')">🙏 Satsang invite</button>
        <button class="btn small ghost" onclick="openTemplates('meditator')">📝 Templates</button>
      </div></details>
    ${isCoord()?`<details class="menu"><summary class="btn small ghost">＋ Add ▾</summary>
      <div class="menu-pop">
        <button class="btn small ghost" onclick="openImport()">📥 Import</button>
        <button class="btn small ghost" onclick="openAddPerson()">➕ Add person</button>
      </div></details>`:''}
    <select class="viewsel" onchange="MED_SCOPE=this.value;MED_SCOPE_SET=true;renderPeople()">
      <option value="mine" ${MED_SCOPE==='mine'?'selected':''}>🙋 My meditators</option>
      <option value="all" ${MED_SCOPE==='all'?'selected':''}>🧘 All meditators</option>
    </select>
  </div>`;

  h += `<details class="card vfilters" ${activeF?'open':''}>
    <summary>🔍 Filters &amp; range${activeF?` <span class="badge">${activeF}</span>`:''}</summary>
    <input id="med-search" placeholder="🔍 Search by name or phone" style="width:100%;margin-top:10px" value="${esc(f.search)}"
      oninput="PF.meditator.search=this.value;medSearchLive()">
    <div class="choices" style="flex-wrap:wrap;gap:6px;margin-top:8px">
      <select style="width:auto" onchange="PF.meditator.center=this.value;renderPeople()">
        ${centerOpts}</select>
      <select style="width:auto" onchange="PF.meditator.tag=this.value;renderPeople()">
        ${tagOpts}</select>
      <input type="date" title="IE date from" value="${f.dateFrom}"
        onchange="PF.meditator.dateFrom=this.value;renderPeople()" style="width:130px">
      <input type="date" title="IE date to" value="${f.dateTo}"
        onchange="PF.meditator.dateTo=this.value;renderPeople()" style="width:130px">
      ${activeF?`<button class="btn small gray" onclick="PF.meditator={center:'',tag:'',dateFrom:'',dateTo:'',search:''};renderPeople()">Clear filters</button>`:''}
    </div>
    ${rangeBlock('med','med-from','med-to')}
  </details>`;

  // Load the full meditator directory once (cached); filter client-side so
  // changing center/tag/date/search is instant and doesn't re-hit the DB.
  // Slim columns for the list; the full profile (address/occupation/etc.) is
  // loaded on demand when a row is tapped (keeps this big fetch light).
  const all = await cached('people_all', () => fetchAll(() => sb.from('people')
    .select('id,full_name,phone,center_id,ie_date,bsp_date,shoonya_date,samyama_date,guru_puja_date,tags,photo_url')
    .eq('is_meditator', true).order('ie_date', {ascending:false})));
  MED_INDEX = {}; all.forEach(p=>MED_INDEX[p.id]=p);
  MED_ALL = all;
  // nurturer assignments (who nurtures whom)
  const nurturers = await cached('nurturers', ()=>fetchAll(()=>sb.from('nurturers').select('id,full_name,phone,profile_id')));
  const assigns   = await cached('med_assign', ()=>fetchAll(()=>sb.from('nurturer_assignments').select('meditator_id,nurturer_id')));
  const nById={}; nurturers.forEach(n=>nById[n.id]=n);
  const myNurIds = new Set(nurturers.filter(n=>n.profile_id===ME.id).map(n=>n.id));
  MED_ASSIGN={}; MY_MED_IDS=new Set();
  assigns.forEach(a=>{ (MED_ASSIGN[a.meditator_id] ||= []).push(nById[a.nurturer_id]?.full_name||'?');
    if(myNurIds.has(a.nurturer_id)) MY_MED_IDS.add(a.meditator_id); });
  const rows = medFilter();

  h += `<div class="card"><h2>${MED_SCOPE==='mine'?'🙋 My meditators':'🧘 Meditators'} <span class="badge" id="med-count">${rows.length}</span></h2><div id="med-host"></div></div>`;
  view().innerHTML = h;
  bulkMount('med', $('med-host'), rows, {externalRange:true, rowFn:meditatorDetailRow, idOf:p=>p.id, personOf:p=>({full_name:p.full_name,phone:p.phone}), aud:'meditator', assignable:true});
}
let MED_ALL = [], MED_SCOPE='all', MED_ASSIGN={}, MY_MED_IDS=new Set();
function medFilter(){
  const f = PF.meditator, s = (f.search||'').toLowerCase().trim(), sd = s.replace(/\D/g,'');
  return MED_ALL.filter(p=>{
    if(MED_SCOPE==='mine' && !MY_MED_IDS.has(p.id)) return false;
    if(f.center && p.center_id!==f.center) return false;
    if(f.tag && !(p.tags||[]).includes(f.tag)) return false;
    if(f.dateFrom && !(p.ie_date && p.ie_date>=f.dateFrom)) return false;
    if(f.dateTo && !(p.ie_date && p.ie_date<=f.dateTo)) return false;
    if(s && !((p.full_name||'').toLowerCase().includes(s) || (sd && (p.phone||'').includes(sd)))) return false;
    return true;
  });
}
// message all currently-shown meditators with a meditator/satsang template
function medMessageAll(aud){
  const people = medFilter().map(p=>({full_name:p.full_name, phone:p.phone})).filter(p=>p.phone);
  if(!people.length) return toast('No one with a phone in this list');
  openMsgAll(aud, people, aud==='satsang'?'Satsang invite':'Message meditators');
}
// live search: re-filter + re-mount only the list, so the search box keeps focus
let MED_SEARCH_T=null;
function medSearchLive(){
  clearTimeout(MED_SEARCH_T);
  MED_SEARCH_T = setTimeout(()=>{
    const host = $('med-host'); if(!host) return;
    const rows = medFilter();
    const cnt = $('med-count'); if(cnt) cnt.textContent = rows.length;
    bulkMount('med', host, rows, {externalRange:true, rowFn:meditatorDetailRow, idOf:p=>p.id, personOf:p=>({full_name:p.full_name,phone:p.phone}), aud:'meditator', assignable:true});
  }, 180);
}

let MED_INDEX = {};
const medProfile = p => ({id:p.id,n:p.full_name,ph:p.phone,email:p.email,occ:p.occupation,gender:p.gender,dob:p.date_of_birth,area:p.area,city:p.city,street:p.street,pin:p.pincode,ie:p.ie_date,bsp:p.bsp_date,sh:p.shoonya_date,sam:p.samyama_date,gp:p.guru_puja_date,tags:p.tags||[],ctr:p.center_id,photo:p.photo_url});
async function showMedById(id){
  const p=MED_INDEX[id]; if(!p) return;
  // fetch the full profile row on demand (list only holds slim columns)
  const {data} = await sb.from('people').select('id,full_name,phone,email,occupation,gender,date_of_birth,area,city,street,pincode,center_id,ie_date,bsp_date,shoonya_date,samyama_date,guru_puja_date,tags,photo_url').eq('id', id).single();
  showMeditatorDetail(medProfile(data||p));
}
function nurtureById(id){ const p=MED_INDEX[id]; if(p) startNurturing({pid:p.id,name:p.full_name}); }

// Shared compact list row: photo/initial + name, then Call / Msg / (extra) actions.
// onclick is the raw JS to open the profile; it's escaped here for a double-quoted attribute.
function simpleRow(o){
  const oc = (o.onclick||'').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  const clickAttr = oc ? `onclick="${oc}"` : '';
  const cur = oc ? 'cursor:pointer' : '';
  const initial = esc((o.name||'?').trim().charAt(0).toUpperCase() || '?');
  const wa = o.phone ? `https://wa.me/91${o.phone}?text=${encodeURIComponent(o.msg||'')}` : null;
  const avatar = o.photo
    ? `<img class="av" src="${esc(o.photo)}" loading="lazy" alt="" ${clickAttr} onerror="this.style.visibility='hidden'">`
    : `<div class="av avph" ${clickAttr}>${initial}</div>`;
  return `<div class="row simple">
    ${o.cb||''}
    ${avatar}
    <div class="grow" style="${cur};min-width:0" ${clickAttr}>
      <div class="name">${esc(o.name||'?')}${o.badge?' '+o.badge:''}</div>
      ${o.sub?`<div class="sub">${o.sub}</div>`:''}
    </div>
    <div class="acts">
      ${o.phone?`<a class="actbtn call" href="tel:+91${o.phone}">Call</a>`:''}
      ${wa?`<a class="actbtn msg" href="${wa}" target="_blank">Msg</a>`:''}
      ${o.extra||''}
    </div>
  </div>`;
}

function meditatorDetailRow(p){
  const onclk = `showMedById('${p.id}')`;
  const msg = WA_MSG.meditator((p.full_name||'').split(' ')[0]);
  const extra = isCoord() ? `<button class="actbtn assign" onclick="quickAssign('${p.id}','${esc(p.full_name)}')">Assign</button>` : '';
  return simpleRow({photo:p.photo_url, name:p.full_name, onclick:onclk, phone:p.phone, msg, extra});
}

// Shared full-profile card (used by New Meditators + Meditators rows)
function profileBody(d){
  const tags = (d.tags||[]).map(t=>`<span class="badge gray">${esc(t)}</span>`).join(' ');
  const addr = [d.street,d.area,d.city].filter(Boolean).map(esc).join(', ');
  const progs = [d.bsp&&`BSP ${fmtD(d.bsp)}`, d.sh&&`Shoonya ${fmtD(d.sh)}`, d.sam&&`Samyama ${fmtD(d.sam)}`, d.gp&&`Guru Puja ${fmtD(d.gp)}`].filter(Boolean).join(' · ');
  return `
    ${d.photo?`<img class="pfp" src="${esc(d.photo)}" alt="" title="Tap to enlarge" onclick="openPhoto(this.src)" onerror="this.style.display='none'">`:''}
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
function openPhoto(src){
  if(!src) return;
  const d=document.createElement('div'); d.className='lightbox';
  d.onclick=()=>d.remove();
  d.innerHTML=`<img src="${esc(src)}" alt="">`;
  document.body.appendChild(d);
}

/* ---------------- WhatsApp message templates ---------------- */
let MSG_TPL=null, MSG_PEOPLE=[], MSG_TS=[], MSG_AUD='nurture', MSG_TITLE='Message all';
let DEFAULT_NURTURE_TPL=null;   // first nurturing template body, used by per-call WA buttons
const AUD_LABEL = {nurture:'Nurturing', adv_completed:'Advanced · Completed', adv_interested:'Advanced · Interested', meditator:'Meditator', satsang:'Satsang invite', new_meditator:'New Meditator', volunteer:'Volunteer'};
const loadTemplates = () => cached('templates', async()=>(await sb.from('message_templates').select('*').order('created_at')).data||[]);
const tplsFor = async(aud)=> (await loadTemplates()).filter(t=>(t.audience||'nurture')===aud);
// Adds the Isha touch to every outgoing WhatsApp message: a 🙏 right after the
// person's name, and a "Pranam 🙏" closing line. Skips either if already present
// (so a template that already has them won't get doubled).
function decorateMsg(text, first){
  let t = (text||'').replace(/\s+$/,'');
  if(first && t.indexOf('🙏')===-1){
    const i = t.indexOf(first);
    if(i>=0) t = t.slice(0, i+first.length) + ' 🙏' + t.slice(i+first.length);
  }
  if(!/pranam/i.test(t)) t = t + '\n\nPranam 🙏';
  return t;
}
function applyTpl(body, name){
  const first=((name||'').trim().split(' ')[0])||'';
  const t=(body||'').replace(/\{name\}/g, first).replace(/\{my_name\}/g, (ME.full_name||ME.email||''));
  return decorateMsg(t, first);
}
async function openTemplates(aud='nurture'){
  const ts = await tplsFor(aud);
  let h = `<h3>📝 ${AUD_LABEL[aud]||''} templates</h3>
    <p class="muted" style="font-size:.8rem">Save as many as you like. Use <b>{name}</b> for the person's first name and <b>{my_name}</b> for your name. A 🙏 and a "Pranam 🙏" close are added automatically.</p>`;
  h += ts.map(t=>`<div class="row"><div class="grow"><div class="name">${esc(t.name)}</div>
      <div class="sub" style="white-space:pre-wrap">${esc(t.body)}</div></div>
      <button class="btn small gray" onclick="editTemplate('${t.id}','${aud}')">Edit</button>
      <button class="btn small gray" onclick="delTemplate('${t.id}','${aud}')">Delete</button></div>`).join('')
    || '<div class="empty">No templates yet — add one below.</div>';
  h += `<button class="btn block" style="margin-top:10px" onclick="editTemplate('','${aud}')">➕ New template</button>`;
  modal(h);
}
async function editTemplate(id, aud='nurture'){
  const ts = await loadTemplates();
  const t = ts.find(x=>x.id===id) || {name:'',body:'',audience:aud};
  const a = t.audience||aud;
  modal(`<h3>${id?'Edit':'New'} template <span class="badge gray">${AUD_LABEL[a]||a}</span></h3>
    <label>Name</label><input id="tpl-name" value="${esc(t.name)}" placeholder="e.g. First call">
    <label>Message</label><textarea id="tpl-body" style="min-height:130px">${esc(t.body)}</textarea>
    <div class="choices" style="margin-top:6px">
      <button onclick="insTpl('{name}')">+ {name}</button>
      <button onclick="insTpl('{my_name}')">+ {my_name}</button>
    </div>
    <button class="btn block" style="margin-top:10px" onclick="saveTemplate('${id}','${a}')">Save</button>`);
}
function insTpl(tok){ const ta=$('tpl-body'); if(!ta)return; const a=ta.selectionStart??ta.value.length, b=ta.selectionEnd??a;
  ta.value=ta.value.slice(0,a)+tok+ta.value.slice(b); ta.focus(); ta.selectionStart=ta.selectionEnd=a+tok.length; }
async function saveTemplate(id, aud='nurture'){
  const name=($('tpl-name').value||'').trim()||'Template'; const body=$('tpl-body').value||'';
  const res = id ? await sb.from('message_templates').update({name,body}).eq('id',id)
                 : await sb.from('message_templates').insert({name,body,audience:aud});
  if(res.error) return toast(res.error.message);
  toast('Saved'); openTemplates(aud);
}
async function delTemplate(id, aud='nurture'){
  const {error}=await sb.from('message_templates').delete().eq('id',id);
  if(error) return toast(error.message);
  toast('Deleted'); openTemplates(aud);
}
// Today: nurturing template -> everyone assigned to me
async function openMessageAll(){
  const js = await fetchAll(()=> sb.from('journeys')
    .select('assigned_to, status, people(id, full_name, phone)')
    .eq('assigned_to', ME.id).neq('status','dropped'));
  const seen=new Map();
  (js||[]).forEach(j=>{ const p=j.people; if(p && p.phone && !seen.has(p.id)) seen.set(p.id,p); });
  return openMsgAll('nurture', [...seen.values()], 'Message all (my people)');
}
// Generic: pick a template of `aud` and one-tap WhatsApp it to each of `people`
async function openMsgAll(aud, people, title){
  const ts = await tplsFor(aud);
  if(!ts.length){ toast('Create a template first'); return openTemplates(aud); }
  MSG_TS = ts; MSG_AUD = aud; MSG_TITLE = title || 'Message all';
  if(!MSG_TPL || !ts.find(t=>t.id===MSG_TPL)) MSG_TPL = ts[0].id;   // reset if template not in this audience
  MSG_PEOPLE = (people||[]).filter(p=>p && p.phone);
  if(MSG_PEOPLE.length>500){ MSG_PEOPLE = MSG_PEOPLE.slice(0,500); toast('Large list — showing first 500. Filter/search to narrow.'); }
  renderMessageAll();
}
function renderMessageAll(){
  const t = MSG_TS.find(x=>x.id===MSG_TPL) || MSG_TS[0];
  const sample = applyTpl(t.body, MSG_PEOPLE[0] ? MSG_PEOPLE[0].full_name : 'Name');
  let h = `<h3>✉️ ${esc(MSG_TITLE)} <span class="badge">${MSG_PEOPLE.length}</span></h3>
    <label>Template (${AUD_LABEL[MSG_AUD]||MSG_AUD})</label>
    <select onchange="MSG_TPL=this.value;renderMessageAll()">${MSG_TS.map(x=>`<option value="${x.id}" ${x.id===MSG_TPL?'selected':''}>${esc(x.name)}</option>`).join('')}</select>
    <button class="btn small ghost" style="margin:8px 0" onclick="openTemplates('${MSG_AUD}')">📝 Edit templates</button>
    <div class="card" style="padding:10px;white-space:pre-wrap;font-size:.9rem">${esc(sample)||'<span class="muted">(empty template)</span>'}</div>
    <p class="muted" style="font-size:.78rem">This exact message goes to everyone below. Tap each person to open WhatsApp with it ready, then press send. Opened ones dim.</p>
    <div style="max-height:46vh;overflow:auto">`;
  h += MSG_PEOPLE.length ? MSG_PEOPLE.map(p=>{
      const wa=`https://wa.me/91${p.phone}?text=${encodeURIComponent(applyTpl(t.body,p.full_name))}`;
      return `<div class="row"><div class="grow"><div class="name">${esc(p.full_name||'?')}</div><div class="sub">${esc(p.phone||'')}</div></div>
        <a class="iconbtn call" href="tel:+91${p.phone}">Call</a>
        <a class="iconbtn wa" href="${wa}" target="_blank" onclick="this.closest('.row').style.opacity='.45'">WA</a></div>`;
    }).join('') : '<div class="empty">No one with a phone number here.</div>';
  h += '</div>';
  modal(h);
}
async function showMeditatorDetail(d){
  const {data:assigned} = await sb.from('nurturer_assignments').select('id, nurturers(full_name)').eq('meditator_id', d.id);
  const a = assigned||[];
  let nurHtml = `<div style="margin-top:12px"><div class="muted" style="font-size:.8rem">🙏 Nurturers</div><div style="margin-top:4px">`;
  nurHtml += a.length ? a.map(x=>`<span class="badge gray" style="margin:3px 5px 0 0">${esc(x.nurturers?.full_name||'?')}${isCoord()?` <a href="#" onclick="unassignNurturer('${x.id}','${d.id}');return false" style="color:var(--warn);text-decoration:none">✕</a>`:''}</span>`).join('')
    : '<span class="muted" style="font-size:.82rem">none yet</span>';
  nurHtml += '</div></div>';
  modal(`<h3>${esc(d.n)}</h3>${profileBody(d)}
    ${nurHtml}
    <div class="choices" style="gap:6px;margin-top:14px">
      ${isCoord()?`<button class="btn small green" onclick="openAssignNurturer('${d.id}','${esc(d.n)}')">👤 Assign nurturer</button>`:''}
      ${isCoord()?`<button class="btn small ghost" onclick='closeModal();startNurturing(${JSON.stringify({pid:d.id,name:d.n}).replace(/'/g,"&#39;")})'>📞 Add to calls</button>`:''}
    </div>`);
}
async function openAssignNurturer(medId, medName){
  const profs = (await sb.from('profiles').select('id,full_name,email,phone,role').eq('active',true).order('full_name')).data||[];
  const nurturers = await cached('nurturers', ()=>fetchAll(()=>sb.from('nurturers').select('id,full_name,phone,profile_id')));
  const cur = (await sb.from('nurturer_assignments').select('nurturer_id').eq('meditator_id',medId)).data||[];
  const assignedSet = new Set(cur.map(x=>x.nurturer_id));
  let h = `<h3>Assign nurturer</h3><p class="muted" style="font-size:.82rem">${esc(medName)}</p>
    <input id="an-q" placeholder="🔍 filter by name" oninput="anFilter()" style="margin-bottom:8px">
    <div id="an-list" style="max-height:46vh;overflow:auto">`;
  h += `<div class="muted" style="font-size:.74rem;margin:4px 0">App users (they get a "My Meditators" view)</div>`;
  h += profs.map(p=>`<div class="row anrow" data-t="${esc((p.full_name||p.email||'').toLowerCase())}"><div class="grow"><div class="name">${esc(p.full_name||p.email)}</div><div class="sub">${roleLabel(p.role)}</div></div>
      <button class="btn small green" onclick="assignProfile('${medId}','${p.id}',this)">Assign</button></div>`).join('');
  const nl = nurturers.filter(n=>!n.profile_id);
  if(nl.length){
    h += `<div class="muted" style="font-size:.74rem;margin:10px 0 4px">Other nurturers (no login)</div>`;
    h += nl.map(n=>`<div class="row anrow" data-t="${esc((n.full_name||'').toLowerCase())}"><div class="grow"><div class="name">${esc(n.full_name)}</div><div class="sub">${esc(n.phone||'')}</div></div>
      <button class="btn small ${assignedSet.has(n.id)?'gray':'green'}" ${assignedSet.has(n.id)?'disabled':''} onclick="assignNurturer('${medId}','${n.id}',this)">${assignedSet.has(n.id)?'Assigned':'Assign'}</button></div>`).join('');
  }
  h += `</div>
    <div style="margin-top:10px;border-top:1px solid var(--line);padding-top:10px">
      <div class="muted" style="font-size:.74rem">➕ New nurturer (no login yet)</div>
      <input id="an-name" placeholder="Name" style="margin-top:4px">
      <input id="an-phone" placeholder="Phone (optional)" inputmode="numeric" style="margin-top:6px">
      <button class="btn block" style="margin-top:8px" onclick="createNurturerAssign('${medId}')">Create &amp; assign</button>
    </div>`;
  modal(h);
}
function anFilter(){ const q=($('an-q').value||'').toLowerCase(); document.querySelectorAll('#an-list .anrow').forEach(r=>{ r.style.display = r.dataset.t.includes(q)?'':'none'; }); }
async function assignProfile(medId, profileId, btn){
  let nid;
  const ex = (await sb.from('nurturers').select('id').eq('profile_id',profileId).limit(1)).data;
  if(ex && ex[0]) nid = ex[0].id;
  else {
    const p = (await sb.from('profiles').select('full_name,email,phone').eq('id',profileId).single()).data;
    const ins = await sb.from('nurturers').insert({full_name:p.full_name||p.email, phone:p.phone||null, profile_id:profileId, source:'login'}).select('id').single();
    if(ins.error) return toast(ins.error.message); nid = ins.data.id;
  }
  return assignNurturer(medId, nid, btn);
}
async function assignNurturer(medId, nurturerId, btn){
  const {error} = await sb.from('nurturer_assignments').upsert({meditator_id:medId, nurturer_id:nurturerId, assigned_by:ME.id},{onConflict:'meditator_id,nurturer_id',ignoreDuplicates:true});
  if(error) return toast(error.message);
  if(btn){ btn.textContent='Assigned'; btn.disabled=true; btn.classList.remove('green'); btn.classList.add('gray'); }
  cacheBust(); toast('Assigned'); celebrate('Assigned 🙏');
}
async function createNurturerAssign(medId){
  const name = ($('an-name').value||'').trim(); if(!name) return toast('Name required');
  const phone = (($('an-phone').value||'').replace(/\D/g,'').slice(-10)) || null;
  let profileId = null;
  if(phone){ const pr=(await sb.from('profiles').select('id').eq('phone',phone).limit(1)).data; if(pr&&pr[0]) profileId=pr[0].id; }
  const ins = await sb.from('nurturers').insert({full_name:name, phone, profile_id:profileId, source:'manual'}).select('id').single();
  if(ins.error) return toast(ins.error.message);
  await assignNurturer(medId, ins.data.id, null);
  closeModal(); toast('Created & assigned');
}
async function unassignNurturer(assignId, medId){
  const {error} = await sb.from('nurturer_assignments').delete().eq('id', assignId);
  if(error) return toast(error.message);
  cacheBust(); toast('Removed'); showMedById(medId);
}
// Quick "Nurture" -> a single dropdown of all nurturers (sector nurturers, nurturers,
// and anyone already entered as a nurturer) to assign this meditator to.
async function quickAssign(medId, medName){
  const nurturers = await cached('nurturers', ()=>fetchAll(()=>sb.from('nurturers').select('id,full_name,phone,profile_id')));
  const profs = (await sb.from('profiles').select('id,full_name,email,role').eq('active',true)
    .in('role',['nurturer','sector_nurturer','center_coordinator','admin'])).data||[];
  const linked = new Set(nurturers.filter(n=>n.profile_id).map(n=>n.profile_id));
  const opts = [];
  nurturers.slice().sort((a,b)=>(a.full_name||'').localeCompare(b.full_name||''))
    .forEach(n=>opts.push({v:'n:'+n.id, label:n.full_name + (n.profile_id?' · app user':'')}));
  profs.filter(p=>!linked.has(p.id)).sort((a,b)=>(a.full_name||a.email||'').localeCompare(b.full_name||b.email||''))
    .forEach(p=>opts.push({v:'p:'+p.id, label:(p.full_name||p.email)+' · '+roleLabel(p.role)}));
  if(!opts.length) return toast('No nurturers yet — add users or nurturers first');
  modal(`<h3>Assign nurturer</h3><p class="muted" style="font-size:.82rem">${esc(medName)}</p>
    <label>Nurturer</label>
    <select id="qa-sel">${opts.map(o=>`<option value="${o.v}">${esc(o.label)}</option>`).join('')}</select>
    <button class="btn block" style="margin-top:12px" onclick="quickAssignSave('${medId}','${esc(medName)}')">Assign</button>
    <p class="muted" style="font-size:.78rem;margin-top:8px">Need to add a brand-new nurturer or remove one? <a href="#" onclick="openAssignNurturer('${medId}','${esc(medName)}');return false">Open full manager</a></p>`);
}
async function quickAssignSave(medId, medName){
  const v = ($('qa-sel')||{}).value || ''; if(!v) return;
  const [t,id] = v.split(':');
  let nid;
  if(t==='n') nid = id;
  else {
    const ex = (await sb.from('nurturers').select('id').eq('profile_id',id).limit(1)).data;
    if(ex && ex[0]) nid = ex[0].id;
    else { const p=(await sb.from('profiles').select('full_name,email,phone').eq('id',id).single()).data;
      const ins=await sb.from('nurturers').insert({full_name:p.full_name||p.email, phone:p.phone||null, profile_id:id, source:'login'}).select('id').single();
      if(ins.error) return toast(ins.error.message); nid=ins.data.id; }
  }
  await assignNurturer(medId, nid, null);
  closeModal(); toast('Assigned'); if(CURRENT_VIEW==='people') renderPeople();
}

/* ============================================================
   Reusable selectable list: checkboxes + pagination + bulk actions
   (Message selected · Assign nurturer to selected)
   cfg = { rowFn, idOf, personOf, aud, assignable, pageSize }
   ============================================================ */
const BL = {};
const BL_MAXR = 500;   // safety cap on how many rows render at once
function bulkMount(ctx, host, items, cfg){
  const prev = BL[ctx];
  BL[ctx] = { items, host, from:(prev?prev.from:null), to:(prev?prev.to:null),
    sel:(prev&&prev.sel)||new Set(), rowFn:cfg.rowFn, idOf:cfg.idOf, personOf:cfg.personOf,
    aud:cfg.aud||'nurture', assignable:!!cfg.assignable, external:!!cfg.externalRange,
    bulkActions:cfg.bulkActions||[] };
  blRender(ctx);
  animateList(host);   // fluid add/remove + entrance for the list
}
// compute the visible slice (a From–To window, or everything capped at BL_MAXR)
function blSlice(ctx){
  const s=BL[ctx]; const total=s.items.length;
  const ranged = s.from!=null && s.to!=null;
  let start = ranged ? Math.max(0, s.from-1) : 0;
  let end   = ranged ? Math.min(total, s.to) : total;
  if(end<start) end=start;
  let shown = s.items.slice(start, end); let capped=false;
  if(shown.length>BL_MAXR){ shown=shown.slice(0,BL_MAXR); end=start+BL_MAXR; capped=true; }
  return {start,end,shown,capped,total,ranged};
}
function blRender(ctx){
  const s = BL[ctx]; if(!s) return;
  const {start,end,shown,capped,total,ranged} = blSlice(ctx);
  const shownIds = shown.map(s.idOf);
  const allSel = shownIds.length && shownIds.every(id=>s.sel.has(id));
  const sel = s.sel.size;
  // Quiet by default (just a Select-shown checkbox); a clean action bar fades in once something is ticked.
  let h = `<div class="bulkbar ${sel?'active':''}">
    <label class="selall"><input type="checkbox" ${allSel?'checked':''} onclick="blSelectPage('${ctx}',this.checked)"> Select shown</label>
    ${sel?`<span class="selcount">${sel} selected</span>` : ``}
    ${sel?`<span class="bulkacts">
      <button class="btn small green" onclick="blMessage('${ctx}')">✉️ Message</button>
      ${s.assignable?`<button class="btn small ghost" onclick="blAssign('${ctx}')">👤 Assign</button>`:''}
      ${s.bulkActions.map(a=>`<button class="btn small green" onclick="${a.fn}('${ctx}')">${a.label}</button>`).join('')}
      <button class="btn small gray" onclick="blClear('${ctx}')">Clear</button>
    </span>`:''}
    ${(sel && total>shown.length)?`<button class="btn small ghost" onclick="blSelectAll('${ctx}')">Select all ${total}</button>`:''}
  </div>`;
  if(!s.external){
    // sideways range: the from–to fields expand inline to the RIGHT of the chip (never drop down)
    h += `<details class="rangetog" ${ranged?'open':''}>
      <summary class="btn small ghost">↔ Range${ranged?` · ${s.from}–${s.to}`:''}</summary>
      <span class="rangefields">
        <input id="bl-from" type="number" min="1" placeholder="from" value="${ranged?s.from:''}">
        <span class="muted">to</span>
        <input id="bl-to" type="number" min="1" placeholder="to" value="${ranged?s.to:''}">
        <button class="btn small ghost" onclick="blRange('${ctx}')">Go</button>
        ${ranged?`<button class="btn small gray" onclick="blShowAll('${ctx}')">Show all</button>`:''}
      </span></details>`;
  }
  h += shown.map(it=>{ const id=s.idOf(it);
    return `<div class="selrow"><input type="checkbox" class="selcb" ${s.sel.has(id)?'checked':''} onclick="blToggle('${ctx}','${esc(id)}',this.checked)">${s.rowFn(it)}</div>`;
  }).join('') || '<div class="empty">No records.</div>';
  h += `<div class="pager">
    ${ranged?`<button class="btn small ghost" ${start<=0?'disabled':''} onclick="blStep('${ctx}',-1)">‹ Prev</button>`:''}
    <span>${total? (start+1)+'–'+end+' of '+total : '0'}${capped?` · capped at ${BL_MAXR}, narrow the range`:''}</span>
    ${ranged?`<button class="btn small ghost" ${end>=total?'disabled':''} onclick="blStep('${ctx}',1)">Next ›</button>`:''}
  </div>`;
  s.host.innerHTML = h;
}
function blRange(ctx){
  const s=BL[ctx];
  let f=parseInt(($('bl-from')||{}).value,10), t=parseInt(($('bl-to')||{}).value,10);
  if(isNaN(f)&&isNaN(t)) return blShowAll(ctx);
  if(isNaN(f)) f=1; if(isNaN(t)) t=f+49;
  if(f<1) f=1; if(t<f) t=f;
  s.from=f; s.to=t; blRender(ctx);
}
function blQuick(ctx,n){ const s=BL[ctx]; s.from=1; s.to=n; blRender(ctx); }
function blShowAll(ctx){ const s=BL[ctx]; s.from=null; s.to=null; blRender(ctx); }
function blStep(ctx,dir){ const s=BL[ctx]; const size=Math.max(1,s.to-s.from+1); s.from+=dir*size; s.to+=dir*size; if(s.from<1){ s.from=1; s.to=size; } blRender(ctx); }
function blToggle(ctx,id,on){ const s=BL[ctx]; on?s.sel.add(id):s.sel.delete(id); blRender(ctx); }
function blSelectPage(ctx,on){ const s=BL[ctx]; const {shown}=blSlice(ctx);
  shown.map(s.idOf).forEach(id=>on?s.sel.add(id):s.sel.delete(id)); blRender(ctx); }
function blSelectAll(ctx){ const s=BL[ctx]; s.items.forEach(it=>s.sel.add(s.idOf(it))); blRender(ctx); }
function blClear(ctx){ BL[ctx].sel.clear(); blRender(ctx); }
function blMessage(ctx){ const s=BL[ctx];
  const people=s.items.filter(it=>s.sel.has(s.idOf(it))).map(s.personOf).filter(p=>p&&p.phone);
  if(!people.length) return toast('No phone numbers in selection');
  openMsgAll(s.aud, people, 'Message selected ('+people.length+')'); }
async function blAssign(ctx){
  const s=BL[ctx]; const ids=[...s.sel]; if(!ids.length) return;
  const nurturers = await cached('nurturers', ()=>fetchAll(()=>sb.from('nurturers').select('id,full_name,phone,profile_id')));
  const profs = (await sb.from('profiles').select('id,full_name,email,role').eq('active',true).in('role',['nurturer','sector_nurturer','center_coordinator','admin'])).data||[];
  const linked=new Set(nurturers.filter(n=>n.profile_id).map(n=>n.profile_id));
  const opts=[];
  nurturers.slice().sort((a,b)=>(a.full_name||'').localeCompare(b.full_name||'')).forEach(n=>opts.push({v:'n:'+n.id,label:n.full_name+(n.profile_id?' · app user':'')}));
  profs.filter(p=>!linked.has(p.id)).forEach(p=>opts.push({v:'p:'+p.id,label:(p.full_name||p.email)+' · '+roleLabel(p.role)}));
  if(!opts.length) return toast('No nurturers available');
  modal(`<h3>Assign nurturer to ${ids.length} selected</h3>
    <label>Nurturer</label><select id="ba-sel">${opts.map(o=>`<option value="${o.v}">${esc(o.label)}</option>`).join('')}</select>
    <button class="btn block" style="margin-top:12px" onclick="blAssignSave('${ctx}')">Assign to ${ids.length} people</button>`);
}
async function blAssignSave(ctx){
  const s=BL[ctx]; const ids=[...s.sel]; const v=($('ba-sel')||{}).value||''; if(!v) return;
  const [t,id]=v.split(':'); let nid;
  if(t==='n') nid=id;
  else { const ex=(await sb.from('nurturers').select('id').eq('profile_id',id).limit(1)).data;
    if(ex&&ex[0]) nid=ex[0].id;
    else { const p=(await sb.from('profiles').select('full_name,email,phone').eq('id',id).single()).data;
      const ins=await sb.from('nurturers').insert({full_name:p.full_name||p.email,phone:p.phone||null,profile_id:id,source:'login'}).select('id').single();
      if(ins.error) return toast(ins.error.message); nid=ins.data.id; } }
  const rows=ids.map(mid=>({meditator_id:mid,nurturer_id:nid,assigned_by:ME.id}));
  const chunk=(a,n)=>{const o=[];for(let i=0;i<a.length;i+=n)o.push(a.slice(i,i+n));return o;};
  let ok=0;
  for(const b of chunk(rows,200)){ const r=await sb.from('nurturer_assignments').upsert(b,{onConflict:'meditator_id,nurturer_id',ignoreDuplicates:true}).select('id'); if(r.error) return toast(r.error.message); ok+=(r.data?r.data.length:0); }
  cacheBust(); closeModal(); toast('Assigned '+ids.length+' people'); celebrate('Assigned '+ids.length+' 🙏'); BL[ctx].sel.clear();
  if(CURRENT_VIEW) go(CURRENT_VIEW);
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
let ADV_MSG = {aud:'adv_completed', people:[], title:''};
function advSetView(v){
  if(v==='interested'){ PF.advanced.view='interested'; }
  else { PF.advanced.view='completed'; PF.advanced.window = (v==='completed_week')?'week':'all'; }
  renderPeople();
}
async function renderAdvancedList(tabBar){
  const f = PF.advanced;
  const meta = ADV_PROGS.find(p=>p[0]===f.program) || ADV_PROGS[0];
  const col = meta[2], label = meta[1];
  const sync = advSync();
  const centerOpts = `<option value="">All Centers</option>${CENTERS.map(c=>`<option value="${c.id}" ${f.center===c.id?'selected':''}>${c.name}</option>`).join('')}`;
  let advMountCfg = null;

  const ctx = f.view==='completed' ? 'adv_completed' : 'adv_interested';
  const tplAud = ctx;
  const activeF = [f.center,f.search].filter(Boolean).length;
  let h = tabBar;
  const progEmoji = {bsp:'🌀', shoonya:'🕉️', samyama:'🧘', guru_puja:'🙏'};
  // primary nav: program + view (+ window), then Message▾ / Import▾ menus
  h += `<div style="display:flex;gap:8px;margin:6px 0;flex-wrap:wrap;align-items:center">
      <select style="width:auto" onchange="PF.advanced.program=this.value;renderPeople()">
        ${ADV_PROGS.map(([v,l])=>`<option value="${v}" ${f.program===v?'selected':''}>${progEmoji[v]||''} ${l}</option>`).join('')}</select>
      <select style="width:auto" onchange="advSetView(this.value)">
        <option value="completed_week" ${(f.view==='completed'&&f.window==='week')?'selected':''}>✅ Completed · new this week</option>
        <option value="completed_all" ${(f.view==='completed'&&f.window!=='week')?'selected':''}>✅ Completed · all</option>
        <option value="interested" ${f.view==='interested'?'selected':''}>✋ Interested</option></select>
      <details class="menu"><summary class="btn small green">✉️ Message ▾</summary>
        <div class="menu-pop">
          <button class="btn small green" onclick="openMsgAll(ADV_MSG.aud,ADV_MSG.people,ADV_MSG.title)">✉️ Message all shown</button>
          <button class="btn small ghost" onclick="openTemplates('${tplAud}')">📝 Templates</button>
        </div></details>
      ${isCoord()?`<details class="menu"><summary class="btn small ghost">📥 Import ▾</summary>
        <div class="menu-pop">
          <button class="btn small ghost" onclick="advImport('excel','${f.program}')">From Excel / Sheet</button>
          <button class="btn small ghost" onclick="advImport('paper','${f.program}')">From paper form</button>
        </div></details>`:''}
  </div>`;
  h += `<details class="card vfilters" ${activeF?'open':''}>
    <summary>🔍 Filters &amp; range${activeF?` <span class="badge">${activeF}</span>`:''}</summary>
    <input placeholder="🔍 Search name/phone" style="width:100%;margin-top:10px" value="${esc(f.search)}"
      oninput="PF.advanced.search=this.value" onkeydown="if(event.key==='Enter')renderPeople()">
    <div class="choices" style="flex-wrap:wrap;gap:6px;margin-top:8px;align-items:center">
      <select style="width:auto" onchange="PF.advanced.center=this.value;renderPeople()">${centerOpts}</select>
      ${activeF?`<button class="btn small gray" onclick="PF.advanced.center='';PF.advanced.search='';renderPeople()">Clear filters</button>`:''}
    </div>
    ${rangeBlock(ctx,'adv-from','adv-to')}
  </details>`;

  if(f.view === 'completed'){
    h += `<p class="muted" style="font-size:.78rem;margin:6px 2px">Completed ${esc(label)} from Ishangam · last synced <b>${fmtD(sync.last_sync_date)}</b>.
      ${isCoord()?`<button class="btn small ghost" onclick="markSynced()" style="margin-left:6px">🔄 I synced today</button>`:''}</p>`;
    const winStart = f.window==='week' ? sync.prev_sync_date : null;   // 'all' = every completer, any date
    // fetch ALL completers for this program ONCE (cached); window/center/search filter client-side for instant switching
    const all = await cached('adv_comp_'+f.program, ()=>fetchAll(() => sb.from('people')
      .select(`id, full_name, phone, center_id, tags, photo_url, ${col}`)
      .eq('is_meditator', true).not(col,'is',null).order(col,{ascending:false})));
    let rows = all.slice();
    if(winStart) rows = rows.filter(p=>p[col] && p[col] >= winStart);
    if(f.center) rows = rows.filter(p=>p.center_id===f.center);
    if(f.search){ const s=f.search.toLowerCase(); rows = rows.filter(p=>p.full_name?.toLowerCase().includes(s)||p.phone?.includes(s)); }
    ADV_MSG = {aud:'adv_completed', people:rows.map(p=>({full_name:p.full_name,phone:p.phone})), title:'Message all — Completed '+label};
    h += `<div class="card"><h2>✅ Completed ${esc(label)} <span class="badge">${rows.length}</span></h2><div id="adv-host"></div></div>`;
    advMountCfg = {ctx:'adv_completed', items:rows, cfg:{externalRange:true, rowFn:p=>advCompletedRow(p,col,label), idOf:p=>p.id, personOf:p=>({full_name:p.full_name,phone:p.phone}), aud:'adv_completed', assignable:true}};
  } else {
    const all = await cached('adv_int_'+f.program, ()=>fetchAll(() => sb.from('advanced_interest')
      .select('id, program, interest_date, status, notes, people!inner(id, full_name, phone, center_id, tags, photo_url)')
      .eq('program', f.program).order('interest_date',{ascending:false})));
    let rows = all.slice();
    if(f.center) rows = rows.filter(r=>r.people?.center_id===f.center);
    if(f.search){ const s=f.search.toLowerCase(); rows = rows.filter(r=>r.people?.full_name?.toLowerCase().includes(s)||r.people?.phone?.includes(s)); }
    ADV_MSG = {aud:'adv_interested', people:rows.map(r=>({full_name:r.people?.full_name,phone:r.people?.phone})), title:'Message all — Interested '+label};
    h += `<div class="card"><h2>✋ Interested in ${esc(label)} <span class="badge">${rows.length}</span></h2>
      <p class="muted" style="font-size:.78rem;margin-bottom:6px">People interested in ${esc(label)} — from Ishangam willingness + paper sign-ups. Reach out and help them register.</p><div id="adv-host"></div></div>`;
    advMountCfg = {ctx:'adv_interested', items:rows, cfg:{externalRange:true, rowFn:r=>advInterestRow(r,label), idOf:r=>r.people?.id||r.id, personOf:r=>({full_name:r.people?.full_name,phone:r.people?.phone}), aud:'adv_interested', assignable:true}};
  }
  view().innerHTML = h;
  if(advMountCfg) bulkMount(advMountCfg.ctx, $('adv-host'), advMountCfg.items, advMountCfg.cfg);
}

function advCompletedRow(p, col, label){
  const msg = WA_MSG.advanced((p.full_name||'').split(' ')[0]);
  const onclk = `showPersonProfile(${JSON.stringify(personToProfile(p))})`;
  const extra = isCoord() ? `<button class="actbtn assign" onclick='startNurturing(${JSON.stringify({pid:p.id,name:p.full_name}).replace(/"/g,'&quot;').replace(/'/g,"&#39;")})'>Assign</button>` : '';
  return simpleRow({photo:p.photo_url, name:p.full_name, onclick:onclk, phone:p.phone, msg, extra});
}

function advInterestRow(r, label){
  const p = r.people || {};
  const msg = 'Namaskaram '+(p.full_name||'').split(' ')[0]+' -- You had expressed interest in '+label+'. We would love to help you register. When is a good time to talk?';
  const extra = isCoord() ? `<select class="actbtn-sel" onchange="setInterestStatus('${r.id}',this.value)">
    ${['new','contacted','registered','done','dropped'].map(s=>`<option value="${s}" ${r.status===s?'selected':''}>${s}</option>`).join('')}
  </select>` : '';
  const onclk = `showPersonProfile(${JSON.stringify(personToProfile(p))})`;
  return simpleRow({photo:p.photo_url, name:p.full_name, onclick:onclk, phone:p.phone, msg, extra});
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
function advImport(kind, program){
  if(kind==='paper') return openAddInterest(program);
  if(kind==='excel') return advImportExcel(program);
}
function advImportExcel(program){
  const label=(ADV_PROGS.find(p=>p[0]===program)||[])[1]||program;
  modal(`<h3>Import interested — ${esc(label)}</h3>
    <p class="muted" style="font-size:.8rem">Paste one per line as <b>Name, Phone</b> (from Excel or a Google Sheet). Each becomes an "interested in ${esc(label)}" entry, matched to existing meditators by phone.</p>
    <textarea id="advimp" style="min-height:170px" placeholder="Ramesh Kumar, 9876543210
Lakshmi, 9123456789"></textarea>
    <button class="btn block" onclick="advImportRun('${program}')">Import</button>`);
}
async function advImportRun(program){
  const lines=($('advimp').value||'').split('\n').map(s=>s.trim()).filter(Boolean);
  if(!lines.length) return toast('Paste some rows first');
  let ok=0, fail=0;
  for(const l of lines){
    const parts=l.split(/[,\t;]+/).map(s=>s.trim()).filter(Boolean);
    let name=null, phone=null;
    parts.forEach(p=>{ const d=p.replace(/\D/g,''); if(d.length>=10&&!phone)phone=d.slice(-10); else if(!name&&/[A-Za-z]/.test(p))name=p; });
    if(!name&&!phone){ fail++; continue; }
    const {data,error}=await sb.rpc('add_advanced_interest',{p_name:name||'',p_phone:phone||'',p_program:program,p_notes:'imported',p_pincode:null});
    if(error||data?.error) fail++; else ok++;
  }
  cacheBust(); closeModal(); toast('Imported '+ok+(fail?(' · '+fail+' skipped'):'')); renderPeople();
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
  if(ME.role==='nurturer') q = q.eq('assigned_to', ME.id);
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
    await loadScript(CDN.papa);
    rows = await new Promise(res => Papa.parse(f, {header:true, skipEmptyLines:true, complete:r=>res(r.data)}));
  } else {
    await loadScript(CDN.xlsx);
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
const INTERESTS = ['Online Calling','Online Operations','Offline Programs','Sadhguru Sannidhi','E-Media','Promotions','Devi Seva','Event Setup','Cooking/Annadanam','Transport','Can offer space'];
let VFILTER = {center:'', interest:'', mode:'', timing:'', space:false, activity:'', event:''};
let VOL_SHOWN = [];   // people currently shown in the active volunteer tab (for Message all)
function volMessageAll(){ if(!VOL_SHOWN.length) return toast('No one with a phone in this list'); openMsgAll('volunteer', VOL_SHOWN, 'Message volunteers'); }
const ssbEventNames = () => { const c=ssbCatalog(); return [...new Set([...(c.SSB?.event||[]), ...(c.IYC?.event||[])])]; };
let SHORTLIST = [];
let VOL_TAB = 'new';   // 'new' = new volunteer interest | 'all' = all existing volunteers
// SSB/IYC nested browser state: Org -> Type -> Name -> Year -> people
let SSB_NAV = {org:'', type:'', name:'', year:null};
const SSB_VTYPES = [['weekend','🚌 Weekend volunteering'],['program','🧘 Program volunteering'],['event','🎉 Event volunteering']];
const ssbTypeLabel = t => ({weekend:'Weekend volunteering', program:'Program volunteering', event:'Event volunteering'}[t]||t);
const ssbCatalog = () => SETTINGS.ssb_catalog || {SSB:{event:[],program:[]}, IYC:{event:[],program:[]}};
// "New interest" = only fresh submissions (added via form / photo OCR / CSV), marked status 'new'.
const isNewInterest = v => v.status==='new';

function icvRow(r, prof){
  const ph = r.phone;
  const msg = 'Namaskaram '+((r.full_name||'').split(' ')[0])+' -- You had expressed interest to volunteer when you completed Inner Engineering. We would love to have you involved at Isha Electronic City. When is a good time to talk?';
  const onclk = prof ? `showPersonProfile(${JSON.stringify(personToProfile(prof))})` : '';
  // Assign only when a synced profile exists (we need a person id to tag a nurturer)
  const assign = (isCoord() && prof) ? `<button class="actbtn assign" onclick="quickAssign('${prof.id}','${esc(prof.full_name||r.full_name||'')}')">Assign</button>` : '';
  // status tracking lives in a compact per-row menu so the row stays clean
  const statusMenu = isCoord() ? `<details class="menu"><summary class="actbtn log">⋯</summary><div class="menu-pop">
      <label class="muted" style="font-size:.72rem;margin:0">Status: <b>${esc(r.status||'new')}</b></label>
      <select onchange="setIcvStatus('${r.id}',this.value)">${['new','contacted','active','done','dropped'].map(s=>`<option value="${s}" ${r.status===s?'selected':''}>${s}</option>`).join('')}</select>
    </div></details>` : '';
  return simpleRow({photo:prof?.photo_url, name:prof?.full_name||r.full_name, onclick:onclk, phone:ph, msg, extra:assign+statusMenu});
}
async function setIcvStatus(id, status){ const {error}=await sb.from('ie_completion_volunteer').update({status}).eq('id', id); toast(error?error.message:'Updated'); }

/* ============================================================
   SSB / IYC volunteering browser  (Org -> Type -> Name -> Year -> people)
   ============================================================ */
async function ssbData(){
  return cached('ssbiyc', async()=>{
    const acts = await fetchAll(()=> sb.from('activities')
      .select('id,name,activity_date,is_open,qr_token,center_id,org,vol_type,event_name,event_year')
      .not('org','is',null).order('event_year',{ascending:false}));
    const ids = acts.map(a=>a.id); const counts = {};
    for(let i=0;i<ids.length;i+=200){
      const {data} = await sb.from('attendance').select('activity_id').in('activity_id', ids.slice(i,i+200));
      (data||[]).forEach(r=> counts[r.activity_id] = (counts[r.activity_id]||0)+1);
    }
    return {acts, counts};
  });
}
function ssbSet(o){ SSB_NAV = {...SSB_NAV, ...o}; renderVols(); }
const ssbSum = (arr,counts)=> arr.reduce((s,a)=>s+(counts[a.id]||0),0);

function renderSSBIYCBody(acts, counts){
  const N = SSB_NAV, cat = ssbCatalog();
  // breadcrumb
  let h = '<div class="card" style="padding:14px">';
  h += '<div class="crumb">';
  h += `<a href="#" onclick="ssbSet({org:'',type:'',name:'',year:null});return false">SSB / IYC</a>`;
  if(N.org)  h += ` › <a href="#" onclick="ssbSet({org:'${N.org}',type:'',name:'',year:null});return false">${N.org}</a>`;
  if(N.type) h += ` › <a href="#" onclick="ssbSet({org:'${N.org}',type:'${N.type}',name:'',year:null});return false">${ssbTypeLabel(N.type)}</a>`;
  if(N.name) h += ` › <a href="#" onclick="ssbSet({org:'${N.org}',type:'${N.type}',name:'${esc(N.name)}',year:null});return false">${esc(N.name)}</a>`;
  if(N.year) h += ` › <b>${N.year}</b>`;
  h += '</div>';
  const card = (icon, title, sub, onclick, badge)=>`<div class="navrow" onclick="${onclick}">
      <div class="ic">${icon||'📁'}</div>
      <div class="grow"><div class="name">${title}</div>${sub?`<div class="sub">${sub}</div>`:''}</div>
      ${badge!=null?`<span class="badge">${badge}</span>`:''}<span class="chev">›</span></div>`;
  const TYPE_IC = {weekend:'🚌', program:'🧘', event:'🎉'};

  // L0 — pick org
  if(!N.org){
    h += '<h2 style="margin-bottom:10px">Choose organisation</h2>';
    ['SSB','IYC'].forEach(o=>{
      const a = acts.filter(x=>x.org===o);
      h += card(o==='SSB'?'🛕':'🏞️', o==='SSB'?'SSB · Sadhguru Sannidhi':'IYC · Isha Yoga Center',
        a.length+' occurrence'+(a.length===1?'':'s')+' · '+ssbSum(a,counts)+' attendees',
        `ssbSet({org:'${o}',type:'',name:'',year:null})`);
    });
    return h+'</div>';
  }
  // L1 — pick type
  if(!N.type){
    h += `<h2 style="margin-bottom:10px">${N.org} — choose type</h2>`;
    SSB_VTYPES.forEach(([t])=>{
      const a = acts.filter(x=>x.org===N.org && x.vol_type===t);
      h += card(TYPE_IC[t], ssbTypeLabel(t), a.length+' occurrence'+(a.length===1?'':'s')+' · '+ssbSum(a,counts)+' attendees',
        `ssbSet({org:'${N.org}',type:'${t}',name:'',year:null})`);
    });
    return h+'</div>';
  }
  // WEEKEND: skip name, go straight to years
  if(N.type==='weekend'){
    if(!N.year){
      const ys = [...new Set(acts.filter(x=>x.org===N.org&&x.vol_type==='weekend').map(x=>x.event_year))].sort((a,b)=>b-a);
      h += `<h2 style="margin-bottom:8px">${N.org} · Weekend volunteering — by year</h2>`;
      h += `<button class="btn small ghost" style="margin-bottom:8px" onclick="ssbAddWeekendTrip('${N.org}')">➕ Add weekend trip</button>`;
      ys.forEach(y=>{ const a=acts.filter(x=>x.org===N.org&&x.vol_type==='weekend'&&x.event_year===y);
        h += card('📅', y, a.length+' trip'+(a.length===1?'':'s')+' · '+ssbSum(a,counts)+' attendees', `ssbSet({year:${y}})`); });
      if(!ys.length) h += '<div class="empty">No weekend trips yet.</div>';
      return h+'</div>';
    }
    const trips = acts.filter(x=>x.org===N.org&&x.vol_type==='weekend'&&x.event_year===N.year)
                      .sort((a,b)=>(a.activity_date<b.activity_date?1:-1));
    h += `<h2 style="margin-bottom:8px">${N.org} · Weekend trips ${N.year}</h2>`;
    h += trips.map(a=>ssbOccRow(a,counts)).join('') || '<div class="empty">No trips.</div>';
    return h+'</div>';
  }
  // PROGRAM / EVENT: pick name
  if(!N.name){
    const present = [...new Set(acts.filter(x=>x.org===N.org&&x.vol_type===N.type).map(x=>x.event_name).filter(Boolean))];
    const names = [...new Set([...((cat[N.org]||{})[N.type]||[]), ...present])];
    h += `<h2 style="margin-bottom:8px">${N.org} · ${ssbTypeLabel(N.type)}</h2>`;
    h += `<button class="btn small ghost" style="margin-bottom:8px" onclick="ssbAddName('${N.org}','${N.type}')">➕ Add ${N.type} name</button>`;
    names.forEach(nm=>{ const a=acts.filter(x=>x.org===N.org&&x.vol_type===N.type&&x.event_name===nm);
      h += card(N.type==='event'?'🎉':'🧘', esc(nm), a.length+' year'+(a.length===1?'':'s')+' · '+ssbSum(a,counts)+' attendees',
        `ssbSet({name:'${esc(nm)}',year:null})`); });
    if(!names.length) h += '<div class="empty">No names yet — add one.</div>';
    return h+'</div>';
  }
  // PROGRAM / EVENT: pick year
  if(!N.year){
    const ys = [...new Set(acts.filter(x=>x.org===N.org&&x.vol_type===N.type&&x.event_name===N.name).map(x=>x.event_year))].sort((a,b)=>b-a);
    h += `<h2 style="margin-bottom:8px">${esc(N.name)} — by year</h2>`;
    h += `<button class="btn small ghost" style="margin-bottom:8px" onclick="ssbAddYear('${N.org}','${N.type}','${esc(N.name)}')">➕ Add year</button>`;
    ys.forEach(y=>{ const a=acts.filter(x=>x.org===N.org&&x.vol_type===N.type&&x.event_name===N.name&&x.event_year===y);
      h += card('📅', y, ssbSum(a,counts)+' attendees', `ssbSet({year:${y}})`); });
    if(!ys.length) h += '<div class="empty">No years yet — add one.</div>';
    return h+'</div>';
  }
  // LEAF: occurrence(s) for this org/type/name/year
  const matches = acts.filter(x=>x.org===N.org&&x.vol_type===N.type&&x.event_name===N.name&&x.event_year===N.year);
  h += `<h2 style="margin-bottom:8px">${esc(N.name)} ${N.year}</h2>`;
  if(!matches.length){
    h += `<div class="empty">No occurrence yet for ${N.year}.</div>
      <button class="btn block" onclick="ssbCreateOccurrence('${N.org}','${N.type}','${esc(N.name)}',${N.year})">➕ Create ${esc(N.name)} ${N.year}</button>`;
    return h+'</div>';
  }
  h += matches.map(a=>ssbOccRow(a,counts)).join('');
  return h+'</div>';
}
// one occurrence row with its action buttons
function ssbOccRow(a, counts){
  const n = counts[a.id]||0;
  const t = a.qr_token;
  return `<div class="card" style="padding:12px;margin:8px 0">
    <div class="name">${esc(a.name)} ${a.is_open?'<span class="badge green">open</span>':'<span class="badge gray">closed</span>'}</div>
    <div class="sub" style="margin:2px 0 8px">${fmtD(a.activity_date)} · <b>${n}</b> attendee${n===1?'':'s'}</div>
    <div class="choices" style="gap:6px">
      <button class="btn small ghost" onclick="viewAttendees('${a.id}','${esc(a.name)}')">👥 Attendees</button>
      <button class="btn small ghost" onclick="ssbAddPerson('${a.id}')">➕ Add person</button>
      <button class="btn small ghost" onclick="ssbImport('${a.id}','${esc(a.name)}')">📥 Import list</button>
      ${t?`<button class="btn small ghost" onclick="showQR('${t}','${esc(a.name)}')">📲 QR</button>`:''}
      <button class="btn small gray" onclick="toggleActivity('${a.id}',${!a.is_open})">${a.is_open?'Close':'Reopen'}</button>
    </div></div>`;
}
async function ssbAddName(org, type){
  const name = (prompt('New '+type+' name under '+org+':')||'').trim(); if(!name) return;
  const cat = JSON.parse(JSON.stringify(ssbCatalog()));
  cat[org] = cat[org]||{}; cat[org][type] = cat[org][type]||[];
  if(!cat[org][type].includes(name)) cat[org][type].push(name);
  const {error} = await sb.from('settings').upsert({key:'ssb_catalog', value:cat},{onConflict:'key'});
  if(error) return toast(error.message);
  SETTINGS.ssb_catalog = cat; toast('Added'); ssbSet({name});
}
async function ssbAddYear(org, type, name){
  const y = (prompt('Year (e.g. 2025):')||'').trim(); const year = parseInt(y,10);
  if(!year || year<2000 || year>2100) return toast('Enter a valid year');
  await ssbCreateOccurrence(org, type, name, year);
}
async function ssbAddWeekendTrip(org){
  const d = (prompt('Trip date (YYYY-MM-DD):', today())||'').trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(d)) return toast('Use YYYY-MM-DD');
  const year = +d.slice(0,4);
  const {error} = await sb.from('activities').insert({name:'Weekend Trip — '+fmtD(d), center_id:'ecity',
    activity_type:'ashram_visit', org, vol_type:'weekend', event_name:'Weekend Trip', event_year:year,
    is_open:true, created_by:ME.id, activity_date:d, description:'SSB weekend trip'});
  if(error) return toast(error.message);
  cacheBust(); toast('Created'); ssbSet({year});
}
async function ssbCreateOccurrence(org, type, name, year){
  const adate = year+'-01-01';
  const {error} = await sb.from('activities').insert({name:name+' '+year+' ('+org+')', center_id:'ecity',
    activity_type:type, org, vol_type:type, event_name:name, event_year:year,
    is_open:true, created_by:ME.id, activity_date:adate, description:'SSB/IYC '+type+' — '+name+' '+year});
  if(error) return toast(error.message);
  cacheBust(); toast('Created'); SSB_NAV={org,type,name,year}; renderVols();
}
function ssbImport(actId, actName){
  modal(`<h3>Import attendees</h3><p class="muted" style="font-size:.82rem">${esc(actName)}</p>
    <p class="muted" style="font-size:.8rem">Paste one person per line as <b>Name, Phone</b> (or just the phone number). New people are created automatically and added as attendees.</p>
    <textarea id="ssb-imp" style="min-height:170px" placeholder="Ramesh Kumar, 9876543210
Lakshmi, 9123456789"></textarea>
    <button class="btn block" onclick="ssbImportRun('${actId}')">Import</button>`);
}
async function ssbImportRun(actId){
  const lines = ($('ssb-imp').value||'').split('\n').map(s=>s.trim()).filter(Boolean);
  const recs = []; const seen=new Set();
  lines.forEach(l=>{
    const parts = l.split(/[,\t;]+/).map(s=>s.trim()).filter(Boolean);
    let name=null, phone=null;
    parts.forEach(p=>{ const d=p.replace(/\D/g,''); if(d.length>=10 && !phone) phone=d.slice(-10); else if(!name && /[A-Za-z]/.test(p)) name=p; });
    if(phone && !seen.has(phone)){ seen.add(phone); recs.push({name:name||'(no name)', phone}); }
  });
  if(!recs.length) return toast('No valid phone numbers found');
  const chunk=(a,n)=>{const o=[];for(let i=0;i<a.length;i+=n)o.push(a.slice(i,i+n));return o;};
  for(const b of chunk(recs,150)){
    const {error}=await sb.from('people').upsert(b.map(r=>({full_name:r.name,phone:r.phone,center_id:'ecity',is_volunteer:true,source:'csv'})),{onConflict:'phone',ignoreDuplicates:true});
    if(error) return toast(error.message);
  }
  const idByPhone={}; const phones=recs.map(r=>r.phone);
  for(const b of chunk(phones,200)){ const {data}=await sb.from('people').select('id,phone').in('phone',b); (data||[]).forEach(p=>idByPhone[p.phone]=p.id); }
  const att = recs.filter(r=>idByPhone[r.phone]).map(r=>({activity_id:actId, person_id:idByPhone[r.phone]}));
  let added=0;
  for(const b of chunk(att,150)){ const {data,error}=await sb.from('attendance').upsert(b,{onConflict:'activity_id,person_id',ignoreDuplicates:true}).select('id'); if(error) return toast(error.message); added+=(data?data.length:0); }
  cacheBust(); closeModal(); toast('Imported '+recs.length+' ('+added+' new)'); renderVols();
}
function ssbAddPerson(actId){
  modal(`<h3>Add attendee</h3>
    <input id="ssb-q" placeholder="Search name or phone (3+ chars)" oninput="ssbAddSearch('${actId}')" autofocus>
    <div id="ssb-res" style="margin-top:8px"><div class="muted">Type to search existing people…</div></div>`);
}
async function ssbAddSearch(actId){
  const q=($('ssb-q').value||'').trim(); const res=$('ssb-res'); if(!res) return;
  if(q.length<3){ res.innerHTML='<div class="muted">Type 3+ characters…</div>'; return; }
  const d=q.replace(/\D/g,'');
  let qb = sb.from('people').select('id,full_name,phone').limit(20);
  qb = d.length>=4 ? qb.ilike('phone','%'+d+'%') : qb.ilike('full_name','%'+q+'%');
  const {data} = await qb;
  res.innerHTML = (data||[]).map(p=>`<div class="row"><div class="grow"><div class="name">${esc(p.full_name||'?')}</div><div class="sub">${esc(p.phone||'')}</div></div>
    <button class="btn small green" onclick="ssbAttach('${actId}','${p.id}',this)">Add</button></div>`).join('') || '<div class="empty">No match</div>';
}
async function ssbAttach(actId, pid, btn){
  const {error}=await sb.from('attendance').upsert({activity_id:actId, person_id:pid},{onConflict:'activity_id,person_id',ignoreDuplicates:true});
  if(error) return toast(error.message);
  if(btn){ btn.textContent='Added ✓'; btn.disabled=true; btn.classList.remove('green'); btn.classList.add('gray'); }
  cacheBust();
}

async function renderVols(){
  view().innerHTML = skel();
  const vps = await cached('vols', () => fetchAll(() => sb.from('volunteer_profiles')
    .select('*, people!inner(id, full_name, phone, email, pincode, center_id, ie_date, bsp_date, shoonya_date, samyama_date, guru_puja_date, occupation, gender, date_of_birth, street, city, area, tags, photo_url)')
    .order('updated_at', {ascending:false})));
  const hist = await cached('vol_hist', () => fetchAll(() => sb.from('volunteer_history')
    .select('person_id, activity, happened_on').order('happened_on',{ascending:false})));
  const histBy = {};
  (hist||[]).forEach(r=>{ (histBy[r.person_id] ||= []).push(r); });

  // split into the two folders the team asked for
  const newCount = (vps||[]).filter(isNewInterest).length;
  const allCount = (vps||[]).length;

  // attendance index (person_id -> attended vol_types/event_names) for the Activity filter
  const attIdx = VFILTER.activity ? await cached('vol_att_idx', async()=>{
    const rows = await fetchAll(()=> sb.from('attendance').select('person_id, activities(vol_type,event_name)'));
    const m={}; (rows||[]).forEach(r=>{ const a=r.activities; if(!a) return;
      const e=(m[r.person_id] ||= {types:new Set(), events:new Set()});
      if(a.vol_type) e.types.add(a.vol_type); if(a.event_name) e.events.add(a.event_name); });
    return m;
  }) : null;

  const list = (vps||[]).filter(v=>{
    if(VOL_TAB==='new' && !isNewInterest(v)) return false;
    if(VFILTER.center && derivedCenter(v.people)!==VFILTER.center) return false;
    if(VFILTER.interest){
      if(VFILTER.interest==='Can offer space'){ if(!v.can_offer_space && !(v.interests||[]).includes('Can offer space')) return false; }
      else if(!(v.interests||[]).includes(VFILTER.interest)) return false; }
    if(VFILTER.mode && v.mode!==VFILTER.mode && v.mode!=='both') return false;
    if(VFILTER.timing && v.preferred_timing!==VFILTER.timing && v.preferred_timing!=='flexible') return false;
    if(VFILTER.activity){ const e=attIdx&&attIdx[v.person_id];
      if(!e || !e.types.has(VFILTER.activity)) return false;
      if(VFILTER.activity==='event' && VFILTER.event && !e.events.has(VFILTER.event)) return false; }
    if(VFILTER.search){ const s=VFILTER.search.toLowerCase(), d=s.replace(/\D/g,''), p=v.people||{};
      if(!((p.full_name||'').toLowerCase().includes(s) || (d && (p.phone||'').includes(d)))) return false; }
    return true;
  });

  // Ashram/SSB volunteering follow-up journeys (moved here from Meditators)
  const ashram = await cached('vol_ashram', () => fetchAll(() => {
    let q = sb.from('journeys')
      .select('id, type, program_name, program_date, status, sadhana_status, assigned_to, center_id, people(id, full_name, phone, center_id), calls(id, call_no, due_date, completed_at)')
      .eq('type', 'volunteer_nurture').order('program_date', {ascending:false});
    if(ME.role==='nurturer') q = q.eq('assigned_to', ME.id);
    return q;
  }));

  // recent activities for event management

  // IE Completion volunteer-interest list (cached once; count = list length, avoids a slow exact-count query).
  const icvList = await cached('icv', () => fetchAll(()=>sb.from('ie_completion_volunteer').select('*').order('ie_date',{ascending:false,nullsFirst:false})));
  const icvCount = icvList.length;

  VOL_SHOWN = list.map(v=>({full_name:v.people?.full_name, phone:v.people?.phone})).filter(p=>p.phone);

  let h = `<div style="display:flex;gap:8px;margin:6px 0;flex-wrap:wrap;align-items:center">
    <select onchange="volSection(this.value)" style="width:auto;font-weight:700;min-width:180px">
      <option value="new" ${VOL_TAB==='new'?'selected':''}>✨ New interest (${newCount})</option>
      <option value="all" ${VOL_TAB==='all'?'selected':''}>🙌 All volunteers (${allCount})</option>
      <option value="ssbiyc" ${VOL_TAB==='ssbiyc'?'selected':''}>🙏 SSB / IYC</option>
      <option value="ie_completion" ${VOL_TAB==='ie_completion'?'selected':''}>🪷 IEO Completion (${icvCount})</option>
    </select>
    <details class="menu"><summary class="btn small green">✉️ Message ▾</summary>
      <div class="menu-pop">
        <button class="btn small green" onclick="volMessageAll()">✉️ Message all shown</button>
        <button class="btn small ghost" onclick="openTemplates('volunteer')">📝 Templates</button>
      </div></details>
    <details class="menu"><summary class="btn small ghost">＋ Add ▾</summary>
      <div class="menu-pop">
        <button class="btn small ghost" onclick="openPaperOCR()">📄 Paper Form (OCR)</button>
        <button class="btn small ghost" onclick="openVolForm()">➕ Add interest</button>
        <button class="btn small ghost" onclick="openGFormHelp()">📝 Google Form</button>
        ${SHORTLIST.length?`<button class="btn small green" onclick="shareShortlist()">📤 Share shortlist (${SHORTLIST.length})</button>`:''}
      </div></details>
  </div>`;

  // IE Completion volunteer-interest folder (sorted by IE date, newest first)
  if(VOL_TAB==='ie_completion'){
    let rows = icvList.slice();
    // back-annotate: match each row to a people profile by phone (cached)
    const profByPhone = await cached('icv_prof', async()=>{
      const phones=[...new Set(icvList.map(r=>r.phone).filter(Boolean))];
      const map={};
      for(let i=0;i<phones.length;i+=300){
        const {data} = await sb.from('people')
          .select('id, full_name, phone, email, pincode, center_id, ie_date, bsp_date, shoonya_date, samyama_date, guru_puja_date, occupation, gender, date_of_birth, street, city, area, tags, photo_url')
          .in('phone', phones.slice(i,i+300));
        (data||[]).forEach(p=>map[p.phone]=p);
      }
      return map;
    });
    if(VFILTER.search){ const s=VFILTER.search.toLowerCase(); rows = rows.filter(r=>r.full_name?.toLowerCase().includes(s)||r.phone?.includes(s)); }
    if(VFILTER.center){ rows = rows.filter(r=>derivedCenter(profByPhone[r.phone])===VFILTER.center); }
    const matched = rows.filter(r=>profByPhone[r.phone]).length;
    h += `<div class="card" style="padding:10px">
      <div class="choices" style="gap:6px;margin-bottom:8px">
        <select style="width:auto" onchange="VFILTER.center=this.value;renderVols()">
          <option value="">All centers</option>${CENTERS.map(c=>`<option value="${c.id}" ${VFILTER.center===c.id?'selected':''}>${c.name}</option>`).join('')}</select>
      </div>
      <input placeholder="Search name/phone" style="width:100%" value="${esc(VFILTER.search||'')}"
        oninput="VFILTER.search=this.value" onkeydown="if(event.key==='Enter')renderVols()">
    </div>`;
    h += `<div class="card"><h2>🪷 IEO Completion Form — Volunteer Interest <span class="badge">${rows.length}</span></h2>
      <p class="muted" style="font-size:.78rem;margin-bottom:6px">People who ticked "Volunteer" on an IE completion form in Ishangam (Electronic City), segregated by center (from pincode). ${matched}/${rows.length} shown have a synced profile. Newest IE first.</p><div id="icv-host"></div></div>`;
    VOL_SHOWN = rows.map(r=>({full_name:r.full_name, phone:r.phone})).filter(p=>p.phone);
    view().innerHTML = h;
    bulkMount('icv', $('icv-host'), rows, {pageSize:30, rowFn:r=>icvRow(r, profByPhone[r.phone]), idOf:r=>r.phone, personOf:r=>({full_name:r.full_name,phone:r.phone}), aud:'volunteer', assignable:false});
    return;
  }

  // SSB / IYC: Org -> Type -> Name -> Year -> people (built on activities + attendance)
  if(VOL_TAB==='ssbiyc'){
    VOL_SHOWN = [];
    const {acts, counts} = await ssbData();
    h += renderSSBIYCBody(acts, counts);
    view().innerHTML = h;
    return;
  }

  // (Recent Events moved to the Admin tab — managed there by Sector Nurturers / Admin.)

  const activeF = [VFILTER.center,VFILTER.activity,VFILTER.interest,VFILTER.mode,VFILTER.timing,VFILTER.search].filter(Boolean).length;
  const vfFrom = (BL.vol&&BL.vol.from!=null)?BL.vol.from:'', vfTo = (BL.vol&&BL.vol.to!=null)?BL.vol.to:'';
  h += `<details class="card vfilters" ${activeF||vfFrom!==''?'open':''}>
    <summary>🔍 Filters &amp; range${activeF?` <span class="badge">${activeF}</span>`:''}</summary>
    <input placeholder="🔍 Search name or phone" style="width:100%;margin-top:10px" value="${esc(VFILTER.search||'')}"
      oninput="VFILTER.search=this.value" onkeydown="if(event.key==='Enter')renderVols()">
    <div class="choices" style="flex-wrap:wrap;gap:6px;margin-top:8px">
      <select style="width:auto" onchange="VFILTER.center=this.value;renderVols()">
        <option value="">All centers</option>${CENTERS.map(c=>`<option value="${c.id}" ${VFILTER.center===c.id?'selected':''}>${c.name}</option>`).join('')}</select>
      <select style="width:auto" onchange="VFILTER.activity=this.value;VFILTER.event='';renderVols()">
        <option value="">Any activity</option>
        <option value="weekend" ${VFILTER.activity==='weekend'?'selected':''}>🚌 Weekend volunteering</option>
        <option value="program" ${VFILTER.activity==='program'?'selected':''}>🧘 Program volunteering</option>
        <option value="event" ${VFILTER.activity==='event'?'selected':''}>🎉 Event volunteering</option></select>
      ${VFILTER.activity==='event' ? `<select style="width:auto" onchange="VFILTER.event=this.value;renderVols()">
        <option value="">All events</option>${ssbEventNames().map(n=>`<option ${VFILTER.event===n?'selected':''}>${esc(n)}</option>`).join('')}</select>` : ''}
      <select style="width:auto" onchange="VFILTER.interest=this.value;renderVols()">
        <option value="">Any interest</option>${INTERESTS.map(i=>`<option ${VFILTER.interest===i?'selected':''}>${i}</option>`).join('')}</select>
      <select style="width:auto" onchange="VFILTER.mode=this.value;renderVols()">
        <option value="">Online/Offline</option><option value="online" ${VFILTER.mode==='online'?'selected':''}>Online</option><option value="offline" ${VFILTER.mode==='offline'?'selected':''}>Offline</option></select>
      <select style="width:auto" onchange="VFILTER.timing=this.value;renderVols()">
        <option value="">Any timing</option><option value="weekday_morning">Weekday AM</option>
        <option value="weekday_evening">Weekday PM</option><option value="weekend">Weekends</option></select>
      ${activeF?`<button class="btn small gray" onclick="VFILTER={center:'',interest:'',mode:'',timing:'',space:false,activity:'',event:'',search:''};renderVols()">Clear filters</button>`:''}
    </div>
    <details class="rangetog" ${vfFrom!==''?'open':''} style="margin-top:10px">
      <summary class="btn small ghost">↔ Range${vfFrom!==''?` · ${vfFrom}–${vfTo}`:''}</summary>
      <span class="rangefields">
        <input id="vf-from" type="number" min="1" placeholder="from" value="${vfFrom}">
        <span class="muted">to</span>
        <input id="vf-to" type="number" min="1" placeholder="to" value="${vfTo}">
        <button class="btn small ghost" onclick="volApplyRange()">Go</button>
        ${vfFrom!==''?`<button class="btn small gray" onclick="volApplyRange(true)">Show all</button>`:''}
      </span></details>
    </details>
  <div class="card"><h2>${VOL_TAB==='new'?'New volunteer interest':'All existing volunteers'} <span class="badge">${list.length}</span></h2><div id="vol-host"></div></div>`;
  view().innerHTML = h;
  bulkMount('vol', $('vol-host'), list, {externalRange:true, rowFn:v=>volRow(v, histBy[v.person_id]||[]), idOf:v=>v.person_id, personOf:v=>({full_name:v.people?.full_name,phone:v.people?.phone}), aud:'volunteer', assignable:true});
}
function volSection(v){ if(v==='ssbiyc') SSB_NAV={org:'',type:'',name:'',year:null}; VOL_TAB=v; renderVols(); }
// generic external From–To applier (reused by Meditators / Advanced / Volunteers filter panels)
function blApplyRange(ctx, fromId, toId, clear){
  if(!BL[ctx]) return;
  if(clear){ BL[ctx].from=null; BL[ctx].to=null; blRender(ctx); return; }
  let f=parseInt(($(fromId)||{}).value,10), t=parseInt(($(toId)||{}).value,10);
  if(isNaN(f)&&isNaN(t)){ BL[ctx].from=null; BL[ctx].to=null; }
  else { f=isNaN(f)?1:Math.max(1,f); t=isNaN(t)?f+49:Math.max(f,t); BL[ctx].from=f; BL[ctx].to=t; }
  blRender(ctx);
}
function volApplyRange(clear){ blApplyRange('vol','vf-from','vf-to',clear); }
// small From–To range block for a unified filters panel
function rangeBlock(ctx, fromId, toId){
  const s=BL[ctx]||{}; const from=(s.from!=null)?s.from:'', to=(s.to!=null)?s.to:''; const ranged=from!=='';
  return `<details class="rangetog" ${ranged?'open':''} style="margin-top:10px">
    <summary class="btn small ghost">↔ Range${ranged?` · ${from}–${to}`:''}</summary>
    <span class="rangefields">
      <input id="${fromId}" type="number" min="1" placeholder="from" value="${from}">
      <span class="muted">to</span>
      <input id="${toId}" type="number" min="1" placeholder="to" value="${to}">
      <button class="btn small ghost" onclick="blApplyRange('${ctx}','${fromId}','${toId}')">Go</button>
      ${ranged?`<button class="btn small gray" onclick="blApplyRange('${ctx}','${fromId}','${toId}',true)">Show all</button>`:''}
    </span></details>`;
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
  const msg = `Namaskaram ${(p.full_name||'').split(' ')[0]} -- There's a volunteering opportunity at Isha ${centerName(derivedCenter(p))} that matches your interest${v.interests?.length?' in '+v.interests[0]:''}. Would you like to join?`;
  const onclk = `showVolProfile(${JSON.stringify({p:personToProfile(p),id:p.id,interests:v.interests||[],mode:v.mode,space:v.can_offer_space,screened:v.screened,h:hist.slice(0,15)})})`;
  const extra = isCoord() ? `<button class="actbtn assign" onclick="quickAssign('${p.id}','${esc(p.full_name)}')">Assign</button>` : '';
  return simpleRow({photo:p.photo_url, name:p.full_name, onclick:onclk, phone:p.phone, msg, extra});
}
function showVolProfile(d){
  const interests = (d.interests||[]).length ? `<p>🤝 Interests: ${(d.interests).map(esc).join(', ')}</p>` : '';
  const pref = [d.mode, d.space?'can offer space':null].filter(Boolean).map(esc).join(' · ');
  const hist = (d.h&&d.h.length)
    ? `<p style="margin-top:8px">📋 Volunteering history:</p><table class="mini"><tr><th>Activity</th><th>Date</th></tr>${d.h.map(r=>`<tr><td>${esc(r.activity)}</td><td>${fmtD(r.happened_on)}</td></tr>`).join('')}</table>`
    : '<p class="muted" style="margin-top:8px">No volunteering history yet.</p>';
  modal(`<h3>${esc(d.p.n)}</h3>${profileBody(d.p)}
    ${interests}${pref?`<p>🕒 ${pref}</p>`:''}${hist}`);
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
    '<label>Notes</label><textarea id="vf-notes"></textarea>' +
    '<button class="btn block" onclick="saveVolForm()">Save</button>';
}
function openVolForm(pre){ modal('<h3>Volunteer interest</h3>' + volFormHTML(pre||{})); }
async function saveVolForm(){
  const interests = [...document.querySelectorAll('#vf-int button.sel')].map(b=>b.textContent);
  const row = {full_name:$('vf-name').value, phone:$('vf-phone').value, pincode:$('vf-pin').value,
    kind:'volunteer', interests, preferred_timing:$('vf-timing').value, mode:$('vf-mode').value,
    can_offer_space:interests.includes('Can offer space'), source:'paper'};
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
  view().innerHTML = skel();
  // Exclude 'dropped' journeys (e.g. cleared stale backlog) from all insights.
  const [J, C, V] = await cached('insights', ()=>Promise.all([
    fetchAll(()=> sb.from('journeys').select('id, type, status, sadhana_status, center_id, assigned_to').neq('status','dropped')),
    fetchAll(()=> sb.from('calls').select('id, due_date, completed_at, reachability, journey_id, journeys!inner(status)').neq('journeys.status','dropped')),
    fetchAll(()=> sb.from('volunteer_history').select('id, person_id, activity, center_id, happened_on'))
  ]));
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

  const tap = 'style="cursor:pointer" ';
  let h = '<div class="stats">' +
    '<div class="stat" ' + tap + 'onclick="drillTo(\'people\',\'new_meditator\')"><div class="n">' + m1.length + '</div><div class="l">🌱 New meditators ›</div></div>' +
    '<div class="stat" ' + tap + 'onclick="drillTo(\'people\',\'new_meditator\',{status:\'completed\'})"><div class="n">' + m1done + '</div><div class="l">✅ Mandala journeys done ›</div></div>' +
    '<div class="stat" ' + tap + 'onclick="drillTo(\'today\')"><div class="n">' + overdue.length + '</div><div class="l">⏰ Overdue calls ›</div></div>' +
    '<div class="stat"><div class="n">' + (done.length?Math.round(answered.length/done.length*100):0) + '%</div><div class="l">📈 Answer rate</div></div>' +
    '<div class="stat" ' + tap + 'onclick="drillTo(\'people\',\'advanced\')"><div class="n">' + J.filter(j=>j.type==='advanced').length + '</div><div class="l">⭐ Advanced completers ›</div></div>' +
    '<div class="stat" ' + tap + 'onclick="drillTo(\'vols\')"><div class="n">' + V.length + '</div><div class="l">🙌 Volunteering records ›</div></div>' +
    '</div>';
  if(suggestions.length)
    h += '<div class="card"><h2>💡 Planning Suggestions</h2>' + suggestions.map(s=>'<div class="row"><div class="grow">' + s + '</div></div>').join('') + '</div>';
  const hasDist = Object.keys(dist).length;
  h += '<details class="acc" id="acc-dist" ' + (hasDist?'open':'') + '><summary>🧘 Sadhana status distribution</summary><div class="acc-body">' +
    (hasDist ? '<canvas id="ch-dist" height="220"></canvas>'
             : '<div class="empty">No sadhana statuses logged yet — as calls get logged, this chart will fill in.</div>') +
    '</div></details>';
  if(isCoord()) h += '<details class="acc" id="acc-center"><summary>📊 Call completion by center</summary><div class="acc-body"><canvas id="ch-center" height="200"></canvas></div></details>';
  h += '<details class="acc"><summary>📋 Per-status counts</summary><div class="acc-body"><table class="mini"><tr><th>Status</th><th>People</th></tr>' +
    (Object.entries(dist).sort((a,b)=>b[1]-a[1]).map(([s,n])=>'<tr><td>' + esc(s) + '</td><td>' + n + '</td></tr>').join('')||'<tr><td colspan=2 class="muted">No logged statuses yet</td></tr>') +
    '</table></div></details>';
  view().innerHTML = h;
  await loadScript(CDN.chart);
  // lazy-build charts only when their accordion is open (avoids 0-width canvases)
  let distBuilt=false, centerBuilt=false;
  const buildDist = ()=>{ if(distBuilt||!hasDist||!$('ch-dist')) return; distBuilt=true;
    new Chart($('ch-dist'), {type:'doughnut',
      data:{labels:Object.keys(dist), datasets:[{data:Object.values(dist),
        backgroundColor:['#c4622d','#3d8a5f','#d8a13a','#7a6bb5','#c92f2f','#4f8fc4','#8a8378','#5fae9c']}]},
      options:{plugins:{legend:{position:'bottom',labels:{boxWidth:12,font:{size:11}}}}}}); };
  const buildCenter = ()=>{ if(centerBuilt||!$('ch-center')) return; centerBuilt=true;
    const byC = {}; const jById = Object.fromEntries(J.map(j=>[j.id,j]));
    C.forEach(c=>{ const j=jById[c.journey_id]; if(!j) return;
      const b = (byC[j.center_id] ||= {done:0,open:0}); c.completed_at?b.done++:b.open++; });
    new Chart($('ch-center'), {type:'bar',
      data:{labels:Object.keys(byC).map(centerName), datasets:[
        {label:'Completed', data:Object.values(byC).map(b=>b.done), backgroundColor:'#3d8a5f'},
        {label:'Open', data:Object.values(byC).map(b=>b.open), backgroundColor:'#e0d6c8'}]},
      options:{scales:{x:{stacked:true},y:{stacked:true}},plugins:{legend:{position:'bottom'}}}}); };
  const accD=$('acc-dist'); if(accD){ accD.addEventListener('toggle',()=>{ if(accD.open) buildDist(); }); if(accD.open) buildDist(); }
  const accC=$('acc-center'); if(accC){ accC.addEventListener('toggle',()=>{ if(accC.open) buildCenter(); }); }
}

/* ============================================================
   ADMIN
   ============================================================ */
async function renderAdmin(){
  if(!isCoord()){ view().innerHTML='<div class="empty">Coordinators only.</div>'; return; }
  view().innerHTML = skel();
  const {profs, acts} = await cached('admin', async()=>{
    const [a,b] = await Promise.all([
      sb.from('profiles').select('*').order('created_at'),
      sb.from('activities').select('*').order('activity_date',{ascending:false}).limit(30)]);
    return {profs:a.data||[], acts:b.data||[]};
  });

  const assignCenters = CENTERS.concat([{id:'all',name:'All Centers'},{id:'unassigned',name:'Unassigned'}]);
  const roleOpts = (sel,id,pre)=>'<select id="'+(pre||'')+id+'" style="width:auto;font-size:.78rem;padding:6px">' +
      ROLES.map(r=>'<option value="'+r+'" '+(sel===r?'selected':'')+'>'+roleLabel(r)+'</option>').join('')+'</select>';
  const centerOptsSel = (sel,id,pre)=>'<select id="'+(pre||'')+id+'" style="width:auto;font-size:.78rem;padding:6px">' +
      assignCenters.map(c=>'<option value="'+c.id+'" '+(sel===c.id?'selected':'')+'>'+c.name+'</option>').join('')+'</select>';

  let h = '';

  // 🕒 Pending approvals (Admin only) — open by default
  if(isAdmin()){
    const pending = (profs||[]).filter(p=>p.active===false);
    h += '<details class="acc" open><summary>🕒 Pending approvals <span class="badge">'+pending.length+'</span></summary><div class="acc-body">';
    h += pending.length ? pending.map(p=>'<div class="row simple"><div class="grow" style="min-width:0">' +
        '<div class="name">'+esc(p.full_name||p.email)+'</div>' +
        '<div class="sub">'+esc(p.email||'')+(p.phone?' · '+esc(p.phone):'')+'</div></div>' +
        '<div class="acts">' +
          '<details class="menu"><summary class="actbtn assign">Role ▾</summary><div class="menu-pop">' +
            '<label class="muted" style="font-size:.72rem;margin:0">Role</label>'+roleOpts('nurturer',p.id,'pa-role-') +
            '<label class="muted" style="font-size:.72rem;margin:6px 0 0">Center</label>'+centerOptsSel(p.center_id||CENTERS[0]?.id,p.id,'pa-ctr-') +
          '</div></details>' +
          '<button class="actbtn msg" onclick="approveUser(\''+p.id+'\')">Approve</button>' +
        '</div></div>').join('')
      : '<div class="empty">No one waiting for approval.</div>';
    h += '</div></details>';
  }

  // 🎉 Events & Attendance (Sector + Admin) — collapsed; per-event ⋯ menu
  if(isSector()){
    h += '<details class="acc"><summary>🎉 Events &amp; Attendance <span class="badge">'+(acts||[]).length+'</span></summary><div class="acc-body">';
    h += '<button class="btn small ghost" style="margin-bottom:6px" onclick="openNewActivity()">➕ New activity</button>';
    h += (acts||[]).map(a=>'<div class="row simple"><div class="grow" style="min-width:0">' +
        '<div class="name">' + esc(a.name) + ' ' + (a.is_open?'<span class="badge green">open</span>':'<span class="badge gray">closed</span>') + '</div>' +
        '<div class="sub">' + centerName(a.center_id) + ' · ' + fmtD(a.activity_date) + (a.activity_type&&a.activity_type!=='general'?' · '+esc(a.activity_type):'') + '</div></div>' +
        '<div class="acts"><details class="menu"><summary class="actbtn assign">⋯ Manage</summary><div class="menu-pop">' +
          '<button class="btn small ghost" onclick="showQR(\'' + a.qr_token + '\',\'' + esc(a.name) + '\')">📲 QR code</button>' +
          '<button class="btn small ghost" onclick="viewAttendees(\'' + a.id + '\',\'' + esc(a.name) + '\')">👥 Attendees</button>' +
          '<button class="btn small ghost" onclick="openEditActivity(\'' + a.id + '\')">✏️ Edit</button>' +
          '<button class="btn small gray" onclick="toggleActivity(\'' + a.id + '\',' + (!a.is_open) + ')">' + (a.is_open?'🔒 Close':'🔓 Reopen') + '</button>' +
          '<button class="btn small gray" onclick="deleteActivity(\'' + a.id + '\')">🗑 Delete</button>' +
        '</div></details></div>' +
      '</div>').join('') || '<div class="empty">No activities yet.</div>';
    h += '</div></details>';
  }

  // 👥 Users & Roles — collapsed
  h += '<details class="acc"><summary>👥 Users &amp; Roles <span class="badge">'+(profs||[]).filter(p=>p.active!==false).length+'</span></summary><div class="acc-body">';
  h += (profs||[]).filter(p=>p.active!==false).map(p=>'<div class="row simple"><div class="grow" style="min-width:0">' +
      '<div class="name">' + esc(p.full_name||p.email) + '</div>' +
      '<div class="sub">' + roleLabel(p.role) + ' · ' + centerName(p.center_id) + '</div></div>' +
    '<div class="acts">' +
    (p.phone?'<a class="actbtn msg" href="https://wa.me/91' + p.phone + '?text=' + encodeURIComponent('Namaskaram - Gentle reminder: you have nurturing calls due on the dashboard. Please take a look when you can!') + '" target="_blank">Msg</a>':'') +
    (isAdmin()?
      '<details class="menu"><summary class="actbtn assign">Edit ▾</summary><div class="menu-pop">' +
        '<label class="muted" style="font-size:.72rem;margin:0">Role</label>' +
        '<select onchange="setRole(\'' + p.id + '\',\'role\',this.value)">' +
          ROLES.map(r=>'<option value="' + r + '" ' + (p.role===r?'selected':'') + '>' + roleLabel(r) + '</option>').join('') + '</select>' +
        '<label class="muted" style="font-size:.72rem;margin:6px 0 0">Center</label>' +
        '<select onchange="setRole(\'' + p.id + '\',\'center_id\',this.value)">' +
          assignCenters.map(c=>'<option value="' + c.id + '" ' + (p.center_id===c.id?'selected':'') + '>' + c.name + '</option>').join('') + '</select>' +
        (p.id!==ME.id?'<button class="btn small gray" style="margin-top:8px" onclick="setActive(\''+p.id+'\',false)">Deactivate</button>':'') +
      '</div></details>'
      :'') +
    '</div>' +
    '</div>').join('');
  h += '</div></details>';

  if(isAdmin()){
    const pm = SETTINGS.pincode_map||{};
    h += '<details class="acc"><summary>📍 Pincode → Center map</summary><div class="acc-body">' +
      '<table class="mini"><tr><th>Pincode</th><th>Center</th><th></th></tr>' +
      Object.entries(pm).map(([pin,cid])=>'<tr><td>' + pin + '</td><td>' + centerName(cid) + '</td>' +
        '<td><button class="btn small gray" onclick="delPin(\'' + pin + '\')">Remove</button></td></tr>').join('') + '</table>' +
      '<div style="display:flex;gap:8px;margin-top:8px">' +
        '<input id="pin-new" placeholder="560xxx" inputmode="numeric" style="flex:1">' +
        '<select id="pin-center" style="flex:1">' + CENTERS.map(c=>'<option value="' + c.id + '">' + c.name + '</option>').join('') + '</select>' +
        '<button class="btn small" onclick="addPin()">Add</button></div></div></details>';
    const rc = SETTINGS.reminder_config||{};
    h += '<details class="acc"><summary>🔔 Reminder settings</summary><div class="acc-body">' +
      '<label>Daily reminder email hour (IST, 0-23)</label>' +
      '<input id="rc-hour" type="number" min="0" max="23" value="' + (rc.email_hour_ist??8) + '">' +
      '<label>Overdue after (days past due)</label>' +
      '<input id="rc-od" type="number" min="0" value="' + (rc.overdue_after_days??0) + '">' +
      '<button class="btn block" onclick="saveReminderCfg()">Save</button></div></details>';
  }
  view().innerHTML = h;
}

async function setRole(id, field, val){
  const {error} = await sb.from('profiles').update({[field]:val}).eq('id', id);
  toast(error?error.message:'Updated');
}
async function approveUser(id){
  const role = ($('pa-role-'+id)||{}).value || 'nurturer';
  const center = ($('pa-ctr-'+id)||{}).value || 'unassigned';
  const {error} = await sb.from('profiles').update({role, center_id:center, active:true}).eq('id', id);
  if(error) return toast(error.message);
  toast('Approved'); renderAdmin();
}
async function setActive(id, val){
  const {error} = await sb.from('profiles').update({active:val}).eq('id', id);
  if(error) return toast(error.message);
  toast(val?'Activated':'Deactivated'); renderAdmin();
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
async function openEditActivity(id){
  const {data:a, error} = await sb.from('activities').select('*').eq('id',id).single();
  if(error) return toast(error.message);
  modal('<h3>Edit Activity</h3>' +
    '<label>Activity name</label><input id="ea-name" value="' + esc(a.name||'') + '">' +
    '<label>Activity type</label>' +
    '<select id="ea-type">' + ACTIVITY_TYPES.map(t=>'<option value="' + t + '"' + (a.activity_type===t?' selected':'') + '>' + t.replace(/_/g,' ') + '</option>').join('') + '</select>' +
    '<label>Center</label>' +
    '<select id="ea-center">' + CENTERS.map(c=>'<option value="' + c.id + '"' + (a.center_id===c.id?' selected':'') + '>' + c.name + '</option>').join('') + '</select>' +
    '<label>Date</label><input id="ea-date" type="date" value="' + (a.activity_date||today()) + '">' +
    '<label>Description (optional)</label><textarea id="ea-desc" style="height:60px">' + esc(a.description||'') + '</textarea>' +
    '<button class="btn block" onclick="saveEditActivity(\'' + id + '\')">Save changes</button>' +
    '<button class="btn block gray" style="margin-top:8px" onclick="deleteActivity(\'' + id + '\')">🗑 Delete activity</button>');
}
async function saveEditActivity(id){
  const {error} = await sb.from('activities').update({
    name:$('ea-name').value||'Activity',
    activity_type:$('ea-type').value||'general',
    center_id:$('ea-center').value,
    activity_date:$('ea-date').value,
    description:$('ea-desc').value||null
  }).eq('id',id);
  if(error) return toast(error.message);
  toast('Saved'); closeModal(); cacheBust(); go(CURRENT_VIEW||'admin');
}
async function deleteActivity(id){
  if(!confirm('Delete this activity? Its attendance records will also be removed. This cannot be undone.')) return;
  await sb.from('attendance').delete().eq('activity_id', id);
  const {error} = await sb.from('activities').delete().eq('id', id);
  if(error) return toast(error.message);
  toast('Activity deleted'); closeModal(); cacheBust(); go(CURRENT_VIEW||'admin');
}
async function showQR(token, name){
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
  await loadScript(CDN.qrcode);
  new QRCode($('qr-box'), {text:url, width:200, height:200});
}

/* ---------------- start ---------------- */
boot();
