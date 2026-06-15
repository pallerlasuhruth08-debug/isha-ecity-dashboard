# Ishangam → Dashboard weekly sync (meditators + profiles + tags)

One pass pulls every Electronic City IE meditator with their profile fields
**and both tag sets** (general Tags + Program Tags), then upserts into the
dashboard. Tags now stay current each time you run this.

There's no server-side cron (static site, session-based Ishangam login), so this
is a 2-step manual run — about 30 seconds. Do it weekly (a reminder is scheduled).

## Step 1 — on Ishangam (must be logged in)
Open https://ishangam.isha.in , sign in, then open DevTools Console
(F12 → Console) and paste this. It loads the data into the tab's memory.

```js
(async()=>{
  const rpc=(m,me,a,k={})=>fetch('/web/dataset/call_kw/'+m+'/'+me,{method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({jsonrpc:"2.0",method:"call",params:{model:m,method:me,args:a,kwargs:k}})}).then(r=>r.json());
  const CENTER=584; // Electronic City (isha.center id)
  // E-City AND (has IE OR BSP OR Shoonya OR Samyama date)
  const domain=[['center_id','=',CENTER],'|','|','|',['ie_date','!=',false],['bsp_date','!=',false],['shoonya_date','!=',false],['samyama_date','!=',false]];
  const fields=['name','mobile','phone','email','zip','city','street','gender','occupation','dob','ie_date','bsp_date','shoonya_date','samyama_date','category_id','pgm_tag_ids'];
  let all=[],off=0;
  while(true){const r=await rpc('res.partner','search_read',[domain,fields],{limit:1000,offset:off});
    const rows=r.result||[];all=all.concat(rows);if(rows.length<1000)break;off+=1000;if(off>20000)break;}
  const catIds=new Set(),pgmIds=new Set();
  all.forEach(p=>{(p.category_id||[]).forEach(i=>catIds.add(i));(p.pgm_tag_ids||[]).forEach(i=>pgmIds.add(i));});
  const cm=Object.fromEntries((((catIds.size?(await rpc('res.partner.category','read',[[...catIds],['name']])).result:[])||[]).map(c=>[c.id,c.name])));
  const pm=Object.fromEntries((((pgmIds.size?(await rpc('isha.program.tag','read',[[...pgmIds],['name']])).result:[])||[]).map(c=>[c.id,c.name])));
  const g=x=>({M:'Male',F:'Female'}[x]||x||null);
  const cl=s=>(s==null||s===false)?null:String(s).replace(/\s+/g,' ').trim();
  const payload=all.filter(r=>r.mobile||r.phone).map(r=>({
    full_name:cl(r.name)||'(no name)', phone:String(r.mobile||r.phone).replace(/\D/g,'').slice(-10),
    email:cl(r.email), pincode:cl(r.zip), city:cl(r.city), street:cl(r.street), gender:g(r.gender),
    occupation:cl(r.occupation), date_of_birth:r.dob||null, ie_date:r.ie_date||null,
    bsp_date:r.bsp_date||null, shoonya_date:r.shoonya_date||null, samyama_date:r.samyama_date||null,
    tags:[...new Set([...(r.category_id||[]).map(i=>cm[i]).filter(Boolean),
                      ...(r.pgm_tag_ids||[]).map(i=>pm[i]).filter(Boolean)])],
    is_meditator:true, source:'ishangam'}));
  window.name=JSON.stringify(payload);
  console.log('✅ Pulled '+payload.length+' meditators (with tags). Now open the dashboard and run Step 2.');
})();
```

## Step 2 — on the dashboard (must be signed in)
In the SAME tab, go to
https://pallerlasuhruth08-debug.github.io/isha-ecity-dashboard/ (the data rides
along in `window.name`), open the Console and paste:

```js
(async()=>{
  const payload=JSON.parse(window.name);
  const seen=new Map(); for(const r of payload){if(r.phone&&r.phone.length===10&&!seen.has(r.phone))seen.set(r.phone,r);}
  const rows=[...seen.values()];
  let ok=0,errs=[];
  for(let i=0;i<rows.length;i+=500){
    const {error}=await sb.from('people').upsert(rows.slice(i,i+500),{onConflict:'phone',ignoreDuplicates:false});
    if(error){errs.push(error.message);if(errs.length>3)break;}else ok+=Math.min(500,rows.length-i);}
  console.log('✅ Synced '+ok+' meditators — profiles + tags refreshed.', errs.length?errs:'');
})();
```

## Notes
- Other centers: change `CENTER=584` to that center's `isha.center` id.
- Re-running is safe (upsert by phone — updates existing, adds new).
- Tags fully refresh each run, so dashboard tags always match Ishangam.
- New meditators imported this way land as directory records (no auto-calls);
  use the New Meditators tab to choose who to start calling.
