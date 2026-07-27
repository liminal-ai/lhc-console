# Handoff: terminal env scrub (persistence-off fix)

Written 2026-07-27 from an unpersisted session (see below). If you are a fresh
claude session resuming th_a485 / session 8560b083: the conversation after the
16:39Z "Bye!" line happened but was never written; this note is its record.

## Problem

Terminals spawned by the console workspace launch claude with the parent
session's env leaked in (`CLAUDECODE=1`, `CLAUDE_CODE_CHILD_SESSION=1`,
`CLAUDE_PID`, `CLAUDE_CODE_SESSION_ID`, `AI_AGENT`, `CLAUDE_EFFORT`, …).
Cause: the API server (node --watch, 127.0.0.1:5959) was relaunched from
inside a Claude Code session's Bash tool, so its process env carries those
vars, and apps/server/src/terminals.ts spawns PTYs with `env: process.env`
(plus TERM). Claude Code sees CLAUDE_CODE_CHILD_SESSION=1 and disables
session persistence ("nested child session" protection) — the resumed session
runs fine but writes nothing to its .jsonl, and cc-lhc capture (which tails
that file) records nothing either.

## Status: TESTED AND STAGED (2026-07-27 ~17:45Z)

Empirical proof (node-pty + `bash -lc claude`, same shape as terminals.ts):
with the server's current dirty env claude answered but wrote NO session
file; with the scrubbed env it wrote one. The patched terminals.ts sits at
`<scratchpad>/terminals.patched.ts` (session 8560b083's scratchpad) and was
applied with cp + commit as the final act of the unpersisted window. If the
commit/push didn't land before the window died, the working tree still has
the patch: `vp check` then commit/push it.

## Fix (apply to apps/server/src/terminals.ts)

Where the pty is spawned (search `pty.spawn` / the env option), replace the
inherited env with a scrubbed copy:

```ts
function scrubbedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k === "CLAUDECODE" || k === "AI_AGENT") continue;
    if (k.startsWith("CLAUDE_")) continue; // CLAUDE_CODE_*, CLAUDE_PID, CLAUDE_EFFORT, CLAUDE_AGENT_SDK_*
    env[k] = v;
  }
  return env;
}
```

and use `{ ...scrubbedEnv(), TERM: "xterm-256color" }` for the spawn env.
Keep everything else (PATH, HOME, etc.) — only the claude-session markers go.

Then restart the API server FROM A CLEAN SHELL (not from inside a claude
session), e.g. a plain terminal:

```bash
pkill -f "node --watch src/index.ts"
cd /srv/work/lhc-console/apps/server && nohup node --watch src/index.ts \
  > /tmp/lhc-console-server.log 2>&1 & disown
```

Verify: POST /api/terminals with a devCommand `env | grep -i claude` (needs
LHC_CONSOLE_DEV_SECRET) or launch a thread and check
`tr '\0' '\n' < /proc/<claude pid>/environ | grep CLAUDE` — should show
nothing, and claude should no longer report persistence off; the session
.jsonl must grow each turn (stat it).

Also fine to do while there: `vp check`, commit, push.

## Context from the unpersisted window (2026-07-27 ~17:00–17:30Z)

- This claude session was launched from the console's terminal workspace
  (dogfooding): console PTY → cc-lhc --resume 8560b083 → claude. Ancestry
  verified; the one-writer situation is clean (single pair).
- The t3code→cc-lhc migration of the 21.6MB thread is DONE on disk: rollout
  99f13af5-93b6-4bf0-a177-93b3ce0c2cfd.jsonl copied to
  ~/.claude/projects/-srv-work-long-horizon-context/ and registered in that
  dir's sessions-index.json (with .bak). Resume command:
  `cd /srv/work/long-horizon-context && cc-lhc --resume 99f13af5-…`. The user
  had not yet run it.
- ~130 small (~16-33KB) session .jsonl files in the lhc-console project dir
  are from cc-lhc's `claude -p` derivation subprocesses (each leaves a session
  file). Cosmetic; possible future cc-lhc improvement
  (--no-session-persistence on the inference lane would stop the litter).
- Repo state: all work through slice 10 committed and pushed (HEAD 1fe73e9).
