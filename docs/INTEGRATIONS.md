# Models, scripts and people use the same contract

Kontur runs independently of any model. It has no model SDK or provider key. An HTTP client publishes an accepted project snapshot; the dashboard renders that snapshot.

## An agent with HTTP tools

Provide the monitor origin, an allowed project ID, the location of an access key in the agent's own trusted environment, and the authoritative roadmap. A local file path on another computer is not automatically accessible to the agent. Hosted clients need an explicitly secured network route; installing Kontur does not create one.

Read `/openapi.json` when implementing the client. Create the project once. For subsequent checkpoints, GET the project and PUT only the documented input fields with its current `If-Match`. Reconcile a 409 instead of overwriting concurrent changes. Publish only after the project's existing acceptance and owner gates permit it.

This works through a tool-capable model's HTTP interface, a conventional script, or a human-operated API client. It does not guarantee that a particular chat product exposes HTTP tools. There are no built-in integrations with named model providers in this release.

Use [AGENTS.example.md](AGENTS.example.md) as a project-scoped instruction block for coding agents or adapt the same text to your tool's instruction format. It does not grant extra permissions or change the agent's model settings.

## A chat-only model

Give the model a synthetic example schema and your non-sensitive roadmap. Ask it to produce a JSON draft with explicit milestone IDs, dependencies and acceptance criteria. Review the result yourself, create a matching project ID in the UI and import the file. The model never needs the Kontur access key.

## No model

Create a `general` project and import `examples/general-project.json`. Maintain the JSON with an ordinary editor and export/import it as needed. You can use the API from any HTTP client. Git is optional, and projects can represent research, events, a community garden or another milestone-based activity.

## Optional Git

The supplied PowerShell collector reads only a local repository. Kontur never connects to a repository by itself. `-OutputPath` writes a preview without reading a token or sending network requests. Without it, the collector GETs the latest Git revision and PUTs a snapshot with that revision. The snapshot may contain private ref names and commit subjects: review before sharing.

## Keep reporting honest

An agent's statement, an owner decision, a test result and independent verification are different evidence sources. Put references in `sources` and `evidence`, explain limits in `note`, and report acceptance only when supported. Kontur does not turn a status label into verification or replace the underlying source of truth.
