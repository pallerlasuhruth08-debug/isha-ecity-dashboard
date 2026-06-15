# Ishangam → Dashboard weekly sync (meditators + advanced programs + tags + interest)

One pass pulls every Electronic City meditator with profile fields, **IE / BSP /
Shoonya / Samyama completion dates**, **tags** (general + Program Tags), and
**BSP/Shoonya willingness** (→ the Interested list), then upserts into the
dashboard. Everything stays current each run.

No server cron (static site, session-based Ishangam login), so it's a 2-step
manual run (~30s). A weekly reminder is scheduled (Mondays).

## Step 1 — on Ishangam (must be logged in)
Open https://ishangam.isha.in , sign in, open DevTools Console (F12), paste:

```js
(async()=>{
  const rpc=(m,me,a,k={})=>fetch('/web/dataset/call_kw/'+m+'/'+me,{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:"2.0",method:"call",params:{model:m,method:me,args:a,kwargs:k}})}).then(r=>r.json());
  const CENTER=584; // Electronic City
  const domain=[['center_id','=',CENTER],'|','|','|','|','|',
    ['ie_date','!=',false],['bsp_date','!=',false],['shoonya_date','!=',false],
    ['samyama_date','!=',false],['bsp_willingness','!=',false],['shoonya_willingness','!=',false]];
  const fields=['name','mobile','phone','email','zip','city','street','gender','occupation','dob',
    'ie_date','bsp_date','shoonya_date','samyama_date','bsp_willingness','shoonya_willingness','category_id','pgm_tag_ids'];
  let all=[],off=0;
  while(true){const r=await rpc('res.partner','search_read',[domain,fields],{limit:1000,offset:off});
    const rows=r.result||[];all=all.concat(rows);if(rows.length<1000)break;off+=1000;if(off>20000)break;}
  const catIds=new Set(),pgmIds=new Set();
  all.forEach(p=>{(p.category_id||[]).forEach(i=>catIds.add(i));(p.pgm_tag_ids||[]).forEach(i=>pgmIds.add(i));});
  const cm=Object.fromEntries((((catIds.size?(await rpc('res.partner.category','read',[[...catIds],['name']])).result:[])||[]).map(c=>[c.id,c.name])));
  const pm=Object.fromEntries((((pgmIds.size?(await rpc('isha.program.tag','read',[[...pgmIds],['name']])).result:[])||[]).map(c=>[c.id,c.name])));
  const g=x=>({M:'Male',F:'Female'}[x]||x||null), cl=s=>(s==null||s===false)?null:String(s).replace(/\s+/g,' ').trim();
  const people=all.filter(r=>r.mobile||r.phone).map(r=>({
    full_name:cl(r.name)||'(no name)', phone:String(r.mobile||r.phone).replace(/\D/g,'').slice(-10),
    email:cl(r.email), pincode:cl(r.zip), city:cl(r.city), street:cl(r.street), gender:g(r.gender),
    occupation:cl(r.occupation), date_of_birth:r.dob||null, ie_date:r.ie_date||null,
    bsp_date:r.bsp_date||null, shoonya_date:r.shoonya_date||null, samyama_date:r.samyama_date||null,
    tags:(r.pgm_tag_ids||[]).map(i=>pm[i]).filter(Boolean), // Program Tags only (per team choice)
    is_meditator:true, source:'ishangam'}));
  const interest=[];
  all.forEach(r=>{const ph=String(r.mobile||r.phone||'').replace(/\D/g,'').slice(-10); if(ph.length!==10)return;
    if(r.bsp_willingness) interest.push({phone:ph,full_name:cl(r.name)||'(no name)',program:'bsp',note:cl(r.bsp_willingness)});
    if(r.shoonya_willingness) interest.push({phone:ph,full_name:cl(r.name)||'(no name)',program:'shoonya',note:cl(r.shoonya_willingness)});});
  window.name=JSON.stringify({people,interest});
  console.log('✅ Pulled '+people.length+' meditators + '+interest.length+' interest rows. Now open the dashboard and run Step 2.');
})();
```

## Step 2 — on the dashboard (must be signed in)
Same tab → https://pallerlasuhruth08-debug.github.io/isha-ecity-dashboard/ , open Console, paste:

```js
(async()=>{
  const {data:s}=await sb.auth.getSession(); if(!s.session){console.warn('Sign into the dashboard first');return;}
  const obj=JSON.parse(window.name); const people=obj.people||obj; const interest=obj.interest||[];
  const seen=new Map(); for(const r of people){if(r.phone&&r.phone.length===10&&!seen.has(r.phone))seen.set(r.phone,r);}
  const rows=[...seen.values()]; let ok=0,errs=[];
  for(let i=0;i<rows.length;i+=500){const {error}=await sb.from('people').upsert(rows.slice(i,i+500),{onConflict:'phone',ignoreDuplicates:false});
    if(error){errs.push(error.message);if(errs.length>3)break;}else ok+=Math.min(500,rows.length-i);}
  let aiOk=0;
  if(interest.length){
    const phones=[...new Set(interest.map(r=>r.phone))]; const idByPhone={};
    for(let i=0;i<phones.length;i+=200){const {data}=await sb.from('people').select('id,phone').in('phone',phones.slice(i,i+200));(data||[]).forEach(p=>idByPhone[p.phone]=p.id);}
    const seen2=new Set(), ai=[];
    for(const r of interest){const pid=idByPhone[r.phone];if(!pid)continue;const k=pid+'|'+r.program;if(seen2.has(k))continue;seen2.add(k);
      ai.push({person_id:pid,program:r.program,source:'ishangam',notes:r.note,status:'new'});}
    const {error}=await sb.from('advanced_interest').upsert(ai,{onConflict:'person_id,program',ignoreDuplicates:false});
    if(error)errs.push('interest: '+error.message); else aiOk=ai.length;
  }
  console.log('✅ Synced '+ok+' meditators, '+aiOk+' interest rows.', errs.length?errs:'');
})();
```

## Notes
- Captures completers (BSP/Shoonya/Samyama dates) and the willing (BSP/Shoonya
  willingness → Advanced Programs ▸ Interested). Guru Puja has no date in Ishangam.
- Other centers: change `CENTER=584` to that center's `isha.center` id.
- Re-running is safe (upsert by phone / by person+program).
- Tags + dates + interest fully refresh each run, so the dashboard mirrors Ishangam.
