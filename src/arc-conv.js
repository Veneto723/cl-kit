// Pure conversation-id reconciliation — extracted from arc-runner so it can be
// unit-tested without launching claude.
//
// arc tracks a convId, but the conversation claude is ACTUALLY showing is the
// ground truth the statusline bridges into arc-active-<session>.json. These can
// diverge: a `arc --resume` picker session arc never assigned an id to, or a
// MANAGED session that drifted so our convId points at a phantom with no
// transcript. If we relaunch the phantom via --session-id we mint a brand-new
// EMPTY session (the "/arc-switch opens a new session instead of resuming" bug).
//
// pickConvId decides which id to (re)launch:
//   tracked          — the convId arc currently tracks (may be null)
//   actual           — the statusline-bridged real id (may be null)
//   userManagesConv  — true when arc never assigned the id (bare picker resume)
//   hasTranscript    — predicate(id) -> bool, is there a persisted transcript?
//
// Adopt `actual` when it's a bare picker resume (always trust the picked id), OR
// when it diverges from what we track AND is a REAL persisted conversation
// (guards against adopting a transient/bogus bridged id). Otherwise keep tracked.
function pickConvId(tracked, actual, userManagesConv, hasTranscript) {
  if (actual && (userManagesConv || (actual !== tracked && hasTranscript(actual)))) return actual;
  return tracked;
}

module.exports = { pickConvId };
