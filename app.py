"""A small, single-owner roadmap registry. No calls to monitored projects."""
import hashlib
import json
import os
import re
import secrets
import sqlite3
from ipaddress import ip_address
from collections import Counter
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit

from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ROOT = Path(__file__).resolve().parent
VERSION = '0.1.0'
DEFAULT_ALLOWED_HOSTS = ('127.0.0.1', 'localhost', '::1')
Status = Literal['planned', 'active', 'blocked', 'done', 'deferred', 'frozen']
Id = Annotated[str, Field(pattern=r'^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$')]
GitHash = Annotated[str, Field(pattern=r'^(?:[0-9a-f]{40}|[0-9a-f]{64})$')]


class Model(BaseModel):
    model_config = ConfigDict(extra='forbid', str_max_length=12000)


class Source(Model):
    label: str
    path: str


def parse_timeline_moment(value):
    """Parse an explicit feature boundary without inventing a local timezone."""
    try:
        if len(value) == 10:
            return datetime.strptime(value, '%Y-%m-%d').replace(tzinfo=timezone.utc)
        normalized = value[:-1] + '+00:00' if value.endswith(('Z', 'z')) else value
        moment = datetime.fromisoformat(normalized)
        if moment.tzinfo is None:
            raise ValueError
        return moment.astimezone(timezone.utc)
    except (TypeError, ValueError):
        raise ValueError('Timeline dates must be YYYY-MM-DD or timezone-aware ISO 8601 timestamps')


class Gate(Model):
    id: Id
    title: str = Field(min_length=1, max_length=300)
    status: Status = 'planned'
    acceptance: str = ''
    existing: str = ''
    note: str = ''
    dependsOn: list[Id] = Field(default_factory=list, max_length=500)
    sources: list[Source] = Field(default_factory=list, max_length=50)
    evidence: list[Source] = Field(default_factory=list, max_length=50)
    completedAt: str | None = None
    startedAt: str | None = Field(
        default=None,
        max_length=40,
        description='Start of feature development: YYYY-MM-DD or timezone-aware ISO 8601 timestamp',
    )
    publishedAt: str | None = Field(
        default=None,
        max_length=40,
        description='Feature publication: YYYY-MM-DD or timezone-aware ISO 8601 timestamp',
    )

    @field_validator('startedAt', 'publishedAt')
    @classmethod
    def valid_timeline_moment(cls, value):
        if value is not None:
            parse_timeline_moment(value)
        return value

    @model_validator(mode='after')
    def chronological_timeline(self):
        if self.startedAt and self.publishedAt:
            if parse_timeline_moment(self.publishedAt) < parse_timeline_moment(self.startedAt):
                raise ValueError('publishedAt must not be earlier than startedAt')
        return self


class Section(Model):
    id: Id
    title: str = Field(min_length=1, max_length=300)
    description: str = ''
    scope: Literal['mvp', 'expansion', 'frozen'] = 'expansion'
    status: Status | None = None
    dependsOn: list[Id] = Field(default_factory=list, max_length=100)
    gates: list[Gate] = Field(default_factory=list, max_length=500)


class Baseline(Model):
    ref: str = ''
    commit: str = ''
    summary: str = ''


class Roadmap(Model):
    version: Literal[1] = 1
    updatedAt: str = ''
    baseline: Baseline = Field(default_factory=Baseline)
    focusNote: str = ''
    currentGateId: Id | None = None
    nextGateId: Id | None = None
    activeGateIds: list[Id] = Field(default_factory=list, max_length=500)
    sections: list[Section] = Field(default_factory=list, max_length=100)

    @model_validator(mode='after')
    def coherent(self):
        sections = {s.id: s for s in self.sections}
        gates = {g.id: g for s in self.sections for g in s.gates}
        if len(sections) != len(self.sections) or len(gates) != sum(len(s.gates) for s in self.sections):
            raise ValueError('IDs must be unique within sections and gates')
        if set(sections) & set(gates):
            raise ValueError('Section and gate IDs must not overlap')
        if len(gates) > 500:
            raise ValueError('Maximum 500 gates per project')
        for s in self.sections:
            if any(d not in sections for d in s.dependsOn):
                raise ValueError('Unknown section dependency')
            if s.status == 'done' and (not s.gates or any(g.status != 'done' for g in s.gates)):
                raise ValueError('A done section must have all gates done')
            for g in s.gates:
                if any(d not in gates for d in g.dependsOn):
                    raise ValueError('Unknown gate dependency')
        def acyclic(graph):
            remaining = dict(graph)
            while remaining:
                ready = {k for k, deps in remaining.items() if not set(deps) & remaining.keys()}
                if not ready:
                    raise ValueError('Dependency cycle')
                remaining = {k: v for k, v in remaining.items() if k not in ready}
        acyclic({s.id: s.dependsOn for s in self.sections})
        # Include block prerequisites in the gate graph to reject mixed cycles.
        acyclic({g.id: g.dependsOn + [x.id for dep in s.dependsOn for x in sections[dep].gates]
                 for s in self.sections for g in s.gates})
        refs = self.activeGateIds + [x for x in [self.currentGateId, self.nextGateId] if x]
        if any(x not in gates for x in refs) or len(set(self.activeGateIds)) != len(self.activeGateIds):
            raise ValueError('Invalid current/next/active plan gate IDs')
        if self.currentGateId and gates[self.currentGateId].status != 'active':
            raise ValueError('Current gate must be active')
        if self.nextGateId and gates[self.nextGateId].status != 'planned':
            raise ValueError('Next gate must be planned')
        active = [g.id for g in gates.values() if g.status == 'active']
        if active != ([self.currentGateId] if self.currentGateId else []):
            raise ValueError('Exactly one current gate is allowed; active must match currentGateId')
        stats = summarize(self)
        for gate_id, gate in gates.items():
            if gate.status == 'done' and stats['gates'][gate_id]['blockers']:
                raise ValueError('A done gate must have completed gate and section prerequisites')
        for gate_id in [self.currentGateId, self.nextGateId]:
            if gate_id and stats['gates'][gate_id]['blockers']:
                raise ValueError('Current/next gate has unresolved dependencies or a paused parent block')
        return self


class ProjectInput(Model):
    name: str = Field(min_length=1, max_length=200)
    type: Literal['software', 'general']
    description: str = ''
    archived: bool = False
    roadmap: Roadmap = Field(default_factory=Roadmap)


class CreateProject(ProjectInput):
    id: Id


class GatePatch(Model):
    status: Status
    note: str
    evidence: list[Source] | None = None
    completedAt: str | None = None
    startedAt: str | None = Field(default=None, max_length=40)
    publishedAt: str | None = Field(default=None, max_length=40)


class GitRef(Model):
    name: str = Field(min_length=1, max_length=500)
    target: GitHash
    kind: Literal['local', 'remote', 'tag']
    layer: Literal['work', 'technical', 'formal'] = 'work'
    isHead: bool = False


class GitCommit(Model):
    hash: GitHash
    parents: list[GitHash] = Field(default_factory=list, max_length=32)
    committedAt: str
    subject: str = Field(max_length=1000)


class GitSnapshotInput(Model):
    repository: str = Field(min_length=1, max_length=300)
    classificationVersion: int = Field(default=1, ge=1, le=1000)
    capturedAt: str
    head: GitHash | None = None
    currentBranch: str | None = Field(default=None, max_length=500)
    defaultBranch: str | None = Field(default=None, max_length=500)
    dirty: bool = False
    truncated: bool = False
    refs: list[GitRef] = Field(default_factory=list, max_length=500)
    commits: list[GitCommit] = Field(default_factory=list, max_length=2000)

    @model_validator(mode='after')
    def coherent(self):
        hashes = [commit.hash for commit in self.commits]
        known_hashes = set(hashes)
        refs = [(ref.kind, ref.name) for ref in self.refs]
        if len(known_hashes) != len(hashes):
            raise ValueError('Git commit hashes must be unique')
        if len(set(refs)) != len(refs):
            raise ValueError('Git refs must be unique within each kind')
        if sum(ref.isHead for ref in self.refs) > 1:
            raise ValueError('Only one Git ref can be marked as HEAD')
        if self.head and self.commits and self.head not in known_hashes:
            raise ValueError('Git HEAD must be included in the commit window')
        if self.commits and any(ref.target not in known_hashes for ref in self.refs):
            raise ValueError('Every Git ref target must be included in the commit window')
        if self.head and any(ref.isHead and ref.target != self.head for ref in self.refs):
            raise ValueError('The Git HEAD ref must target the declared head commit')
        return self


def summarize(roadmap):
    sections = {s.id: s for s in roadmap.sections}
    gates = {g.id: g for s in roadmap.sections for g in s.gates}
    done_sections = {s.id for s in roadmap.sections if s.gates and all(g.status == 'done' for g in s.gates)}
    effective = {}
    for s in roadmap.sections:
        for g in s.gates:
            blockers = [d for d in g.dependsOn if gates[d].status != 'done']
            blockers += [d for d in s.dependsOn if d not in done_sections]
            paused = s.status in ('frozen', 'deferred', 'blocked') or s.scope == 'frozen'
            if paused and g.status != 'done':
                blockers.append(s.id)
            state = g.status
            if state != 'done' and (s.status == 'frozen' or s.scope == 'frozen'):
                state = 'frozen'
            elif state not in ('done', 'frozen') and s.status == 'deferred':
                state = 'deferred'
            elif state in ('planned', 'active') and blockers:
                state = 'blocked'
            effective[g.id] = {'status': state, 'blockers': blockers, 'ready': state == 'planned' and not blockers}
    counts = {s: 0 for s in ('planned', 'active', 'blocked', 'done', 'deferred', 'frozen')}
    counts.update(Counter(v['status'] for v in effective.values()))
    plan = roadmap.activeGateIds
    return {'total': len(gates), 'counts': counts, 'gates': effective,
            'plan': {'total': len(plan), 'done': sum(gates[x].status == 'done' for x in plan),
                     'percent': round(100 * sum(gates[x].status == 'done' for x in plan) / len(plan)) if plan else None}}


def normalize_host(value):
    """Accept only an exact DNS name or IP, never a wildcard, URL or network."""
    if not isinstance(value, str) or not value or value != value.strip() or '%' in value:
        raise ValueError('Allowed hosts must be exact hostnames or IP addresses')
    try:
        return str(ip_address(value))
    except ValueError:
        if len(value) > 253 or not all(
            re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label)
            for label in value.split('.')
        ):
            raise ValueError('Allowed hosts must be exact hostnames or IP addresses')
        return value.lower()


def configured_hosts(allowed_hosts=None):
    if allowed_hosts is None:
        configured = os.environ.get('KONTUR_ALLOWED_HOSTS')
        allowed_hosts = [host.strip() for host in configured.split(',')] if configured is not None else DEFAULT_ALLOWED_HOSTS
    if isinstance(allowed_hosts, str) or not allowed_hosts:
        raise ValueError('Configure at least one exact allowed host')
    return tuple(dict.fromkeys(normalize_host(host) for host in allowed_hosts))


def request_host(value):
    """Parse Host including a port and bracketed IPv6, without URL ambiguity."""
    if not value or any(ord(char) < 33 or ord(char) > 126 or char in '/\\@?#%' for char in value) or value.endswith(':'):
        raise ValueError('Invalid Host header')
    authority = urlsplit('//' + value)
    if authority.path or authority.query or authority.fragment or not authority.hostname:
        raise ValueError('Invalid Host header')
    if authority.port is not None and not 1 <= authority.port <= 65535:
        raise ValueError('Invalid Host port')
    return normalize_host(authority.hostname)


def create_app(data_dir=None, token=None, allowed_hosts=None):
    hosts = configured_hosts(allowed_hosts)
    folder = Path(data_dir or os.environ.get('KONTUR_DATA', ROOT / 'data'))
    # Protect new snapshots at the directory boundary on POSIX. Existing
    # directories and Windows ACLs stay under the owner's control.
    folder.mkdir(mode=0o700, parents=True, exist_ok=True)
    secret = token or os.environ.get('KONTUR_TOKEN')
    if not secret:
        token_path = folder / 'api-token.txt'
        if not token_path.exists():
            descriptor = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            with os.fdopen(descriptor, 'w', encoding='utf-8') as f:
                f.write(secrets.token_urlsafe(32))
        secret = token_path.read_text(encoding='utf-8').strip()
    if len(secret) < 32:
        raise RuntimeError('API token must be at least 32 characters')

    @contextmanager
    def db():
        conn = sqlite3.connect(folder / 'monitor.sqlite3', timeout=10)
        conn.row_factory = sqlite3.Row
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    with db() as conn:
        conn.execute('PRAGMA journal_mode=WAL')
        conn.executescript('''
            CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL, updated TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS history (project_id TEXT NOT NULL, revision INTEGER NOT NULL, body TEXT NOT NULL, updated TEXT NOT NULL, PRIMARY KEY(project_id, revision));
            CREATE TABLE IF NOT EXISTS git_snapshots (project_id TEXT PRIMARY KEY, body TEXT NOT NULL, revision INTEGER NOT NULL, updated TEXT NOT NULL);
        ''')

    app = FastAPI(title='Kontur API', version=VERSION, docs_url=None, redoc_url=None)
    bearer = HTTPBearer(auto_error=False)

    def auth(credentials: HTTPAuthorizationCredentials | None = Depends(bearer)):
        if not credentials or not secrets.compare_digest(credentials.credentials.encode(), secret.encode()):
            raise HTTPException(401, 'API key required', headers={'WWW-Authenticate': 'Bearer'})

    @app.middleware('http')
    async def guard(request: Request, call_next):
        # Exact Host matching also handles IPv6 and rejects duplicate headers.
        # Forwarded headers never grant trust or change the allowed host list.
        host_headers = request.headers.getlist('host')
        try:
            valid_host = len(host_headers) == 1 and request_host(host_headers[0]) in hosts
        except ValueError:
            valid_host = False
        if not valid_host:
            return JSONResponse({'detail': 'Invalid Host header'}, status_code=400)
        # Bound actual streamed bytes, including requests without Content-Length.
        if request.method in ('POST', 'PUT', 'PATCH'):
            body = bytearray()
            async for chunk in request.stream():
                body.extend(chunk)
                if len(body) > 2_000_000:
                    return JSONResponse({'detail': 'Maximum request size is 2 MB'}, status_code=413)
            request._body = bytes(body)
        response = await call_next(request)
        response.headers['Cache-Control'] = 'no-store'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        if request.url.scheme == 'https':
            response.headers['Strict-Transport-Security'] = 'max-age=31536000'
        response.headers['Content-Security-Policy'] = "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
        return response

    def envelope(row):
        body = json.loads(row['body'])
        return {'id': row['id'], **body, 'revision': row['revision'], 'updatedAt': row['updated'],
                'stats': summarize(Roadmap.model_validate(body['roadmap']))}

    def get_row(conn, project_id):
        row = conn.execute('SELECT * FROM projects WHERE id=?', (project_id,)).fetchone()
        if row is None:
            raise HTTPException(404, 'Project not found')
        return row

    def git_fingerprint(snapshot):
        facts = snapshot.model_dump(exclude={'capturedAt'})
        facts['refs'] = sorted(facts['refs'], key=lambda item: (item['kind'], item['name'], item['target']))
        facts['commits'] = sorted(facts['commits'], key=lambda item: item['hash'])
        canonical = json.dumps(facts, ensure_ascii=False, sort_keys=True, separators=(',', ':'))
        return hashlib.sha256(canonical.encode('utf-8')).hexdigest()

    def git_envelope(row, unchanged=False):
        return {'projectId': row['project_id'], **json.loads(row['body']), 'revision': row['revision'],
                'updatedAt': row['updated'], 'unchanged': unchanged}

    def expected(value):
        if value is None:
            raise HTTPException(428, 'If-Match revision header required')
        try:
            return int(value.strip('"'))
        except ValueError:
            raise HTTPException(400, 'If-Match must contain a revision integer')

    def save(conn, project_id, body, revision):
        now = datetime.now(timezone.utc).isoformat()
        encoded = json.dumps(body, ensure_ascii=False)
        conn.execute('INSERT OR REPLACE INTO projects VALUES(?,?,?,?)', (project_id, encoded, revision, now))
        conn.execute('INSERT INTO history VALUES(?,?,?,?)', (project_id, revision, encoded, now))
        conn.execute('DELETE FROM history WHERE project_id=? AND revision<=?', (project_id, revision - 100))
        return envelope(get_row(conn, project_id))

    @app.get('/health', tags=['Service'])
    def health():
        with db() as conn:
            conn.execute('SELECT 1 FROM projects LIMIT 1')
        return {'status': 'ok', 'version': VERSION}

    @app.get('/api/v1/types', dependencies=[Depends(auth)], tags=['Projects'])
    def types():
        return [{'id': 'software', 'name': 'Software project'}, {'id': 'general', 'name': 'General project'}]

    @app.get('/api/v1/projects', dependencies=[Depends(auth)], tags=['Projects'])
    def list_projects():
        with db() as conn:
            return [envelope(row) for row in conn.execute('SELECT * FROM projects ORDER BY updated DESC')]

    @app.post('/api/v1/projects', status_code=201, dependencies=[Depends(auth)], tags=['Projects'])
    def create_project(project: CreateProject):
        with db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            if conn.execute('SELECT 1 FROM projects WHERE id=?', (project.id,)).fetchone():
                raise HTTPException(409, 'Project ID already exists')
            return save(conn, project.id, project.model_dump(exclude={'id'}), 1)

    @app.get('/api/v1/projects/{project_id}', dependencies=[Depends(auth)], tags=['Projects'])
    def read_project(project_id: str):
        with db() as conn:
            return envelope(get_row(conn, project_id))

    @app.put('/api/v1/projects/{project_id}', dependencies=[Depends(auth)], tags=['Projects'])
    def replace_project(project_id: str, project: ProjectInput, if_match: str | None = Header(None)):
        revision = expected(if_match)
        with db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            row = get_row(conn, project_id)
            if row['revision'] != revision:
                raise HTTPException(409, 'Revision changed; read latest project and reconcile')
            return save(conn, project_id, project.model_dump(), revision + 1)

    @app.patch('/api/v1/projects/{project_id}/gates/{gate_id}', dependencies=[Depends(auth)], tags=['Gates'])
    def patch_gate(project_id: str, gate_id: str, patch: GatePatch, if_match: str | None = Header(None)):
        revision = expected(if_match)
        with db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            row = get_row(conn, project_id)
            if row['revision'] != revision:
                raise HTTPException(409, 'Revision changed; read latest project and reconcile')
            body = json.loads(row['body'])
            roadmap = body['roadmap']
            gate = next((g for s in roadmap['sections'] for g in s['gates'] if g['id'] == gate_id), None)
            if gate is None:
                raise HTTPException(404, 'Gate not found')
            gate.update(patch.model_dump(exclude_unset=True))
            if patch.status != 'done':
                gate['completedAt'] = None
            if patch.status == 'active':
                roadmap['currentGateId'] = gate_id
            elif roadmap['currentGateId'] == gate_id:
                roadmap['currentGateId'] = None
            if roadmap['nextGateId'] == gate_id and patch.status != 'planned':
                roadmap['nextGateId'] = None
            try:
                validated = ProjectInput.model_validate(body)
            except ValueError as exc:
                raise HTTPException(422, str(exc))
            return save(conn, project_id, validated.model_dump(), revision + 1)

    @app.get('/api/v1/projects/{project_id}/git', dependencies=[Depends(auth)], tags=['Git'])
    def read_git_snapshot(project_id: str):
        with db() as conn:
            get_row(conn, project_id)
            row = conn.execute('SELECT * FROM git_snapshots WHERE project_id=?', (project_id,)).fetchone()
            if row is None:
                raise HTTPException(404, 'Git snapshot not found')
            return git_envelope(row)

    @app.put('/api/v1/projects/{project_id}/git', dependencies=[Depends(auth)], tags=['Git'])
    def replace_git_snapshot(project_id: str, snapshot: GitSnapshotInput,
                             if_match: str | None = Header(None)):
        revision = expected(if_match)
        fingerprint = git_fingerprint(snapshot)
        with db() as conn:
            conn.execute('BEGIN IMMEDIATE')
            get_row(conn, project_id)
            row = conn.execute('SELECT * FROM git_snapshots WHERE project_id=?', (project_id,)).fetchone()
            current = row['revision'] if row else 0
            if current != revision:
                raise HTTPException(409, 'Git revision changed; read latest snapshot and reconcile')
            if row and json.loads(row['body']).get('fingerprint') == fingerprint:
                return git_envelope(row, unchanged=True)
            now = datetime.now(timezone.utc).isoformat()
            body = {**snapshot.model_dump(), 'fingerprint': fingerprint}
            encoded = json.dumps(body, ensure_ascii=False)
            conn.execute('INSERT OR REPLACE INTO git_snapshots VALUES(?,?,?,?)',
                         (project_id, encoded, current + 1, now))
            saved = conn.execute('SELECT * FROM git_snapshots WHERE project_id=?', (project_id,)).fetchone()
            return git_envelope(saved)

    @app.get('/api/v1/projects/{project_id}/history', dependencies=[Depends(auth)], tags=['History'])
    def history(project_id: str):
        with db() as conn:
            get_row(conn, project_id)
            return [dict(r) for r in conn.execute('SELECT revision,updated FROM history WHERE project_id=? ORDER BY revision DESC', (project_id,))]

    @app.get('/api/v1/projects/{project_id}/history/{revision}', dependencies=[Depends(auth)], tags=['History'])
    def historical(project_id: str, revision: int):
        with db() as conn:
            row = conn.execute('SELECT * FROM history WHERE project_id=? AND revision=?', (project_id, revision)).fetchone()
            if row is None:
                raise HTTPException(404, 'Revision not found')
            return {'id': project_id, 'revision': revision, 'updatedAt': row['updated'], **json.loads(row['body'])}

    @app.get('/', include_in_schema=False)
    def index():
        return FileResponse(ROOT / 'static' / 'index.html')

    @app.get('/docs', include_in_schema=False)
    def docs(lang: Literal['en', 'ru', 'zh-CN'] = 'en'):
        pages = {'en': 'docs.html', 'ru': 'docs.ru.html', 'zh-CN': 'docs.zh-CN.html'}
        return FileResponse(ROOT / 'static' / pages[lang])

    @app.get('/static/{filename}', include_in_schema=False)
    def static(filename: str):
        if filename not in {'app.js', 'i18n.js', 'style.css'}:
            raise HTTPException(404)
        return FileResponse(ROOT / 'static' / filename)

    return app
