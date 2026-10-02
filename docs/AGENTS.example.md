# Optional project-scoped instructions

Copy this block into your project's instruction file after replacing placeholders.
It is a reporting contract for any trusted HTTP-capable tool, not model routing.

```text
Kontur origin: <your-local-or-trusted-HTTPS-origin>
Allowed project ID: <project-id>
Authoritative roadmap: <accepted-roadmap-path>
Private token source: <environment-variable-or-private-file-accessible-to-this-client>

Only the designated coordinator publishes this project's state. Workers return
evidence to the coordinator. Do not publish other projects or private files.
Read-only instructions remain read-only and prohibit monitor API writes.

At an authorized checkpoint:
1. Read the accepted roadmap and source evidence. Do not change the plan merely
   to fill the dashboard. Do not invent completion, approvals or Git facts.
2. Read the API schema when needed and GET the current project/revision.
3. Prepare name/type/description/archived/roadmap, excluding response metadata.
4. PUT with the read revision in If-Match. On 409, stop, reread and reconcile.
5. Read back the result and report the new revision without exposing the token.

Never put tokens into prompts, command-line arguments, logs, URLs or JSON.
Git snapshots are optional and have their own revision. Collect only from the
authoritative local repository; use NO_GIT when none exists. Sending a Git
snapshot does not authorize commit, merge, cleanup or deployment operations.
Existing owner approval and acceptance rules remain in force.
```
