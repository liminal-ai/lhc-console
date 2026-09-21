# Provisioning a Photon/iMessage line for a seat

Written 2026-09-09 by Reed from the Reed/Wrenn/Flint/Sable/Wren/Heron provisions. Do the relay entry first (docs/relay-seat-t3code.md), then this; the channel is a block on the same registry entry.

## Account facts
- One Photon project per seat, owned by the liminal.builder Photon account (`photon whoami`; credentials in ~/.config/photon/credentials, device login via `photon login` if expired; a login link + code goes to Lee to approve, valid 15 min).
- Plan: free/pro shared pool. The seat's number is a shared-pool line: it can DM and receive DMs, cannot create or join new groups, cannot carry a display name (Lee names it as a contact on his phone). Group chat needs the Business plan's dedicated line (`photon spectrum lines add`); not provisioned for any seat today.
- The project's Spectrum user is Lee (`--phone +14436783841`, email liminal.builder@gmail.com). That is what makes his number the owner on the line; `ownerSenderIds` in the registry must match it.

## Steps
1. Create the project, iMessage on: `photon projects create -n "<Name>" --platforms imessage --json` -> project id.
2. Secret: `photon projects secret <id>`.
3. Add Lee as the Spectrum user: `photon spectrum users add -p <id> --first-name Lee --last-name Moore --email liminal.builder@gmail.com --phone +14436783841`.
4. Confirm: `photon spectrum platforms list -p <id>` shows imessage on; `photon spectrum users list -p <id>` shows Lee.
5. Env file `~/.lhc-console/agents/<key>.env`, chmod 600, exactly two lines: `PHOTON_PROJECT_ID=<id>` and `PHOTON_PROJECT_SECRET=<secret>`. A wrong secret crash-loops the connector on install and the watchdog rolls the registry back (this happened on Wren's first install).
6. The number: `photon spectrum users list --project <id> --json` returns `assignedPhoneNumber` immediately after step 3 (Alder, Ash provision 2026-09-09). Write it into `channels.photon.address`; one-pass install. (My earlier installs read it from the connector log after a placeholder install; unnecessary.)
7. Registry channel block on the seat entry:
   `"channels": {"photon": {"address": "+1XXXXXXXXXX", "envFile": "agents/<key>.env", "notifySpaceId": "any;-;+14436783841"}}`
   `envFile` is relative to ~/.lhc-console. `notifySpaceId` `any;-;<owner>` is the DM space with Lee, used for alerts and goal notices.
8. Install by candidate + validate-registry.sh + registry-swap-watchdog.sh, quiet window only (see the relay runbook; the watchdog forces a restart after 20 minutes, so start it only when I say the relay is quiet).

## Verify
- Order matters: Lee texts the new number first. A shared-pool line refuses an unsolicited first outbound with `[spectrum-imessage] Target not allowed for this project` (Ash, 2026-09-09); every working seat was texted before it sent.
- Outbound: from inside the seat, `lhc-agent lee -` with a one-line message; Lee gets a text from the new number.
- Inbound: Lee texts the number; the connector wraps it as `[from: lee, channel: iMessage]` + the trailer and starts a prioritized turn (mid-turn = steer). The t3code thread gains a turn; the reply comes back to the phone.
- Unknown-sender DMs are dropped before any turn; only Lee's number wakes the seat.
- Alerts: `~/.lhc-console/bin/alert.sh` and deliver-alerts.sh route operator alerts through the agent-control-plane-steward's line, not the seat's.

## Not covered
Dedicated lines, group chats, avatar/profile (all need the Business plan); rotating a leaked number (`photon projects regenerate-secret` for the secret; for the number, a new project and env, no thread loss).
