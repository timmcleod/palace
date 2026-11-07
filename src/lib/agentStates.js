// What agents are doing, as one state for a repository: "blocked" (one needs you),
// "error" or "done" (one finished, and hasn't been looked at since), or "working". Each
// window sums up its own terminals' (see repositoryStates in terminals.js); every
// window's are put together here for Worktrees to show, wherever the agents are.

// How much each calls for the user, so the most pressing shows.
const URGENCY = { working: 1, done: 2, error: 3, blocked: 4 };

// Whether `state` is one an agent can be in.
const isAgentState = (state) => state in URGENCY;

/** Of two states, the more pressing; either may be null. */
export const morePressing = (a, b) => ((URGENCY[b] ?? 0) > (URGENCY[a] ?? 0) ? b : a);

/**
 * Every window's agents' states together, by repository: `byWindow` is each window's,
 * by repository, as the backend keeps them. Where two windows have agents in one
 * repository, the more pressing state shows.
 */
export function allAgentStates(byWindow) {
  const all = {};
  for (const states of Object.values(byWindow ?? {})) {
    for (const [path, state] of Object.entries(states)) {
      if (isAgentState(state)) all[path] = morePressing(all[path] ?? null, state);
    }
  }
  return all;
}
