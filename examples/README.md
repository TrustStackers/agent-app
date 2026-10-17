# Examples — Apache-2.0

Everything in this directory is licensed **Apache-2.0** (see [`LICENSE`](./LICENSE)),
**not** under the repository's GPL-3.0-only + commercial dual license.

That split is deliberate. The rest of this repository is a full reference
application: it is useful to read, run and modify, but nobody copies a 34-file
TUI + web app into their product. The handful of short patterns that developers
*do* copy live here, under a permissive license, so you can paste them into a
proprietary codebase without thinking about copyleft.

## What is here

| File | Shows |
|---|---|
| [`boot-agent.ts`](./boot-agent.ts) | `createAgentStack` → subscribe → `start()` → `stop()`, plus the OOBI handshake entry point |

## The patterns worth taking

**Subscribe before you start.** `createAgentStack()` creates or unlocks the agent
but does not start the runtime. Every event you subscribe to before `start()`
arrives; anything you miss is only available via replay.

**One stack per agent handle.** If you host the agent lifecycle yourself, create
it with the `Host` seam and pass `{ adopt: handle }` to `createAgentStack` so the
stack answers for the same handle you hold. Two handles for one agent drift.

**Pin `home` when you embed.** `createAgentStack` defaults to `P2PTS_HOME` and
then to a platform directory. A process hosting more than one stack must pass
`home` explicitly, because the environment variable is process-wide.

**On mobile, set `P2PTS_HOME` before importing the stack.** Importing
`@p2p-trust-stack/app-api` has a module-level side effect (it builds a default
agent registry and creates the home directory). On Android the platform default
is not writable, so import dynamically *after* setting the variable. See the
`agent-app-mobile` repository for a working example.

## License boundary, in one line

Apache-2.0 covers the files in this directory. `@p2p-trust-stack/core` and
`@p2p-trust-stack/app-api` remain `GPL-3.0-only OR LicenseRef-TrustStackers-Commercial`,
so a distributed product built on them still needs to satisfy GPL-3.0 or hold a
commercial license. Apache-2.0 snippets do not change that.

See [`../NOTICE`](../NOTICE) and [`../COMMERCIAL-LICENSE.md`](../COMMERCIAL-LICENSE.md).
