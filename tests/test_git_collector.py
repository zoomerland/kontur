"""Verify read-only offline collection against a small real Git graph."""
import json
from pathlib import Path
import shutil
import subprocess

import pytest


def test_offline_collector_preserves_repository_and_reports_real_graph(tmp_path):
    pwsh = shutil.which('pwsh')
    git = shutil.which('git')
    if not pwsh or not git:
        pytest.skip('PowerShell 7 and Git are required for optional collector tests')
    repo = tmp_path / 'synthetic-repo'
    repo.mkdir()

    def command(*args):
        result = subprocess.run([git, '-C', str(repo), *args], check=True,
                                capture_output=True, text=True, encoding='utf-8')
        return result.stdout.strip()

    command('init', '-b', 'main')
    command('config', 'user.name', 'Synthetic Test')
    command('config', 'user.email', 'synthetic@example.invalid')
    (repo / 'file.txt').write_text('one\n', encoding='utf-8')
    command('add', 'file.txt')
    command('commit', '-m', 'Synthetic root')
    root = command('rev-parse', 'HEAD')
    command('branch', 'feature')
    (repo / 'file.txt').write_text('two\n', encoding='utf-8')
    command('commit', '-am', 'Synthetic second')
    head = command('rev-parse', 'HEAD')
    (repo / 'file.txt').write_text('uncommitted\n', encoding='utf-8')
    before = (command('show-ref'), command('status', '--porcelain'),
              (repo / 'file.txt').read_bytes())
    script = Path(__file__).resolve().parents[1] / 'scripts' / 'Publish-GitSnapshot.ps1'

    def collect(name, limit):
        output = tmp_path / name
        subprocess.run([pwsh, '-NoProfile', '-File', str(script), '-ProjectId', 'synthetic',
                        '-RepositoryPath', str(repo), '-OutputPath', str(output),
                        '-TokenPath', str(tmp_path / 'absent-token'),
                        '-MonitorUrl', 'https://not-contacted.example.invalid',
                        '-CommitLimit', str(limit)], check=True, capture_output=True,
                       text=True, encoding='utf-8', timeout=45)
        return json.loads(output.read_text(encoding='utf-8'))

    snapshot = collect('first.json', 10)
    assert snapshot['head'] == head
    assert snapshot['dirty'] is True
    assert snapshot['truncated'] is False
    commits = {item['hash']: item for item in snapshot['commits']}
    assert set(commits) == {root, head}
    assert commits[head]['parents'] == [root]
    assert commits[root]['parents'] == []
    assert {item['name']: item['target'] for item in snapshot['refs']} == {
        'main': head, 'feature': root,
    }
    repeated = collect('second.json', 10)
    assert {key: value for key, value in snapshot.items() if key != 'capturedAt'} == {
        key: value for key, value in repeated.items() if key != 'capturedAt'
    }
    assert before == (command('show-ref'), command('status', '--porcelain'),
                      (repo / 'file.txt').read_bytes())

    # A third commit exceeds the bounded window while both branch tips survive.
    command('commit', '-am', 'Synthetic third')
    clipped = collect('clipped.json', 2)
    assert clipped['truncated'] is True
    assert len(clipped['commits']) == 2
    assert {item['target'] for item in clipped['refs']} <= {
        item['hash'] for item in clipped['commits']
    }
