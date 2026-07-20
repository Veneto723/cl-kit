#!/usr/bin/env node
// arc-stop-hook: the board's SECOND delivery point — the END of a turn.
//
// UserPromptSubmit delivers notes at turn START, which means a note that arrives while
// you are working sits on the board until a HUMAN types something. For an answer you
// ASKED FOR that is backwards: you posed the question, so the reply should come back to
// you — not wait for a nudge.
//
// Stop fires as the agent is about to go idle. `{decision:'block', reason}` keeps the
// turn alive and feeds `reason` to the model, so an arrived note is handed over with
// NOBODY TYPING A CHARACTER. Three cases, in order:
//
//   1. Unread notes  → block once and hand them over. injection() advances the read
//      cursor over exactly what it delivered, so the same note can never block twice —
//      delivery is idempotent, and that is what makes this loop-safe.
//
//   2. No notes, but a request I asked a PEER is STILL UNANSWERED → this is the last
//      moment we can do anything. Nothing outside can wake an idle session: arc runs
//      claude on the real TTY (stdio:'inherit'), so it holds no handle to type into, and
//      Claude Code exposes no timer hook and no external prompt injection. The ONLY wake
//      channel is a background command the session itself started, which re-invokes the
//      agent WHEN IT EXITS. So we block once and ask the agent to arm `arc await <role>`
//      before it stops. That exits the moment the reply lands → the session wakes itself.
//
//   3. Nothing pending at all, but I HOLD A ROLE → arm the listener anyway. Both delivery
//      points need a TURN, and an idle session has none, so a role-holder that stops without
//      a listener is simply unreachable until a human types. This is what makes "being on a
//      board IS being reachable" true rather than aspirational. Deliberately NOT gated on a
//      peer existing (that check expires the instant you idle — a peer can join afterwards)
//      nor on stance (listening is not acting).
//
// STANCE (/arc-mode) does NOT gate any of this, on purpose. Every case here is conditioned on
// something YOU ALREADY STARTED — an unread note addressed to you, a request you sent. That is
// FOLLOW-THROUGH, not initiative. The stance gates the ASK, upstream:
// under PASSIVE you'd only have asked because the user told you to, so muting the wake would
// eat an answer the user explicitly wanted. (Contrast `arc watch`, which volunteers you for work
// nobody has asked for yet — speculative, so the skill gates THAT on ACTIVE.)
// And we only ever OFFER: the block goes to the model, which is already carrying its stance
// directive, so a passive agent can just decline. Whether the user ordered the ask is a judgment
// only the model can make — a hook can't see it.
//
// Safety (a Stop hook that misfires wedges a session, so all three are load-bearing):
//   • stop_hook_active → deliveries chain (provably terminating) and MARKER-BOUNDED offers may
//     fire once; only the unmarked spawns-leak nag returns immediately. (The old blanket bail
//     here is what left a fed-then-idle session deaf — see the guard comment below.)
//   • We only ever block when there is genuinely something to say (a note, or an
//     un-armed unanswered request) — never speculatively.
//   • Any throw exits 0 silently. A coordination nicety must never trap a session.
// Claude Code independently caps consecutive Stop blocks at 8, which is the backstop.
'use strict';

const BIRTH_GRACE_MS = 120000;   // a spawn younger than this is not yet nagged as charterless — it is still writing its charter

function out(value) { process.stdout.write(JSON.stringify(value)); }

function run(raw) {
  let hook = {};
  try { hook = JSON.parse(raw || '{}'); } catch {}

  const session = (process.env.ARC_SESSION || '').trim();
  if (!session) return null;                       // not an arc session — stay out of the way
  const cwd = typeof hook.cwd === 'string' ? hook.cwd : process.cwd();

  // 0. A FORKED session's claim was written before its conversation id existed (see
  //    arc-notes.healClaimConv). The id is knowable by now, so heal the claim — otherwise this
  //    peer silently loses its role on the next restart, and can never invite anyone itself.
  //    Idempotent: one cheap read once healed.
  try { require('./arc-notes').healClaimConv(session, cwd); } catch { /* never wedge a turn */ }

  // 0b. The seen-marker is stamped at TURN START (arc-switch-hook, on UserPromptSubmit), NOT here.
  //     It used to be stamped here at turn END — but turn-end HEAD is an UPPER bound: if ANOTHER peer
  //     commits mid-turn on the shared tree, that commit is <= my turn-end HEAD yet I never read it,
  //     so stamping it "seen" would hide it from my next revive brief FOREVER (audit #170, arc's own
  //     multi-agent case). Turn-start HEAD is a lower bound the peer definitely saw, so the brief
  //     over-reports (safe noise) instead of under-reporting (silent zombie). See notes.stampSeenHead.

  // 1. Anything on the board for me? Hand it over instead of going idle.
  //
  // THIS CASE MAY CHAIN, and must. A batch is capped at INJECT_MAX, so a peer that answers at
  // length arrives in PIECES — and `stop_hook_active` used to bail out at the top of this hook,
  // so the FIRST batch was delivered and every later one sat there until a human typed. That is
  // the whole promise ("the board reaches you without a keystroke") broken exactly when a peer
  // has the most to say. Caught live: research replied 2985 + 2555 chars, #26 landed, #27 waited
  // for the user. It was latent for as long as bodies were clipped to 400 (many notes fit one
  // batch); raising the clip so a peer's ANSWER survives whole is what made multi-batch normal.
  //
  // Chaining is safe HERE and nowhere else, because delivery is provably terminating: injection()
  // advances the read cursor over exactly what it delivered, so every block strictly shrinks the
  // unread set and the next stop either delivers the remainder or returns null. Claude Code's cap
  // of 8 consecutive Stop blocks is the backstop, not the mechanism. The OFFERS below (arm a
  // listener) have no such property — they are advice, not a queue that drains — so they keep the
  // stop_hook_active guard and can never nag mid-continuation.
  const inj = require('./arc-notes').injection(session, cwd);
  if (inj) {
    const more = inj.count > inj.consumed;   // a capped batch — the rest arrives on the next stop
    // FOLD THE ARM-NUDGE INTO THE DELIVERY (measured fix, 2026-07-18). A role-holder that is not
    // listening is deaf the moment it idles — and the standalone offer below is UNREACHABLE for a
    // busy session, because this delivery block returns first on every turn that has a note. That
    // is exactly how audit stayed deaf all day: it was revived with a request every time, so every
    // turn ended in a delivery, the standalone offer never fired, and the one time it did (a quiet
    // continuation) audit was mid-verdict and ignored it — after which the once-per-cycle marker
    // suppressed it forever. Reproduced cold: a role-holder fed a note each turn NEVER armed.
    // So ride the interruption the session is already taking — append the nudge to the note it is
    // already reading. This is the ONE place a deaf-but-busy session is guaranteed to be looking,
    // and it costs no extra block (zero added nagging — it is text on a delivery that was
    // happening anyway). Guarded on holding a role and NOT already listening, so an armed session
    // sees nothing extra. The standalone offer below still covers a QUIET role-holder (no
    // deliveries to ride), which is the case it was always for.
    let armTail = '';
    try {
      const A = require('./arc-await');
      const N = require('./arc-notes');
      const R = require('./arc-board');
      const role = N.getRole(session, R.resolveBoard(N.resolveCwd(session, cwd)));
      // isWaitingAs, NOT isWaiting: a listener armed for an OLD role is deaf on this one, so a
      // role-blind check would call a genuinely-deaf session "reachable" and suppress the nudge.
      if (role && !A.isWaitingAs(session, role, { genuine: true })) {
        // RESET THE OFFER CYCLE on this fresh activity (the deafness root, found 2026-07-18 from
        // audit's own confession). The standalone offer below is muted once per cycle by wasOffered,
        // cleared ONLY when a listener actually arms (isWaiting). So an arm that DID NOT TAKE — a
        // malformed one (audit ran `arc join` foreground+piped, not run_in_background) or an ignored
        // one — leaves the marker stuck TRUE, and every future offer is suppressed FOREVER, even
        // across new delegated tasks: the session gets one failed arm and is then never re-prompted.
        // A delivery is proof the session is engaged AND still deaf, so re-open the cycle: the next
        // quiet turn re-offers. Bounded (only on a delivery to an unarmed holder), so it is not a
        // per-turn nag — it re-prompts once per task the session actually handles.
        A.clearOffered(session);
        armTail = `\n\n⚠ You hold "${role}" but have NO listener armed — the moment this turn ends you are `
          + `unreachable again (a note would sit unseen until a human types). After you handle the above, `
          + `arm it so the NEXT reply reaches you without anyone typing:\n`
          + `  run EXACTLY "arc join ${role}" via run_in_background: true — NO pipe, NO redirect, NO &.\n`
          + `  (a foreground or piped \`arc join\` is NOT a wakeable listener even if it prints "listening" —\n`
          + `   only a run_in_background task whose EXIT re-invokes you can wake this session.)`;
      }
    } catch { /* a nudge must never wedge a delivery */ }
    out({
      decision: 'block',
      reason: `${inj.text}\n\n(arc delivered this at the END of your turn — the user typed nothing. `
        + `Act on it if it needs acting on, then tell the user what came back.`
        + (more ? ' More is still unread; arc will hand you the next batch when this turn ends.' : '')
        + `)${armTail}`,
    });
    return 'notes';
  }

  // Past here we only ever OFFER something. Which offers may follow OUR OWN block is decided by
  // whether the offer is SELF-BOUNDED — this used to be a blanket `stop_hook_active -> return`,
  // and that hole put audit deaf TWICE in one day (2026-07-18): a woken session's turn ends in a
  // chain — Stop -> deliver a note (block) -> reply -> Stop with stop_hook_active — so the
  // blanket bail silenced the listener offer on exactly the turn shape a busy board produces:
  // wake, answer, idle, DEAF until a human typed. The request offer (marked per seq) and the
  // listener offer (marked once per cycle) are bounded by their own markers — at most one extra
  // block each, then the marker holds — so they now run even mid-continuation. Only the
  // spawns-leak nag has no marker (it re-fires as long as the leak exists), so it alone keeps
  // the hard stop_hook_active guard, at its own site below.

  // 2. A QUESTION you asked a PEER that nobody has answered yet. You asked, so you want the
  //    answer — but a peer replies on THEIR schedule, and if you go idle first, nothing wakes
  //    you: the reply just sits on the board until a human happens to type something. So arm
  //    `arc await`, whose EXIT re-invokes you. Offered ONCE per request (markRequestsArmed),
  //    never every turn.
  const N = require('./arc-notes');
  const open = N.unarmedRequests(session, cwd);
  if (open.notes.length) {
    N.markRequestsArmed(session, open.notes.map((n) => n.seq));
    // A live listener already guarantees the wake — the reply will exit it and re-invoke us.
    // Telling the agent to arm what is armed is exactly the nag this hook promises not to be.
    // isWaitingAs(open.role), NOT isWaiting: the reply lands addressed to open.role, so a listener
    // armed for an OLD role will NEVER see it (it polls unreadFor(board, oldRole)). A role-blind
    // check here would call a genuinely-deaf session "reachable" and arm no waiter for the role
    // that is actually owed the answer — the silent-drop this case exists to prevent. (Adversarial
    // deafness-hunt, 2026-07-18: this was the ONE re-arm site left role-blind after case 1/case 3
    // were converted — two independent verifiers convicted it.)
    if (require('./arc-await').isWaitingAs(session, open.role, { genuine: true })) return null;
    const asked = open.notes.map((n) => `#${n.seq} → ${n.to || 'everyone'}${n.toLive === false ? ' [EMPTY CHAIR]' : ''}: "${String(n.body).replace(/\s+/g, ' ').slice(0, 60)}"`).join('\n  ');
    // A request whose target is GONE cannot be answered — and the peer may have closed AFTER the
    // ask, so nothing warned at post time. Telling this agent to arm a listener would be telling
    // it to wait forever. Name the empty chair and give it the only two real options.
    const dead = open.notes.filter((n) => n.toLive === false);
    const deadLine = dead.length
      ? `\n⚠ ${dead.length === 1 ? 'One of those is' : `${dead.length} of those are`} addressed to a role NOBODY HOLDS `
        + `(${[...new Set(dead.map((n) => `"${n.to}"`))].join(', ')}). Waiting cannot help: nobody is there to answer.\n`
        + `  Put someone in the chair →  arc delegate ${dead[0].to} "<packet>"   (it reads it on arrival)\n`
        + `  …or drop it and do the work yourself / with a subagent.\n`
      : '';
    // This "arm the waker" IS the listener-arm instruction (`arc join <role>`) — the same one case 3
    // gives. So mark the offer here too, or case 3 would fire the identical prompt on the NEXT turn:
    // a double-nag for one action. markRequestsArmed above bounds THIS case per request; markOffered
    // bounds case 3. Both clear on a real arm (isWaiting) or a fresh delivery (case 1).
    require('./arc-await').markOffered(session);
    out({
      decision: 'block',
      reason: `[arc] ${open.notes.length} request(s) you asked a peer are STILL UNANSWERED:\n  ${asked}\n${deadLine}\n`
        + `They answer on their own schedule, and nothing can wake an idle session from outside. `
        + `If you want the answer, arm the waker before you stop:\n`
        + `  →  arc join ${open.role}   — run it via run_in_background: true (that IS the backgrounding); add\n`
        + `     NO & and NO redirects. A shell &/>/2>&1 breaks the permission allowlist (so it prompts you\n`
        + `     instead of just running), AND a shell-backgrounded process is not a wakeable listener —\n`
        + `     only a run_in_background task re-invokes this session. The command must be EXACTLY "arc join ${open.role}".\n\n`
        + `It exits the moment they reply, and that exit re-invokes YOU with it. If the answer `
        + `isn't worth waiting on, just say so and stop — you won't be asked about these again.`,
    });
    return 'request';
  }

  // 2b. YOU OPENED PEERS AND LEFT THEM RUNNING. Spawning without closing is a leak, and until now
  //     arc had no way to notice: a claim recorded that a peer EXISTED, never who MADE it, so a
  //     forgotten probe was indistinguishable from a standing team member and only a human
  //     recognising a name ever cleaned one up. That cost five leaks in a single session — three
  //     test peers named by hand, sixteen orphan consoles from a harness that killed the wrong
  //     pid, and a ghost holding a chair after its caller was told it never started.
  //
  //     THIS NAG IS THE FIX — the whole fix. There is deliberately NO auto-reaper behind it (an
  //     earlier draft promised one; nothing was ever built, and it should not be): every one of
  //     those leaks had a LIVE spawner that simply did not tidy up, and no orphan rule catches
  //     that — the parent is right there. Worse, the rule itself is unwritable: under the
  //     standing-duty doctrine a peer is SUPPOSED to outlive its spawner, so "parent gone" is the
  //     design working, not orphanhood — and telling "dead" from "not yet" is the exact judgment
  //     this project measured itself getting wrong six times in one day (the zombie that did two
  //     trials' work after its trial was voided; eb53c3c). A reaper's mistake kills accumulated
  //     context, the one asset a peer exists to hold; the leak it would prevent is an idle
  //     process — cheap, visible in the roster, and named right here every turn. Only the parent
  //     can know the work is done, and this is the one moment it is both about to forget and
  //     still able to act.
  //
  //     NAG, NEVER KILL — AND NAG ONLY A LEAK. A peer with an armed listener is idle BY DESIGN: a
  //     standing team member waiting for work, and silently reaping it would make `arc delegate` a
  //     trap where your team evaporates between turns. But the first cut nagged too widely — it
  //     listed a CHARTERED standing duty (`research`) as something to close, and the human caught
  //     it: closing a standing peer is not free (revive pays boot + prefill on its whole history),
  //     and the process it saves costs RAM, not quota (an armed listener is blocked on a poll, it
  //     makes no API calls). So the nag now fires ONLY for an idle spawn with NO committed charter
  //     — a temp worker, the one thing the doctrine says should barely exist. A chartered peer is a
  //     teammate; it is never listed. Only ones that OWE NOTHING are candidates; a peer mid-answer
  //     is working.
  //     THE SPAWNS-LEAK NAG ALONE KEEPS THE HARD GUARD: it has no once-per-cycle marker, so
  //     chained onto our own block it would re-fire on every stop while the leak exists.
  if (!hook.stop_hook_active) try {
    const R = require('./arc-board');
    const N = require('./arc-notes');
    const D = require('./arc-duty');
    const board = R.resolveBoard(N.resolveCwd(session, null));
    const myConv = N.sessionConv(session);
    const mine = R.spawnsOf(board, myConv);
    if (mine.length) {
      const live = R.liveRoles(board);
      // Idle = live, and owes me nothing. Anything still holding an unanswered request is working.
      const idle = mine.filter((b) => live.some((l) => l.role === b.role)
        && !R.openRequests(board, b.role).some((n) => n.to === b.role));
      // A CHARTERED role — one with a committed .arc/roles/<role>.md — is a STANDING DUTY, and the
      // nag must NEVER push you to close it. That was the bug the human caught: it listed a chartered
      // `research` as something to reap, and closing a standing peer is not free — reviving it pays
      // boot + prefill on its whole history, while the process it "saves" costs a little RAM, not
      // quota (an armed listener is BLOCKED ON A FILE POLL; it makes no API calls while it idles, so
      // "burns its own quota" was simply false). The doctrine's own words: a fresh-born peer is a
      // subagent with extra steps — so what is worth keeping is exactly the peer with accumulated
      // context, which is exactly the chartered one. So the nag now catches ONLY the leak: an idle
      // spawn with NO charter. That is a temp worker, and a temp worker is the smell the doctrine
      // warns about — if the job was real it earns a charter; if not, it was noise.
      // BIRTH-AGE GRACE (audit #149): a brand-new role is staffed and claims its chair a few
      // seconds BEFORE it writes its charter (the birth instruction says to write it on the first
      // turn). In that window it reads live + idle + charterless and would be wrongly nagged as a
      // leak — the same false positive the human caught, narrower. So a spawn younger than the grace
      // is never nagged; after it, a still-charterless spawn is a genuine temp worker. (A charter
      // being WRITTEN over an existing file is already safe — a partial read is still truthy.)
      const leaks = idle.filter((b) => !D.readDuty(board, b.role) && (Date.now() - (b.at || 0)) > BIRTH_GRACE_MS);
      if (leaks.length) {
        const list = leaks.map((b) => `  arc close ${b.role}`).join('\n');
        out({
          decision: 'block',
          reason: `[arc] You spawned ${leaks.length} peer(s) with NO charter, still running and owing you nothing:\n`
            + `${leaks.map((b) => `  "${b.role}"`).join(', ')}\n\n`
            + `A peer with no committed .arc/roles/ charter is a temp worker — and reaching for one is a `
            + `smell the doctrine warns about: if its job is real it earns a chartered standing duty; if `
            + `it is not, it was probably noise. So either WRITE its charter (\`arc role\` shows the shape) `
            + `— then it is a teammate, not a leak — or close it. Closing what you opened is YOUR job, not `
            + `your human's.\n${list}\n\n`
            + `A closed peer is REVIVABLE: its conversation stays on disk, so \`arc delegate <role>\` `
            + `brings it back knowing everything it learned. Chartered standing peers are NOT listed here — `
            + `they are teammates waiting for work, and leaving them live between assignments is correct.`,
        });
        return 'spawns';
      }
    }
  } catch { /* bookkeeping must never block a turn */ }

  // 3. Nothing pending — but you HOLD A ROLE, so a peer can address you at any time, and you
  //    are about to become unreachable. Both automatic delivery points need a TURN: the
  //    UserPromptSubmit injection needs a human prompt, and this hook needs a turn to end.
  //    An idle session has neither, so a note posted to you now would sit unseen until a human
  //    happens to type — which defeats the entire point of asking a peer who is "just sitting
  //    there ready".
  //
  //    So: arm the listener on the way out. Every idle, unconditionally.
  //
  //    NOT gated on "does a peer exist right now?" — that check is evaluated at the exact
  //    moment it stops being true. A session that idles alone, and only THEN gets a peer
  //    (someone delegates to it, or opens a second tab), would be asleep and unarmed with no
  //    way to ever learn about them. Holding a role is what makes you addressable; that is the
  //    condition, and it does not expire.
  //
  //    NOT gated on stance either, for the reason above: listening is not acting. A PASSIVE
  //    session that wakes on a note reads it and tells the user — it still won't self-initiate
  //    work. Muting the ear would not make it more passive, just deaf.
  const A = require('./arc-await');
  if (!open.role) return null;                       // no role = nobody can address you = nothing to hear
  // isWaitingAs(open.role), NOT isWaiting: a listener armed for an OLD role hears nothing on this
  // one, so a role-blind check would leave a role-changed session silently deaf (the misfile shape).
  if (A.isWaitingAs(session, open.role, { genuine: true })) { A.clearOffered(session); return null; }  // listening AS THIS ROLE: quiet, re-offer next cycle
  if (A.wasOffered(session)) return null;            // already asked this cycle — never nag
  A.markOffered(session);
  out({
    decision: 'block',
    reason: `[arc] You hold the role "${open.role}" on this board, so a peer can address you at any time — `
      + `but you are about to go idle, and an idle session cannot be reached: notes arrive on a TURN, and `
      + `nothing outside can start one. Arm your listener before you stop:\n`
      + `  run it in the BACKGROUND (run_in_background: true), in whichever shell you use  →  arc join ${open.role}\n\n`
      + `It blocks (costing nothing) until a note lands, then EXITS — and that exit re-invokes you with it. `
      + `Do this, then finish your turn normally; you won't be asked again while it's listening.`,
  });
  return 'listen';
}

module.exports = { run };

if (require.main === module) {
  let raw = '';
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    try { run(raw); } catch { /* NEVER wedge a session on a coordination nicety */ }
    process.exit(0);
  };
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', finish);
  process.stdin.on('error', finish);
  setTimeout(finish, 500).unref();
}
