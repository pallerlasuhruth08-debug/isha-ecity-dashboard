/* Isha E-City Scraper — reads the largest table (or Odoo list view) on the
   active tab, lets you map columns once (remembered), pushes to Supabase
   via the same import_people RPC the dashboard uses (dedupe + routing + journeys). */

const $ = id => document.getElementById(id);
const FIELDS = ['(skip)','full_name','phone','email','pincode','area','program_name','program_date'];
let SCANNED = null; // {headers:[], rows:[[]]}

const setStatus = (m, cls='') => { $('status').textContent = m; $('status').className = cls; };

/* ---------- setup / auth ---------- */
async function getCfg(){ return (await chrome.storage.local.get('cfg')).cfg || null; }

async function authToken(cfg){
  // password grant against Supabase GoTrue
  const r = await fetch(`${cfg.url}/auth/v1/token?grant_type=password`, {
    method:'POST',
    headers:{'Content-Type':'application/json', apikey:cfg.key},
    body: JSON.stringify({email:cfg.email, password:cfg.pass})
  });
  const j = await r.json();
  if(!r.ok) throw new Error(j.error_description || j.msg || 'Login failed');
  return j.access_token;
}

async function init(){
  const cfg = await getCfg();
  if(cfg){
    $('setup').classList.add('hidden'); $('main').classList.remove('hidden');
    setStatus('Signed in as ' + cfg.email, 'ok');
  }
}
$('save-setup').onclick = async () => {
  const cfg = {url:$('sb-url').value.trim().replace(/\/$/,''), key:$('sb-key').value.trim(),
               email:$('sb-email').value.trim(), pass:$('sb-pass').value};
  try{
    setStatus('Signing in…');
    await authToken(cfg);
    await chrome.storage.local.set({cfg});
    init();
  }catch(e){ setStatus('⚠️ '+e.message, 'err'); }
};
$('reset').onclick = async () => { await chrome.storage.local.remove(['cfg','colmap']);
  $('main').classList.add('hidden'); $('setup').classList.remove('hidden'); setStatus(''); };

/* ---------- scan the page ---------- */
function pageScraper(){
  // Runs IN the page. Finds the biggest data table (works for Odoo list views,
  // which render as <table class="o_list_table">) and returns headers + rows.
  const tables = [...document.querySelectorAll('table')];
  if(!tables.length) return {error:'No table found on this page. Open the list view of meditators first.'};
  const best = tables.reduce((a,b)=> (b.rows.length > (a?.rows.length||0) ? b : a), null);
  const rows = [...best.rows].map(tr => [...tr.cells].map(td => td.innerText.trim()));
  if(rows.length < 2) return {error:'Table has no data rows.'};
  let headers = rows[0];
  // Odoo sometimes has an empty checkbox column header
  return {headers, rows: rows.slice(1).filter(r => r.some(c => c))};
}

$('scan').onclick = async () => {
  setStatus('Scanning page…');
  const [tab] = await chrome.tabs.query({active:true, currentWindow:true});
  const [res] = await chrome.scripting.executeScript({target:{tabId:tab.id}, func:pageScraper});
  const data = res.result;
  if(data.error) return setStatus('⚠️ '+data.error, 'err');
  SCANNED = data;
  // build mapping UI; restore saved mapping by header name
  const saved = (await chrome.storage.local.get('colmap')).colmap || {};
  const guess = h => {
    h = h.toLowerCase();
    if(saved[h]) return saved[h];
    if(/name/.test(h)) return 'full_name';
    if(/phone|mobile|contact/.test(h)) return 'phone';
    if(/mail/.test(h)) return 'email';
    if(/pin|zip|postal/.test(h)) return 'pincode';
    if(/area|city|address|locality/.test(h)) return 'area';
    if(/program|course/.test(h)) return 'program_name';
    if(/date|completed/.test(h)) return 'program_date';
    return '(skip)';
  };
  $('map-table').innerHTML = '<tr><th>Page column</th><th>Maps to</th><th>Sample</th></tr>' +
    data.headers.map((h,i)=>`<tr><td>${h||'(col '+(i+1)+')'}</td>
      <td><select data-i="${i}">${FIELDS.map(f=>`<option ${f===guess(h)?'selected':''}>${f}</option>`).join('')}</select></td>
      <td>${(data.rows[0]?.[i]||'').slice(0,18)}</td></tr>`).join('');
  $('rowcount').textContent = data.rows.length;
  $('mapping').classList.remove('hidden');
  setStatus(`Found ${data.rows.length} rows. Check the column mapping, then push.`, 'ok');
};

/* ---------- push ---------- */
$('push').onclick = async () => {
  if(!SCANNED) return;
  const cfg = await getCfg();
  const kind = $('kind').value;
  const map = {};   // colIndex -> field
  const colmap = {}; // headerName -> field (persisted)
  document.querySelectorAll('#map-table select').forEach(s => {
    if(s.value !== '(skip)'){ map[+s.dataset.i] = s.value;
      colmap[(SCANNED.headers[+s.dataset.i]||'').toLowerCase()] = s.value; }
  });
  if(!Object.values(map).includes('phone') && !Object.values(map).includes('full_name'))
    return setStatus('⚠️ Map at least name or phone.', 'err');
  await chrome.storage.local.set({colmap});

  const rows = SCANNED.rows.map(r => {
    const o = {kind, source:'ishangam'};
    for(const [i, f] of Object.entries(map)){
      let v = r[+i]; if(!v) continue;
      if(f === 'program_date'){ const d = new Date(v); v = isNaN(d) ? null : d.toISOString().slice(0,10); }
      if(v) o[f] = v;
    }
    return o;
  }).filter(o => o.full_name || o.phone);

  try{
    setStatus(`Signing in…`);
    const token = await authToken(cfg);
    setStatus(`Pushing ${rows.length} rows…`);
    let tot = {inserted:0, merged:0, journeys:0};
    for(let i=0; i<rows.length; i+=200){
      const r = await fetch(`${cfg.url}/rest/v1/rpc/import_people`, {
        method:'POST',
        headers:{'Content-Type':'application/json', apikey:cfg.key, Authorization:'Bearer '+token},
        body: JSON.stringify({rows: rows.slice(i,i+200)})
      });
      const j = await r.json();
      if(!r.ok) throw new Error(j.message || JSON.stringify(j));
      tot.inserted += j.inserted; tot.merged += j.merged; tot.journeys += j.journeys;
    }
    setStatus(`✔ Done!\n${tot.inserted} new people\n${tot.merged} merged with existing\n${tot.journeys} call journeys created`, 'ok');
  }catch(e){ setStatus('⚠️ '+e.message, 'err'); }
};

init();
