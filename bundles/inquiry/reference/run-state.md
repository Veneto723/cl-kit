# Run state and writer lease

Read this when starting, resuming, recording, pausing, or completing a run. Prefer the portable
Node utility so Claude and Codex apply the same counters and single-writer rule:

```sh
node <skill-root>/scripts/inquiry-state.js init <run-dir>
node <skill-root>/scripts/inquiry-state.js acquire <run-dir>
```

`acquire` returns an owner ID and creates `RUNNING.lock` with a 30-minute lease. Keep that ID
for the controller's lifetime. Re-run `acquire` with the same owner before a round to renew the
lease. If another unexpired owner holds it, stop; workers never acquire a lease or write files.
An expired lease may be replaced by `acquire` without deleting it manually.

After every attempted round, record the normalized booleans and the number of escalations:

```sh
node <skill-root>/scripts/inquiry-state.js record <run-dir> <owner> <clean> <dry> <roundFailed> <escalations>
```

A failed attempt increments `roundAttempts` but not `roundsCompleted` and does not alter the
clean dry streak. Any completed round that is not both clean and dry resets that streak. Treat
`state.json` as authoritative for round count, dry streak, total escalations, and run ID.

Release the lease before a handoff or legitimate stop:

```sh
node <skill-root>/scripts/inquiry-state.js release <run-dir> <owner> paused
node <skill-root>/scripts/inquiry-state.js release <run-dir> <owner> complete
```

Use `status <run-dir>` for inspection. Do not edit `state.json` or `RUNNING.lock` by hand when
the utility is available.

## Host fallback when process launch is unavailable

Use this fallback only after two utility launch attempts fail because the host cannot start a
process (for example, a Windows sandbox `CreateProcess` error). Do not use it for a utility
validation error or an active-owner conflict.

1. Read `state.json` and `RUNNING.lock` if present. Stop on an unexpired lease owned by anyone
   else. If the lease is expired, re-read it, delete only that observed stale lock, then continue.
2. Generate a unique owner ID. Create `RUNNING.lock` with a host operation that is explicitly
   create-only and fails if the file already exists, such as an `apply_patch` **Add File**. If
   creation conflicts, re-read the lock and stop. Never overwrite an active lock.
3. If `state.json` is absent, create version 1 state with a unique `runId`, zeroed counters,
   `status: "active"`, the owner in `activeOwner`, and ISO timestamps. Otherwise update only
   `status`, `activeOwner`, and `updatedAt` after acquiring the lock.
4. Record rounds with the exact counter semantics above, using a compare-aware patch. Before
   every write, re-read the lock and confirm the owner still matches and has not expired.
5. On pause or completion, update state first, then delete only the matching owner's lock.

The lock JSON contains `version`, `owner`, `acquiredAt`, `expiresAt`, and `ttlSeconds`. If the
host cannot provide create-only writes, stop before divergence; ordinary overwrite-capable file
editing is not a lease.
