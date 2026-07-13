# Live CLI Smoke

Use this diagnostic only when the human explicitly asks for a live Claude Code or Codex CLI
test. It incurs authenticated model calls. Normal CI and offline conformance tests must not set
the live gate.

## Run

Pin the exact installed version so an upgrade cannot silently change the test surface:

```powershell
claude --version
codex --version

$env:INQUIRY_LIVE_SMOKE = '1'
node <SKILL_ROOT>/scripts/inquiry-live-smoke.js claude --expect-version <version>
node <SKILL_ROOT>/scripts/inquiry-live-smoke.js codex --expect-version <version>
```

For Claude, `--max-budget-usd` sets a per-turn cap and defaults to `0.25`. Every host command has
an external deadline, defaulting to 180 seconds; override it with `--timeout-ms`. The gate may
also use `INQUIRY_CLAUDE_VERSION` or `INQUIRY_CODEX_VERSION` instead of `--expect-version`.

## Safety Boundary

- The harness creates a generated temp Git repository and refuses to recursively remove any path
  outside its `inquiry-live-smoke-*` namespace.
- Codex starts in `workspace-write` with user config/rules ignored. On Windows, its relative file
  write may still be classified as a sandbox-approval event; that one fixed temp-repository task
  is routed to the automatic reviewer. The harness rejects command traces not scoped to
  `probe.txt` and the generated nonce. It never passes `--yolo`, a dangerous bypass, or
  `--ephemeral`.
- Claude runs in safe mode with only `Write` available on the first turn and no tools on resume.
  `acceptEdits` is scoped to the generated temp project; no permission bypass is used.
- The first file, output, and nonce-bearing schema are removed before resume. The resume schema
  contains no expected nonce. Codex fails if the resume event stream contains a command, file,
  MCP, or web tool event.
- Cleanup uses exact-ID `codex delete --force`, project-scoped `claude project purge --yes`, and
  guarded temp deletion. Cleanup failure fails the diagnostic.

`--keep` retains the generated filesystem only for explicit debugging. Host session state is
still purged, and the retained path is reported so it can be removed after inspection.

## Meaning of a Pass

A pass demonstrates, for the pinned CLI build and current account, authenticated non-interactive
execution, schema-constrained output, one bounded workspace edit, exact-session resume, and
cleanup. It does not certify the full inquiry workflow, hidden prompt delivery, reasoning effort,
web-source quality, subagent independence, or semantic equivalence between hosts. Those remain
the responsibility of the runtime adapter, `inquiry.trace/v1` conformance checks, and research
audits.
