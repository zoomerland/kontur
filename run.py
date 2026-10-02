"""Run the single-owner Kontur server with explicit, fail-closed exposure."""
import argparse
import logging
import os
from ipaddress import ip_address
from logging.handlers import RotatingFileHandler
from pathlib import Path

import uvicorn
from app import ROOT, configured_hosts, create_app


def configuration(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-dir', default=os.environ.get('KONTUR_DATA', str(ROOT / 'data')),
                        help='Data directory (KONTUR_DATA; default: ./data beside run.py)')
    parser.add_argument('--host', default=os.environ.get('KONTUR_HOST', '127.0.0.1'),
                        help='Bind IP or localhost (KONTUR_HOST; default: 127.0.0.1)')
    parser.add_argument('--port', default=os.environ.get('KONTUR_PORT', '8766'),
                        help='Bind port (KONTUR_PORT; default: 8766)')
    parser.add_argument('--allowed-host', action='append', dest='allowed_hosts',
                        help='Exact request Host; repeat for multiple hosts (KONTUR_ALLOWED_HOSTS: comma list)')
    parser.add_argument('--ssl-certfile', default=os.environ.get('KONTUR_SSL_CERTFILE'),
                        help='TLS certificate PEM (KONTUR_SSL_CERTFILE)')
    parser.add_argument('--ssl-keyfile', default=os.environ.get('KONTUR_SSL_KEYFILE'),
                        help='TLS private key PEM (KONTUR_SSL_KEYFILE)')
    args = parser.parse_args(argv)
    try:
        args.port = int(args.port)
        if not 1 <= args.port <= 65535:
            raise ValueError
    except ValueError:
        parser.error('port must be an integer from 1 to 65535')
    try:
        loopback = args.host == 'localhost' or ip_address(args.host).is_loopback
    except ValueError:
        parser.error('host must be a bind IP address or localhost')
    explicit_hosts = args.allowed_hosts is not None or 'KONTUR_ALLOWED_HOSTS' in os.environ
    try:
        args.allowed_hosts = configured_hosts(args.allowed_hosts)
    except ValueError as error:
        parser.error(str(error))
    if not loopback and not explicit_hosts:
        parser.error('non-loopback binding requires explicit --allowed-host or KONTUR_ALLOWED_HOSTS')
    if bool(args.ssl_certfile) != bool(args.ssl_keyfile):
        parser.error('TLS requires both --ssl-certfile and --ssl-keyfile')
    if not loopback and not args.ssl_certfile:
        parser.error('non-loopback binding requires TLS certificate and key; use a loopback backend behind an HTTPS reverse proxy instead')
    for name in ('ssl_certfile', 'ssl_keyfile'):
        value = getattr(args, name)
        if value and not Path(value).is_file():
            parser.error(f'{name.replace("_", "-")} must name an existing file')
    args.data_dir = Path(args.data_dir).expanduser().resolve()
    return args


def main(argv=None):
    args = configuration(argv)
    app = create_app(data_dir=args.data_dir, allowed_hosts=args.allowed_hosts)
    handler = RotatingFileHandler(args.data_dir / 'server.log', maxBytes=1_000_000,
                                  backupCount=2, encoding='utf-8')
    logging.basicConfig(handlers=[handler], level=logging.INFO)
    options = {}
    if args.ssl_certfile:
        options = {'ssl_certfile': args.ssl_certfile, 'ssl_keyfile': args.ssl_keyfile}
    try:
        uvicorn.run(app, host=args.host, port=args.port, workers=1, access_log=False,
                    proxy_headers=False, limit_concurrency=32, timeout_keep_alive=5,
                    log_config=None, **options)
    finally:
        handler.close()


if __name__ == '__main__':
    main()
