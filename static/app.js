'use strict';
const t = (key,values) => KonturI18n.t(key,values);
const $ = id => document.getElementById(id);
const labels = Object.defineProperties({},Object.fromEntries(Object.entries({planned:'m1',active:'m2',blocked:'m3',done:'m4',deferred:'m5',frozen:'m6'}).map(([state,key])=>[state,{enumerable:true,get:()=>t(key)}])));
function activeTheme(){return document.documentElement.dataset.theme==='dark'?'dark':'light';}
function initialTheme(){
  try{const saved=localStorage.getItem('monitor-theme');return saved==='dark'||saved==='light'?saved:(matchMedia('(prefers-color-scheme: dark)').matches?'dark':'light');}
  catch{return 'light';}
}
function paintTheme(theme,persist=false){
  const dark=theme==='dark';
  document.documentElement.dataset.theme=dark?'dark':'light';
  const button=$('theme-toggle');
  if(button){button.setAttribute('aria-pressed',String(dark));button.innerHTML=dark?`<span aria-hidden="true">☀</span> ${t("m7")}`:`<span aria-hidden="true">☾</span> ${t("m8")}`;button.title=dark?t("m9"):t("m10");}
  if(persist)try{localStorage.setItem('monitor-theme',dark?'dark':'light');}catch{/* The theme still works for this page. */}
}
paintTheme(initialTheme());
document.addEventListener('DOMContentLoaded',()=>{
KonturI18n.paint();
paintTheme(activeTheme());
function storedKey(storage,name='monitor-key'){try{return window[storage].getItem(name)||'';}catch{return '';}}
function authSnapshot(){return JSON.stringify([storedKey('localStorage'),storedKey('localStorage','monitor-auth-change')]);}
function authLock(action){return navigator.locks?navigator.locks.request('monitor-auth',action):Promise.resolve(action());}
async function forgetKey(expected){return authLock(()=>{
  if(expected!==undefined && authSnapshot()!==expected)return;
  // The marker also cancels pending legacy migration when no shared key existed.
  try{localStorage.setItem('monitor-auth-change',crypto.randomUUID());}catch{/* Storage may be disabled. */}
  for(const storage of ['localStorage','sessionStorage']){try{window[storage].removeItem('monitor-key');}catch{/* Storage may be disabled. */}}
});}
async function rememberKey(expected){return authLock(()=>{
  if(authSnapshot()!==expected)return null;
  if(!navigator.locks){try{sessionStorage.setItem('monitor-key',key);}catch{}return false;}
  if(storedKey('localStorage')===key){try{sessionStorage.removeItem('monitor-key');}catch{}return true;}
  try{localStorage.setItem('monitor-key',key);}catch{
    try{sessionStorage.setItem('monitor-key',key);}catch{/* In-memory login still works. */}
    return false;
  }
  try{sessionStorage.removeItem('monitor-key');}catch{/* Legacy storage may be disabled. */}
  return true;
});}
let key = storedKey('localStorage') || storedKey('sessionStorage'), projects = [], current = null, filter = 'work', busy = false;
let loggingOut=false;
function reloadAuth(){key='';if(!loggingOut)location.reload();}
let expandedProject = null, selectedGate = null;
const expandedBlocks = new Set(), expandedGates = new Set();
let visualView=['road','time','tree'].includes(storedKey('localStorage','monitor-visual-view'))?storedKey('localStorage','monitor-visual-view'):'road', visualZoom=1, visualDrag=null;
const visualLayers=new Set(['work','technical','paused']);
const gitLayers=new Set(['work','technical','formal']),gitSnapshots=new Map(),gitErrors=new Map();
let gitLoadingProject=null,visualTooltipPinned=false;
const gitSelectedRefs=new Map(),gitBaseRefs=new Map(),gitExpandedSegments=new Set(),gitExpandedBranches=new Set();
const gitShowAllCommits=new Set();
const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let lastNotice='',syncState='m290',lastRefresh=null;
function localMessage(message){const known=KonturI18n.identify(message);return known?t(known.key,known.values):message;}
function notice(message=''){lastNotice=message; $('notice').textContent=localMessage(message); $('notice').hidden=!message;}
function paintSync(){ $('sync').textContent=syncState==='m16'?t(syncState)+lastRefresh.toLocaleTimeString(KonturI18n.locale,{hour:'2-digit',minute:'2-digit'}):t(syncState); }
function setSync(state){syncState=state;if(state==='m16')lastRefresh=new Date();paintSync();}
async function api(path, options={}) {
  const requestKey=key, sharedAuth=authSnapshot();
  let response,body;
  try{response=await fetch('/api/v1'+path, {...options,headers:{Authorization:'Bearer '+requestKey,'Content-Type':'application/json',...options.headers}});}catch{throw new Error(t('networkError'));}
  try{body=await response.json();}catch{throw new Error(t('responseError'));}
  if(key!==requestKey || authSnapshot()!==sharedAuth){reloadAuth();throw new Error(t("m11"));}
  if (!response.ok) {
    if (response.status===401) {$('gate-dialog')?.close();current=null;projects=[];key=''; await forgetKey(sharedAuth); $('login').hidden=false; $('dashboard').hidden=true; $('empty').hidden=true; $('projects').replaceChildren();}
    const error=new Error(response.status===401?t("m12"):response.status===409?t("m13"):t('requestError',{status:response.status}));error.status=response.status;throw error;
  }
  return body;
}
async function refresh(silent=false){
  if(!key){$('login').hidden=false;setSync('m14');return;}
  if(busy)return; busy=true;
  const sharedAuth=authSnapshot();
  try {const loaded=await api('/projects'); const remembered=await rememberKey(sharedAuth); if(remembered===null){reloadAuth();return;} projects=loaded; current=projects.find(p=>p.id===current?.id)||projects[0]||null; render(); if(!silent)notice(); if(!remembered)notice(t("m15")); setSync('m16');}
  catch(e){notice(e.message);setSync('m17');}finally{busy=false;}
}
function render(){
  if(expandedProject!==current?.id){expandedBlocks.clear();expandedGates.clear();expandedProject=current?.id;}
  $('login').hidden=true;$('empty').hidden=!!current;$('dashboard').hidden=!current;
  $('projects').innerHTML=projects.map(p=>`<button data-project="${esc(p.id)}" class="${p.id===current?.id?'selected':''}">${esc(p.name)}${p.archived?t("m18"):''}<small>${p.stats.counts.done} ${t("m19")}${p.stats.total} ${t("m20")}</small></button>`).join('');
  if(!current){$('breadcrumb').textContent=t('m289');return;}
  const p=current,r=p.roadmap,s=p.stats;
  $('project-type').textContent=p.type==='software'?t('m305'):t('generalHeading');
  $('title').textContent=p.name;$('breadcrumb').textContent=p.name;$('description').textContent=p.description||r.baseline.summary||t("m21");
  $('revision').textContent=t("m22")+p.revision;$('snapshot').textContent=t("m23")+dateLabel(r.updatedAt);
  $('metrics').innerHTML=[[t("m24"),s.total,t("m25")+r.sections.length+t("m26")],[t("m4"),s.counts.done,t("m27")],[t("m2"),s.counts.active,t("m28")],[t("m29"),s.counts.blocked,t("m30")]].map(([t,n,h])=>`<article class="metric"><div class="metric-label">${t}</div><strong>${n}</strong><small>${h}</small></article>`).join('');
  $('current').innerHTML=r.currentGateId?gateButton(r.currentGateId):t("m31");
  $('next').innerHTML=r.nextGateId?gateButton(r.nextGateId):t("m32");
  $('focus-note').textContent=r.focusNote||t("m33");
  $('plan').textContent=s.plan.percent===null?t("m34"):`${t("m35")}${s.plan.done} ${t("m19")}${s.plan.total} ${t("m36")}${s.plan.percent}%). ${t("m37")}`;
  renderOverview(); renderBlocks();
  if($('gate-dialog')?.open && selectedGate)showGate(selectedGate);
  if($('visual-dialog')?.open)renderVisualGraph();
}
function renderBlocks(){
  if(!current)return;
  const q=$('search').value.toLowerCase(), stats=current.stats.gates;
  const match=g=>filter==='all'||filter===stats[g.id].status||(filter==='ready'&&stats[g.id].ready)||(filter==='work'&&['planned','active','blocked'].includes(stats[g.id].status))||(filter==='paused'&&['frozen','deferred'].includes(stats[g.id].status));
  const counts={work:0,done:0,paused:0,all:current.stats.total};
  Object.values(stats).forEach(g=>{if(['planned','active','blocked'].includes(g.status))counts.work++;if(g.status==='done')counts.done++;if(['frozen','deferred'].includes(g.status))counts.paused++;});
  const tabNames={work:t("m38"),done:t("m39"),paused:t("m40"),all:t("m41")};
  document.querySelectorAll('[data-filter]').forEach(b=>{b.textContent=tabNames[b.dataset.filter]+' · '+counts[b.dataset.filter];b.setAttribute('aria-selected',String(filter===b.dataset.filter));});
  const special=!Object.hasOwn(tabNames,filter);
  const selection=special?`<div class="filter-note">${t("m42")}${esc(filter==='ready'?t("m43"):labels[filter])} <button data-reset-filter>${t("m44")}</button></div>`:'';
  const parts=current.roadmap.sections.map(b=>{
    const gates=b.gates.filter(g=>match(g)&&(!q||[b.title,b.id,b.description,g.title,g.id,g.note,g.acceptance,g.existing,...g.evidence.flatMap(s=>[s.label,s.path]),...g.sources.flatMap(s=>[s.label,s.path])].join(' ').toLowerCase().includes(q)));
    if(!gates.length&&!(filter==='all'&&!b.gates.length&&(!q||b.title.toLowerCase().includes(q))))return '';
    const done=b.gates.filter(g=>g.status==='done').length;
    const open=expandedBlocks.has(b.id)||(!expandedBlocks.has('closed:'+b.id)&&(filter==='work'||special||q));
    return `<details class="block" id="block-${esc(b.id)}" data-block="${esc(b.id)}" ${open?'open':''}>
      <summary><div><h3>${esc(b.title)}</h3><p>${esc(b.description)}</p><p>${esc(b.id)} · ${scopeLabel(b)}</p></div><div class="block-stat"><strong>${done} / ${b.gates.length} ${t("m45")}</strong>${b.scope==='frozen'||b.status==='frozen'?t("m46"):b.status?labels[b.status]:t("m47")+gates.length}</div></summary>
      <div class="gates">${b.dependsOn.length?`<div class="block-deps">${t("m48")}${b.dependsOn.map(id=>entityButton(id)).join(' ')}</div>`:''}${gates.map(g=>`<details class="gate" data-expanded-gate="${esc(g.id)}" ${expandedGates.has(g.id)?'open':''}>
        <summary><span class="gate-id">${esc(g.id)}</span><span class="gate-name">${esc(g.title)}<small>${g.acceptance?t("m49"):t("m50")} · ${g.evidence.length} ${t("m51")}</small></span><span class="badge ${stats[g.id].status}">${labels[stats[g.id].status]}</span><span class="expand-hint">${t("m52")}</span></summary>
        <div class="gate-body"><p>${esc(g.note||g.acceptance||t("m53"))}</p>${stats[g.id].blockers.length?`<b>${t("m54")}</b><div class="entity-list">${stats[g.id].blockers.map(id=>entityButton(id)).join('')}</div>`:''}<button data-gate="${esc(g.id)}">${t("m55")}</button></div></details>`).join('')||`<p class="muted">${t("m56")}</p>`}</div></details>`;
  });
  $('blocks').innerHTML=selection+(parts.join('')||`<div class="blank">${t("m57")}<br>${t("m58")}</div>`);
  $('blocks').querySelectorAll('details').forEach(el=>el.addEventListener('toggle',()=>{
    if(!el.isConnected)return;
    if(el.dataset.block){const id=el.dataset.block;expandedBlocks.delete(el.open?'closed:'+id:id);expandedBlocks.add(el.open?id:'closed:'+id);}
    else if(el.open)expandedGates.add(el.dataset.expandedGate);else expandedGates.delete(el.dataset.expandedGate);
  }));
}
function gateIndex(){return current.roadmap.sections.flatMap(b=>b.gates.map(g=>({...g,block:b})));}
function scopeLabel(b){return {mvp:'MVP',expansion:t("m59"),frozen:t("m60")}[b.scope];}
function gateButton(id){const g=gateIndex().find(g=>g.id===id);return g?`<button class="entity-link" data-gate="${esc(id)}">${esc(id)} · ${esc(g.title)}</button>`:esc(id);}
function entityButton(id){
  const b=current.roadmap.sections.find(b=>b.id===id);
  return b?`<button class="entity-link" data-section="${esc(id)}">${t("m61")}${esc(id)} · ${esc(b.title)}</button>`:gateButton(id);
}
function dateLabel(value){
  if(!value)return t("m62");
  const d=new Date(value);
  if(Number.isNaN(d.valueOf()))return value;
  return /^\d{4}-\d{2}-\d{2}$/.test(value)?d.toLocaleDateString(KonturI18n.locale,{dateStyle:'medium',timeZone:'UTC'}):d.toLocaleString(KonturI18n.locale,{dateStyle:'medium',timeStyle:'short'});
}
function statusChart(counts,total){
  if(!total)return `<p class="muted">${t("m63")}</p>`;
  let x=0;
  const bars=Object.keys(labels).map(status=>{
    const width=(counts[status]||0)*100/total;
    const rect=`<rect class="fill-${status}" x="${x}" y="0" width="${width}" height="12"/>`;x+=width;return rect;
  }).join('');
  const description=Object.entries(labels).map(([s,l])=>`${l}: ${counts[s]||0}`).join(', ');
  return `<svg class="status-chart" viewBox="0 0 100 12" preserveAspectRatio="none" role="img" aria-label="${esc(description)}">${bars}</svg>`;
}
function renderOverview(){
  if(!$('distribution'))return;
  const {stats:s,roadmap:r}=current, gates=gateIndex();
  $('received').textContent=t("m64")+dateLabel(current.updatedAt);
  $('distribution').innerHTML=statusChart(s.counts,s.total)+`<div class="status-legend">${Object.entries(labels).map(([status,label])=>`<button data-status="${status}" aria-label="${t("m65")}${label}"><span class="status-dot fill-${status}"></span>${label}<strong>${s.counts[status]}</strong></button>`).join('')}</div><p class="muted">${t("m66")}</p>`;
  $('plan-chart').innerHTML=s.plan.total?`<div class="plan-heading"><b>${t("m67")}</b><span>${s.plan.done} / ${s.plan.total} ${t("m68")}${s.plan.percent}%</span></div><progress max="${s.plan.total}" value="${s.plan.done}" aria-label="${t("m69")}"></progress><p class="muted">${t("m70")}</p>`:`<p class="muted">${t("m71")}</p>`;
  const blocked=gates.filter(g=>s.gates[g.id].status==='blocked'), ready=gates.filter(g=>s.gates[g.id].ready);
  const blockers=new Map();
  blocked.forEach(g=>new Set(s.gates[g.id].blockers).forEach(id=>blockers.set(id,(blockers.get(id)||0)+1)));
  const ranked=[...blockers].sort((a,b)=>b[1]-a[1]);
  const attention=ranked.slice(0,5).map(([id,n])=>`<li>${entityButton(id)}<small>${t("m72")}${n} ${t("m73")}</small></li>`).join('');
  $('attention').innerHTML=`<div class="attention-totals"><button data-status="blocked"><strong>${blocked.length}</strong> ${t("m30")}</button><button data-status="ready"><strong>${ready.length}</strong> ${t("m74")}</button></div>${attention?`<ul class="attention-list">${attention}</ul><p class="muted">${ranked.length>5?t("m75")+ranked.length+t("m76"):''}${t("m77")}</p>`:`<p class="muted">${blocked.length?t("m78"):t("m79")}</p>`}${blocked.some(g=>!s.gates[g.id].blockers.length)&&attention?`<p class="muted">${t("m80")}</p>`:''}<p class="muted">${t("m81")}${s.counts.frozen} ${t("m82")}${s.counts.deferred} ${t("m83")}</p>`;
  $('block-map').innerHTML=r.sections.map(b=>{
    const counts=Object.fromEntries(Object.keys(labels).map(k=>[k,0]));b.gates.forEach(g=>counts[s.gates[g.id].status]++);
    return `<article class="map-card"><button class="map-title" data-section="${esc(b.id)}"><small>${esc(b.id)} · ${scopeLabel(b)}</small><strong>${esc(b.title)}</strong></button>${statusChart(counts,b.gates.length)}<div class="map-stats"><b>${counts.done} / ${b.gates.length} ${t("m45")}</b><span>${counts.blocked} ${t("m84")}${counts.frozen+counts.deferred} ${t("m85")}</span></div>${b.dependsOn.length?`<div class="map-deps"><span>${t("m86")}</span>${b.dependsOn.map(id=>entityButton(id)).join('')}</div>`:`<p class="muted">${t("m87")}</p>`}</article>`;
  }).join('')||`<p class="muted">${t("m88")}</p>`;
}
function visualLayer(section){
  if(section.scope==='frozen'||section.status==='frozen'||section.status==='deferred')return 'paused';
  const text=[section.id,section.title,section.description,...section.gates.flatMap(g=>[g.id,g.title])].join(' ').toLowerCase();
  const technical=/(^|[\s_-])(git|ci|lint|build|test|docs?|documentation|governance|routing|bootstrap|initiali[sz]ation|migration|runtime|infra(?:structure)?|security|audit|review|checkpoint|inventory|config|release|deploy(?:ment)?|quality)(?=$|[\s_-])|документац|провер|инициализац|инфраструктур|безопасност|миграц|ревиз|сборк|тест/iu;
  return technical.test(text)?'technical':'work';
}
function visualLayerLabel(layer){return {work:t("m89"),technical:t("m90"),paused:t("m91")}[layer];}
function graphTextLines(value,max=30,limit=2){
  const words=String(value).split(/\s+/),lines=[];let line='';
  for(const word of words){const next=(line+' '+word).trim();if(line&&next.length>max){lines.push(line);line=word;}else line=next;if(lines.length===limit-1)break;}
  if(line&&lines.length<limit)lines.push(line);
  const used=lines.join(' ').length;if(used<String(value).length)lines[lines.length-1]=lines[lines.length-1].replace(/[.…]*$/,'')+'…';
  return lines;
}
function graphText(value,x,y,className,max=30,limit=2,anchor='start'){
  return `<text x="${x}" y="${y}" class="${className}" text-anchor="${anchor}">${graphTextLines(value,max,limit).map((line,index)=>`<tspan x="${x}" dy="${index?'17':'0'}">${esc(line)}</tspan>`).join('')}</text>`;
}
function graphCurve(from,to){
  const bend=Math.max(45,Math.abs(to.x-from.x)*.42);
  return `M ${from.x} ${from.y} C ${from.x+bend} ${from.y}, ${to.x-bend} ${to.y}, ${to.x} ${to.y}`;
}
function graphDefs(){return `<defs><filter id="node-shadow" x="-30%" y="-30%" width="160%" height="160%"><feDropShadow dx="0" dy="3" stdDeviation="4" flood-opacity=".14"/></filter><marker id="dependency-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" class="graph-arrow"/></marker></defs>`;}
function configureVisualSvg(width,height){
  const svg=$('visual-svg');svg.setAttribute('viewBox',`0 0 ${width} ${height}`);svg.dataset.baseWidth=String(width);svg.dataset.baseHeight=String(height);svg.style.width=width+'px';svg.style.height=height+'px';visualZoom=1;
  requestAnimationFrame(()=>{const viewport=$('visual-viewport');if(visualView==='tree'){setVisualZoom(1,false);}else if(visualView==='time'){const readable=Math.max(.72,Math.min(1.1,(viewport.clientWidth-24)/width));setVisualZoom(readable,false);}else{fitVisualGraph();if(visualZoom<.62)setVisualZoom(.62,false);}viewport.scrollLeft=0;viewport.scrollTop=0;});
}
function renderRoadGraph(){
  const sections=current.roadmap.sections,cardW=276,cardH=184,gapX=92,gapY=104,margin=70,cols=Math.max(1,Math.min(3,sections.length));
  const rows=Math.ceil(sections.length/cols),width=margin*2+cols*cardW+(cols-1)*gapX,height=margin*2+rows*cardH+(rows-1)*gapY;
  const positions=new Map();sections.forEach((section,index)=>{const row=Math.floor(index/cols),raw=index%cols,col=row%2?cols-1-raw:raw;positions.set(section.id,{x:margin+col*(cardW+gapX),y:margin+row*(cardH+gapY)});});
  let routes='',dependencies='',cards='';
  sections.forEach((section,index)=>{if(!index)return;const a=positions.get(sections[index-1].id),b=positions.get(section.id);routes+=`<path d="${graphCurve({x:a.x+cardW/2,y:a.y+cardH/2},{x:b.x+cardW/2,y:b.y+cardH/2})}" class="graph-road"/><path d="${graphCurve({x:a.x+cardW/2,y:a.y+cardH/2},{x:b.x+cardW/2,y:b.y+cardH/2})}" class="graph-road-center"/>`;});
  sections.forEach(section=>section.dependsOn.forEach(id=>{const a=positions.get(id),b=positions.get(section.id);if(a&&b)dependencies+=`<path d="${graphCurve({x:a.x+cardW/2,y:a.y+cardH/2},{x:b.x+cardW/2,y:b.y+cardH/2})}" class="graph-dependency" marker-end="url(#dependency-arrow)"/>`;}));
  sections.forEach((section,index)=>{
    const p=positions.get(section.id),layer=visualLayer(section),states=section.gates.map(g=>current.stats.gates[g.id].status),done=states.filter(s=>s==='done').length;
    const stageStatus=states.length&&done===states.length?'done':states.includes('active')?'active':states.includes('blocked')?'blocked':states.includes('planned')?'planned':states.includes('deferred')?'deferred':'frozen';
    const title=graphText(section.title,p.x+22,p.y+51,'graph-stage-title',31,2);
    const shown=section.gates.slice(0,30),dots=shown.map((gate,gateIndex)=>{const col=gateIndex%15,row=Math.floor(gateIndex/15),cx=p.x+22+col*16,cy=p.y+129+row*21,state=current.stats.gates[gate.id].status,special=gate.id===current.roadmap.currentGateId?' graph-current':gate.id===current.roadmap.nextGateId?' graph-next':'';return `<g class="graph-gate-node${special}" data-graph-gate="${esc(gate.id)}" tabindex="0" role="button" aria-label="${esc(gate.id+' '+gate.title)}"><circle cx="${cx}" cy="${cy}" r="6" class="graph-status-${state}"/><circle cx="${cx}" cy="${cy}" r="10" class="graph-node-ring"/></g>`;}).join('');
    const more=section.gates.length>shown.length?`<text x="${p.x+cardW-48}" y="${p.y+157}" class="graph-more">+${section.gates.length-shown.length}</text>`:'';
    cards+=`<g class="graph-stage layer-${layer}" data-graph-section="${esc(section.id)}" tabindex="0" role="button" aria-label="${esc(section.title)}"><rect x="${p.x}" y="${p.y}" width="${cardW}" height="${cardH}" rx="18" class="graph-stage-card graph-stage-${stageStatus}" filter="url(#node-shadow)"/><text x="${p.x+22}" y="${p.y+25}" class="graph-stage-id">${t("m92")}${index+1} · ${esc(section.id)}</text>${title}<text x="${p.x+22}" y="${p.y+102}" class="graph-stage-meta">${done} / ${section.gates.length} ${t("m68")}${esc(visualLayerLabel(layer))}</text></g>${dots}${more}`;
  });
  $('visual-svg').innerHTML=graphDefs()+routes+dependencies+cards;
  configureVisualSvg(width,height);
}
const timelineDay=24*60*60*1000;
function timelineMoment(value){const moment=value?Date.parse(value):NaN;return Number.isFinite(moment)?moment:null;}
function timelineDateOnly(value){return typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value);}
function timelineStableEnd(gate){
  const published=timelineMoment(gate.publishedAt),completed=timelineMoment(gate.completedAt);
  if(published!==null)return {moment:published,kind:'published',value:gate.publishedAt,gate};
  if(completed!==null)return {moment:completed,kind:'completed',value:gate.completedAt,gate};
  return null;
}
function timelineStart(gates,gate,index){
  const explicit=timelineMoment(gate.startedAt);
  if(explicit!==null)return {moment:explicit,kind:'explicit',value:gate.startedAt,source:null,sourceCount:0};
  const sectionById=new Map(current.roadmap.sections.map(section=>[section.id,section]));
  const datedPredecessor=predecessorIds=>{
    const byId=new Map(gates.map(item=>[item.id,item]));
    const candidates=[...predecessorIds].map(id=>timelineStableEnd(byId.get(id)||{})).filter(Boolean);
    if(!candidates.length)return null;
    const latest=candidates.reduce((selected,item)=>item.moment>selected.moment?item:selected);
    return {moment:latest.moment,kind:'inferred-dependency',value:latest.value,source:latest.gate,sourceCount:candidates.length};
  };
  if(gate.dependsOn.length){
    return datedPredecessor(new Set(gate.dependsOn))||{moment:null,kind:null,value:null,source:null,sourceCount:0};
  }
  for(let previous=index-1;previous>=0&&gates[previous].block.id===gate.block.id;previous--){
    const end=timelineStableEnd(gates[previous]);
    if(end)return {moment:end.moment,kind:'inferred-previous',value:end.value,source:end.gate,sourceCount:1};
  }
  const blockPredecessors=new Set();
  gate.block.dependsOn.forEach(sectionId=>sectionById.get(sectionId)?.gates.forEach(item=>blockPredecessors.add(item.id)));
  if(blockPredecessors.size){
    const inferred=datedPredecessor(blockPredecessors);
    if(inferred)return inferred;
  }
  for(let previous=index-1;previous>=0;previous--){
    const end=timelineStableEnd(gates[previous]);
    if(end)return {moment:end.moment,kind:'inferred-previous',value:end.value,source:end.gate,sourceCount:1};
  }
  return {moment:null,kind:null,value:null,source:null,sourceCount:0};
}
function timelineEntries(){
  const asOf=timelineMoment(current.updatedAt)??Date.now();
  const gates=gateIndex();
  return gates.map((gate,index)=>{
    const startInfo=timelineStart(gates,gate,index),stableEnd=timelineStableEnd(gate),state=current.stats.gates[gate.id].status;
    let start=startInfo.moment,startKind=startInfo.kind,startValue=startInfo.value;
    let end=null,endKind=null,endValue=null;
    if(stableEnd){end=stableEnd.moment;endKind=stableEnd.kind;endValue=stableEnd.value;}
    else if(start!==null&&asOf>=start){end=asOf;endKind='snapshot';endValue=current.updatedAt;}
    if(start!==null&&end!==null&&end<start){
      if(startKind==='explicit'){end=null;endKind=null;endValue=null;}
      else{start=null;startKind=null;startValue=null;}
    }
    return start===null&&end===null?null:{gate,start,startKind,startValue,startSource:startInfo.source,startSourceCount:startInfo.sourceCount,end,endKind,endValue,state};
  }).filter(Boolean);
}
function timelineDurationLabel(entry){
  if(entry.start===null||entry.end===null)return t("m93");
  const elapsed=Math.max(0,entry.end-entry.start);
  if(timelineDateOnly(entry.startValue)||timelineDateOnly(entry.endValue)){
    const days=Math.round(elapsed/timelineDay);
    if(days===0)return t("m94");
    return `${timelineDateOnly(entry.startValue)&&timelineDateOnly(entry.endValue)?'':'≈ '}${days} ${t("m95")}`;
  }
  const minutes=Math.round(elapsed/60000);
  if(minutes<120)return `${minutes} ${t("m96")}`;
  const hours=Math.round(elapsed/360000)/10;
  if(hours<48)return `${hours.toLocaleString(KonturI18n.locale)} ${t("m97")}`;
  const days=Math.floor(hours/24),rest=Math.round((hours-days*24)*10)/10;
  return `${days} ${t("m95")}${rest?` ${rest.toLocaleString(KonturI18n.locale)} ${t("m97")}`:''}`;
}
function timelineEndLabel(entry){return {published:t("m98"),completed:t("m99"),snapshot:t("m100")}[entry.endKind]||t("m101");}
function timelineStartSource(entry){
  if(entry.startKind==='explicit')return t("m102");
  if(entry.startKind==='inferred-dependency')return `${t("m103")}${entry.startSourceCount>1?t("m104"):t("m105")} ${entry.startSource?.id||''}; ${t("m106")}`;
  if(entry.startKind==='inferred-previous')return `${t("m107")}${entry.startSource?.id||''} ${t("m108")}`;
  return t("m109");
}
function timelineAxisLabel(moment,span){
  const options=span<=3*timelineDay?{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}:{day:'2-digit',month:'short',year:'numeric'};
  return new Date(moment).toLocaleString(KonturI18n.locale,options);
}
function renderTimelineGraph(){
  const entries=timelineEntries();
  if(!entries.length){$('visual-svg').innerHTML=graphDefs()+graphText(t("m110"),70,92,'graph-empty',58,2)+graphText(t("m111"),70,142,'timeline-empty-note',75,2);configureVisualSvg(940,260);return;}
  const moments=entries.flatMap(entry=>[entry.start,entry.end].filter(value=>value!==null));let min=Math.min(...moments),max=Math.max(...moments);
  if(max<=min)max=min+timelineDay;
  const rawSpan=max-min,pad=Math.max(timelineDay,rawSpan*.035);min-=pad;max+=pad;const span=max-min;
  const labelWidth=380,chartWidth=Math.max(820,Math.min(6200,Math.ceil(span/timelineDay)*22)),marginRight=70,top=82,rowHeight=58,width=labelWidth+chartWidth+marginRight,height=top+entries.length*rowHeight+46;
  const xAt=value=>labelWidth+(value-min)*chartWidth/span,tickCount=Math.max(5,Math.min(12,Math.floor(chartWidth/150))),parts=[];
  parts.push(`<rect x="0" y="0" width="${labelWidth}" height="${height}" class="timeline-label-pane"/><line x1="${labelWidth}" y1="52" x2="${labelWidth+chartWidth}" y2="52" class="timeline-axis"/>`);
  for(let i=0;i<=tickCount;i++){
    const moment=min+span*i/tickCount,x=xAt(moment),anchor=i===0?'start':i===tickCount?'end':'middle';
    parts.push(`<line x1="${x}" y1="52" x2="${x}" y2="${height-25}" class="timeline-grid"/><text x="${x}" y="34" text-anchor="${anchor}" class="timeline-axis-label">${esc(timelineAxisLabel(moment,span))}</text>`);
  }
  entries.forEach((entry,index)=>{
    const y=top+index*rowHeight,rowY=y-rowHeight/2,label=`${entry.gate.id} · ${entry.gate.title}`,section=entry.gate.block.title;
    const aria=`${label}. ${entry.start!==null?(entry.startKind==='explicit'?t("m112"):t("m113"))+dateLabel(entry.startValue):t("m114")}. ${entry.end!==null?timelineEndLabel(entry)+' '+dateLabel(entry.endValue):t("m101")}.`;
    let mark='';
    if(entry.start!==null&&entry.end!==null){
      const startX=xAt(entry.start),endX=xAt(entry.end),barWidth=Math.max(8,endX-startX),duration=timelineDurationLabel(entry),ongoing=entry.endKind==='snapshot'?' timeline-ongoing':'';
      const inferred=entry.startKind!=='explicit'?' timeline-start-inferred':'';
      mark=`<rect x="${startX}" y="${y-10}" width="${barWidth}" height="20" rx="10" class="timeline-bar graph-status-${entry.state}${ongoing}"/><circle cx="${startX}" cy="${y}" r="5" class="timeline-boundary${inferred}"/><circle cx="${Math.max(startX+8,endX)}" cy="${y}" r="6" class="timeline-boundary timeline-end-${entry.endKind}"/>${barWidth>82?`<text x="${startX+barWidth/2}" y="${y+4}" text-anchor="middle" class="timeline-duration">${esc(duration)}</text>`:''}`;
    }else{
      const moment=entry.end??entry.start,x=xAt(moment),kind=entry.endKind||'start';
      mark=`<path d="M ${x} ${y-9} L ${x+9} ${y} L ${x} ${y+9} L ${x-9} ${y} Z" class="timeline-milestone graph-status-${entry.state} timeline-end-${kind}"/>`;
    }
    const shortId=entry.gate.id.length>13?entry.gate.id.slice(0,12)+'…':entry.gate.id,shortTitle=entry.gate.title.length>34?entry.gate.title.slice(0,33)+'…':entry.gate.title;
    parts.push(`<g class="timeline-row" data-timeline-gate="${esc(entry.gate.id)}" tabindex="0" role="button" aria-label="${esc(aria)}"><rect x="0" y="${rowY}" width="${width}" height="${rowHeight}" class="timeline-row-bg ${index%2?'timeline-row-alt':''}"/><text x="24" y="${y-4}" class="timeline-gate-id">${esc(shortId)}</text><text x="134" y="${y-4}" class="timeline-gate-title">${esc(shortTitle)}</text><text x="134" y="${y+16}" class="timeline-gate-section">${esc(section.length>42?section.slice(0,41)+'…':section)}</text>${mark}</g>`);
  });
  $('visual-svg').innerHTML=graphDefs()+parts.join('');configureVisualSvg(width,height);
}
function renderTreeGraph(){
  const sections=current.roadmap.sections.map(section=>({section,layer:visualLayer(section)})).filter(item=>visualLayers.has(item.layer));
  if(!sections.length){$('visual-svg').innerHTML=graphDefs()+graphText(t("m115"),80,90,'graph-empty',30,1);configureVisualSvg(520,220);return;}
  const marginX=72,laneHeight=118,top=76,maxGates=Math.max(1,...sections.map(item=>item.section.gates.length)),width=Math.max(920,390+maxGates*148),height=top*2+sections.length*laneHeight;
  const gatePositions=new Map(),branchParts=[],nodeParts=[];
  sections.forEach(({section,layer},lane)=>{
    const y=top+lane*laneHeight+44,firstX=330,lastX=firstX+Math.max(0,section.gates.length-1)*148;
    branchParts.push(`<g class="graph-branch-group" data-graph-section="${esc(section.id)}" tabindex="0" role="button" aria-label="${esc(section.title)}"><path d="M 64 ${y} L ${Math.max(firstX,lastX)} ${y}" class="graph-branch layer-stroke-${layer}"/>${graphText(section.title,92,y-23,'graph-branch-title',30,1)}<text x="92" y="${y-5}" class="graph-branch-layer layer-text-${layer}">${esc(visualLayerLabel(layer))}</text></g>`);
    section.gates.forEach((gate,index)=>{const x=firstX+index*148,state=current.stats.gates[gate.id].status,special=gate.id===current.roadmap.currentGateId?' graph-current':gate.id===current.roadmap.nextGateId?' graph-next':'';gatePositions.set(gate.id,{x,y,section});nodeParts.push(`<g class="graph-commit${special}" data-graph-gate="${esc(gate.id)}" tabindex="0" role="button" aria-label="${esc(gate.id+' '+gate.title)}"><circle cx="${x}" cy="${y}" r="9" class="graph-status-${state}"/><circle cx="${x}" cy="${y}" r="14" class="graph-node-ring"/><text x="${x}" y="${y+29}" class="graph-commit-id" text-anchor="middle">${esc(gate.id.length>16?gate.id.slice(0,15)+'…':gate.id)}</text></g>`);});
  });
  const minY=top+44,maxY=top+(sections.length-1)*laneHeight+44,rootY=(minY+maxY)/2,baseline=current.roadmap.baseline.commit?current.roadmap.baseline.commit.slice(0,8):'baseline';
  const trunk=`<path d="M 64 ${minY} L 64 ${maxY}" class="graph-trunk"/><circle cx="64" cy="${rootY}" r="13" class="graph-baseline"/><text x="64" y="${rootY+32}" class="graph-baseline-label" text-anchor="middle">${esc(baseline)}</text>`;
  let dependencyParts='';gatePositions.forEach((target,targetId)=>{const gate=target.section.gates.find(item=>item.id===targetId);gate.dependsOn.forEach(depId=>{const source=gatePositions.get(depId);if(!source)return;const sameLane=source.y===target.y&&Math.abs(target.x-source.x)===148;if(!sameLane)dependencyParts+=`<path d="${graphCurve(source,target)}" class="graph-dependency" marker-end="url(#dependency-arrow)"/>`;});});
  $('visual-svg').innerHTML=graphDefs()+trunk+branchParts.join('')+dependencyParts+nodeParts.join('');
  configureVisualSvg(width,height);
}
const gitRefKey=ref=>ref.kind+':'+ref.name;
const gitRefKind=ref=>({local:t("m116"),remote:t("m117"),tag:t("m118")})[ref.kind]||ref.kind;
const gitCount=(n,one,few,many)=>`${n} ${KonturI18n.language==='ru'?(n%100>=11&&n%100<=14?many:n%10===1?one:n%10>=2&&n%10<=4?few:many):n===1?one:many}`;
function gitRefTitle(ref){
  const leaf=ref.name.split('/').pop().replace(/[-_]+/g,' ').trim();
  return leaf?leaf[0].toUpperCase()+leaf.slice(1):ref.name;
}
function gitBaseRef(snapshot){
  const branches=snapshot.refs.filter(ref=>ref.kind!=='tag');
  const saved=branches.find(ref=>gitRefKey(ref)===gitBaseRefs.get(current.id));
  return saved||branches.find(ref=>ref.kind==='local'&&ref.name===snapshot.defaultBranch)
    ||branches.find(ref=>ref.kind==='remote'&&ref.name==='origin/'+snapshot.defaultBranch)
    ||branches.find(ref=>ref.isHead)||branches[0]||null;
}
function gitBaseSource(snapshot,base){
  if(!base)return t('baseMissing');
  if(gitRefKey(base)===gitBaseRefs.get(current.id))return t('baseSelected');
  if(snapshot.defaultBranch&&(base.kind==='local'&&base.name===snapshot.defaultBranch||base.kind==='remote'&&base.name==='origin/'+snapshot.defaultBranch))return t('basePublished');
  return base.isHead?t('baseHead'):t('baseFirst');
}
function gitSelectedRef(snapshot,base){
  const saved=gitSelectedRefs.get(current.id);
  if(saved==='all')return null;
  return snapshot.refs.find(ref=>gitRefKey(ref)===saved)
    ||snapshot.refs.find(ref=>ref.isHead)||base;
}
function gitAncestors(start,byHash){
  const seen=new Set(),stack=start?[start]:[];
  while(stack.length){const hash=stack.pop(),commit=byHash.get(hash);if(!commit||seen.has(hash))continue;seen.add(hash);commit.parents.forEach(parent=>stack.push(parent));}
  return seen;
}
function gitSpine(start,byHash){
  const nodes=new Set(),edges=new Set();let hash=start;
  while(hash&&byHash.has(hash)&&!nodes.has(hash)){
    nodes.add(hash);const parent=byHash.get(hash).parents[0];if(parent&&byHash.has(parent))edges.add(hash+'|'+parent);hash=parent;
  }
  return {nodes,edges};
}
function gitFocus(ref,base,spine,byHash){
  const nodes=new Set(),edges=new Set();if(!ref)return {nodes,edges};
  if(base&&gitRefKey(ref)===gitRefKey(base))return {nodes:new Set(spine.nodes),edges:new Set(spine.edges)};
  let hash=ref.target;
  while(hash&&byHash.has(hash)&&!nodes.has(hash)){
    nodes.add(hash);if(spine.nodes.has(hash))break;
    const parent=byHash.get(hash).parents[0];if(parent&&byHash.has(parent))edges.add(hash+'|'+parent);hash=parent;
  }
  return {nodes,edges};
}
function gitVisualDepths(snapshot,byHash,spine){
  const children=new Map(snapshot.commits.map(commit=>[commit.hash,[]]));
  snapshot.commits.forEach(commit=>{const parent=commit.parents[0];if(children.has(parent))children.get(parent).push(commit);});
  const byTime=(a,b)=>(Date.parse(a.committedAt)||0)-(Date.parse(b.committedAt)||0)||a.hash.localeCompare(b.hash);
  const nodeDepths=new Map(),edgeDepths=new Map();
  function visit(hash,depth){
    if(nodeDepths.has(hash))return;
    nodeDepths.set(hash,depth);
    const next=[...(children.get(hash)||[])].sort(byTime);
    const continuation=spine.nodes.has(hash)?next.find(child=>spine.edges.has(child.hash+'|'+hash)):next[0];
    next.forEach(child=>{
      const edge=child.hash+'|'+hash;
      const level=depth===null?null:spine.edges.has(edge)?0:spine.nodes.has(hash)?1:child===continuation?depth:Math.min(3,depth+1);
      edgeDepths.set(edge,level??1);visit(child.hash,level);
    });
  }
  const roots=snapshot.commits.filter(commit=>!byHash.has(commit.parents[0])).sort(byTime);
  roots.filter(commit=>spine.nodes.has(commit.hash)).forEach(commit=>visit(commit.hash,0));
  roots.filter(commit=>!nodeDepths.has(commit.hash)).forEach(commit=>visit(commit.hash,null));
  snapshot.commits.forEach(commit=>commit.parents.slice(1).forEach(parent=>{
    if(byHash.has(parent))edgeDepths.set(commit.hash+'|'+parent,nodeDepths.get(commit.hash)??1);
  }));
  return {nodeDepths,edgeDepths};
}
function gitFirstParentPath(start,byHash,included){
  let hash=start;
  while(hash&&byHash.has(hash)&&!included.has(hash)){
    included.add(hash);hash=byHash.get(hash).parents[0];
  }
}
function gitGraphScope(snapshot,refs,base,selected,byHash){
  const all=gitSelectedRefs.get(current.id)==='all',included=new Set(),openRefs=new Map();
  const open=ref=>{if(!ref)return;openRefs.set(gitRefKey(ref),ref);gitFirstParentPath(ref.target,byHash,included);};
  if(all){
    gitAncestors(snapshot.head,byHash).forEach(hash=>included.add(hash));
    refs.forEach(ref=>{openRefs.set(gitRefKey(ref),ref);gitAncestors(ref.target,byHash).forEach(hash=>included.add(hash));});
  }else{
    open(base);open(selected);
    if(!snapshot.refs.some(ref=>ref.isHead))gitFirstParentPath(snapshot.head,byHash,included);
    if(!included.size)gitFirstParentPath(snapshot.head,byHash,included);
    for(const entry of gitExpandedBranches){
      const prefix=current.id+':';if(entry.startsWith(prefix))gitFirstParentPath(entry.slice(prefix.length),byHash,included);
    }
  }
  return {all,included,openRefs:[...openRefs.values()]};
}
function renderGitBrowser(snapshot,refs,base,selected,byHash,spine,visualDepths,scope){
  const baseLabel=base?`${gitRefKind(base)} ${base.name} · ${base.target.slice(0,9)}`:t("m119");
  $('git-summary').innerHTML=`<div><small>${t("m120")}</small><strong>${esc(snapshot.currentBranch||t("m121"))}</strong><code>${esc(snapshot.head?.slice(0,9)||'—')}</code></div><div><small>${t("m122")}</small><strong>${esc(baseLabel)}</strong></div><small>${t("m123")}${esc(dateLabel(snapshot.capturedAt))} · ${gitCount(snapshot.commits.length,t("m124"),t("m125"),t("m126"))} · ${gitCount(snapshot.refs.length,t("m127"),t("m128"),t("m129"))}${snapshot.truncated?t("m130"):''}${snapshot.dirty?t("m131"):''}</small>`;
  const branches=snapshot.refs.filter(ref=>ref.kind!=='tag');
  $('git-base').innerHTML=branches.map(ref=>`<option value="${esc(gitRefKey(ref))}"${base&&gitRefKey(ref)===gitRefKey(base)?' selected':''}>${esc(gitRefKind(ref)+' · '+ref.name)}</option>`).join('');
  $('git-base').disabled=!branches.length;
  const baseReach=gitAncestors(base?.target,byHash),selectedReach=gitAncestors(selected?.target,byHash);
  const unique=[...selectedReach].filter(hash=>!baseReach.has(hash)).length;
  const common=snapshot.commits.find(commit=>baseReach.has(commit.hash)&&selectedReach.has(commit.hash));
  const same=!!(selected&&base&&gitRefKey(selected)===gitRefKey(base));
  const visualLevel=selected?visualDepths.nodeDepths.get(selected.target):null;
  const visualLevelLabel=visualLevel===null||visualLevel===undefined?t("m132"):visualLevel>=3?'3+':String(visualLevel);
  $('git-selection-summary').textContent=selected
    ?`${gitRefKind(selected)} ${selected.name}: ${gitCount(unique,t("m124"),t("m125"),t("m126"))} ${t("m133")}${!same&&baseReach.has(selected.target)?t("m134"):''}${common?t("m135")+common.hash.slice(0,9)+'. ':snapshot.truncated?t("m136"):t("m137")}${selected.kind==='tag'?t("m138"):''}${same?t("m139"):`${t("m140")}${visualLevelLabel}; ${t("m141")}`}`
    :t("m142");
  const query=$('git-ref-search').value.trim().toLocaleLowerCase(KonturI18n.locale),scroll=$('git-branch-list').scrollTop;
  const sorted=[...refs].sort((a,b)=>Number(b.isHead)-Number(a.isHead)||['local','remote','tag'].indexOf(a.kind)-['local','remote','tag'].indexOf(b.kind)||a.name.localeCompare(b.name));
  $('git-branch-list').innerHTML=sorted.filter(ref=>!query||(ref.name+' '+gitRefTitle(ref)).toLocaleLowerCase(KonturI18n.locale).includes(query)).map(ref=>{
    const key=gitRefKey(ref),active=selected&&key===gitRefKey(selected);
    return `<button type="button" class="git-branch-item${active?' selected':''}" data-git-ref="${esc(key)}" aria-pressed="${!!active}" title="${esc(gitRefKind(ref)+' '+ref.name)}"><span class="git-branch-title">${esc(gitRefTitle(ref))}${ref.isHead?' · HEAD':''}</span><small>${esc(gitRefKind(ref))} · ${esc(ref.name)}</small><code>${esc(ref.target.slice(0,9))}</code></button>`;
  }).join('')||`<p class="git-no-refs">${t("m143")}</p>`;
  $('git-branch-list').scrollTop=scroll;
  $('git-fold-summary').textContent=scope.all
    ?`${t("m144")}${gitCount(refs.length,t("m127"),t("m128"),t("m129"))}. ${t("m145")}`
    :`${t("m146")}${scope.openRefs.length} ${t("m19")}${refs.length} ${t("m147")}`;
  $('git-clear-selection').setAttribute('aria-pressed',String(scope.all));
  $('git-clear-selection').textContent=scope.all?t("m148"):t("m149");
  $('git-show-all').setAttribute('aria-pressed',String(gitShowAllCommits.has(current.id)));
  $('git-show-all').textContent=gitShowAllCommits.has(current.id)?t("m150"):t("m151");
}
function renderGitGraph(snapshot){
  const byHash=new Map(snapshot.commits.map(commit=>[commit.hash,commit])),base=gitBaseRef(snapshot),selected=gitSelectedRef(snapshot,base);
  const refMap=new Map(snapshot.refs.filter(ref=>gitLayers.has(ref.layer)).map(ref=>[gitRefKey(ref),ref]));
  for(const ref of [base,selected])if(ref)refMap.set(gitRefKey(ref),ref);
  const refs=[...refMap.values()],scope=gitGraphScope(snapshot,refs,base,selected,byHash),included=scope.included,graphRefs=scope.openRefs;
  const commits=snapshot.commits.filter(commit=>included.has(commit.hash)),spine=gitSpine(base?.target,byHash);
  const focus=gitFocus(selected,base,spine,byHash),visualDepths=gitVisualDepths(snapshot,byHash,spine);
  renderGitBrowser(snapshot,refs,base,selected,byHash,spine,visualDepths,scope);
  if(!commits.length){$('visual-svg').innerHTML=graphDefs()+graphText(t("m152"),70,95,'graph-empty',62,2);configureVisualSvg(820,240);return;}
  const children=new Map(commits.map(commit=>[commit.hash,0]));
  commits.forEach(commit=>commit.parents.forEach(parent=>{if(children.has(parent))children.set(parent,children.get(parent)+1);}));
  const previewMerges=new Set();
  if(!scope.all)for(const ref of [selected,base].filter(Boolean)){
    let hash=ref.target,shownMerges=0;
    while(hash&&byHash.has(hash)&&shownMerges<4){
      const commit=byHash.get(hash);
      if(commit.parents.length>1){previewMerges.add(hash);shownMerges++;}
      hash=commit.parents[0];
    }
  }
  const anchors=new Set(commits.filter(commit=>commit.hash===snapshot.head||graphRefs.some(ref=>ref.target===commit.hash)
    ||commit.parents.length>1&&(scope.all||previewMerges.has(commit.hash)||commit.parents.slice(1).some(parent=>included.has(parent)))
    ||!included.has(commit.parents[0])||children.get(commit.hash)!==1).map(commit=>commit.hash));
  const visible=new Set(gitShowAllCommits.has(current.id)?commits.map(commit=>commit.hash):anchors);
  if(!gitShowAllCommits.has(current.id))commits.filter(commit=>anchors.has(commit.hash)).forEach(commit=>commit.parents.forEach(parent=>{
    if(!included.has(parent))return;const hidden=[];let hash=parent;
    while(hash&&included.has(hash)&&!anchors.has(hash)){hidden.push(hash);hash=byHash.get(hash).parents[0];}
    if(hidden.length<5||gitExpandedSegments.has(current.id+':'+commit.hash+'|'+hash))hidden.forEach(item=>visible.add(item));
  }));
  const shown=commits.filter(commit=>visible.has(commit.hash)),parentsByHash=new Map();
  shown.forEach(commit=>{
    const parents=commit.parents.filter(parent=>included.has(parent)).map(parent=>{
      let hash=parent,skipped=0;while(hash&&!visible.has(hash)&&included.has(hash)){skipped++;hash=byHash.get(hash).parents[0];}
      return hash&&visible.has(hash)?{hash,skipped,first:parent}:null;
    }).filter(Boolean);parentsByHash.set(commit.hash,parents);
  });
  const active=[],positions=new Map();let maxLane=0;
  shown.forEach((commit,row)=>{
    let lane=active.indexOf(commit.hash);if(lane<0){lane=active.findIndex(value=>value===null);if(lane<0)lane=active.length;active[lane]=commit.hash;}
    positions.set(commit.hash,{lane,row});maxLane=Math.max(maxLane,lane);
    const parents=parentsByHash.get(commit.hash),first=parents[0]?.hash||null,existing=first?active.indexOf(first):-1;
    active[lane]=existing>=0&&existing!==lane?null:first;
    let insert=lane+1;parents.slice(1).forEach(parent=>{if(!active.includes(parent.hash)){active.splice(insert,0,parent.hash);insert++;}});
    while(active.length&&active[active.length-1]===null)active.pop();
  });
  const margin=60,laneWidth=38,rowHeight=74,width=Math.max(1100,margin+(maxLane+1)*laneWidth+960),height=margin*2+Math.max(1,shown.length-1)*rowHeight+42;
  let halos='',edges='',badges='',nodes='',branchButtons='';const badgeGaps=new Map();
  shown.forEach(commit=>{
    const source=positions.get(commit.hash),sx=margin+source.lane*laneWidth,sy=margin+source.row*rowHeight;
    parentsByHash.get(commit.hash).forEach(parent=>{
      const target=positions.get(parent.hash),tx=margin+target.lane*laneWidth,ty=margin+target.row*rowHeight,key=commit.hash+'|'+parent.first;
      const d=`M ${sx} ${sy} C ${sx} ${sy+28}, ${tx} ${ty-28}, ${tx} ${ty}`;
      const main=spine.edges.has(key),focused=focus.edges.has(key),level=Math.min(3,visualDepths.edgeDepths.get(key)??1);
      const style=`git-edge git-depth-${level}${selected&&!focused?(main?' git-context':' git-muted'):''}`;
      if(selected&&focused)halos+=`<path d="${d}" class="git-selected-halo git-depth-${level}"/>`;
      edges+=`<path d="${d}" class="${style}"/>`;
      if(parent.skipped){const segment=commit.hash+'|'+parent.hash,mid=(sy+ty)/2,gap=Math.max(0,Math.min(shown.length-2,Math.floor((mid-margin)/rowHeight))),slot=badgeGaps.get(gap)||0,my=margin+(gap+.5)*rowHeight,mx=Math.max(sx,tx)+48+slot*205;
        let hiddenHash=parent.first,hiddenMerges=0;
        while(hiddenHash&&hiddenHash!==parent.hash&&byHash.has(hiddenHash)){if(byHash.get(hiddenHash).parents.length>1)hiddenMerges++;hiddenHash=byHash.get(hiddenHash).parents[0];}
        const countLabel='+'+gitCount(parent.skipped,t("m124"),t("m125"),t("m126"))+(hiddenMerges?' · '+gitCount(hiddenMerges,t("m153"),t("m154"),t("m155")):'');
        badgeGaps.set(gap,slot+1);
        badges+=`<g class="git-segment" data-git-segment="${esc(segment)}" tabindex="0" role="button" aria-label="${t("m156")}${gitCount(parent.skipped,t("m157"),t("m158"),t("m159"))}${hiddenMerges?t("m160")+gitCount(hiddenMerges,t("m161"),t("m162"),t("m163")):''}"><rect x="${mx-6}" y="${my-13}" width="${Math.max(99,18+countLabel.length*6)}" height="25" rx="11"/><text x="${mx+4}" y="${my+4}">${countLabel}</text></g>`;
      }
    });
  });
  shown.forEach(commit=>{
    const position=positions.get(commit.hash),x=margin+position.lane*laneWidth,y=margin+position.row*rowHeight;
    const commitRefs=graphRefs.filter(ref=>ref.target===commit.hash),isHead=commit.hash===snapshot.head,labelX=x+112;
    const refText=commitRefs.slice(0,2).map(ref=>(ref.kind==='local'?'⌂ ':ref.kind==='remote'?'⇢ ':'◆ ')+ref.name).join(' · ')+(commitRefs.length>2?` · +${commitRefs.length-2}`:'');
    const outside=commit.parents.filter(parent=>!byHash.has(parent)).length,folded=commit.parents.filter(parent=>byHash.has(parent)&&!included.has(parent)).length,merge=commit.parents.length>1;
    const faded=selected&&!focus.nodes.has(commit.hash)?(spine.nodes.has(commit.hash)?' git-context':' git-muted'):'';
    nodes+=`<g class="git-commit${isHead?' git-head':''}${faded}${selected&&focus.nodes.has(commit.hash)?' git-focused':''}" data-git-commit="${esc(commit.hash)}" tabindex="0" role="button" aria-label="${esc(commit.hash+' '+commit.subject)}"><rect x="${x-15}" y="${y-28}" width="${Math.max(320,width-x-55)}" height="56" rx="7" class="git-hitbox"/><circle cx="${x}" cy="${y}" r="${merge?10:isHead?10:7}" class="git-commit-dot"/><circle cx="${x}" cy="${y}" r="15" class="graph-node-ring"/>${merge?`<text x="${x}" y="${y+3}" text-anchor="middle" class="git-merge-mark">M</text>`:''}<text x="${x+18}" y="${y+4}" class="git-hash">${esc(commit.hash.slice(0,9))}</text><text x="${labelX}" y="${y-5}" class="git-subject">${esc(commit.subject.length>92?commit.subject.slice(0,91)+'…':commit.subject)}</text><text x="${labelX}" y="${y+16}" class="git-meta">${esc(dateLabel(commit.committedAt))} · ${merge?t("m164"):''}${commit.parents.length} ${t("m165")}${outside?' · '+outside+t("m166"):''}${folded?' · '+folded+t("m167"):''}</text>${refText?`<text x="${labelX}" y="${y-23}" class="git-ref-label">${esc(refText)}</text>`:''}</g>`;
    if(!scope.all&&merge)commit.parents.slice(1).forEach((parent,index)=>{
      if(!byHash.has(parent))return;
      const expanded=gitExpandedBranches.has(current.id+':'+parent),hidden=!included.has(parent);
      if(!expanded&&!hidden)return;
      const bx=x+24+index*88,by=y-30,label=expanded?t("m168"):t("m169");
      branchButtons+=`<g class="git-branch-fold" data-git-branch-toggle="${esc(parent)}" tabindex="0" role="button" aria-expanded="${expanded}" aria-label="${esc((expanded?t("m170"):t("m171"))+t("m172")+commit.hash.slice(0,9))}"><rect x="${bx}" y="${by}" width="78" height="22" rx="11"/><text x="${bx+39}" y="${by+15}" text-anchor="middle">${label}</text></g>`;
    });
  });
  $('visual-svg').innerHTML=graphDefs()+halos+edges+nodes+badges+branchButtons;
  configureVisualSvg(width,height);
}
function setVisualZoom(value,keepCenter=true){
  const svg=$('visual-svg'),viewport=$('visual-viewport'),old=visualZoom,next=Math.max(.35,Math.min(2.4,value)),baseW=Number(svg.dataset.baseWidth||1),baseH=Number(svg.dataset.baseHeight||1);
  const centerX=(viewport.scrollLeft+viewport.clientWidth/2)/old,centerY=(viewport.scrollTop+viewport.clientHeight/2)/old;visualZoom=next;svg.style.width=baseW*next+'px';svg.style.height=baseH*next+'px';$('visual-fit').textContent=Math.round(next*100)+'%';
  if(keepCenter){viewport.scrollLeft=centerX*next-viewport.clientWidth/2;viewport.scrollTop=centerY*next-viewport.clientHeight/2;}
}
function fitVisualGraph(){
  const svg=$('visual-svg'),viewport=$('visual-viewport'),baseW=Number(svg.dataset.baseWidth||1),baseH=Number(svg.dataset.baseHeight||1),fit=Math.max(.35,Math.min(1.25,(viewport.clientWidth-24)/baseW,(viewport.clientHeight-24)/baseH));setVisualZoom(fit,false);viewport.scrollLeft=0;viewport.scrollTop=0;
}
function graphGateById(id){return gateIndex().find(gate=>gate.id===id);}
function showVisualTooltip(event,element){
  const tooltip=$('visual-tooltip'),gateId=element.dataset.graphGate||element.dataset.timelineGate,sectionId=element.dataset.graphSection;
  const commitHash=element.dataset.gitCommit;
  if(commitHash){
    const snapshot=gitSnapshots.get(current.id),commit=snapshot?.commits.find(item=>item.hash===commitHash),refs=snapshot?.refs.filter(ref=>ref.target===commitHash)||[];
    if(!commit)return;
    const base=gitBaseRef(snapshot),byHash=new Map(snapshot.commits.map(item=>[item.hash,item]));
    const baseReach=gitAncestors(base?.target,byHash),baseState=!base?t("m173"):baseReach.has(commitHash)?`${t("m174")}${base.name}: ${t("m175")}`:snapshot.truncated?`${t("m176")}${base.name} ${t("m177")}`:`${t("m174")}${base.name}: ${t("m178")}`;
    tooltip.innerHTML=`<b>${esc(commit.hash.slice(0,12))} · ${esc(commit.subject)}</b><span>${esc(dateLabel(commit.committedAt))} · ${t("m179")}${commit.parents.length}${commit.parents.length>1?t("m180"):''}</span><p>${refs.length?t("m181")+esc(refs.map(ref=>gitRefKind(ref)+' '+ref.name).join(', ')):t("m182")}<br>${esc(baseState)}</p><small>${t("m183")}${esc(commit.hash)}${visualTooltipPinned?t("m184"):t("m185")}</small>`;
  }
  else if(element.dataset.timelineGate){const entry=timelineEntries().find(item=>item.gate.id===gateId),gate=entry?.gate;if(!entry||!gate)return;const start=entry.start===null?t("m186"):dateLabel(entry.startValue),end=entry.end===null?t("m187"):dateLabel(entry.endValue),duration=timelineDurationLabel(entry),startLabel=entry.startKind==='explicit'?t("m188"):t("m189"),endSource=entry.endKind==='published'?t("m190"):entry.endKind==='completed'?t("m191"):entry.endKind==='snapshot'?t("m192"):t("m193");tooltip.innerHTML=`<b>${esc(gate.id)} · ${esc(gate.title)}</b><span>${esc(labels[entry.state])} · ${esc(duration)}</span><p>${esc(startLabel)}: ${esc(start)}<br>${esc(timelineEndLabel(entry))}: ${esc(end)}</p><small>${esc(timelineStartSource(entry)+' '+endSource)} ${t("m194")}</small>`;}
  else if(gateId){const gate=graphGateById(gateId),state=current.stats.gates[gateId];tooltip.innerHTML=`<b>${esc(gate.id)} · ${esc(gate.title)}</b><span>${esc(labels[state.status])} · ${esc(gate.block.title)}</span><p>${esc((gate.note||gate.acceptance||t("m195")).slice(0,240))}</p><small>${t("m196")}</small>`;}
  else{const section=current.roadmap.sections.find(item=>item.id===sectionId),layer=visualLayer(section);tooltip.innerHTML=`<b>${esc(section.title)}</b><span>${esc(visualLayerLabel(layer))} · ${section.gates.length} ${t("m197")}</span><p>${esc((section.description||t("m198")).slice(0,240))}</p><small>${t("m199")}</small>`;}
  tooltip.hidden=false;moveVisualTooltip(event);
}
function moveVisualTooltip(event){const tooltip=$('visual-tooltip'),pad=14,w=tooltip.offsetWidth||280,h=tooltip.offsetHeight||110;tooltip.style.left=Math.min(innerWidth-w-pad,event.clientX+pad)+'px';tooltip.style.top=Math.min(innerHeight-h-pad,event.clientY+pad)+'px';}
async function loadGitSnapshot(force=false){
  const id=current?.id;if(!id||(!force&&gitSnapshots.has(id)))return;
  gitLoadingProject=id;gitErrors.delete(id);renderVisualGraph();
  try{gitSnapshots.set(id,await api('/projects/'+id+'/git'));}
  catch(error){gitSnapshots.set(id,null);gitErrors.set(id,error.status===404?t("m200"):error.message);}
  finally{if(gitLoadingProject===id)gitLoadingProject=null;if(current?.id===id&&$('visual-dialog')?.open)renderVisualGraph();}
}
function attachVisualInteractions(){
  const svg=$('visual-svg');
  svg.querySelectorAll('[data-graph-gate],[data-timeline-gate],[data-graph-section],[data-git-commit]').forEach(element=>{
    const activate=event=>{const commitHash=element.dataset.gitCommit;if(commitHash){visualTooltipPinned=true;const rect=element.getBoundingClientRect(),point=Number.isFinite(event?.clientX)?event:{clientX:rect.right,clientY:rect.top};showVisualTooltip(point,element);return;}const gateId=element.dataset.graphGate||element.dataset.timelineGate,sectionId=element.dataset.graphSection;$('visual-dialog').close();if(gateId)showGate(gateId);else openSection(sectionId);};
    element.addEventListener('click',event=>{event.stopPropagation();activate();});element.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();activate();}});
    element.addEventListener('pointerenter',event=>{if(!visualTooltipPinned)showVisualTooltip(event,element);});element.addEventListener('pointermove',event=>{if(!visualTooltipPinned)moveVisualTooltip(event);});element.addEventListener('pointerleave',()=>{if(!visualTooltipPinned)$('visual-tooltip').hidden=true;});
  });
  svg.querySelectorAll('[data-git-segment]').forEach(element=>{
    const expand=()=>{gitExpandedSegments.add(current.id+':'+element.dataset.gitSegment);renderVisualGraph();};
    element.addEventListener('click',event=>{event.stopPropagation();expand();});
    element.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();expand();}});
  });
  svg.querySelectorAll('[data-git-branch-toggle]').forEach(element=>{
    const toggle=()=>{const key=current.id+':'+element.dataset.gitBranchToggle;if(gitExpandedBranches.has(key))gitExpandedBranches.delete(key);else gitExpandedBranches.add(key);renderVisualGraph();};
    element.addEventListener('click',event=>{event.stopPropagation();toggle();});
    element.addEventListener('keydown',event=>{if(event.key==='Enter'||event.key===' '){event.preventDefault();toggle();}});
  });
}
function renderVisualGraph(){
  if(!current)return;
  visualTooltipPinned=false;$('visual-tooltip').hidden=true;
  document.querySelectorAll('[data-visual-view]').forEach(button=>button.setAttribute('aria-selected',String(button.dataset.visualView===visualView)));
  const git=gitSnapshots.get(current.id),loading=gitLoadingProject===current.id,known=gitSnapshots.has(current.id);
  $('visual-layers').hidden=true;$('git-layers').hidden=visualView!=='tree';$('git-browser').hidden=visualView!=='tree'||!git;
  if(visualView==='road'){
    $('visual-note').textContent=t("m201");
    $('visual-legend').innerHTML=`<span><i class="status-dot fill-done"></i>${t("m4")}</span><span><i class="status-dot fill-active"></i>${t("m2")}</span><span><i class="status-dot fill-blocked"></i>${t("m3")}</span><span><i class="status-dot fill-planned"></i>${t("m1")}</span><span><i class="status-dot fill-deferred"></i>${t("m5")}</span><span><i class="status-dot fill-frozen"></i>${t("m6")}</span><small>${t("m202")}</small>`;
    renderRoadGraph();
  }else if(visualView==='time'){
    const timed=timelineEntries(),total=gateIndex().length,exact=timed.filter(entry=>entry.startKind==='explicit'&&entry.endKind==='published').length,inferred=timed.filter(entry=>entry.startKind?.startsWith('inferred')).length;
    $('visual-note').textContent=`${t("m203")}${exact}; ${t("m204")}${inferred}; ${t("m205")}${timed.length} ${t("m19")}${total} ${t("m206")}`;
    $('visual-legend').innerHTML=`<span><i class="timeline-legend-bar"></i>${t("m207")}</span><span><i class="timeline-legend-inferred"></i>${t("m189")}</span><span><i class="timeline-legend-published"></i>${t("m98")}</span><span><i class="timeline-legend-completed"></i>${t("m99")}</span><span><i class="timeline-legend-snapshot"></i>${t("m100")}</span><small>${t("m208")}</small>`;
    renderTimelineGraph();
  }else if(git){
    $('visual-note').textContent=`${t("m209")}${git.repository} · ${t("m210")}${git.revision}. ${t('baseProvenance',{source:gitBaseSource(git,gitBaseRef(git))})} ${t("m212")} ${t("m213")}`;
    $('visual-legend').innerHTML=`<span><i class="git-line-sample main"></i>${t("m214")}</span><span><i class="git-line-sample side"></i>${t("m215")}</span><span><i class="git-line-sample selected"></i>${t("m216")}</span><span><i class="git-node-sample head"></i>HEAD</span><span class="git-merge-legend">M — ${t("m153")}</span><small>${t('gitLegend')}</small>`;
    renderGitGraph(git);
  }else{
    const message=loading?t("m218"):(localMessage(gitErrors.get(current.id))||(known?t("m219"):t("m220")));
    $('visual-note').textContent=message+t("m221");
    $('visual-legend').innerHTML=`<small>${t("m222")}</small>`;
    $('visual-svg').innerHTML=graphDefs()+graphText(message,70,95,'graph-empty',58,3);configureVisualSvg(760,240);
  }
  attachVisualInteractions();
  try{localStorage.setItem('monitor-visual-view',visualView);}catch{}
}
function referenceList(items){return items.length?`<ul class="reference-list">${items.map(item=>`<li><strong>${esc(item.label)}</strong><code>${esc(item.path)}</code></li>`).join('')}</ul>`:`<p class="muted">${t("m223")}</p>`;}
function showGate(id){
  if(!$('gate-dialog')){location.reload();return;}
  const gates=gateIndex(),g=gates.find(g=>g.id===id);
  if(!g){$('gate-dialog').close();notice(t("m224"));return;}
  selectedGate=id;
  const state=current.stats.gates[id], r=current.roadmap, timing=timelineEntries().find(entry=>entry.gate.id===id);
  const effectiveStart=g.startedAt?dateLabel(g.startedAt):(timing&&timing.start!==null?dateLabel(timing.startValue)+t("m225"):t("m62"));
  const timingNote=timing&&timing.startKind?.startsWith('inferred')?timelineStartSource(timing)+t("m226"):t("m227");
  const prerequisites=[...new Set([...g.dependsOn,...g.block.dependsOn])];
  const dependents=gates.filter(x=>x.dependsOn.includes(id)||x.block.dependsOn.includes(g.block.id));
  const statusDiff=g.status!==state.status?`<p class="status-explanation">${t("m228")}<b>${labels[g.status]}</b>. ${t("m229")}<b>${labels[state.status]}</b>.</p>`:'';
  const reasons=state.blockers.length?`<div class="entity-list">${state.blockers.map(x=>entityButton(x)).join('')}</div>`:`<p>${state.status==='blocked'?t("m230"):['frozen','deferred'].includes(state.status)?t("m231"):state.ready?t("m232"):t("m233")}</p>`;
  $('gate-detail').innerHTML=`<div class="gate-heading"><span class="gate-id">${esc(id)}</span><span class="badge ${state.status}">${labels[state.status]}</span><span class="muted">${r.activeGateIds.includes(id)?t("m234"):t("m235")}</span></div><h2 id="gate-title">${esc(g.title)}</h2><div class="entity-list">${entityButton(g.block.id)}</div>${statusDiff}
    <section class="detail-section"><h3>${t("m236")}</h3>${reasons}${state.blockers.includes(g.block.id)?`<p class="muted">${t("m237")}</p>`:''}</section>
    <div class="detail-columns"><section class="detail-section"><h3>${t("m238")}</h3><p class="preserve-lines">${esc(g.acceptance||t("m239"))}</p></section><section class="detail-section"><h3>${t("m240")}</h3><p class="preserve-lines">${esc(g.existing||t("m241"))}</p></section></div>
    <section class="detail-section"><h3>${t("m242")}</h3><p class="preserve-lines">${esc(g.note||t("m243"))}</p></section>
    <section class="detail-section"><h3>${t("m244")}</h3><p class="muted">${t("m245")}</p><div class="dependency-flow"><div><h4>${t("m246")}${prerequisites.length}</h4>${prerequisites.map(x=>entityButton(x)).join('')||`<p class="muted">${t("m247")}</p>`}</div><div class="flow-current"><span aria-hidden="true">→</span><b>${esc(g.id)}</b><span class="badge ${state.status}">${labels[state.status]}</span><span aria-hidden="true">→</span></div><div><h4>${t("m248")}${dependents.length}</h4>${dependents.map(x=>gateButton(x.id)).join('')||`<p class="muted">${t("m249")}</p>`}</div></div></section>
    <div class="detail-columns"><section class="detail-section"><h3>${t("m250")}${g.evidence.length}</h3>${g.status==='done'&&!g.evidence.length?`<p class="muted">${t("m251")}</p>`:''}${referenceList(g.evidence)}</section><section class="detail-section"><h3>${t("m252")}</h3><p>${t("m253")}<b>${esc(effectiveStart)}</b></p><p>${t("m254")}<b>${esc(dateLabel(g.publishedAt))}</b></p><p>${t("m255")}<b>${esc(dateLabel(g.completedAt))}</b></p><p class="muted">${esc(timingNote)}</p></section></div><section class="detail-section"><h3>${t("m256")}${g.sources.length}</h3>${referenceList(g.sources)}</section><p class="muted">${t("m257")}</p>`;
  if(!$('gate-dialog').open)$('gate-dialog').showModal();
  $('gate-title').tabIndex=-1;$('gate-title').focus({preventScroll:true});
  $('gate-dialog').scrollTop=0;
}
function selectFilter(value){filter=value;renderBlocks();$('blocks').scrollIntoView({block:'start',behavior:'smooth'});}
function openSection(id){
  $('gate-dialog')?.close();filter='all';$('search').value='';expandedBlocks.delete('closed:'+id);expandedBlocks.add(id);renderBlocks();
  const el=$('block-'+id);if(el){el.querySelector('summary').focus();el.scrollIntoView({block:'start',behavior:'smooth'});}
}
document.addEventListener('click',e=>{
  const gate=e.target.closest('[data-gate]'), section=e.target.closest('[data-section]'), status=e.target.closest('[data-status]');
  if(gate)showGate(gate.dataset.gate);else if(section)openSection(section.dataset.section);else if(status)selectFilter(status.dataset.status);else if(e.target.closest('[data-reset-filter]'))selectFilter('all');
});
$('close-gate')?.addEventListener('click',()=>$('gate-dialog').close());
$('visualize')?.addEventListener('click',async()=>{$('visual-dialog').showModal();renderVisualGraph();if(visualView==='tree')await loadGitSnapshot();});
$('close-visual')?.addEventListener('click',()=>$('visual-dialog').close());
$('visual-dialog')?.addEventListener('close',()=>{$('visual-tooltip').hidden=true;visualTooltipPinned=false;visualDrag=null;});
document.querySelectorAll('[data-visual-view]').forEach(button=>button.addEventListener('click',async()=>{visualView=button.dataset.visualView;renderVisualGraph();if(visualView==='tree')await loadGitSnapshot();}));
document.querySelectorAll('[data-visual-layer]').forEach(button=>button.addEventListener('click',()=>{const layer=button.dataset.visualLayer;if(visualLayers.has(layer))visualLayers.delete(layer);else visualLayers.add(layer);button.setAttribute('aria-pressed',String(visualLayers.has(layer)));renderVisualGraph();}));
document.querySelectorAll('[data-git-layer]').forEach(button=>button.addEventListener('click',()=>{const layer=button.dataset.gitLayer;if(gitLayers.has(layer))gitLayers.delete(layer);else gitLayers.add(layer);button.setAttribute('aria-pressed',String(gitLayers.has(layer)));renderVisualGraph();}));
$('git-reload')?.addEventListener('click',()=>loadGitSnapshot(true));
$('git-base')?.addEventListener('change',event=>{gitBaseRefs.set(current.id,event.target.value);renderVisualGraph();});
$('git-ref-search')?.addEventListener('input',()=>{if(gitSnapshots.get(current?.id)&&visualView==='tree')renderVisualGraph();});
$('git-branch-list')?.addEventListener('click',event=>{const button=event.target.closest('[data-git-ref]');if(!button)return;gitSelectedRefs.set(current.id,button.dataset.gitRef);renderVisualGraph();});
$('git-clear-selection')?.addEventListener('click',()=>{
  if(gitSelectedRefs.get(current.id)==='all'){
    gitSelectedRefs.delete(current.id);
    for(const entry of gitExpandedBranches)if(entry.startsWith(current.id+':'))gitExpandedBranches.delete(entry);
  }else gitSelectedRefs.set(current.id,'all');
  renderVisualGraph();
});
$('git-show-all')?.addEventListener('click',()=>{if(gitShowAllCommits.has(current.id))gitShowAllCommits.delete(current.id);else gitShowAllCommits.add(current.id);renderVisualGraph();});
$('visual-zoom-out')?.addEventListener('click',()=>setVisualZoom(visualZoom-.15));
$('visual-zoom-in')?.addEventListener('click',()=>setVisualZoom(visualZoom+.15));
$('visual-fit')?.addEventListener('click',fitVisualGraph);
$('visual-viewport')?.addEventListener('wheel',event=>{if(!event.ctrlKey&&!event.metaKey)return;event.preventDefault();setVisualZoom(visualZoom+(event.deltaY<0?.12:-.12));},{passive:false});
$('visual-viewport')?.addEventListener('pointerdown',event=>{if(event.button!==0||event.target.closest('[data-graph-gate],[data-timeline-gate],[data-graph-section],[data-git-commit],[data-git-segment],[data-git-branch-toggle]'))return;visualTooltipPinned=false;$('visual-tooltip').hidden=true;const viewport=$('visual-viewport');visualDrag={x:event.clientX,y:event.clientY,left:viewport.scrollLeft,top:viewport.scrollTop};viewport.setPointerCapture(event.pointerId);viewport.classList.add('dragging');});
$('visual-viewport')?.addEventListener('pointermove',event=>{if(!visualDrag)return;const viewport=$('visual-viewport');viewport.scrollLeft=visualDrag.left-(event.clientX-visualDrag.x);viewport.scrollTop=visualDrag.top-(event.clientY-visualDrag.y);});
for(const name of ['pointerup','pointercancel'])$('visual-viewport')?.addEventListener(name,()=>{visualDrag=null;$('visual-viewport').classList.remove('dragging');});
$('projects').addEventListener('click',e=>{const b=e.target.closest('[data-project]');if(b){current=projects.find(p=>p.id===b.dataset.project);$('search').value='';filter='work';render();}});
document.querySelectorAll('[data-filter]').forEach(b=>b.addEventListener('click',()=>{filter=b.dataset.filter;document.querySelectorAll('[data-filter]').forEach(x=>x.setAttribute('aria-selected',String(x===b)));renderBlocks();}));
$('search').addEventListener('input',renderBlocks);$('refresh').addEventListener('click',()=>refresh());
$('theme-toggle').addEventListener('click',()=>paintTheme(activeTheme()==='dark'?'light':'dark',true));
$('language-select').addEventListener('change',event=>KonturI18n.setLanguage(event.target.value));
window.addEventListener('kontur-language-change',()=>{
  paintTheme(activeTheme());paintSync();notice(lastNotice);
  if(key&&$('login').hidden)render();
});
$('login-form').addEventListener('submit',e=>{e.preventDefault();key=$('token').value.trim();$('token').value='';refresh();});
$('logout').addEventListener('click',async()=>{loggingOut=true;key='';await forgetKey();location.reload();});
window.addEventListener('storage',event=>{
  if(event.storageArea===window.localStorage && (event.key==='monitor-key'||event.key==='monitor-auth-change'||event.key===null)){
    key='';
    try{sessionStorage.removeItem('monitor-key');}catch{/* Do not restore a legacy key after logout. */}
    reloadAuth();
  }else if(event.storageArea===window.localStorage && event.key==='monitor-theme' && (event.newValue==='dark'||event.newValue==='light'))paintTheme(event.newValue);
  else if(event.storageArea===window.localStorage && event.key==='kontur-language')KonturI18n.setLanguage(event.newValue,false);
});
function newProject(){if(!key){notice(t("m258"));return;}$('create-dialog').showModal();}
$('new-project').addEventListener('click',newProject);$('empty-add').addEventListener('click',newProject);$('cancel-create').addEventListener('click',()=>$('create-dialog').close());
$('create-form').addEventListener('submit',async e=>{e.preventDefault();const button=e.submitter;button.disabled=true;try{current=await api('/projects',{method:'POST',body:JSON.stringify({id:$('new-id').value,name:$('new-name').value,type:$('new-type').value})});$('create-dialog').close();$('create-form').reset();await refresh();}catch(error){$('create-dialog').close();notice(error.message);}finally{button.disabled=false;}});
function projectBody(){const {name,type,description,archived,roadmap}=current;return {name,type,description,archived,roadmap};}
$('export').addEventListener('click',()=>{const a=document.createElement('a');a.href=URL.createObjectURL(new Blob([JSON.stringify({id:current.id,...projectBody()},null,2)],{type:'application/json'}));a.download=current.id+'.json';a.click();setTimeout(()=>URL.revokeObjectURL(a.href),1000);});
$('import').addEventListener('click',()=>$('import-file').click());
$('import-file').addEventListener('change',async e=>{const f=e.target.files[0];if(!f)return;const target=current;try{if(f.size>2_000_000)throw Error(t("m259"));const data=JSON.parse(await f.text());if(data.id&&data.id!==target.id)throw Error(t("m260"));const body=data.sections?{name:target.name,type:target.type,description:target.description,archived:target.archived,roadmap:data}:data;delete body.id;delete body.stats;delete body.revision;delete body.updatedAt;if(!confirm(t('importConfirm',{project:target.name,file:f.name})))return;await api('/projects/'+target.id,{method:'PUT',headers:{'If-Match':String(target.revision)},body:JSON.stringify(body)});await refresh();notice(t("m264"));}catch(error){notice(error instanceof SyntaxError?t('invalidJson'):error.message);}finally{e.target.value='';}});
refresh();setInterval(()=>{if(key&&!document.hidden&&!$('create-dialog').open&&!$('gate-dialog')?.open&&!$('visual-dialog')?.open)refresh(true);},60000);
});
