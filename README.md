# Kontur

**A small, self-hosted view of your projects: roadmaps, dependencies, evidence, timelines and optional Git snapshots.**

[Русский](docs/README.ru.md) · [简体中文](docs/README.zh-CN.md) · [API guide](docs/API.md) · [Agent integration](docs/INTEGRATIONS.md)

Kontur turns explicitly supplied project state into a dashboard. See what is active, what is accepted and what is waiting on a dependency. Use it with an HTTP-capable AI agent, a script, or manually maintained JSON. No model, API subscription or Git repository is required.

![Kontur dashboard with synthetic example data](docs/images/dashboard.jpg)

## What you get

- English, Russian and Simplified Chinese interface, with a saved language preference.
- Roadmap blocks and gates, acceptance criteria, source references and evidence references.
- Dependency validation, one current gate, and a separately selected active plan.
- Overview, roadmap graph, calendar timeline and optional Git graph.
- JSON import/export and the last 100 project revisions.
- A versioned HTTP API with optimistic concurrency (`If-Match`).
- FastAPI, SQLite and plain HTML/CSS/JavaScript. No frontend build, external CDN or telemetry.

`done` is a reported acceptance status. Kontur does not independently verify an agent's work. A plan percentage counts equally weighted gates; it is not a product readiness score or effort estimate. Timeline dates describe calendar intervals. Git graphs use supplied real refs and parent links; they cannot prove where a branch was originally created.

## Run locally

Python **3.10+**. Windows PowerShell 7:

```powershell
git clone https://github.com/zoomerland/kontur.git
Set-Location kontur
python -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe run.py
```

Linux/macOS:

```sh
git clone https://github.com/zoomerland/kontur.git
cd kontur
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt
.venv/bin/python run.py
```

Open **http://127.0.0.1:8766**. A random access key is generated in `data/api-token.txt`; read it locally and enter it in the browser. The key is not printed by the server. The browser stores it until you sign out, when supported by browser storage and Web Locks.

```powershell
Get-Content -LiteralPath .\data\api-token.txt
```

Keep `data/` private. One key grants access to every project in that installation. This release is for a single owner and trusted clients; it has no per-user permissions.

## Try a project without an agent

1. Create a project named **Community garden**, ID **community-garden**, type **General project**.
2. Select it, click **Import JSON**, and choose `examples/general-project.json`.
3. Confirm the replacement, open the current gate, and explore the overview, roadmap and timeline.
4. Export JSON, edit it in your usual editor, and import it again. Import preserves the previous revision in history.

For a software example, create ID `demo-software` with type Software and import `examples/software-project.json`. All bundled examples and screenshots are synthetic.

The interface creates projects and imports snapshots. It is not a full inline roadmap editor. Any real project with explicit milestones can use the `general` type, including research, events or household projects. Git is optional for both types.

## Use with any model or tool

The integration boundary is HTTP and JSON, not a model SDK. An agent that can make authenticated HTTP requests can publish state after a checkpoint. A chat-only model can produce a JSON draft for a person to review and import. People and automation can use the same API.

There are no built-in provider connectors or claims of tested compatibility with every model. Start with the [portable integration instructions](docs/INTEGRATIONS.md), [API contract](docs/API.md) and [optional project instruction template](docs/AGENTS.example.md). Keep the access key outside prompts, exported JSON and repositories.

## Optional Git snapshots

PowerShell 7 and Git are needed only for this collector:

```powershell
pwsh -File ./scripts/Publish-GitSnapshot.ps1 `
  -ProjectId demo-software -RepositoryPath ./ `
  -OutputPath ./data/git-preview.json
```

Inspect that local JSON first. It includes branch names and commit subjects, which may be private. Without `-OutputPath`, the collector sends the snapshot to your local monitor using `data/api-token.txt`. Set `-MonitorUrl` and `-TokenPath` explicitly for another installation. Non-loopback destinations require HTTPS; certificate verification stays enabled.

The collector runs read-only Git commands, never reads changed-file contents, and reports only a dirty flag. It limits the snapshot to 500 refs and up to 2,000 commits (800 by default). A truncated graph is labelled. Roadmap and Git revisions are independent; repeating identical Git facts does not increment the Git revision.

## Configuration and remote access

`run.py --help` lists options. Defaults are loopback port 8766 and `data/` beside the source.

| Setting | Environment | CLI |
| --- | --- | --- |
| Data directory | `KONTUR_DATA` | `--data-dir` |
| Access key, 32+ characters | `KONTUR_TOKEN` | environment only |
| Bind address | `KONTUR_HOST` | `--host` |
| Port | `KONTUR_PORT` | `--port` |
| Accepted HTTP hostnames, comma separated | `KONTUR_ALLOWED_HOSTS` | repeat `--allowed-host` |
| TLS certificate / private key | `KONTUR_SSL_CERTFILE`, `KONTUR_SSL_KEYFILE` | `--ssl-certfile`, `--ssl-keyfile` |

For remote access, prefer a trusted HTTPS reverse proxy or private tunnel with the backend on loopback. Configure the hostname accepted by the backend explicitly. Direct non-loopback binding requires an explicit host allowlist and a TLS certificate/key pair; startup refuses an insecure configuration. No firewall, account, scheduled-task or certificate changes are made by the application. See [security and backup guidance](SECURITY.md).

## Development

```powershell
.\.venv\Scripts\python.exe -m pip install -r requirements-dev.txt
.\.venv\Scripts\python.exe -m pytest -q
node tests/localization.test.cjs
```

Python tests use temporary databases. Node is needed only for the localization check, not to run Kontur. CI checks Windows and Linux. The release is early software: report bugs with synthetic or redacted examples through [GitHub Issues](https://github.com/zoomerland/kontur/issues).

Contributions and translation corrections are welcome; see [CONTRIBUTING.md](CONTRIBUTING.md). Code and documentation were developed with AI assistance. Human users remain responsible for accepting work and choosing what to publish.

## License

[MIT](LICENSE). The published repository contains the portable application and synthetic examples. Personal deployment history, credentials and project snapshots are excluded.

