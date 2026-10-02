"""Public startup configuration and an isolated loopback process smoke."""
import json
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.request import Request, urlopen

import pytest
import run


@pytest.fixture(autouse=True)
def no_ambient_configuration(monkeypatch):
    for name in ('DATA', 'TOKEN', 'HOST', 'PORT', 'ALLOWED_HOSTS', 'SSL_CERTFILE', 'SSL_KEYFILE'):
        monkeypatch.delenv('KONTUR_' + name, raising=False)


def test_loopback_defaults():
    args = run.configuration([])
    assert (args.host, args.port) == ('127.0.0.1', 8766)
    assert args.allowed_hosts == ('127.0.0.1', 'localhost', '::1')
    assert args.data_dir == run.ROOT / 'data'
    assert not args.ssl_certfile and not args.ssl_keyfile


@pytest.mark.parametrize('arguments', [
    ['--host', '0.0.0.0'], ['--host', '::'], ['--host', '192.0.2.10'],
    ['--host', '0.0.0.0', '--allowed-host', 'kontur.example'],
    ['--allowed-host', '*'], ['--allowed-host', '*.example'],
    ['--host', 'kontur.example'], ['--port', '0'], ['--port', '65536'], ['--port', 'wrong'],
    ['--ssl-certfile', 'missing.pem'], ['--ssl-certfile', 'missing.pem', '--ssl-keyfile', 'missing.key'],
])
def test_unsafe_or_invalid_configuration_fails_without_data(tmp_path, arguments):
    data = tmp_path / 'never-created'
    with pytest.raises(SystemExit) as failure:
        run.configuration(['--data-dir', str(data), *arguments])
    assert failure.value.code == 2
    assert not data.exists()


def test_explicit_non_loopback_tls_config_and_cli_override(tmp_path, monkeypatch):
    cert, key = tmp_path / 'cert.pem', tmp_path / 'key.pem'
    cert.write_text('placeholder')
    key.write_text('placeholder')
    monkeypatch.setenv('KONTUR_HOST', '0.0.0.0')
    monkeypatch.setenv('KONTUR_PORT', '8443')
    monkeypatch.setenv('KONTUR_DATA', str(tmp_path / 'configured-data'))
    monkeypatch.setenv('KONTUR_ALLOWED_HOSTS', 'kontur.example,192.0.2.10')
    monkeypatch.setenv('KONTUR_SSL_CERTFILE', str(cert))
    monkeypatch.setenv('KONTUR_SSL_KEYFILE', str(key))
    args = run.configuration([])
    assert args.allowed_hosts == ('kontur.example', '192.0.2.10')
    assert args.host == '0.0.0.0' and args.port == 8443
    assert args.data_dir == tmp_path / 'configured-data'
    overridden = run.configuration(['--host', '127.0.0.1', '--port', '8767', '--allowed-host', 'localhost'])
    assert (overridden.host, overridden.port, overridden.allowed_hosts) == ('127.0.0.1', 8767, ('localhost',))


def test_empty_host_environment_fails(monkeypatch):
    monkeypatch.setenv('KONTUR_ALLOWED_HOSTS', '')
    with pytest.raises(SystemExit):
        run.configuration([])


def test_server_options_disable_forwarded_header_trust(tmp_path, monkeypatch):
    captured = {}
    monkeypatch.setattr(run.uvicorn, 'run', lambda app, **options: captured.update(options))
    run.main(['--data-dir', str(tmp_path)])
    assert captured['host'] == '127.0.0.1' and captured['port'] == 8766
    assert captured['proxy_headers'] is False
    assert captured['access_log'] is False
    assert captured['workers'] == 1 and captured['limit_concurrency'] == 32
    assert 'ssl_certfile' not in captured


def test_explicit_external_server_options_keep_tls_and_no_proxy_trust(tmp_path, monkeypatch):
    captured = {}
    cert, key = tmp_path / 'cert.pem', tmp_path / 'key.pem'
    cert.write_text('placeholder')
    key.write_text('placeholder')
    monkeypatch.setattr(run.uvicorn, 'run', lambda app, **options: captured.update(options))
    run.main(['--data-dir', str(tmp_path), '--host', '0.0.0.0', '--allowed-host', 'kontur.example',
              '--ssl-certfile', str(cert), '--ssl-keyfile', str(key)])
    assert captured['host'] == '0.0.0.0'
    assert captured['ssl_certfile'] == str(cert) and captured['ssl_keyfile'] == str(key)
    assert captured['proxy_headers'] is False


def test_isolated_process_startup_and_generated_token(tmp_path):
    with socket.socket() as listener:
        listener.bind(('127.0.0.1', 0))
        port = listener.getsockname()[1]
    process = subprocess.Popen([sys.executable, str(Path(run.__file__)), '--data-dir', str(tmp_path),
                                '--port', str(port)], stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    url = f'http://127.0.0.1:{port}'
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if process.poll() is not None:
                pytest.fail('Isolated server exited before becoming ready')
            try:
                with urlopen(url + '/health', timeout=0.5) as response:
                    assert json.load(response) == {'status': 'ok', 'version': '0.1.0'}
                break
            except (URLError, TimeoutError):
                time.sleep(0.1)
        else:
            pytest.fail('Isolated server startup timed out')
        token = (tmp_path / 'api-token.txt').read_text(encoding='utf-8')
        with pytest.raises(HTTPError) as failure:
            urlopen(url + '/api/v1/projects', timeout=1)
        assert failure.value.code == 401
        request = Request(url + '/api/v1/projects', headers={'Authorization': 'Bearer ' + token})
        with urlopen(request, timeout=1) as response:
            assert json.load(response) == []
        with pytest.raises(HTTPError) as failure:
            urlopen(Request(url + '/health', headers={'Host': 'evil.example'}), timeout=1)
        assert failure.value.code == 400
    finally:
        process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
        process.stdout.close()
