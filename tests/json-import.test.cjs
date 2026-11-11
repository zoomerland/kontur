'use strict';

const assert = require('node:assert/strict');
const {spawnSync} = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {test} = require('node:test');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const source = fs.readFileSync(path.join(root, 'static/app.js'), 'utf8');
const original = {
  id: 'demo', revision: 4, name: 'Before import', type: 'general', description: '', archived: false,
  roadmap: {
    version: 1, updatedAt: '', baseline: {ref: '', commit: '', summary: ''}, focusNote: '',
    sections: [], activeGateIds: [], currentGateId: null, nextGateId: null
  },
  stats: {total: 0, counts: {}, plan: {total: 0, done: 0, percent: null}, gates: {}}
};
const {id, revision, stats, ...originalBody} = original;
const payload = {...originalBody, name: 'From the file'};
// Reverse key order to check structural equality after server serialization.
const saved = {...Object.fromEntries(Object.entries(payload).reverse()), id, revision: 5, stats, updatedAt: '2026-11-08T00:00:00Z'};
const other = {...original, revision: 5, name: 'Changed by another client'};
const timeout = Symbol('timeout');
const unreadable = Symbol('unreadable response body');
const response = (body, status = 200) => ({
  status,
  ok: status >= 200 && status < 300,
  async json() {
    if (body === unreadable) throw new SyntaxError('Response was cut off');
    return structuredClone(body);
  }
});
const put = (body, status) => ({method: 'PUT', body, status});
const get = (body, status) => ({method: 'GET', body, status});

async function runImport(writesAndReads, {fileBody = payload, initial = original, firstRead = initial, actions = ['confirm-import']} = {}) {
  const projectPath = '/api/v1/projects/' + initial.id;
  const steps = [get(firstRead), ...writesAndReads];
  const requests = [];
  const unexpected = [];
  const elements = new Map();
  const storage = new Map([['monitor-key', 'synthetic-key']]);
  const localStorage = {
    getItem: key => storage.get(key),
    setItem: (key, value) => storage.set(key, value),
    removeItem: key => storage.delete(key)
  };
  function getElementById(id) {
    if (!elements.has(id)) {
      elements.set(id, {
        value: '', handlers: {}, dataset: {},
        addEventListener(type, handler) { this.handlers[type] = handler; },
        setAttribute() {}, focus() {}, querySelectorAll: () => [],
        showModal() { this.open = true; },
        close() { this.open = false; }
      });
    }
    return elements.get(id);
  }
  let ready;
  const sandbox = {
    document: {
      documentElement: {dataset: {}}, getElementById, querySelectorAll: () => [],
      addEventListener(type, handler) { if (type === 'DOMContentLoaded') ready = handler; }
    },
    KonturI18n: {t: (key, values) => values ? `${key} ${Object.values(values).join(' ')}` : key, identify: () => null, paint() {}, locale: 'en'},
    navigator: {locks: {request: async (_name, callback) => callback()}},
    localStorage, sessionStorage: {removeItem() {}}, location: {reload() {}},
    matchMedia: () => ({matches: false}), addEventListener() {}, setInterval() {},
    AbortSignal: {timeout: ms => ({ms})},
    async fetch(url, options) {
      if (url === '/api/v1/projects' && !options.method) return response([initial]);
      const method = options.method || 'GET';
      requests.push({url, method, body: options.body, ifMatch: options.headers['If-Match'], signal: options.signal, cache: options.cache});
      const step = steps[requests.length - 1];
      if (!step || step.method !== method || url !== projectPath) {
        unexpected.push(`${method} ${url}`);
        throw new Error('Unexpected request');
      }
      if (step.changeSession) storage.set('monitor-auth-change', 'new-session');
      if (step.body === timeout) throw new DOMException('The request timed out', 'TimeoutError');
      return response(step.body, step.status);
    }
  };
  sandbox.window = sandbox;
  vm.runInNewContext(source, sandbox);
  ready();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(getElementById('title').textContent, initial.name);
  const input = getElementById('import-file');
  const text = JSON.stringify(fileBody);
  input.files = [{name: 'import.json', size: Buffer.byteLength(text), text: async () => text}];
  await input.handlers.change({target: input});
  function snapshot() {
    return {
      open: getElementById('import-dialog').open,
      disabled: getElementById('confirm-import').disabled,
      reloadHidden: getElementById('reload-import').hidden,
      summary: getElementById('import-summary').textContent,
      status: getElementById('import-status').textContent,
      diff: getElementById('import-diff').innerHTML,
      writes: requests.filter(request => request.method === 'PUT').length
    };
  }
  const previews = [snapshot()];
  for (const action of actions) {
    await getElementById(action).handlers.click();
    previews.push(snapshot());
  }

  assert.deepEqual(unexpected, []);
  assert.equal(requests.length, steps.length);
  assert.equal(previews[0].writes, 0, 'Opening a preview does not write');
  assert.equal(getElementById('import').disabled, previews.at(-1).open);
  requests.forEach((request, i) => {
    assert.ok(request.signal.ms > 0, 'Each import request has a timeout');
    if (request.method === 'GET') {
      assert.equal(request.cache, 'no-store');
    } else {
      assert.equal(request.ifMatch, steps[i].ifMatch ?? '4');
      assert.equal(request.body, steps[i].requestBody ?? text);
    }
  });
  assert.equal(new Set(requests.map(request => request.signal)).size, requests.length);
  return {notice: getElementById('notice').textContent, title: getElementById('title').textContent, previews};
}

test('confirmation sends the displayed body and the revision read for the preview', async () => {
  const result = await runImport([{...put(saved), ifMatch: '5'}], {firstRead: other});
  assert.match(result.previews[0].summary, /\b5\b/);
  assert.match(result.previews[0].summary, /import\.json/);
  assert.match(result.previews[0].diff, /Changed by another client/);
  assert.match(result.previews[0].diff, /From the file/);
  assert.equal(result.notice, 'm264');
  assert.equal(result.previews[1].open, false);
});

test('cancelling an import never writes', async () => {
  const {previews} = await runImport([], {actions: ['cancel-import', 'confirm-import']});
  assert.equal(previews[0].open, true);
  assert.equal(previews[1].open, false);
  assert.equal(previews.at(-1).writes, 0);
});

test('an unchanged file cannot be applied', async () => {
  const {previews} = await runImport([], {fileBody: originalBody});
  assert.equal(previews[0].status, 'importNoChanges');
  assert.equal(previews[0].disabled, true);
  assert.equal(previews.at(-1).writes, 0);
});

test('an applied import is confirmed after its response is lost', async () => {
  const result = await runImport([put(timeout), get(saved)]);
  assert.equal(result.notice, 'importVerified');
  assert.equal(result.title, saved.name);
});

test('a gateway timeout with an unreadable body also triggers a readback', async () => {
  assert.equal((await runImport([put(unreadable, 504), get(saved)])).notice, 'importVerified');
});

test('an unchanged revision permits one identical retry', async () => {
  assert.equal((await runImport([put(timeout), get(original), put(saved)])).notice, 'm264');
});

test('two timeouts end with readback and no third write', async () => {
  const result = await runImport([put(timeout), get(original), put(timeout), get(original)]);
  assert.equal(result.previews[1].status, 'importOutcomeUnknown');
  assert.equal(result.previews[1].disabled, true);
});

test('readback can confirm a retry whose success response was cut off', async () => {
  const result = await runImport([put(timeout), get(original), put(unreadable, 200), get(saved)]);
  assert.equal(result.notice, 'importVerified');
  assert.equal(result.title, saved.name);
});

test('another revision found after a timeout requires a new preview and no automatic retry', async () => {
  const result = await runImport([put(timeout), get(other)]);
  assert.equal(result.previews[1].status, 'importReconfirm');
  assert.match(result.previews[1].diff, /Changed by another client/);
  assert.equal(result.previews[1].writes, 1);
});

test('a concurrent write between readback and retry requires fresh confirmation', async () => {
  const result = await runImport([put(timeout), get(original), put({detail: 'Conflict'}, 409), get(other)]);
  assert.equal(result.previews[1].status, 'importReconfirm');
  assert.equal(result.previews[1].writes, 2);
  assert.equal(result.title, other.name);
});

test('409 rebuilds the preview and sends the new revision only after a second confirmation', async () => {
  const {previews} = await runImport([put({detail: 'Conflict'}, 409), get(other), {...put(saved), ifMatch: '5'}],
    {actions: ['confirm-import', 'confirm-import']});
  assert.match(previews[0].diff, /Before import/);
  assert.match(previews[1].summary, /\b5\b/);
  assert.match(previews[1].diff, /Changed by another client/);
  assert.doesNotMatch(previews[1].diff, /Before import/);
  assert.equal(previews[1].status, 'importReconfirm');
  assert.equal(previews[1].writes, 1);
  assert.equal(previews[2].writes, 2);
});

test('failure to reread after 409 blocks writes and lets the user retry only the read', async () => {
  const {previews} = await runImport([put({detail: 'Conflict'}, 409), get(timeout), get(other)],
    {actions: ['confirm-import', 'confirm-import', 'reload-import']});
  assert.equal(previews[1].status, 'importReadFailed');
  assert.equal(previews[1].disabled, true);
  assert.equal(previews[1].diff, '');
  assert.equal(previews[1].reloadHidden, false);
  assert.equal(previews[2].writes, 1);
  assert.equal(previews[3].status, 'importReconfirm');
  assert.equal(previews[3].writes, 1);
});

test('a roadmap-only file preserves the latest project metadata after a conflict', async () => {
  const roadmap = {...payload.roadmap, focusNote: 'New focus'};
  const firstBody = JSON.stringify({...originalBody, roadmap});
  const nextBody = JSON.stringify({...originalBody, name: other.name, roadmap});
  const {previews} = await runImport([
    {...put({detail: 'Conflict'}, 409), requestBody: firstBody}, get(other),
    {...put(saved), ifMatch: '5', requestBody: nextBody}
  ], {fileBody: roadmap, actions: ['confirm-import', 'confirm-import']});
  assert.match(previews[1].diff, /New focus/);
  assert.doesNotMatch(previews[1].diff, /Before import|Changed by another client/);
  assert.equal(previews[1].writes, 1);
});

test('after failed readback the next check only reads and can confirm the saved result', async () => {
  const {previews, notice} = await runImport([put(timeout), get(timeout), get(saved)],
    {actions: ['confirm-import', 'confirm-import', 'reload-import']});
  assert.equal(previews[1].status, 'importOutcomeUnknown');
  assert.equal(previews[1].reloadHidden, false);
  assert.equal(previews[1].disabled, true);
  assert.equal(previews.at(-1).writes, 1);
  assert.equal(notice, 'importVerified');
});

test('omission resets a non-default field and readback confirms the reset', async () => {
  const archived = {...original, archived: true};
  const fileBody = {name: original.name, type: original.type};
  const {previews, notice} = await runImport([put(timeout), get({...original, revision: 5})], {fileBody, firstRead: archived});
  assert.match(previews[0].diff, /<strong>archived<\/strong>.*<pre>true<\/pre>.*<pre>false<\/pre>/);
  assert.equal(previews[1].writes, 1);
  assert.equal(notice, 'importVerified');
});

test('explicit values are preserved and an ambiguous readback remains read-only', async () => {
  const fileBody = {...payload, archived: 'false', roadmap: {...payload.roadmap, focusNote: 'Keep this note'}};
  const observed = {...saved, roadmap: fileBody.roadmap};
  const {previews} = await runImport([put(timeout), get(observed), get(observed)],
    {fileBody, actions: ['confirm-import', 'reload-import', 'confirm-import']});
  assert.match(previews[0].diff, /<strong>archived<\/strong>.*<pre>false<\/pre>.*<pre>&quot;false&quot;<\/pre>/);
  assert.equal(previews[1].status, 'importOutcomeUnknown');
  assert.equal(previews[2].disabled, true);
  assert.equal(previews.at(-1).writes, 1);
});

test('an authentication change during verification stops the retry', async () => {
  const result = await runImport([put(timeout), {...get(original), changeSession: true}]);
  assert.equal(result.previews[1].status, 'importOutcomeUnknown');
  assert.equal(result.previews[1].disabled, true);
});

test('server-normalized examples have no diff and a lost reply does not reopen confirmation', async () => {
  const localPython = path.join(root, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
  const python = process.env.KONTUR_TEST_PYTHON || (fs.existsSync(localPython) ? localPython : 'python');
  const result = spawnSync(python, ['-B', '-c', `
import json
from pathlib import Path
from app import CreateProject, summarize

examples = {}
for name in ('general-project.json', 'software-project.json'):
    path = Path('examples') / name
    raw = json.loads(path.read_text(encoding='utf-8'))
    model = CreateProject.model_validate(raw)
    project = {**model.model_dump(), 'revision': 5, 'stats': summarize(model.roadmap)}
    examples[name] = [raw, project]
print(json.dumps(examples))
`], {cwd: root, encoding: 'utf8'});
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  const examples = JSON.parse(result.stdout);
  assert.deepEqual(Object.keys(examples), ['general-project.json', 'software-project.json']);
  for (const [fileBody, stored] of Object.values(examples)) {
    const unchanged = await runImport([], {fileBody, initial: stored});
    assert.equal(unchanged.previews[0].status, 'importNoChanges');
    assert.equal(unchanged.previews[0].diff, '');

    const initial = {...stored, revision: 4, name: 'Before import'};
    const {id, ...body} = fileBody;
    const lostReply = await runImport([{...put(timeout), requestBody: JSON.stringify(body)}, get(stored)],
      {fileBody, initial, actions: ['confirm-import', 'confirm-import']});
    assert.equal(lostReply.notice, 'importVerified');
    assert.equal(lostReply.previews[1].open, false);
    assert.equal(lostReply.previews.at(-1).writes, 1);
  }
});

test('diff pairs entities by ID and shows additions, removals, ordering and safe text', async () => {
  const sectionA = {id: 'A', title: 'A', gates: [{id: 'keep', title: 'Old title'}, {id: 'remove', title: 'Removed'}]};
  const sectionB = {id: 'B', title: 'B', gates: []};
  const updatedA = {...sectionA, gates: [{id: 'keep', title: '<img src=x onerror=alert(1)>'}]};
  const firstRead = {...original, roadmap: {...original.roadmap, sections: [sectionA, sectionB]}};
  const fileBody = {...payload, roadmap: {...payload.roadmap, sections: [sectionB, updatedA, {id: 'C', title: 'Added', gates: []}]}};
  const {previews} = await runImport([], {firstRead, fileBody, actions: []});
  const diff = previews[0].diff;
  assert.match(diff, /sections \/ importOrder/);
  assert.match(diff, /importBlock C<\/strong> <small>importAdded/);
  assert.match(diff, /importGate remove<\/strong> <small>importRemoved/);
  assert.match(diff, /importGate keep \/ title/);
  assert.match(diff, /Old title/);
  assert.match(diff, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.doesNotMatch(diff, /<img/);
});

test('the visible order distinguishes inserting at the beginning and end of both lists', async () => {
  const gate = id => ({id, title: id});
  const section = (id, gates = []) => ({id, title: id, gates});
  const sections = [section('A', [gate('a'), gate('b')]), section('B')];
  const firstRead = {...original, roadmap: {...original.roadmap, sections}};
  for (const first of [true, false]) {
    const gates = first ? [gate('c'), gate('a'), gate('b')] : [gate('a'), gate('b'), gate('c')];
    const updatedA = {...sections[0], gates};
    const updated = first ? [section('C'), updatedA, sections[1]] : [updatedA, sections[1], section('C')];
    const fileBody = {...payload, roadmap: {...payload.roadmap, sections: updated}};
    const {previews} = await runImport([], {firstRead, fileBody, actions: []});
    const rows = [...previews[0].diff.matchAll(/<li><strong>[^<]*importOrder<\/strong>.*?<\/li>/gs)].map(match => match[0]);
    assert.equal(rows.length, 2, 'Order is visible without expanding a details element');
    for (const [row, expected] of [[rows[0], updated.map(block => block.id)], [rows[1], gates.map(gate => gate.id)]]) {
      const values = [...row.matchAll(/<pre>(.*?)<\/pre>/gs)].map(match => JSON.parse(match[1].replaceAll('&quot;', '"')));
      assert.deepEqual(values[1], expected);
    }
  }
});
