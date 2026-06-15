# Ishangam → Dashboard weekly sync

One pass refreshes, for Electronic City:
- **Meditators** — profile fields, IE / BSP / Shoonya / Samyama dates, Program Tags
- **Advanced ▸ Interested** — BSP/Shoonya willingness
- **Volunteers ▸ IE Completion** — `ie.completion` (volunteer = true)

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
  const g=x=>({M:'Male',F:'Female'}[x]||x||null), cl=s=>(s==null||s===false)?null:String(s).replace(/\s+/g,' ').trim();
  const tend=p=>{p=String(p||'').replace(/\D/g,'');return p.length>=10?p.slice(-10):null;};

  // --- meditators + advanced dates + program tags + willingness ---
  const dom=[['center_id','=',CENTER],'|','|','|','|','|',['ie_date','!=',false],['bsp_date','!=',false],['shoonya_date','!=',false],['samyama_date','!=',false],['bsp_willingness','!=',false],['shoonya_willingness','!=',false]];
  const fields=['name','mobile','phone','email','zip','city','street','gender','occupation','dob','ie_date','bsp_date','shoonya_date','samyama_date','bsp_willingness','shoonya_willingness','pgm_tag_ids'];
  let all=[],off=0; while(true){const r=await rpc('res.partner','search_read',[dom,fields],{limit:1000,offset:off});const rows=r.result||[];all=all.concat(rows);if(rows.length<1000)break;off+=1000;if(off>20000)break;}
  const pgmIds=new Set(); all.forEach(p=>(p.pgm_tag_ids||[]).forEach(i=>pgmIds.add(i)));
  const pm=Object.fromEntries((((pgmIds.size?(await rpc('isha.program.tag','read',[[...pgmIds],['name']])).result:[])||[]).map(c=>[c.id,c.name])));
  const people=all.filter(r=>r.mobile||r.phone).map(r=>({full_name:cl(r.name)||'(no name)',phone:tend(r.mobile||r.phone),email:cl(r.email),pincode:cl(r.zip),city:cl(r.city),street:cl(r.street),gender:g(r.gender),occupation:cl(r.occupation),date_of_birth:r.dob||null,ie_date:r.ie_date||null,bsp_date:r.bsp_date||null,shoonya_date:r.shoonya_date||null,samyama_date:r.samyama_date||null,tags:(r.pgm_tag_ids||[]).map(i=>pm[i]).filter(Boolean),is_meditator:true,source:'ishangam'}));
  const interest=[]; all.forEach(r=>{const ph=tend(r.mobile||r.phone);if(!ph)return;if(r.bsp_willingness)interest.push({phone:ph,full_name:cl(r.name)||'(no name)',program:'bsp',note:cl(r.bsp_willingness)});if(r.shoonya_willingness)interest.push({phone:ph,full_name:cl(r.name)||'(no name)',program:'shoonya',note:cl(r.shoonya_willingness)});});

  // --- IE completion form: volunteer = true ---
  let ic=[],o2=0; while(true){const r=await rpc('ie.completion','search_read',[[['center_id','=',CENTER],['volunteer','=',true]],['contact_id_fkey','reg_phone','ie_date','program_name','reg_email']],{limit:1000,offset:o2,order:'ie_date desc'});const rows=r.result||[];ic=ic.concat(rows);if(rows.length<1000)break;o2+=1000;if(o2>9000)break;}
  const iecompletion=ic.map(r=>({full_name:(Array.isArray(r.contact_id_fkey)?cl(r.contact_id_fkey[1]):null)||cl(r.reg_email)||'(no name)',phone:tend(r.reg_phone),ie_date:r.ie_date?String(r.ie_date).slice(0,10):null,program_name:cl(r.program_name),center_id:'ecity',source:'ishangam'}));

  window.name=JSON.stringify({people,interest,iecompletion});
  console.log('✅ '+people.length+' meditators, '+interest.length+' interest, '+iecompletion.length+' IE-completion volunteers. Open the dashboard and run Step 2.');
})();
```

## Step 2 — on the dashboard (must be signed in)
Same tab → https://pallerlasuhruth08-debug.github.io/isha-ecity-dashboard/ , open Console, paste:

```js
(async()=>{
  const {data:s}=await sb.auth.getSession(); if(!s.session){console.warn('Sign into the dashboard first');return;}
  const obj=JSON.parse(window.name); const people=obj.people||[]; const interest=obj.interest||[]; const iec=obj.iecompletion||[];
  // meditators
  const seen=new Map(); for(const r of people){if(r.phone&&r.phone.length===10&&!seen.has(r.phone))seen.set(r.phone,r);}
  const rows=[...seen.values()]; let ok=0,errs=[];
  for(let i=0;i<rows.length;i+=500){const {error}=await sb.from('people').upsert(rows.slice(i,i+500),{onConflict:'phone',ignoreDuplicates:false});if(error){errs.push(error.message);if(errs.length>3)break;}else ok+=Math.min(500,rows.length-i);}
  // advanced interest (willingness)
  let aiOk=0; if(interest.length){const phones=[...new Set(interest.map(r=>r.phone))];const idByPhone={};for(let i=0;i<phones.length;i+=200){const {data}=await sb.from('people').select('id,phone').in('phone',phones.slice(i,i+200));(data||[]).forEach(p=>idByPhone[p.phone]=p.id);}const s2=new Set(),ai=[];for(const r of interest){const pid=idByPhone[r.phone];if(!pid)continue;const k=pid+'|'+r.program;if(s2.has(k))continue;s2.add(k);ai.push({person_id:pid,program:r.program,source:'ishangam',notes:r.note,status:'new'});}const {error}=await sb.from('advanced_interest').upsert(ai,{onConflict:'person_id,program',ignoreDuplicates:false});if(!error)aiOk=ai.length;else errs.push('interest: '+error.message);}
  // IE completion volunteers: replace contents (dedupe by phone)
  let icOk=0; { const sp=new Set(),icr=[]; for(const r of iec){if(r.phone){if(sp.has(r.phone))continue;sp.add(r.phone);} icr.push(r);}
    await sb.from('ie_completion_volunteer').delete().neq('id','00000000-0000-0000-0000-000000000000');
    for(let i=0;i<icr.length;i+=500){const {error}=await sb.from('ie_completion_volunteer').insert(icr.slice(i,i+500));if(error){errs.push('iec: '+error.message);break;}else icOk+=Math.min(500,icr.length-i);} }
  console.log('✅ Synced '+ok+' meditators, '+aiOk+' interest, '+icOk+' IE-completion volunteers.', errs.length?errs:'');
})();
```

## Notes
- Tags synced are **Program Tags only**.
- IE Completion volunteers are **deduped by phone** (one row per person).
- Re-running is safe (upsert / replace).
- Other centers: change `CENTER=584` to that center's `isha.center` id.
