# inquiry

`inquiry` is a self-paced, human-in-the-loop research skill for Claude Code and Codex. Give it
a `GOAL.md` with background, direction, and an optional limiter. It creates distinct research
angles, requires real sources, independently verifies candidate findings, and keeps a durable
ledger. It interrupts only for a major decision or a verified finding that changes strategy.

## One Skill, Two Runtimes

The repository root is the canonical skill directory. Claude Code and Codex both load the same
`SKILL.md`, templates, ledger, and scorecard. Only execution is host-specific.

| Runtime | Execution model | Continuation |
|---|---|---|
| Claude Code | Existing native `Workflow` engine in `workflows/round.js` | `ScheduleWakeup`, questions, and notifications |
| Codex | Planner, investigators, and fresh skeptic subagents | Active `/goal` session, resume, or external scheduling |

Both runtimes must preserve the same `roundFailed`, `clean`, `dry`, and `unverified` semantics
before a controller writes a finding to the ledger.

```text
SKILL.md                    Shared protocol and runtime selection
reference/                  Setup, resume, taste, scorecard, Claude and Codex adapters
templates/                  GOAL and ledger seeds
conformance/                Versioned trace contract, reducer, adapters, and synthetic fixtures
workflows/round.js          Existing Claude Workflow engine
workflows/scorecard.js      Portable feedback scorecard
scripts/inquiry-state.js    Portable run counters and single-writer lease
scripts/inquiry-conformance.js  Offline round-record validator
scripts/inquiry-live-smoke.js   Opt-in, version-pinned live CLI diagnostic
agents/openai.yaml          Codex skill metadata
runs/                       Ignored example runs for this source repository
```

## Executable Conformance

Inquiry does not require Claude and Codex to share an execution engine. Each runtime exposes a
host-shaped round record that must reduce to the same `inquiry.trace/v1` projection before the
controller writes findings. The Claude workflow returns an additive `trace` field; the Codex
adapter accepts the explicit angle/outcome record described by the canonical fixture.

```sh
node scripts/inquiry-conformance.js claude path/to/workflow-result.json
node scripts/inquiry-conformance.js codex path/to/codex-round-record.json
```

The first fixture at `conformance/fixtures/v1/partial-one-kept.json` is intentionally marked
synthetic. Passing it certifies the translators and reducer for that fixture; it is not evidence
that a live Claude or Codex host conforms. Live compatibility tests remain a separate layer.

Claim-level evidence is currently additive audit data. Investigators may return atomic claim IDs
with exact passage bundles, and the independent skeptic labels each row entailment, neutral, or
contradiction. The collector reports `pass`, `review`, or `missing` without blocking legacy
findings; enforcement waits for measured false-rejection data rather than an invented threshold.

## Live CLI Smoke

The live diagnostic checks the host boundary separately from round semantics. It makes one
schema-constrained turn in a generated temp repository, verifies a real file write, deletes the
file and nonce-bearing schema, resumes the exact session ID, and asks for the nonce with tools
disabled or audited. It then purges the host session and temp repository.

Live calls are never part of CI. They require both an exact CLI version pin and the explicit
credential/cost gate:

```powershell
$env:INQUIRY_LIVE_SMOKE = '1'
node scripts/inquiry-live-smoke.js codex --expect-version 0.144.1
node scripts/inquiry-live-smoke.js claude --expect-version 2.1.207 --max-budget-usd 0.25
```

Use the versions actually installed on the machine. A version mismatch fails before any model
call. See `reference/live-smoke.md` for the safety boundary and what a pass does not certify.

## Install

Expose this repository root as the `inquiry` skill directory.

```text
Claude Code: <checkout>/ -> ~/.claude/skills/inquiry/
Codex:       <checkout>/ -> ~/.agents/skills/inquiry/
```

On Windows, create the Codex junction once:

```powershell
New-Item -ItemType Directory -Force -Path "$env:USERPROFILE\.agents\skills"
cmd /c mklink /J "$env:USERPROFILE\.agents\skills\inquiry" "E:\path\to\inquiry"
```

Restart Codex after adding the junction. Invoke it with `$inquiry` and a brief path; use `/goal`
for an interactive long-running inquiry. When CLI web search is not already enabled, start with
`codex --search`. Claude users can continue to install the root directory as
`~/.claude/skills/inquiry/`.

## Run

1. Copy `templates/GOAL.md` to `docs/inquiry/<topic>/GOAL.md` in the host project.
2. Copy `templates/ledger/*` beside it.
3. Initialize run state with `node <skill-root>/scripts/inquiry-state.js init <run-dir>`;
   `reference/run-state.md` defines the create-only fallback for hosts that cannot launch it.
4. Invoke `inquiry` with the brief path; the controller acquires the writer lease.
5. Read the ledger at any time. It records findings, reversible decisions, open questions, and
   escalations; `RESUME.md` is written before a context handoff, never as an early conclusion.

Codex preflight checks adapter capabilities without starting research. In Codex CLI, delayed work
needs a desktop/web scheduled task or an external scheduler; the skill never pretends it can wake
itself.
