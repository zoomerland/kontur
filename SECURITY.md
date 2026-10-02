# Security and data handling

Kontur is a single-owner project registry. One bearer key has read/write access to all projects. It is not a multi-user permission system. Use it with trusted people and integrations.

The default listener is loopback only. Protect remote connections with HTTPS and a trusted private network or authenticated proxy. Direct non-loopback startup requires explicit allowed hosts and TLS. The application does not trust forwarded headers by default. Do not disable certificate checks or expose the service as an anonymous public dashboard.

The browser stores the bearer key in localStorage after successful login when available. Sign out on shared devices. An XSS vulnerability or access to that browser profile could expose it. The app sends a restrictive Content Security Policy and does not load third-party scripts.

Keep `data/`, environment files, API keys, backups and TLS private keys outside Git. A newly created POSIX data directory uses 0700 and the generated key uses 0600. Existing directory permissions are preserved; on Windows inherited ACLs apply. Ensure existing data directories and backups are accessible only to the owner or service account. Roadmaps may include private paths and evidence labels. Git snapshots include commit subjects and ref names. Review JSON before sending it to any installation or attaching it to a public issue. Reference paths are stored as text; the server does not open them.

For a consistent backup of a running database, use the SQLite backup API:

```python
import sqlite3
with sqlite3.connect('data/monitor.sqlite3') as source:
    with sqlite3.connect('data/backup.sqlite3') as backup:
        source.backup(backup)
```

Also preserve the access key privately if needed. Do not copy only a live WAL database file. To rotate a generated key, stop your Kontur process, replace `data/api-token.txt` with a cryptographically random key of at least 32 characters, and restart. If `KONTUR_TOKEN` is set, rotate that value instead. Existing browser sessions must sign in again.

Do not report secrets in public issues. Use GitHub private vulnerability reporting when enabled on the repository. If it is unavailable, open an issue asking for a private reporting channel without exploit details or sensitive data. This early release has no promised security support period or response SLA.
