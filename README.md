# agent-app — P2P Trust Stack reference agent

A reference **agent application** for the P2P Trust Stack: a terminal UI and a
browser UI over the same agent runtime. It creates and manages self-certifying
identities (VTAs), exchanges OOBI handshakes, chats over the Trust Spanning
Protocol (TSP), manages profiles, issues and verifies credentials, and runs
VTC/VRC ceremonies.

It is the companion to the published packages
[`@p2p-trust-stack/core`](https://www.npmjs.com/package/@p2p-trust-stack/core)
and [`@p2p-trust-stack/app-api`](https://www.npmjs.com/package/@p2p-trust-stack/app-api).
**Read it, run it, fork it** — it is a demonstration of how to build on the SDK,
not a supported product.

> **Status.** Reference implementation. Pre-1.0, not independently audited, no
> SLA or support commitment, provided "AS IS". See [`SECURITY.md`](./SECURITY.md).

## Requirements

- **Node.js ≥ 22.5** — the stack uses the built-in `node:sqlite`.
- No build step in development: TypeScript runs directly via
  `--experimental-strip-types`. `npm run typecheck` uses `tsc --noEmit`.

## Quick start

```bash
npm ci                 # reproducible install from the committed lockfile
npm run tui            # terminal UI
npm run web            # browser UI on http://127.0.0.1:24010
```

Target a specific agent directly:

```bash
AGENT_NAME=alice AGENT_PASSPHRASE=my-secret npm run web
AGENT_WEB_PORT=8080 npm run web          # override the default port (24010)
```

With no `AGENT_NAME`, the web server starts in login-only mode and shows the
agent picker. Agents are created on first use and live in their own directory
under `P2PTS_HOME/vta/<agent>/` — each with its own database, keystore and
transaction coordinator. There is no shared database.

### Pointing the agent at a bootstrap node

Out of the box the agent runs in LAN-only mode. To register with a bootstrap /
relay server, generate the `BOOTSTRAP_*` block in `.env`:

```bash
cp .env.example .env
npm run init:bootstrap -- --host <dns-or-ip> --tcp-port 4001 --ws-port 4002
```

The values must match the bootstrap server's own `.env`. See
[`.env.example`](./.env.example) for the full list.

## What it demonstrates

| Pattern | Where |
|---|---|
| Composition root: `createNodeHost()` → `createAgentStack({ adopt })` | `web/server.ts` |
| Subscribe-before-`start()` event wiring | `web/server.ts`, `tui/app.ts` |
| Server-Sent Events bridge from the agent event bus to a browser UI | `src/sse-bridge.ts` |
| A Fastify host serving a static UI over the agent API | `src/web-server.ts` |
| Terminal UI with per-screen capability scoping | `tui/screens/` |
| Agent picker, login and passphrase handling | `tui/screens/auth.ts`, `tui/screens/agent-picker.ts` |

Short, copy-pasteable versions of the most useful patterns live in
[`examples/`](./examples) under **Apache-2.0** — see
[`examples/README.md`](./examples/README.md).

## Layout

```
src/
  sse-bridge.ts        # agent event bus -> Server-Sent Events
  web-server.ts        # Fastify server + REST surface over the agent API
tui/
  app.ts               # Blessed screen setup and orchestration
  screens/             # dashboard, chat, connect, credentials, profiles, ...
web/
  *.html               # the browser UI
  assets/              # client JS + CSS (talks to /api and /events)
examples/              # Apache-2.0 recipes (NOT under the repo's dual license)
scripts/               # bootstrap env generation, SPDX + license gates
```

## Relationship to the SDK

The agent programs against **`@p2p-trust-stack/app-api` only**. The single
exception is an OOBI helper imported from `@p2p-trust-stack/core`, which is a
documented, narrow reach. Everything the UI does goes through the typed
`TrustStack` surface — `identity`, `connectivity`, `relationships`, `messaging`,
`credentials`, `communities`, `names`, `profiles`, `contexts`, `delegations` —
plus the event bus.

## License

**Dual-licensed:**

- **GPL-3.0-only** — see [`LICENSE`](./LICENSE); or
- a **commercial license** for use cases where GPL-3.0 obligations are not
  acceptable — see [`COMMERCIAL-LICENSE.md`](./COMMERCIAL-LICENSE.md).

[`NOTICE`](./NOTICE) declares the `LicenseRef-TrustStackers-Commercial`
reference and lists third-party attribution; [`TRADEMARK.md`](./TRADEMARK.md)
covers the marks ("Trust Stackers", "P2P Trust Stack"), which no license grants.

**The `examples/` directory is Apache-2.0** (see [`examples/LICENSE`](./examples/LICENSE)).
Everything else is under the dual license above.

All contributions require the [CLA](./CLA.md) — see [CONTRIBUTING.md](./CONTRIBUTING.md).
