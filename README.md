# lhc-console

One place to find, inspect, and manage long-horizon-context (LHC) threads across
every host on this machine — cc-lhc, pi-lhc, codex-lhc, t3code-lhc, and future
hosts (grok, hermes). A Fastify REST API backed by console-owned read operations
over the hosts' SQLite files, with an HTML/TypeScript front end.

The console opens host registries and thread files directly (always read-only)
and does not depend on the `lhc` SDK. Its operations live in
`packages/core` so they can later be broken out into a standalone sdk/cli.

## Layout

| Path            | What                                                                               |
| --------------- | ---------------------------------------------------------------------------------- |
| `packages/core` | Host discovery, registry reads, thread-file reads (`node:sqlite`, read-only)       |
| `apps/server`   | Fastify REST API (`/api/hosts`, `/api/threads`, thread detail/turns/messages/view) |
| `apps/web`      | Vite front end — thread finder, turn/message navigation                            |

## Development

Two processes (Vite proxies `/api` to the server):

```bash
vp run dev:server   # Fastify on 127.0.0.1:5959 (LHC_CONSOLE_PORT to change)
vp run dev          # Vite dev server for apps/web
```

Checks and tests:

```bash
vp check            # format, lint, typecheck
vp run -r test
```

## API sketch

- `GET /api/hosts` — discovered hosts + thread counts
- `GET /api/threads?host=&cwd=&q=` — aggregated cross-host listing with quick stats (mtime-cached)
- `GET /api/threads/:hostId/:threadId` — overview: counts, message kinds, derivation states, view bands, visibility boundary
- `GET /api/threads/:hostId/:threadId/turns` — turn listing with prompt excerpts
- `GET /api/threads/:hostId/:threadId/messages?turn=&from=&to=&limit=&cap=` — messages with decoded blocks
- `GET /api/threads/:hostId/:threadId/view` — stored compact bands (rendered text)

Thread ids accept unique prefixes (e.g. `th_a485`).

## Roadmap

1. **Finder** (done, first pass) — cross-host list, filter/search, thread drill-down
2. **Navigator/visualizations** — band ribbons, token mass over time, chunk maps, lineage/fork graphs
3. **Search** — content search across threads (FTS index in a console-owned cache DB)
4. **Actions** — relaunch helpers, then edit/prune/smart-compact (via the LHC SDK, which owns mutation invariants)
