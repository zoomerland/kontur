import copy
import os
import stat
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient
from app import create_app

TOKEN = 'test-only-' + 'x' * 40


@pytest.fixture(autouse=True)
def no_ambient_app_configuration(monkeypatch):
    for name in ('DATA', 'TOKEN', 'ALLOWED_HOSTS'):
        monkeypatch.delenv('KONTUR_' + name, raising=False)


@pytest.fixture
def client(tmp_path):
    with TestClient(create_app(tmp_path, TOKEN), base_url='http://localhost', headers={'Authorization': 'Bearer ' + TOKEN}) as client:
        yield client


def sample():
    return {'id': 'demo', 'name': 'Пример', 'type': 'software', 'roadmap': {'sections': [
        {'id': 'foundation', 'title': 'Основа', 'gates': [{'id': 'A', 'title': 'Контракт'}]},
        {'id': 'delivery', 'title': 'Поставка', 'dependsOn': ['foundation'], 'gates': [
            {'id': 'B', 'title': 'Запуск', 'dependsOn': ['A']}]}]}}


def git_sample(captured_at='2026-09-23T10:00:00Z'):
    root = 'a' * 40
    head = 'b' * 40
    return {
        'repository': 'demo',
        'capturedAt': captured_at,
        'head': head,
        'currentBranch': 'main',
        'defaultBranch': 'main',
        'dirty': False,
        'truncated': False,
        'refs': [
            {'name': 'main', 'target': head, 'kind': 'local', 'layer': 'work', 'isHead': True},
            {'name': 'v1', 'target': root, 'kind': 'tag', 'layer': 'formal'},
        ],
        'commits': [
            {'hash': head, 'parents': [root], 'committedAt': '2026-09-23T09:00:00Z', 'subject': 'Finish'},
            {'hash': root, 'parents': [], 'committedAt': '2026-09-22T09:00:00Z', 'subject': 'Start'},
        ],
    }


def test_auth_and_no_sensitive_static(client):
    assert client.get('/api/v1/projects', headers={'Authorization': ''}).status_code == 401
    assert client.get('/api/v1/projects', headers={'Authorization': 'Bearer wrong'}).status_code == 401
    assert client.get('/static/api-token.txt').status_code == 404
    assert client.get('/health').json() == {'status': 'ok', 'version': '0.1.0'}
    assert client.get('/', headers={'Host': 'evil.example'}).status_code == 400
    assert "script-src 'self'" in client.get('/').headers['content-security-policy']


@pytest.mark.parametrize('host', ['kontur.example', '192.0.2.10', 'server', 'server.example'])
def test_explicit_hosts_accept_exact_configured_name(tmp_path, host):
    with TestClient(
        create_app(tmp_path, TOKEN, allowed_hosts=[host]),
        headers={'Authorization': 'Bearer ' + TOKEN, 'Host': host},
        client=('127.0.0.1', 50000),
    ) as public_client:
        assert public_client.get('/health').status_code == 200


def test_crud_revision_history_and_persistence(client):
    created = client.post('/api/v1/projects', json=sample())
    assert created.status_code == 201
    assert created.json()['stats']['gates']['B']['status'] == 'blocked'
    assert client.post('/api/v1/projects', json=sample()).status_code == 409
    body = sample(); body.pop('id')
    assert client.put('/api/v1/projects/demo', json=body).status_code == 428
    assert client.put('/api/v1/projects/demo', json=body, headers={'If-Match': '9'}).status_code == 409
    body['name'] = 'Новое имя'
    assert client.put('/api/v1/projects/demo', json=body, headers={'If-Match': '1'}).json()['revision'] == 2
    assert client.get('/api/v1/projects/demo/history/1').json()['name'] == 'Пример'
    assert len(client.get('/api/v1/projects/demo/history').json()) == 2


def test_reopen_database(tmp_path):
    with TestClient(create_app(tmp_path, TOKEN), base_url='http://localhost', headers={'Authorization': 'Bearer '+TOKEN}) as c:
        c.post('/api/v1/projects', json=sample()).raise_for_status()
    with TestClient(create_app(tmp_path, TOKEN), base_url='http://localhost', headers={'Authorization': 'Bearer '+TOKEN}) as c:
        assert c.get('/api/v1/projects/demo').json()['revision'] == 1


def test_optional_feature_timeline_fields_round_trip_and_validate(client):
    payload = sample()
    gate = payload['roadmap']['sections'][0]['gates'][0]
    gate['startedAt'] = '2026-09-20T09:15:00+03:00'
    gate['publishedAt'] = '2026-09-22T18:45:00+03:00'
    created = client.post('/api/v1/projects', json=payload)
    assert created.status_code == 201
    stored = created.json()['roadmap']['sections'][0]['gates'][0]
    assert stored['startedAt'] == gate['startedAt']
    assert stored['publishedAt'] == gate['publishedAt']

    invalid = sample()
    invalid['id'] = 'invalid-order'
    invalid_gate = invalid['roadmap']['sections'][0]['gates'][0]
    invalid_gate['startedAt'] = '2026-09-23'
    invalid_gate['publishedAt'] = '2026-09-22'
    assert client.post('/api/v1/projects', json=invalid).status_code == 422

    invalid_format = sample()
    invalid_format['id'] = 'invalid-format'
    invalid_format['roadmap']['sections'][0]['gates'][0]['startedAt'] = '23.09.2026'
    assert client.post('/api/v1/projects', json=invalid_format).status_code == 422


def test_git_snapshot_is_separate_deterministic_resource(client):
    assert client.put('/api/v1/projects/missing/git', json=git_sample(), headers={'If-Match': '0'}).status_code == 404
    client.post('/api/v1/projects', json=sample()).raise_for_status()
    assert client.get('/api/v1/projects/demo/git').status_code == 404
    assert client.put('/api/v1/projects/demo/git', json=git_sample()).status_code == 428
    assert client.put('/api/v1/projects/demo/git', json=git_sample(), headers={'If-Match': '1'}).status_code == 409

    created = client.put('/api/v1/projects/demo/git', json=git_sample(), headers={'If-Match': '0'})
    assert created.status_code == 200
    first = created.json()
    assert first['revision'] == 1
    assert first['classificationVersion'] == 1
    assert first['unchanged'] is False
    assert len(first['fingerprint']) == 64
    assert client.get('/api/v1/projects/demo').json()['revision'] == 1

    same_facts = git_sample('2026-09-23T11:00:00Z')
    same_facts['refs'].reverse()
    same_facts['commits'].reverse()
    unchanged = client.put('/api/v1/projects/demo/git', json=same_facts, headers={'If-Match': '1'}).json()
    assert unchanged['revision'] == 1
    assert unchanged['unchanged'] is True
    assert unchanged['capturedAt'] == first['capturedAt']
    assert unchanged['fingerprint'] == first['fingerprint']

    changed = git_sample('2026-09-23T12:00:00Z')
    changed['dirty'] = True
    updated = client.put('/api/v1/projects/demo/git', json=changed, headers={'If-Match': '1'}).json()
    assert updated['revision'] == 2
    assert updated['fingerprint'] != first['fingerprint']
    assert client.put('/api/v1/projects/demo/git', json=changed, headers={'If-Match': '1'}).status_code == 409


@pytest.mark.parametrize('mutation', [
    'duplicate-commit', 'duplicate-ref', 'missing-head', 'missing-ref', 'head-ref-mismatch', 'bad-hash'
])
def test_invalid_git_snapshots_rejected(client, mutation):
    client.post('/api/v1/projects', json=sample()).raise_for_status()
    payload = git_sample()
    if mutation == 'duplicate-commit':
        payload['commits'].append(copy.deepcopy(payload['commits'][0]))
    elif mutation == 'duplicate-ref':
        payload['refs'].append(copy.deepcopy(payload['refs'][0]))
    elif mutation == 'missing-head':
        payload['head'] = 'c' * 40
    elif mutation == 'missing-ref':
        payload['refs'][1]['target'] = 'c' * 40
    elif mutation == 'head-ref-mismatch':
        payload['refs'][0]['target'] = 'a' * 40
    else:
        payload['head'] = 'not-a-sha'
    assert client.put('/api/v1/projects/demo/git', json=payload, headers={'If-Match': '0'}).status_code == 422


@pytest.mark.parametrize('kind', ['duplicate','missing','cycle','block-cycle','mixed-cycle','unknown-type','bad-current','bad-next','frozen-current'])
def test_invalid_graphs_rejected(client, kind):
    p = sample(); r=p['roadmap']; a,b=r['sections']; ga=a['gates'][0]; gb=b['gates'][0]
    if kind == 'duplicate': gb['id']='A'
    if kind == 'missing': gb['dependsOn']=['UNKNOWN']
    if kind == 'cycle': ga['dependsOn']=['B']
    if kind == 'block-cycle': a['dependsOn']=['delivery']
    if kind == 'mixed-cycle': ga['dependsOn']=['B'];gb['dependsOn']=[]
    if kind == 'unknown-type': p['type']='science'
    if kind == 'bad-current': r['currentGateId']='B'
    if kind == 'bad-next': r['nextGateId']='B'
    if kind == 'frozen-current': a['scope']='frozen';ga['status']='active';r['currentGateId']='A'
    assert client.post('/api/v1/projects', json=p).status_code == 422
    assert client.get('/api/v1/projects').json() == []


def test_frozen_and_plan_counts(client):
    p=sample(); p['roadmap']['sections'][0]['scope']='frozen'
    result=client.post('/api/v1/projects', json=p).json()
    assert result['stats']['counts']['frozen']==1
    assert result['stats']['counts']['done']==0
    assert result['stats']['plan']['percent'] is None


def test_patch_transitions(client):
    client.post('/api/v1/projects', json=sample()).raise_for_status()
    result=client.patch('/api/v1/projects/demo/gates/A',json={'status':'active','note':'Начало','startedAt':'2026-09-11T10:00:00Z'},headers={'If-Match':'1'})
    assert result.status_code==200
    assert result.json()['roadmap']['currentGateId']=='A'
    invalid=client.patch('/api/v1/projects/demo/gates/A',json={'status':'active','note':'Неверная дата','publishedAt':'2026-09-10T10:00:00Z'},headers={'If-Match':'2'})
    assert invalid.status_code==422
    assert client.get('/api/v1/projects/demo').json()['revision']==2
    result=client.patch('/api/v1/projects/demo/gates/A',json={'status':'done','note':'Принято','publishedAt':'2026-09-12T15:00:00Z','completedAt':'2026-09-13'},headers={'If-Match':'2'})
    assert result.json()['roadmap']['currentGateId'] is None
    gate=result.json()['roadmap']['sections'][0]['gates'][0]
    assert gate['startedAt']=='2026-09-11T10:00:00Z'
    assert gate['publishedAt']=='2026-09-12T15:00:00Z'
    assert result.json()['stats']['gates']['B']['ready'] is True
    assert client.get('/api/v1/projects/demo/history/1').json()['roadmap']['sections'][0]['gates'][0]['status']=='planned'


def test_concurrent_updates_only_one_wins(client):
    client.post('/api/v1/projects',json=sample()).raise_for_status()
    body=sample();body.pop('id')
    def update(n):
        p=copy.deepcopy(body);p['name']=str(n)
        return client.put('/api/v1/projects/demo',json=p,headers={'If-Match':'1'}).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(update,range(2)))==[200,409]


def test_request_limit(client):
    assert client.post('/api/v1/projects',content=b'x'*2_000_001).status_code==413


def test_project_separation(client):
    client.post('/api/v1/projects',json=sample()).raise_for_status()
    second=sample();second['id']='second'
    client.post('/api/v1/projects',json=second).raise_for_status()
    client.patch('/api/v1/projects/demo/gates/A',json={'status':'done','note':'ok'},headers={'If-Match':'1'}).raise_for_status()
    assert client.get('/api/v1/projects/second').json()['stats']['counts']['done']==0


@pytest.mark.parametrize('gate_dependency', [True, False])
def test_done_requires_completed_prerequisites(client, gate_dependency):
    p=sample()
    b=p['roadmap']['sections'][1]
    b['gates'][0]['status']='done'
    b['status']='done'
    if not gate_dependency:
        b['gates'][0]['dependsOn']=[]
    assert client.post('/api/v1/projects',json=p).status_code==422


def test_frozen_block_preserves_previously_done_gate(client):
    p=sample();a=p['roadmap']['sections'][0];a['scope']='frozen';a['gates'][0]['status']='done'
    result=client.post('/api/v1/projects',json=p)
    assert result.status_code==201
    assert result.json()['stats']['counts']['done']==1


def test_exact_host_and_transport_restrictions(tmp_path):
    app=create_app(tmp_path,TOKEN,allowed_hosts=['kontur.example'])
    with TestClient(app,client=('192.0.2.12',54321),base_url='https://kontur.example') as c:
        assert c.get('/health').status_code==200
        assert c.get('/api/v1/projects').status_code==401
        assert c.get('/health',headers={'Host':'other.example'}).status_code==400
        assert c.get('/health').headers['strict-transport-security']=='max-age=31536000'
    with TestClient(app,client=('198.51.100.12',54321),base_url='http://kontur.example') as c:
        result = c.get('/health',headers={'X-Forwarded-Proto':'https'})
        assert result.status_code == 200
        assert 'strict-transport-security' not in result.headers
        assert c.get('/health',headers={'Host':'evil.example','X-Forwarded-Host':'kontur.example'}).status_code==400


def test_general_project_without_git_or_model(client):
    assert client.get('/api/v1/types', headers={'Authorization': ''}).status_code == 401
    assert client.get('/api/v1/types').json() == [
        {'id': 'software', 'name': 'Software project'}, {'id': 'general', 'name': 'General project'}
    ]
    payload = sample()
    payload.update(type='general', name='Community garden')
    created = client.post('/api/v1/projects', json=payload)
    assert created.status_code == 201
    assert created.json()['type'] == 'general'
    assert client.get('/api/v1/projects/demo/git').status_code == 404
    updated = client.patch('/api/v1/projects/demo/gates/A', json={'status': 'done', 'note': 'Site survey complete'},
                           headers={'If-Match': '1'})
    assert updated.status_code == 200
    assert updated.json()['stats']['gates']['B']['ready'] is True
    body = payload.copy()
    body.pop('id')
    body['roadmap'] = updated.json()['roadmap']
    assert client.put('/api/v1/projects/demo', json=body, headers={'If-Match': '2'}).json()['revision'] == 3
    assert client.get('/api/v1/projects/demo/history/1').json()['type'] == 'general'


@pytest.mark.parametrize('host', ['localhost', 'localhost:8766', 'LOCALHOST', '127.0.0.1', '[::1]:8766'])
def test_default_loopback_hosts(client, host):
    assert client.get('/health', headers={'Host': host}).status_code == 200


@pytest.mark.parametrize('host', ['testserver', 'evil.example', 'localhost.evil.example',
                                 'localhost:bad', 'localhost:', 'localhost:65536',
                                 'localhost/evil', 'user@localhost', 'localhost,evil', '::1',
                                 '', '\x01localhost', '[::1%eth0]'])
def test_invalid_host_headers(client, host):
    assert client.get('/health', headers={'Host': host}).status_code == 400


def test_duplicate_host_headers_rejected(client):
    assert client.get('/health', headers=[('Host', 'localhost'), ('Host', 'evil.example')]).status_code == 400


@pytest.mark.parametrize('hosts', [[], ['*'], ['*.example'], ['https://kontur.example'],
                                  ['192.0.2.0/24'], ['kontur.example:443'], ['::1%eth0'], [''], 'localhost'])
def test_invalid_allowed_hosts_fail_before_creating_data(tmp_path, hosts):
    folder = tmp_path / 'never-created'
    with pytest.raises(ValueError):
        create_app(folder, TOKEN, allowed_hosts=hosts)
    assert not folder.exists()


def test_generated_token_persists_and_authenticates(tmp_path, monkeypatch):
    monkeypatch.delenv('KONTUR_TOKEN', raising=False)
    monkeypatch.delenv('KONTUR_ALLOWED_HOSTS', raising=False)
    first = create_app(tmp_path)
    token = (tmp_path / 'api-token.txt').read_text(encoding='utf-8')
    assert len(token) >= 32
    for app in (first, create_app(tmp_path)):
        with TestClient(app, base_url='http://localhost') as c:
            assert c.get('/api/v1/projects').status_code == 401
            assert c.get('/api/v1/projects', headers={'Authorization': 'Bearer ' + token}).status_code == 200
    assert (tmp_path / 'api-token.txt').read_text(encoding='utf-8') == token


@pytest.mark.skipif(os.name != 'posix', reason='POSIX permission and umask contract')
@pytest.mark.parametrize('preexisting', [False, True])
def test_posix_data_directory_privacy_with_permissive_umask(tmp_path, preexisting):
    folder = tmp_path / 'owner-data'
    original_umask = os.umask(0o022)
    try:
        if preexisting:
            folder.mkdir(mode=0o750)
        create_app(folder, TOKEN)
        assert (folder / 'monitor.sqlite3').is_file()
        mode = stat.S_IMODE(folder.stat().st_mode)
        if preexisting:
            assert mode == 0o750  # Never silently alter an owner's existing permissions.
        else:
            assert mode == 0o700
            assert mode & (stat.S_IRWXG | stat.S_IRWXO) == 0
    finally:
        os.umask(original_umask)


def test_environment_configured_data_token_hosts(tmp_path, monkeypatch):
    monkeypatch.setenv('KONTUR_DATA', str(tmp_path / 'configured'))
    monkeypatch.setenv('KONTUR_TOKEN', TOKEN)
    monkeypatch.setenv('KONTUR_ALLOWED_HOSTS', 'kontur.example, 192.0.2.10')
    with TestClient(create_app(), base_url='http://kontur.example') as c:
        assert c.get('/api/v1/projects', headers={'Authorization': 'Bearer ' + TOKEN}).status_code == 200
        assert c.get('/health', headers={'Host': 'localhost'}).status_code == 400
    assert (tmp_path / 'configured' / 'monitor.sqlite3').is_file()
    assert not (tmp_path / 'configured' / 'api-token.txt').exists()


def test_docs_fixed_locale_mapping_and_static_allowlist(tmp_path, monkeypatch, client):
    import app as module
    static = tmp_path / 'static'
    static.mkdir()
    for locale, name in [('en', 'docs.html'), ('ru', 'docs.ru.html'), ('zh-CN', 'docs.zh-CN.html')]:
        (static / name).write_text(locale, encoding='utf-8')
    (static / 'i18n.js').write_text('// dictionary', encoding='utf-8')
    monkeypatch.setattr(module, 'ROOT', tmp_path)
    for locale in ('en', 'ru', 'zh-CN'):
        assert client.get('/docs', params={'lang': locale}).text == locale
    assert client.get('/docs').text == 'en'
    assert client.get('/docs', params={'lang': '../api-token.txt'}).status_code == 422
    assert client.get('/static/i18n.js').status_code == 200
    assert client.get('/static/docs.ru.html').status_code == 404
