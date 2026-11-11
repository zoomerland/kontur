'use strict';
// Synthetic, loopback-only smoke. Requires an existing Playwright + Chrome installation.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const http=require('node:http');
const {chromium}=require('playwright');
const root=path.join(__dirname,'..');
const states=['planned','active','blocked','done','deferred','frozen'];
const gates=states.map((status,i)=>({id:'G'+i,title:'Исходный текст '+i,status,acceptance:'Original acceptance <b>plain text</b>',existing:'已有成果',note:'Original note',dependsOn:i===2?['G0']:[],evidence:i===3?[{label:'Evidence',path:'synthetic/evidence.txt'}]:[],sources:[],startedAt:'2026-01-01',publishedAt:i===3?'2026-01-03':null,completedAt:i===3?'2026-01-04':null}));
const project={id:'synthetic-project',name:'Исходный проект 中文',type:'general',description:'User description <img src=x onerror=window.leaked=true>',archived:false,revision:2,updatedAt:'2026-01-05T12:00:00Z',roadmap:{updatedAt:'2026-01-05T11:00:00Z',baseline:{summary:'Original baseline',commit:'a'.repeat(40)},sections:[{id:'B1',title:'原始模块',description:'Original block',scope:'mvp',status:'active',dependsOn:[],gates}],activeGateIds:['G0','G1','G2','G3'],currentGateId:'G1',nextGateId:'G2',focusNote:'Original focus'},stats:{total:6,counts:Object.fromEntries(states.map(s=>[s,1])),plan:{total:4,done:1,percent:25},gates:Object.fromEntries(gates.map(g=>[g.id,{status:g.status,ready:g.status==='planned',blockers:g.status==='blocked'?['G0']:[]}]))}};
const a='a'.repeat(40),b='b'.repeat(40),c='c'.repeat(40);
const snapshot={repository:'synthetic-repository',revision:1,capturedAt:'2026-01-05T12:00:00Z',currentBranch:'topic',defaultBranch:'main',head:c,dirty:false,truncated:false,refs:[{kind:'local',name:'main',target:b,layer:'work',isHead:false},{kind:'local',name:'topic',target:c,layer:'work',isHead:true},{kind:'tag',name:'v1',target:a,layer:'formal',isHead:false}],commits:[{hash:c,parents:[a],subject:'Original commit 中文',committedAt:'2026-01-03T12:00:00Z'},{hash:b,parents:[a],subject:'Original main commit',committedAt:'2026-01-02T12:00:00Z'},{hash:a,parents:[],subject:'Original root',committedAt:'2026-01-01T12:00:00Z'}]};
let failStatus=0;
let currentProject=project;
const importWrites=[];
const files={'/':'static/index.html','/static/app.js':'static/app.js','/static/i18n.js':'static/i18n.js','/static/style.css':'static/style.css'};
const server=http.createServer((req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(files[url.pathname]){
    res.setHeader('Content-Type',url.pathname.endsWith('.js')?'application/javascript':url.pathname.endsWith('.css')?'text/css':'text/html');
    res.setHeader('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'");
    res.end(fs.readFileSync(path.join(root,files[url.pathname])));return;
  }
  res.setHeader('Content-Type','application/json');
  if(failStatus){res.statusCode=failStatus;res.end(JSON.stringify({detail:'Do not display server-internal detail'}));return;}
  if(url.pathname==='/api/v1/projects'){res.end(JSON.stringify([currentProject]));return;}
  if(url.pathname==='/api/v1/projects/'+project.id){
    if(req.method==='GET'){res.end(JSON.stringify(currentProject));return;}
    if(req.method==='PUT'){
      let body='';
      req.setEncoding('utf8');
      req.on('data',chunk=>{body+=chunk;});
      req.on('end',()=>{
        const ifMatch=req.headers['if-match'];
        importWrites.push({ifMatch,body});
        if(ifMatch!==String(currentProject.revision)){
          res.statusCode=409;
          res.end(JSON.stringify({detail:'Revision changed'}));
          return;
        }
        currentProject={...currentProject,...JSON.parse(body),revision:currentProject.revision+1};
        res.end(JSON.stringify(currentProject));
      });
      return;
    }
  }
  if(url.pathname.endsWith('/git')){res.end(JSON.stringify(snapshot));return;}
  res.statusCode=404;res.end(JSON.stringify({detail:'Not found'}));
});
(async()=>{
  let browser;
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    browser=await chromium.launch({channel:'chrome',headless:true});
    const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.waitForSelector('#login:not([hidden])');
    assert.equal(await page.locator('html').getAttribute('lang'),'en');
    assert.equal(await page.locator('#sync').innerText(),'Key required');
    await page.selectOption('#language-select','ru');
    assert.equal(await page.locator('#sync').innerText(),'Нужен ключ');
    await page.reload();assert.equal(await page.locator('html').getAttribute('lang'),'ru');
    await page.selectOption('#language-select','en');
    await page.fill('#token','synthetic-key-for-browser-tests-000000000');
    await page.locator('#login-form button').click();
    await page.waitForSelector('#dashboard:not([hidden])');
    assert.equal(await page.locator('#title').innerText(),project.name);
    for(const locale of ['en','ru','zh-CN']){
      await page.selectOption('#language-select',locale);
      assert.equal(await page.locator('html').getAttribute('lang'),locale);
      assert.equal(await page.locator('#title').innerText(),project.name);
      assert.equal(await page.locator('#description').innerText(),project.description);
      assert.equal(await page.locator('#project-type').innerText(),await page.evaluate(()=>KonturI18n.t('generalHeading')));
      assert.equal(await page.locator('.side-bottom a').getAttribute('href'),'/docs?lang='+locale);
      assert.equal((await page.locator('.status-legend button[data-status="done"]').innerText()).replace(/\s/g,''),(await page.evaluate(()=>KonturI18n.t('m4'))).replace(/\s/g,'')+'1');
      if(process.env.SAVE_SCREENSHOTS){const output=path.join(root,'output/playwright');fs.mkdirSync(output,{recursive:true});await page.screenshot({path:path.join(output,'frontend-'+locale+'.png'),fullPage:true});}
      await page.locator('#current [data-gate]').click();
      assert.equal(await page.locator('#gate-title').innerText(),gates[1].title);
      assert.equal(await page.locator('#gate-detail h3').first().innerText(),await page.evaluate(()=>KonturI18n.t('m236')));
      assert.equal(await page.locator('#gate-detail .preserve-lines').first().innerText(),gates[1].acceptance);
      await page.locator('#close-gate').click();
      await page.locator('#visualize').click();
      for(const view of ['road','time','tree']){
        await page.locator(`[data-visual-view="${view}"]`).click();
        if(view==='tree')await page.waitForSelector('.git-commit');
        assert.ok((await page.locator('#visual-svg').innerHTML()).includes('<text'));
        const node=view==='tree'?page.locator('[data-git-commit]').first():view==='time'?page.locator('[data-timeline-gate]').first():page.locator('[data-graph-gate]').first();
        await node.hover();await page.waitForSelector('#visual-tooltip:not([hidden])');
        assert.ok((await page.locator('#visual-tooltip').innerText()).length>20);
        if(view==='tree')assert.ok((await page.locator('#visual-note').innerText()).includes(await page.evaluate(()=>KonturI18n.t('basePublished'))));
      }
      // Changing the locale re-renders an open dialog without changing source content.
      await page.evaluate(()=>KonturI18n.setLanguage(KonturI18n.language));
      assert.equal(await page.locator('#visual-dialog').evaluate(d=>d.open),true);
      await page.locator('#close-visual').click();
      await page.locator('#new-project').click();
      assert.equal(await page.locator('#new-type option[value="general"]').innerText(),await page.evaluate(()=>KonturI18n.t('general')));
      await page.locator('#cancel-create').click();
    }
    await page.reload();assert.equal(await page.locator('html').getAttribute('lang'),'zh-CN');await page.waitForSelector('#dashboard:not([hidden])');
    failStatus=409;await page.locator('#refresh').click();await page.waitForFunction(()=>document.getElementById('notice').textContent===KonturI18n.t('m13'));
    await page.selectOption('#language-select','en');assert.equal(await page.locator('#notice').innerText(),await page.evaluate(()=>KonturI18n.t('m13')));
    failStatus=500;await page.locator('#refresh').click();await page.waitForFunction(()=>document.getElementById('notice').textContent.includes('500'));
    assert.equal(await page.locator('#notice').innerText(),'Request failed (HTTP 500).');
    await page.locator('#import').click();await page.locator('#import-file').setInputFiles({name:'broken.json',mimeType:'application/json',buffer:Buffer.from('{broken')});
    await page.waitForFunction(()=>document.getElementById('notice').textContent===KonturI18n.t('invalidJson'));
    failStatus=0;
    const importName='Imported <img src=x onerror=window.leaked=true>';
    const file={name:'project.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify({...project,name:importName}))};
    await page.locator('#import-file').setInputFiles(file);
    await page.waitForSelector('#confirm-import:enabled');
    assert.ok((await page.locator('#import-diff').innerText()).includes(importName));
    assert.equal(await page.locator('#import-diff img').count(),0);
    await page.keyboard.press('Escape');
    await page.waitForSelector('#import-dialog',{state:'hidden'});
    assert.equal(importWrites.length,0);
    await page.locator('#import-file').setInputFiles(file);
    await page.waitForSelector('#confirm-import:enabled');
    currentProject={...project,revision:3,name:'Concurrent project update'};
    await page.locator('#confirm-import').click();
    await page.waitForFunction(()=>document.getElementById('import-status').textContent===KonturI18n.t('importReconfirm'));
    assert.ok((await page.locator('#import-diff').innerText()).includes(currentProject.name));
    assert.match(await page.locator('#import-summary').innerText(),/revision 3/);
    assert.deepEqual(importWrites.map(write=>write.ifMatch),['2']);
    await page.locator('#confirm-import').click();
    await page.waitForSelector('#import-dialog',{state:'hidden'});
    await page.waitForFunction(name=>document.getElementById('title').textContent===name,importName);
    assert.deepEqual(importWrites.map(write=>write.ifMatch),['2','3']);
    assert.equal(importWrites[0].body,importWrites[1].body);
    for(const locale of ['en','ru','zh-CN']){
      await page.selectOption('#language-select',locale);await page.setViewportSize({width:390,height:844});
      assert.ok(await page.locator('#language-select').isVisible());
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=window.innerWidth),true,`Mobile overflow: ${locale}`);
    }
    assert.equal(await page.evaluate(()=>window.leaked),undefined);
    assert.deepEqual(errors,[]);
    console.log('PASS: synthetic Chrome smoke: login, all three locales, source-text escaping, project views, JSON import preview, cancellation, 409 re-confirmation, 390px layout, CSP and no page errors.');
  }finally{if(browser)await browser.close();await new Promise(resolve=>server.close(resolve));}
})().catch(error=>{console.error(error);process.exitCode=1;});
