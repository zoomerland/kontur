'use strict';
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const root=path.join(__dirname,'..');
const source=fs.readFileSync(path.join(root,'static/i18n.js'),'utf8');
function context(saved,blocked=false){
  const storage=new Map(saved?[['kontur-language',saved]]:[]);
  const doc={documentElement:{lang:'',dataset:{}},querySelectorAll:()=>[],getElementById:()=>null};
  const sandbox={document:doc,Event:class{constructor(type){this.type=type;}},localStorage:{getItem:key=>{if(blocked)throw Error('disabled');return storage.get(key);},setItem:(key,value)=>{if(blocked)throw Error('disabled');storage.set(key,value);}},dispatchEvent:()=>{}};
  sandbox.window=sandbox;
  vm.runInNewContext(source.replace('const supported =','global.__dictionaries=dictionaries;\nconst supported ='),sandbox);
  return {i18n:sandbox.KonturI18n,dictionaries:sandbox.__dictionaries,doc,storage,sandbox};
}
const {i18n,dictionaries,doc,storage}=context();
assert.equal(i18n.language,'en');assert.equal(doc.documentElement.lang,'en');
const keys=Object.keys(dictionaries.en).sort();
const placeholders=text=>[...text.matchAll(/\{([A-Za-z0-9_]+)\}/g)].map(m=>m[1]).sort();
for(const locale of i18n.supported){
  assert.deepEqual(Object.keys(dictionaries[locale]).sort(),keys);
  for(const key of keys){
    assert.ok(dictionaries[locale][key].trim(),`${locale}:${key} is empty`);
    assert.deepEqual(placeholders(dictionaries[locale][key]),placeholders(dictionaries.en[key]),`${locale}:${key} placeholders`);
    if(locale!=='ru')assert.doesNotMatch(dictionaries[locale][key],/[А-Яа-яЁё]/,`${locale}:${key} contains untranslated Russian`);
  }
  i18n.setLanguage(locale);assert.equal(doc.documentElement.lang,locale);assert.equal(storage.get('kontur-language'),locale);
  assert.equal(i18n.t('importConfirm',{project:'<Тест {file}>',file:'示例.json'}).includes('<Тест {file}>'),true);
}
for(const file of ['static/app.js','static/index.html']){
  const text=fs.readFileSync(path.join(root,file),'utf8');
  const referenced=[...text.matchAll(/\bt\(["']([^"']+)["']/g),...text.matchAll(/data-i18n(?:-[a-z-]+)?="([^"]+)"/g)].map(m=>m[1]);
  for(const key of referenced)assert.ok(keys.includes(key),`${file}: missing ${key}`);
}
assert.equal(context('ru').i18n.language,'ru');assert.equal(context('zh-CN').i18n.language,'zh-CN');
assert.equal(context('unsupported').i18n.language,'en');assert.equal(context('ru',true).i18n.language,'en');
context(null,true).i18n.setLanguage('zh-CN');
const app=fs.readFileSync(path.join(root,'static/app.js'),'utf8');
// Exercise the production helpers with neutral synthetic refs, without mounting the UI.
const gitContext=context();
let ready;
gitContext.doc.addEventListener=(name,callback)=>{if(name==='DOMContentLoaded')ready=callback;};
const seam='function gitRefTitle(ref){';
assert.ok(app.includes(seam),'Git helper test seam must exist');
vm.runInNewContext(app.replace(seam,`globalThis.gitTest={gitBaseRef,gitSelectedRef,gitBaseSource,gitSpine,gitVisualDepths,
  project:id=>{current={id};},base:key=>gitBaseRefs.set(current.id,key),ref:key=>gitSelectedRefs.set(current.id,key)};
return;\n${seam}`),gitContext.sandbox);
ready();
const git=gitContext.sandbox.gitTest;
const base={kind:'local',name:'trunk',target:'a',isHead:false};
const topic={kind:'local',name:'work/topic',target:'b',isHead:true};
const remote={kind:'remote',name:'origin/trunk',target:'a',isHead:false};
const snapshot={defaultBranch:'trunk',refs:[topic,remote,base]};
git.project('synthetic-roadmap');
assert.equal(git.gitBaseRef(snapshot),base,'Published local default wins over HEAD and ref order');
assert.equal(git.gitSelectedRef(snapshot,base),topic,'HEAD is the initial selected path');
assert.equal(git.gitBaseSource(snapshot,base),gitContext.i18n.t('basePublished'));
git.base('local:work/topic');
assert.equal(git.gitBaseRef(snapshot),topic,'Explicit base selection wins');
assert.equal(git.gitBaseSource(snapshot,topic),gitContext.i18n.t('baseSelected'));
git.ref('remote:origin/trunk');
assert.equal(git.gitSelectedRef(snapshot,topic),remote,'Explicit ref selection wins');
git.ref('all');assert.equal(git.gitSelectedRef(snapshot,topic),null,'All refs removes path focus');
git.project('synthetic-second-roadmap');
assert.equal(git.gitBaseRef({...snapshot,refs:[topic,remote]}),remote,'Published remote default is a fallback');
assert.equal(git.gitBaseRef({...snapshot,defaultBranch:'missing'}),topic,'HEAD is the next base fallback');
assert.equal(git.gitBaseSource({...snapshot,defaultBranch:'missing'},topic),gitContext.i18n.t('baseHead'));
const first={kind:'local',name:'unclassified-branch',target:'c',isHead:false};
assert.equal(git.gitBaseRef({refs:[first,remote]}),first,'First available branch is the final fallback');
assert.equal(git.gitBaseSource({refs:[first]},first),gitContext.i18n.t('baseFirst'));
assert.equal(git.gitBaseRef({refs:[{kind:'tag',name:'example-tag',target:'a'}]}),null,'A tag cannot become the comparison base');
assert.equal(git.gitBaseSource({refs:[]},null),gitContext.i18n.t('baseMissing'));
const commits=[{hash:'a',parents:[],committedAt:'2026-01-01'},{hash:'b',parents:['a'],committedAt:'2026-01-02'},{hash:'c',parents:['outside-window'],committedAt:'2026-01-03'}];
const byHash=new Map(commits.map(commit=>[commit.hash,commit]));
const depths=git.gitVisualDepths({commits},byHash,git.gitSpine('a',byHash));
assert.equal(depths.nodeDepths.get('a'),0);assert.equal(depths.nodeDepths.get('b'),1);
assert.equal(depths.nodeDepths.get('c'),null,'Missing graph links keep branch level unknown');
assert.match(app,/baseProvenance/);assert.doesNotMatch(app,/toLocale(?:DateString|TimeString|String|LowerCase)\('ru-RU'/);
const html=fs.readFileSync(path.join(root,'static/index.html'),'utf8');
assert.ok(html.indexOf('/static/i18n.js')<html.indexOf('/static/app.js'));
assert.doesNotMatch(html,/<script(?![^>]*\bsrc=)[^>]*>/);assert.match(html,/value="general"/);
console.log(`PASS: ${keys.length} keys x 3 locales; placeholder/source parity, persistence, blocked storage, content boundaries, CSP script structure; synthetic Git base/ref selection, fallback provenance and unknown depth.`);
