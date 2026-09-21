# Registering a t3code-hosted seat on the relay (relay only, no Photon)

Written 2026-09-09 by Reed from the Reed/Wrenn/Flint/Sable installs. Registry is `~/.lhc-console/agents.json`; the console loads it once at start, so every change is a candidate file plus one console restart, guarded.

## What Lee supplies
- key (lowercase, the relay address and `--from` sender id), display name, one-line description/duties
- the t3code thread id (UUID) the seat lives on, already created in the t3code UI with its provider, model, and project; its history is never touched by registration
- owner sender ids: keep the same list as every other seat (`+14436783841`), needed even without Photon because the injector marks owner messages

## The entry (relay only)
```json
"<key>": {
  "name": "<Name>", "description": "<one line>", "duties": ["<one line>"],
  "ownerSenderIds": ["+14436783841"],
  "mentionPatterns": ["(?<![\\w@])@?<key>\\b[,\\-:]?"],
  "relay": {
    "hostId": "t3code",
    "threadId": "<t3code thread uuid>",
    "cwd": "/srv/work/long-horizon-context/packages/t3code-inject",
    "command": "/srv/work/long-horizon-context/packages/t3code-inject/bin/t3code-inject",
    "args": ["--base-url", "http://127.0.0.1:3773", "--thread", "<t3code thread uuid>"],
    "timeoutMs": 2700000,
    "concurrent": true,
    "env": {
      "T3CODE_INJECT_HOME": "/home/leemoore/.t3code-inject",
      "T3CODE_HOME": "/home/leemoore/.t3code",
      "T3CODE_INJECT_CHECKOUT": "/srv/work/t3code",
      "HOME": "/home/leemoore",
      "PATH": "/home/leemoore/.local/share/fnm/node-versions/v24.18.0/installation/bin:/usr/local/bin:/usr/bin:/bin"
    }
  }
}
```
No `channels` block: omitted means no messaging channel (agent-registry.ts parseChannels returns empty). Photon/iMessage is a separate provisioning step (Photon project, number, secrets, `channels.photon`) and is not part of relay access.

Binding: the relay binds by `relay.threadId` only. The injector posts turns to the running server over its websocket dispatch, using the shared auth file `~/.t3code-inject/auth-http_127_0_0_1_3773.json` (self-issued pairing token, one per server, shared by all t3code seats). Nothing is written to the thread at registration; the first turn is the first message you send.

## Install
1. `cp ~/.lhc-console/agents.json ~/.lhc-console/agents.json.pre-<key>-$(date -u +%Y%m%dT%H%M%SZ)`
2. Write the candidate: `~/.lhc-console/agents.json.candidate-<key>` = live file plus the entry (python json load/dump, chmod 600).
3. `~/.lhc-console/bin/validate-registry.sh ~/.lhc-console/agents.json.candidate-<key>` must exit 0.
4. `~/.lhc-console/bin/registry-swap-watchdog.sh <candidate> <key>` detached (`setsid nohup ... &`): it installs the candidate and restarts `lhc-console.service` at the next quiet relay window via `relay-restart-quiet.sh`; on start `registry-guard.sh` re-validates and rolls back to `agents.json.last-good` on failure, with an alert either way. Do not restart the unit by hand while it runs. Every cc-lhc seat is down for the restart (seconds); t3code seats are unaffected except that their relay calls queue.
5. `~/.lhc-console/registry-guard.log` tail shows `ok sha=... (last-good refreshed)` for the new file.

## Verify
- `lhc-agent list` shows the key.
- `printf 'Reply with one word.\n' | lhc-agent <key> -` returns the reply (the `-` reads the message from stdin; without it the CLI treats the argument as the prompt). Check the t3code thread gained one turn.
- The seat's own sends carry its name only when a sender is supplied. Claude LHC seats get it from `T3CODE_THREAD_ID` (the Claude LHC sidecar sets it per thread); Codex seats share one app-server with no thread env, so they must pass `--from <key>` or export `LHC_AGENT_ID=<key>` (put it in the project AGENTS.md). A send without a sender is rejected, never misattributed.
- Goals: `lhc-agent goal start <key> "..." --every 60m` reaches the seat through the same injector.

## Not covered
Photon/iMessage provisioning; the plane's v2 identity tables (`v2` block), only needed for seats on the v2 provider plane; moving the seat's thread to another project (delete and re-import, see the fork tool campaign).
