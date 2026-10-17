// SPDX-License-Identifier: GPL-3.0-only OR LicenseRef-TrustStackers-Commercial
// Copyright (C) 2026 Trust Stackers

import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';

import type { AgentHandle, Host, TrustStack, CredentialViewFilters } from '@p2p-trust-stack/app-api/index.js';
import { createSseHub, bridgeEventsToSse } from './sse-bridge.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WEB_DIR = join(__dirname, '..', 'web');

/** Helper: return true when an agent is active (not null). */
function hasAgent(agent: AgentHandle | null): agent is AgentHandle {
  return agent !== null;
}

/**
 * Layer-aware "utility server unavailable" message for routes that need it.
 *
 * Replaces the context-free "Utility server unavailable." text with one that
 * names WHICH layer failed (bootstrap unreachable / connection lost and still
 * reconnecting / relay session being refreshed) and states that the work is
 * queued and will be retried — so a user can tell "wait a moment" from
 * "something is actually wrong".
 *
 * Falls back to the generic wording when the active agent implementation does
 * not expose live connectivity status (e.g. a test stub).
 */
async function utilityServerUnavailable(deps: WebServerDeps, operation: string): Promise<string> {
  // Through the layer, not around it: `connectivity.explainFailure()` reads the live view and words it. This used
  // to read `deps.agent.getConnectivityStatus()` directly (one of 21 reaches no ratchet could see) AND import
  // `describeConnectivityFailure` from `src/` to turn the result into a sentence — a presentation decision the
  // adapter had no business making.
  //
  // No try/catch: `explainFailure` is itself an error-path helper that never throws and falls back to the generic
  // wording. The only remaining branch is "no layer configured", which is a different condition and gets the
  // same wording.
  if (!deps.stack) return `Utility server unavailable. Cannot ${operation} right now.`;
  return deps.stack.connectivity.explainFailure(operation);
}

/**
 * What the entrypoint hands back when it activates an agent: the handle AND the
 * `trust-app-api` layer built around it.
 *
 * The two must travel together. The server boots in login-only mode with no agent,
 * so the entrypoint has no stack to hand `buildWebServer` at construction time and
 * creates one lazily on the first activation. Returning only the handle is what used
 * to leave `deps.agent` set while `deps.stack` stayed undefined — every delegated
 * route then answered "trust-app-api layer not configured" and the dashboard bounced
 * straight back to the login screen. See `onActivateAgent`.
 */
export interface ActivatedAgent {
  agent: AgentHandle;
  stack: TrustStack;
}

export interface WebServerDeps {
  agent: AgentHandle | null;
  // NOTE: there is deliberately no `api` dep. `WebServerDeps.api` held an `AgentApi` — the facade this refactor
  // replaces — and it was passed by every caller yet read by NOTHING (`grep 'deps\.api'` found zero uses). It is
  // the same shape as the `db` and `libp2pNode` deps that went earlier: a typed contract advertising a
  // capability the adapter had already stopped needing. Removed 2026-10-09, which is what let `agent-app/api/`
  // be deleted outright.
  /**
   * The host this adapter provisions agents through.
   *
   * The per-agent layout — directory, database, keystore, migrations — is the host's knowledge, so the adapter
   * asks for it rather than reconstructing it. It used to hold an `AgentRegistry` and an `AgentDatabase`
   * directly: three path calls plus a constructed database, purely to create an agent. Those are now
   * `host.provisionStorage()`.
   */
  host: Host;
  /**
   * The `trust-app-api` layer this adapter delegates to.
   *
   * When present, the delegated routes call one domain method instead of reaching into agent internals or
   * running raw SQL. Optional so the adapter still builds without a layer (and so a route that needs it can
   * say so loudly rather than silently taking a second code path).
   */
  stack?: TrustStack;
  // NOTE: there is deliberately no `db` dep and no `libp2pNode` dep.
  //
  // `libp2pNode` went in P3 rest: `/api/relationships/:id/debug` reached into the raw node through it
  // (`deps.libp2pNode as any`), which became `AgentHandle.getPeerConnections()`. `db` went in the same slice's
  // follow-up: it was the fallback raw `DatabaseSync` handle for the routes that ran `.prepare(...)` inline, and
  // once the last of those (the VIC-accept `UPDATE`) moved behind `credentials.acceptInvitation()` nothing read
  // it — `grep 'deps\.db'` found no call site and no caller ever passed it.
  //
  // Both were a typed contract advertising a capability that no longer existed. Removing them is what makes R5
  // checkable: there is now no way for this file to reach a raw database handle or a raw libp2p node at all.
  /**
   * Callback invoked after a new agent is activated via POST /api/activate.
   * The entrypoint (web/server.ts) uses this to swap the active agent handle
   * and restart the libp2p node for the selected VTA.
   *
   * It returns BOTH the handle and the `trust-app-api` layer the entrypoint built
   * around it (see {@link ActivatedAgent}); the route stores both on `deps`. The
   * layer has to come back with the handle because the entrypoint owns the
   * lifecycle and may only have created the stack during this very call.
   */
  onActivateAgent?: (params: { name: string; passphrase: string }) => Promise<ActivatedAgent>;
  /**
   * Callback invoked on POST /api/logout to stop the active agent and
   * return the user to the VTA selection screen.
   */
  onDeactivateAgent?: () => Promise<void>;
}

export async function buildWebServer(deps: WebServerDeps) {
  // `forceCloseConnections: true` is what makes Ctrl-C actually work.
  //
  // `GET /api/events` is a Server-Sent-Events stream: it writes the headers and
  // then never ends the response, so a browser tab running the dashboard or chat
  // page holds one connection open for the life of the tab. On Node ≥ 18.2
  // Fastify's `forceCloseConnections` default resolves to `'idle'`, which on
  // close only calls `server.closeIdleConnections()` — and an SSE response is NOT
  // idle, because it is still in flight. The SSE socket therefore survives, the
  // subsequent `server.close()` waits for every connection to end, and
  // `await app.close()` never resolves. That is what left the process (and its
  // libp2p node) running after SIGINT: the entrypoint's `process.exit(0)` sits
  // *after* `app.close()`, so it was never reached.
  //
  // With `true`, Fastify calls `server.closeAllConnections()` on close, which
  // destroys the SSE socket (and every other live connection) so `app.close()`
  // resolves promptly and the entrypoint can exit.
  const app = Fastify({ logger: false, forceCloseConnections: true });

  // Serve static files from the web/ directory
  await app.register(fastifyStatic, {
    root: WEB_DIR,
    prefix: '/',
    setHeaders(res, path) {
      // Never cache the HTML pages — a stale dashboard.html hides deployed
      // UI changes until a manual hard refresh. Assets are tiny; freshness wins.
      if (path.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-store');
      }
    },
  });

  const { host } = deps;

  // NOTE: the raw-DB plumbing that used to live here (`getDbHandle()` + `getActiveDb()`) is GONE as of
  // 2026-10-09. It existed so route handlers could run `DatabaseSync.prepare(...)` directly against the active
  // agent's file; every one of those statements now lives behind a domain, so the adapter no longer needs a
  // handle at all. Deleting it is what makes R5's "zero `.prepare(` above the layer" checkable by grep rather
  // than by reading — there is no longer a way to reach a raw handle from this file.

  // ── Per-peer, in-memory chat transcripts ──────────────────────────────
  // Each chat session is a list of text entries keyed by the peer's DID; every
  // entry records the authoring agent's login name, the time, and the text.
  // This lives in PROCESS MEMORY only — nothing is written to SQLite or disk,
  // so POST /api/logout (and an agent switch via POST /api/activate) drops every
  // session: an agent logout loses all chat history, by design.
  // Serve cytoscape.js from node_modules (npm dependency, not CDN)
  const cyDistPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'node_modules', 'cytoscape', 'dist', 'cytoscape.min.js');
  const cyContent = readFileSync(cyDistPath, 'utf-8');
  app.get('/lib/cytoscape.min.js', async (_req, reply) => {
    return reply.type('application/javascript').send(cyContent);
  });

  // IMPORTANT: All route handlers read deps.agent (not a destructured copy)
  // so they always see the current VTA after POST /api/activate swaps it.
  // When deps.agent is null, routes that require an active agent return 401.

  // ── Health ───────────────────────────────────────────────────────────
  app.get('/api/health', async () => {
    // `active` reflects THIS adapter's view — the same condition every other route gates its 401 on. It is
    // deliberately NOT read from `identity.current()`: a stack can hold an agent this adapter was never handed
    // (the adapter-test harness does exactly that), and reporting that as active would contradict the 401s.
    // The name and vid come from the layer.
    const active = hasAgent(deps.agent);
    const id: { name?: string; vid?: string } = active && deps.stack
      ? await deps.stack.identity.current()
      : {};
    return {
      status: 'ok',
      service: 'agent-web',
      time: new Date().toISOString(),
      agent: active
        ? { name: id.name, vid: (id.vid ?? '').slice(0, 20) + '...', active: true }
        : { active: false },
    };
  });

  app.post('/api/sign', async (req, reply) => {
    if (!hasAgent(deps.agent)) {
      return reply.code(401).send({ error: 'No active VTA — log in first.' });
    }
    const { message } = req.body as { message?: string };
    if (!message) {
      return reply.code(400).send({ error: 'message is required' });
    }
    try {
      // `identity.sign()` is the same operation the adapter used to reach for on the handle. It stays a
      // root-key operation: it is DENIED to capability-scoped contexts (`scope.ts`), so this route is the only
      // way to reach it and only the host's own adapter can.
      const { signature } = await requireStack().identity.sign(message);
      return reply.code(200).send({ signature });
    } catch (err) {
      return reply.code(500).send({ error: (err as Error).message });
    }
  });

  // ── Readiness check — verifies agent + transport + relationship store ──
  // The chat page polls this before calling loadPeers() so it doesn't flash
  // "Error loading peers" while the agent is still starting up.
  app.get('/api/ready', async (_req, reply) => {
    if (!hasAgent(deps.agent)) {
      return reply.code(503).send({ ready: false, reason: 'no active VTA — log in first' });
    }
    // Delegated to `stack.connectivity.ready()`, which owns the chat-eligibility rule (organization
    // relationships are infrastructure, not chat) and reports not-ready as a value rather than an error.
    const ready = await requireStack().connectivity.ready();
    if (!ready.ready) {
      return reply.code(503).send(ready);
    }
    return ready;
  });

  // ── Identity ─────────────────────────────────────────────────────────
  app.get('/api/identity', async (_req, reply) => {
    if (!hasAgent(deps.agent)) {
      return { active: false };
    }
    // Delegated to `stack.identity.current()`: it resolves the identity row through `identities-repo` rather
    // than the inline `SELECT ... JOIN` this route used to run, and it fills `meta.subjectKind` (which the
    // runtime's AgentMeta does not carry, so the UI's Human/AI icon had always read `undefined`).
    try {
      return await requireStack().identity.current();
    } catch (err: any) {
      return reply.code(500).send({ error: { message: err?.message ?? 'identity read failed' } });
    }
  });

  // ── Agent activation (VTA login) ─────────────────────────────────────
  app.post('/api/activate', async (req, reply) => {
    const { name, passphrase } = req.body as { name?: string; passphrase?: string };
    if (!name || !passphrase) {
      return reply.code(400).send({ error: { message: 'name and passphrase are required' } });
    }
    if (!deps.onActivateAgent) {
      return reply.code(501).send({ error: { message: 'Agent activation not supported in this deployment mode' } });
    }
    try {
      const { agent: newAgent, stack: newStack } = await deps.onActivateAgent({ name, passphrase });
      // Swap the active agent AND the layer so all subsequent handlers use the new VTA. Both must be
      // replaced together: `requireStack()` reads `deps.stack`, and in login-only mode the entrypoint
      // created that stack lazily during this call, so this is the only place it reaches the adapter.
      deps.agent = newAgent;
      deps.stack = newStack;
      // Re-bridge the bus onto the SSE stream for the newly activated agent.
      refreshSseBridge();
      return reply.code(200).send({
        ok: true,
        agent: {
          name: newAgent.getName(),
          vid: newAgent.getVid(),
          did: newAgent.getDid(),
        },
      });
    } catch (err: any) {
      return reply.code(401).send({ error: { message: err.message } });
    }
  });

  // ── Logout (deactivate agent, return to login) ─────────────────────
  app.post('/api/logout', async (_req, reply) => {
    if (deps.onDeactivateAgent) {
      await deps.onDeactivateAgent();
      deps.agent = null;
    }
    return reply.code(200).send({ ok: true });
  });

  // ── Agents (multi-VTA management) ────────────────────────────────────
  app.get('/api/agents', async (_req, reply) => {
    // Delegated to `stack.identity.list()`, which resolves each agent's id/subjectKind/custody from that
    // agent's OWN database. This route used to query the ACTIVE agent's database for every summary, so the
    // fields were only ever right for the active agent.
    try {
      return await requireStack().identity.list();
    } catch (err: any) {
      return reply.code(500).send({ error: { message: err?.message ?? 'agent listing failed' } });
    }
  });

  // Create a new VTA agent with did:scid:vh identity + encrypted keys.
  app.post('/api/agents', async (req, reply) => {
    const { name, subjectKind, passphrase } = req.body as { name?: string; subjectKind?: string; passphrase?: string };
    if (!name || !passphrase) {
      return reply.code(400).send({ error: { message: 'name and passphrase are required' } });
    }
    if (passphrase.length < 8) {
      return reply.code(400).send({ error: { message: 'passphrase must be at least 8 characters' } });
    }
    // A newly-created VTA has no running libp2p node yet, so it has no real
    // peerId. Do NOT reuse the active agent's peerId here: peer_endpoints.peer_id
    // is UNIQUE and its guarded write refuses to assign an endpoint already
    // active on another identity, which would leave the new VTA bound to the
    // wrong (or no) endpoint — the exact multi-VTA hazard. The new VTA records
    // its own endpoint when it starts (BaseAgent.start() → updatePeerId).
    const peerId = undefined;
    const nodeId = undefined;
    try {
      const { createVta } = await import('@p2p-trust-stack/core/services/vta.js');
      // The new VTA owns its own directory + database + keystore. Open it via
      // AgentDatabase FIRST so the P2PTS schema is created (migrations) before
      // createVta writes the identity — a bare SqliteDataSource would have no
      // tables and fail with "no such table: identities".
      // The host owns the per-agent layout: it creates the directory, applies the P2PTS schema, and hands back
      // an open DataSource plus the keystore path `createVta` needs. Doing this here used to mean reaching the
      // registry for three paths and constructing an `AgentDatabase` for its migration side effect.
      const provisioned = await host.provisionStorage(name);
      const newAgentDs = provisioned.dataSource;
      try {
        const result = await createVta(newAgentDs, {
          name,
          subjectKind: (subjectKind as any) ?? 'human',
          passphrase,
          peerId,
          nodeId,
          keystorePath: provisioned.keystorePath,
        });
        return reply.code(201).send(result);
      } finally {
        await newAgentDs.close();
      }
    } catch (err: any) {
      if (err.name === 'CreateVtaValidationError') {
        return reply.code(400).send({ error: { message: err.message } });
      }
      return reply.code(500).send({ error: { message: err.message } });
    }
  });

  // Import an existing VTA from its 24-word seed phrase — "claim" a VTA that was
  // created during utility-server setup. Reconstructs the deterministic
  // did:scid:vh identity from the seed and registers it locally (custody='local').
  app.post('/api/agents/import', async (req, reply) => {
    const { name, mnemonic, passphrase } = req.body as { name?: string; mnemonic?: string; passphrase?: string };
    if (!name || !mnemonic || !passphrase) {
      return reply.code(400).send({ error: { message: 'name, mnemonic and passphrase are required' } });
    }
    if (passphrase.length < 8) {
      return reply.code(400).send({ error: { message: 'passphrase must be at least 8 characters' } });
    }
    // Same rule as POST /api/agents: a freshly-imported VTA has no live node yet,
    // so do not bind it to the active agent's peerId. Endpoint is recorded on start.
    const peerId = undefined;
    const nodeId = undefined;
    try {
      const { importSeedPhrase } = await import('@p2p-trust-stack/core/crypto/seed-phrase.js');
      const { generateEd25519KeyPairFromSeed } = await import('@p2p-trust-stack/core/crypto/primitives.js');
      const signingKeyPair = await importSeedPhrase(mnemonic, async (seed) => generateEd25519KeyPairFromSeed(seed));
      const identitySeed = signingKeyPair.secretKey.slice(0, 32);

      const { createVta } = await import('@p2p-trust-stack/core/services/vta.js');
      // Same host-owned provisioning as the create route: directory, migrated schema, and the keystore path the
      // new identity's keypair is written to.
      const provisioned = await host.provisionStorage(name);
      const newAgentDs = provisioned.dataSource;
      try {
        const result = await createVta(newAgentDs, {
          name,
          subjectKind: 'human',
          passphrase,
          peerId,
          nodeId,
          keystorePath: provisioned.keystorePath,
          identitySeed,
        });
        return reply.code(201).send(result);
      } finally {
        await newAgentDs.close();
      }
    } catch (err: any) {
      return reply.code(400).send({ error: { message: err.message } });
    }
  });

  // ── Profiles ─────────────────────────────────────────────────────────
  // Delegated to `stack.profiles` — the domain projects ProfileRow/ProfileClaimRow onto DTOs, so the
  // response no longer carries replication bookkeeping or a claim's commitment `salt`.
  app.get('/api/profiles', async (_req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    return requireStack().profiles.list();
  });

  // R-Card sync health — surfaces the agent-side pending/retry state so the
  // UI can show "profile changes not yet synced to the utility server".
  app.get('/api/profiles/sync-status', async (_req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    return requireStack().profiles.syncStatus();
  });

  app.post('/api/profiles', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { label, purpose, visibility } = req.body as any;
    return requireStack().profiles.create({ label, purpose, visibility });
  });

  // ── Profiles ─────────────────────────────────────────────────────────
  // Every `:uuid` here is a profile uuid (or, on the `claims` routes, a claim uuid). The paths were `:id` and
  // `:claimId` until 2026-10-10 — the values were already uuids, so this is a naming correction, not a
  // behaviour change: uuid is the trust stack's identifier standard and no route parameter should read as
  // though a numeric id were possible.
  app.put('/api/profiles/:uuid', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { uuid } = req.params as any;
    const { label, purpose, visibility, setDefault } = req.body as any;
    return requireStack().profiles.update(String(uuid), { label, purpose, visibility, setDefault });
  });

  app.delete('/api/profiles/:uuid', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { uuid } = req.params as any;
    return requireStack().profiles.remove(String(uuid));
  });

  app.get('/api/profiles/:uuid/claims', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { uuid } = req.params as any;
    return requireStack().profiles.claims(String(uuid));
  });

  app.post('/api/profiles/:uuid/claims', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { uuid } = req.params as any;
    const { claimKey, claimValue, disclosure } = req.body as any;
    return requireStack().profiles.addClaim({
      profileUuid: String(uuid),
      claimKey,
      claimValue,
      disclosure,
    });
  });

  app.put('/api/profiles/claims/:uuid', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { uuid } = req.params as any;
    const { claimValue, disclosure } = req.body as any;
    return requireStack().profiles.updateClaim(String(uuid), { claimValue, disclosure });
  });

  app.delete('/api/profiles/claims/:uuid', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { uuid } = req.params as any;
    return requireStack().profiles.removeClaim(String(uuid));
  });

  app.get('/api/profiles/:uuid/card', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { uuid } = req.params as any;
    const { keys } = req.query as any;
    const requestedKeys = keys ? String(keys).split(',') : [];
    return requireStack().profiles.card(String(uuid), requestedKeys);
  });

  // ── Relationships ────────────────────────────────────────────────────
  // Relationships are only shown for chat between 'human' subjects. The
  // utility server connection is tagged subject_kind='organization' — it is
  // infrastructure (protocol messages), not a chat peer, so it is filtered
  // out of the chat-facing relationship list.
  app.get('/api/relationships', async (_req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });

    // Delegated to `stack.relationships.list()`, which owns the chat-eligibility filtering (organization and
    // self-referencing rows), the ceremony-ack enrichment, and peer display-name resolution.
    const rels = await requireStack().relationships.list();

    // The one-shot duplicate-connect notice, read through the layer. `duplicate.connect.notice` PUSHES it; this
    // is the catch-up read, which is what surfaces a notice that arrived while the page was closed. It used to
    // reach `deps.agent.getDuplicateConnectNotice()` directly.
    //
    // `Promise.all` rather than a loop: each read is independent, and the notice is consumed on read, so the
    // order they resolve in does not matter.
    const notices = await Promise.all(
      rels.map((r) => requireStack().relationships.duplicateNotice(r.remoteDid).catch(() => null)),
    );
    return rels.map((r, i) => {
      const notice = notices[i];
      return notice ? { ...r, notice } : r;
    });
  });

  // ── Trust Graph (DTG) — Cytoscape-ready graph data ────────────────────
  // Delegated to `stack.relationships.graph()`. The UUID-canonicalization pass that used to live here (and the
  // three rendering rules it feeds: ephemeral-peer4 collapsing, VRC pair-collapse, peer-edge suppression) moved
  // with it to `trust-app-api/domains/relationships-graph.ts`. The response shape is unchanged.
  app.get('/api/graph', async (_req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    return requireStack().relationships.graph();
  });

  app.get('/api/relationships/:remoteVid', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { remoteVid: remoteDid } = req.params as any;
    const record = await requireStack().relationships.get(remoteDid);
    return record ?? { notFound: true };
  });

  // ── Debug: relationship health ────────────────────────────────────────
  // ── Debug: relationship health ────────────────────────────────────────
  // Delegated to `stack.relationships.debug()`. The libp2p reach this route used to do (`deps.libp2pNode as
  // any`) is now the declared `AgentHandle.getPeerConnections()`, so the layer never touches the raw node.
  app.get('/api/relationships/:remoteVid/debug', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { remoteVid: remoteDid } = req.params as any;
    const debug = await requireStack().relationships.debug(String(remoteDid));
    if (!debug) return reply.code(404).send({ notFound: true });
    return debug;
  });

  // ── Notification bridge: the event bus is the ONLY source of SSE pushes ─────
  // The bus→wire translation lives in `sse-bridge.ts`; the hub it pushes through is created here so
  // `GET /api/events` and the bridge share one connection set.
  const sseHub = createSseHub();
  let disposeSseBridge: () => void = () => {};

  /**
   * (Re)bridge the bus onto the SSE stream for the CURRENTLY active agent.
   *
   * Called at startup and each time `POST /api/activate` swaps `deps.agent`. The dispose call is what makes a
   * swap safe: without it the previous agent's subscriptions would stay attached and push into the same stream.
   */
  function refreshSseBridge(): void {
    disposeSseBridge();
    disposeSseBridge = bridgeEventsToSse({ hub: sseHub, stack: deps.stack });
  }
  refreshSseBridge();


  app.post('/api/messages/:remoteVid', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { remoteVid: remoteDid } = req.params as any;
    const { body } = req.body as any;
    const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
    console.log(`[web-server:send] → POST /api/messages/${String(remoteDid).slice(0,12)}... body="${String(body).slice(0,80)}"`);

    // Delegated to `stack.messaging.send()`, which performs the same pre-flight readiness check and records
    // the local half of the conversation — in the DURABLE transcript, so it survives a logout.
    try {
      await requireStack().messaging.send(String(remoteDid), bodyText);
    } catch (err: any) {
      // A not-ready peer is a 400 with the reason; anything else is a genuine failure.
      const code = err?.code === 'not_ready' ? 400 : 500;
      console.log(`[web-server:send] ✗ blocked: ${err?.message}`);
      return reply.code(code).send({ error: { message: err?.message } });
    }
    console.log(`[web-server:send] ✓ sent to ${String(remoteDid).slice(0,12)}...`);
    return { ok: true };
  });

  // ── Confidential message send ─────────────────────────────────────────
  app.post('/api/messages/:remoteVid/confidential', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { remoteVid: remoteDid } = req.params as any;
    const { body } = req.body as any;
    const bodyText = typeof body === 'string' ? body : JSON.stringify(body);
    console.log(`[web-server:send] → POST /api/messages/${String(remoteDid).slice(0,12)}.../confidential`);
    try {
      await requireStack().messaging.send(String(remoteDid), bodyText, { confidential: true });
    } catch (err: any) {
      const code = err?.code === 'not_ready' ? 400 : 500;
      return reply.code(code).send({ error: { message: err?.message } });
    }
    return { ok: true };
  });

  // ── SSE event stream for real-time chat ──────────────────────────────
  // `sseHub` (declared with the bridge above) owns the client set and the write path.

  app.get('/api/events', async (req, reply) => {
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const client = {
      write: (data: string) => reply.raw.write(data),
      end: () => reply.raw.end(),
    };
    sseHub.add(client);
    // Log connect/disconnect with the running total. This is the ONE place a browser's SSE stream becomes
    // visible in the server log, and it is what makes a connection leak diagnosable: a count that only ever
    // rises means a page is holding a stream it should have released. Without it a stalled page is silent,
    // because the requests that stall never leave the browser (they are queued behind a full connection pool).
    console.log(`[web-server:sse] + stream opened (${sseHub.clientCount()} open)`);

    // Send initial connection event
    client.write(`event: connected\ndata: {"time":${Date.now()}}\n\n`);

    // Heartbeat every 15 seconds
    const heartbeat = setInterval(() => {
      try { client.write(`: heartbeat\n\n`); } catch { clearInterval(heartbeat); }
    }, 15000);

    req.raw.on('close', () => {
      clearInterval(heartbeat);
      sseHub.remove(client);
      console.log(`[web-server:sse] - stream closed (${sseHub.clientCount()} open)`);
    });
  });


  // GET /api/messages/:remoteVid/inbox — the peer's transcript from a cursor.
  //
  // The response shape CHANGED here: it used to be `{ messages, now }` read from the in-memory ring, and it is
  // now the transcript DTO. Nothing consumed it — `grep` over `agent-app/web/` finds no caller — so this is a
  // dead-endpoint shape correction rather than a breaking change, and the durable transcript is the only
  // sensible source for it.
  app.get('/api/messages/:remoteVid/inbox', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { remoteVid: remoteDid } = req.params as any;
    const since = parseInt((req.query as any).since ?? '0', 10);
    return requireStack().messaging.transcript(String(remoteDid), { since });
  });

  // ── Global unread count (for cross-page notification badges) ─────────
  app.get('/api/messages/unread', async (req, _reply) => {
    if (!hasAgent(deps.agent)) return { unread: 0 };
    const since = parseInt((req.query as any).since ?? '0', 10);
    // Delegated to `stack.messaging.unread()`, which reads the durable transcript rather than the in-memory
    // ring. The `since` semantics are unchanged — `nav.js` sends the time the page loaded — so the badge
    // behaves exactly as before, but it now counts real persisted messages.
    const { unread, senders, latestReceivedAt } = await requireStack().messaging.unread({ since });
    return { unread, senders, latestReceivedAt };
  });

  // ── Chat transcript (DURABLE, per peer) ───────────────────────────────
  // The chat UI replays one peer's session at a time; switching peers in the dropdown re-reads this
  // transcript. Entries are keyed by the peer's DID and each records the authoring agent's login name, the
  // time, and the text — now persisted, so a logout or an agent switch no longer drops the conversation.
  //
  // The response shape is unchanged from the in-memory version (`peerVid`, `peerName`, `localName`,
  // `entries`), with `cursor` added; the entry `time` values now come from `agent_messages.occurred_at`, and
  // the notification bridge uses the SAME entry, which is what preserves the DOM-id de-duplication the old
  // code arranged between the transcript and the SSE push.
  app.get('/api/chat/:remoteVid/log', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { remoteVid: remoteDid } = req.params as any;
    return requireStack().messaging.transcript(String(remoteDid));
  });

  // POST /api/chat/:remoteVid/clear — drop ONE peer's transcript. Other peers are untouched.
  app.post('/api/chat/:remoteVid/clear', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { remoteVid: remoteDid } = req.params as any;
    const result = await requireStack().messaging.clear(String(remoteDid));
    console.log(`[web-server:chat] cleared ${result.cleared} entr(ies) for ${String(remoteDid).slice(0, 12)}...`);
    return result;
  });

  // ── VTC / VRC ─────────────────────────────────────────────────────────
  app.get('/api/vtcs', async (_req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    // Delegated to `stack.communities.governanceDocs()`. This route used to return
    // `deps.agent.listVtcGovernanceDocs()` — the raw signed documents, including `adminVids` (CESR public keys),
    // the `digest` and the founding `signatures`. None of that belongs on a wire, and the only consumer used
    // none of it. The projection also supplies `kind`, which the page read as `role` — a field that has never
    // existed on a governance doc, so every VTN rendered as "VTC".
    return requireStack().communities.governanceDocs();
  });

  // GET /api/vtcs/check-name?name=... — pre-flight name availability
  app.get('/api/vtcs/check-name', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const name = (req.query as any)?.name;
    if (!name || !name.trim()) {
      return reply.code(400).send({ available: false, message: 'name is required' });
    }
    try {
      return reply.code(200).send(await requireStack().communities.checkName(name));
    } catch (err) {
      // `utility_server_unavailable` is the retryable transport condition → 503 with the layer-aware reason.
      // Anything else is the server answering badly, which is a 502.
      if ((err as { code?: string })?.code === 'utility_server_unavailable') {
        return reply.code(503).send({ available: false, error: await utilityServerUnavailable(deps, 'check name availability') });
      }
      console.error('[web] name check failed:', (err as Error)?.message ?? err);
      return reply.code(502).send({ available: false, error: (err as Error)?.message ?? 'Name check failed.' });
    }
  });

  // Delegated to `stack.communities` — the read model is the runtime's own list projection.
  app.get('/api/communities', async (_req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    // Community records are delivered by the utility server's queued push
    // (exchange:vtc-membership) — no local re-pull needed before listing.
    return reply.code(200).send(await requireStack().communities.list());
  });

  // Parent-VTN picker source for the create-community page.
  //
  // The namespace VTN is a SERVER-side identity, and an agent only receives records for
  // communities it is a MEMBER of — so an agent that joined a VTC but not the namespace
  // VTN has no local VTN row, and the picker offered only "None — standalone VTC"
  // (the server nevertheless accepts `parentCommunityUuid` and wires the affiliation).
  // `stack.communities.parents()` merges the server's answer with whatever this agent
  // knows locally, and degrades to the local list when the server is offline.
  app.get('/api/parent-vtns', async (_req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    return reply.code(200).send(await requireStack().communities.parents());
  });

  // ── Community detail (members + governance) for detail view ─────────────
  // Delegated to `stack.communities.detail()`. It replaced three inline raw-SQL statements — a three-table
  // join for the community, a roster join, and a policy-binding scan — with repository reads.
  app.get('/api/community-detail', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const did = (req.query as any).did;
    if (!did) return reply.code(400).send({ error: { message: 'did query parameter required' } });
    try {
      return reply.code(200).send(await requireStack().communities.detail(did));
    } catch (err) {
      if ((err as { code?: string })?.code === 'community_not_found') {
        return reply.code(404).send({ error: { message: 'community not found' } });
      }
      throw err;
    }
  });

  // ── Invite a member to a community (server-mediated VIC mint) ────────
  // Sends a `vtc_invite` query to the utility server, which resolves the
  // community signing key and mints a signed InvitationCredential (VIC) +
  // the shareable OOBI invite. The agent never needs the community private key
  // (Model A custody).
  app.post('/api/communities/:did/invite', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const did = (req.params as any).did;
    const body = (req.body ?? {}) as { subjectDid?: string; subjectName?: string; subjectIdentityUuid?: string; taskContext?: string };
    if (!did) return reply.code(400).send({ error: { message: 'community did param is required' } });

    try {
      return reply.code(200).send(await requireStack().communities.invite(did, body));
    } catch (err) {
      const code = (err as { code?: string })?.code;
      // An unresolvable community is the caller's problem, not the server's.
      if (code === 'community_not_found') {
        return reply.code(404).send({ error: { message: 'community not found' } });
      }
      // A missing server link is retryable (503, with the layer-aware reason); anything else is the server
      // refusing the invitation, which keeps the server's own message (502).
      if (code === 'utility_server_unavailable') {
        return reply.code(503).send({ error: { message: await utilityServerUnavailable(deps, 'send an invitation') } });
      }
      return reply.code(502).send({ error: { message: (err as Error).message } });
    }
  });

  // ── Governance-change proposals (Phase B — Rules UI) ────────────────────────
  // A community rule/threshold change needs multi-admin consent. The utility server
  // owns the proposal lifecycle (scope resolution, hashing, durable fan-out to every
  // required approver, crystallization); the agent proposes, lists what it may approve,
  // and co-signs.

  // Delegated to `stack.communities` — the governance routes are thin wrappers over typed handle members.
  app.get('/api/governance/proposals', async (_req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    return reply.code(200).send(await requireStack().communities.governanceProposals());
  });

  app.post('/api/governance/propose', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { communityUuid, change, scope, minApprovals } = (req.body ?? {}) as {
      communityUuid?: string;
      change?: unknown;
      scope?: 'admins' | 'members' | 'all_members';
      minApprovals?: number;
    };
    if (!communityUuid || !change) {
      return reply.code(400).send({ error: { message: 'communityUuid and change are required' } });
    }
    try {
      const result = await requireStack().communities.propose({ communityUuid, change, scope, minApprovals });
      return reply.code(result.success ? 200 : 502).send(result);
    } catch (err) {
      if ((err as { code?: string })?.code === 'not_supported') {
        return reply.code(501).send({ error: { message: 'Governance changes are not supported in this deployment mode' } });
      }
      throw err;
    }
  });

  app.post('/api/governance/proposals/:uuid/approve', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const uuid = (req.params as { uuid?: string }).uuid;
    if (!uuid) return reply.code(400).send({ error: { message: 'proposal uuid is required' } });
    try {
      const result = await requireStack().communities.approve(uuid);
      return reply.code(result.success ? 200 : 502).send(result);
    } catch (err) {
      if ((err as { code?: string })?.code === 'not_supported') {
        return reply.code(501).send({ error: { message: 'Governance changes are not supported in this deployment mode' } });
      }
      throw err;
    }
  });

  // ── Admin candidates (VRC-filtered checklist for VTC creation) ──────
  // Agent-local only. The agent SQLite is the source of truth: co-admin
  // candidates are the deliverable HUMAN VRC peers resolved by
  // getVrcConnectedPeers(). The utility server is contacted only to import VRC
  // credentials into the local store (enrichment); its own candidate entries
  // are never added to the checklist, because it cannot vouch for the agent's
  // local deliverability (relationship transport / Ed25519 key) that the
  // create ceremony strictly requires.
  app.get('/api/admin-candidates', async (_req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    return reply.code(200).send(await requireStack().communities.adminCandidates());
  });

  // ── Ceremony task log (read) ───────────────────────────────────────────────
  // What the utility server's ceremonies actually did, step by step, in plain
  // language. The AGENT is where communities are created and managed, so the log is
  // read here (over TSP) and rendered in the Communities page — the utility server
  // does not carry a second copy of this view.
  //
  // The read degrades to an empty list rather than throwing when the server is down, so a page still renders.
  app.get('/api/ceremony-log', async (_req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    try {
      return reply.code(200).send({ threads: await requireStack().communities.ceremonyLog() });
    } catch (err) {
      return reply.code(502).send({ error: { message: (err as Error)?.message ?? String(err) } });
    }
  });

  app.get('/api/ceremony-log/:threadId', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const threadId = (req.params as { threadId?: string })?.threadId;
    if (!threadId) return reply.code(400).send({ error: { message: 'threadId (param) is required' } });
    try {
      return reply.code(200).send({
        threadId,
        steps: await requireStack().communities.ceremonyLogThread(threadId),
      });
    } catch (err) {
      return reply.code(502).send({ error: { message: (err as Error)?.message ?? String(err) } });
    }
  });

  // ── Pending ceremony approvals (co-founder co-signing) ────────────────────
  // When a community's approver threshold (M) is > 1, the creator's single
  // approval is not enough; each additional founding admin lists the pending
  // ceremony here and signs it. Approvals are real Ed25519 signatures.

  app.get('/api/ceremonies/pending', async (_req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    try {
      const rows = await requireStack().communities.pendingCeremonies();
      return reply.code(200).send({ ceremonies: rows });
    } catch (err) {
      return reply.code(500).send({ error: { message: (err as Error)?.message ?? String(err) } });
    }
  });

  app.post('/api/ceremonies/:uuid/approve', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const uuid = (req.params as { uuid?: string })?.uuid;
    if (!uuid) return reply.code(400).send({ error: { message: 'ceremony uuid (param) is required' } });
    // A MUTATION: `stack.communities.approveCeremony` co-signs with this identity's Ed25519 key and submits
    // through the 2PC coordinator. It must never be routed through the bare query seam.
    const result = await requireStack().communities.approveCeremony(uuid);
    if (!result?.success) {
      return reply.code(400).send({ error: { message: result?.error ?? 'approval failed' } });
    }
    return reply.code(200).send(result);
  });

  app.post('/api/vtcs', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });

    const { name, threshold, adminUuids, parentCommunityUuid } = req.body as any;
    if (!Array.isArray(adminUuids) || adminUuids.length < 1) {
      return reply.code(400).send({ error: { message: 'adminUuids (selected founding-admin UUIDs) is required' } });
    }

    // The creator is always a founding admin; `stack.communities.create` resolves this agent's own uuid from
    // the local store, so the adapter no longer reaches for the database to do it.
    try {
      console.log(`[web:vtc] initiating VTC creation via tx coordinator: '${name}' (admins=${adminUuids.length}, parentVTN=${parentCommunityUuid ?? 'none'})`);

      // The founding ceremony runs through the transaction coordinator: the agent's
      // createCommunityCeremony() sends ceremony_begin + ceremony_approve, which the server's
      // CeremonyCoordinatorParticipant crystallizes via the catalogued vtc-establish ceremony.
      const result = await requireStack().communities.create({
        name,
        kind: 'vtc',
        threshold: threshold ?? 1,
        adminUuids,
        parentCommunityUuid: parentCommunityUuid || undefined,
      });

      if (!result?.success) {
        return reply.code(400).send({ error: { message: result?.error ?? 'VTC creation failed' } });
      }

      // No local caching step here. It used to read `result.vtcData` and hand it to `upsertRemoteVtc`, but
      // `createCommunityCeremony` has never returned a `vtcData` field — the branch was unreachable, so the
      // cache was never written. The community record arrives through the utility server's queued push
      // (`exchange:vtc-membership`), which is what makes it available to `/api/communities` anyway.

      return reply.code(201).send(result);
    } catch (err) {
      console.error('[web:vtc] creation failed:', (err as Error)?.message ?? err);
      return reply.code(400).send({ error: { message: (err as Error)?.message ?? String(err) } });
    }
  });

  // ── Ceremony query & reset (agent-facing ceremony lifecycle) ─────────
  // GET /api/ceremony/:id — query the status of a VTC founding ceremony
  app.get('/api/ceremony/:uuid', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const uuid = (req.params as any)?.uuid;
    if (!uuid) return reply.code(400).send({ error: { message: 'ceremony uuid required' } });
    try {
      const result = await requireStack().communities.ceremony(uuid);
      if (result?.error) return reply.code(502).send({ error: { message: result.error } });
      return reply.code(200).send(result);
    } catch (err) {
      return reply.code(400).send({ error: { message: (err as Error)?.message ?? String(err) } });
    }
  });

  // POST /api/ceremony/:uuid/reset — reset a failed/expired ceremony for retry
  app.post('/api/ceremony/:uuid/reset', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const uuid = (req.params as any)?.uuid;
    if (!uuid) return reply.code(400).send({ error: { message: 'ceremony uuid required' } });
    try {
      const result = await requireStack().communities.resetCeremony(uuid);
      if (!result?.success) return reply.code(502).send({ error: { message: result?.error || 'Reset failed' } });
      return reply.code(200).send(result);
    } catch (err) {
      return reply.code(400).send({ error: { message: (err as Error)?.message ?? String(err) } });
    }
  });

  // ── Invitations (received VICs) ──────────────────────────────────────────
  // A signed InvitationCredential (VIC) delivered to this agent's local
  // `credentials` table (via the server's `credential` queue) IS the
  // notification. These endpoints surface pending invitations and act on them.
  //
  // Both delegate to `stack.credentials`: the membership cross-check and the VIC status change are domain
  // concerns, and `declineInvitation` announces `invitation.changed` so the nav badge can stop polling.
  app.get('/api/invitations', async (_req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    try {
      return await requireStack().credentials.invitations();
    } catch (err: any) {
      return reply.code(500).send({ error: { message: err.message } });
    }
  });

  app.post('/api/invitations/:uuid/accept', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const uuid = (req.params as any).uuid;
    try {
      // Delegated to `stack.credentials.acceptInvitation()`. This route is why `queryUtilityServer` exists — it
      // used to assemble its own participant transport out of the agent's private transaction state, and its
      // last local piece was the `UPDATE` marking the VIC spent.
      return await requireStack().credentials.acceptInvitation(String(uuid));
    } catch (err) {
      const code = (err as { code?: string })?.code;
      // `utility_server_unavailable` is retryable and gets the layer-aware reason; a missing or unusable
      // invitation is 404/400. Anything else is a genuine failure and keeps the route's original 400.
      if (code === 'utility_server_unavailable') {
        return reply.code(503).send({ error: { message: await utilityServerUnavailable(deps, 'accept the invitation') } });
      }
      if (code === 'not_found') {
        return reply.code(404).send({ error: { message: (err as Error).message } });
      }
      return reply.code(400).send({ error: { message: (err as Error).message } });
    }
  });

  app.post('/api/invitations/:uuid/decline', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const uuid = (req.params as any).uuid;
    try {
      return await requireStack().credentials.declineInvitation(String(uuid));
    } catch (err: any) {
      return reply.code(500).send({ error: { message: err.message } });
    }
  });

  // ── VRC list ────────────────────────────────────────────────────────────
  // RESTORED (2026-10-08). This route's body had been overwritten with the `/api/vrcs/:id/verify` body — it
  // read `req.params.id` on a path that declares no `:id`, so it answered `400 id must be an integer` to every
  // request. The duplicated auth check and the orphaned "Include VTC-store VRCs" comment were the fingerprints
  // of that paste; the verify body it displaced was itself deleted from the adapter in the same commit, and it
  // addressed VRCs by a numeric `id` that `listVrcsForSelf()` never returns (see `domains/credentials.ts`).
  //
  // The list behaviour is restored, now via `stack.credentials.list()` — which reads both stores through their
  // repositories instead of the JOIN this route used to run inline.
  app.get('/api/vrcs', async (_req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    try {
      return await requireStack().credentials.list();
    } catch (err: any) {
      return reply.code(500).send({ error: { message: err.message } });
    }
  });

  // ── VRC issue ───────────────────────────────────────────────────────────
  // RESTORED (2026-10-09) — the route `domains/credentials.ts` documents as deleted in `86eb1e8`. It is a
  // CONTRACT CHANGE (74 → 75 routes), not a port: the deleted version took `{ vtcVid, subjectVid, claim,
  // signers: [{ vid, signingKeyPair }] }`, which would have required the page to hold admin private keys.
  //
  // The contract settled on instead: the caller names the community by DID and the claim, and the RUNTIME signs
  // with the active identity's own keypair (`issueVrcForSelf`). No key material crosses this boundary, which is
  // what lets `scope.ts` keep denying `identity.sign` to app contexts.
  //
  // Refusals are typed and reported with their code, because `claim_not_allowed` and `unknown_subject` are both
  // 400s and the page has to tell them apart to say which rule was hit.
  app.post('/api/vrcs', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const body = (req.body ?? {}) as {
      vtcDid?: unknown;
      subjectVid?: unknown;
      claim?: { type?: unknown };
      expiresAt?: unknown;
    };
    try {
      return await requireStack().credentials.issue({
        vtcDid: typeof body.vtcDid === 'string' ? body.vtcDid : '',
        ...(typeof body.subjectVid === 'string' && body.subjectVid ? { subjectVid: body.subjectVid } : {}),
        claim: {
          ...(body.claim && typeof body.claim === 'object' ? body.claim : {}),
          type: typeof body.claim?.type === 'string' ? body.claim.type : '',
        },
        ...(body.expiresAt !== undefined ? { expiresAt: Number(body.expiresAt) } : {}),
      });
    } catch (err: any) {
      const code = err?.code as string | undefined;
      if (code === 'not_implemented') return reply.code(501).send({ error: { code, message: err.message } });
      if (code === 'not_found') return reply.code(404).send({ error: { code, message: err.message } });
      if (code === 'not_admin') return reply.code(403).send({ error: { code, message: err.message } });
      if (code === 'threshold_not_met') return reply.code(409).send({ error: { code, message: err.message } });
      if (code === 'invalid_input' || code === 'claim_not_allowed' || code === 'unknown_subject') {
        return reply.code(400).send({ error: { code, message: err.message } });
      }
      return reply.code(500).send({ error: { message: err.message } });
    }
  });

  // ── VRC verify ──────────────────────────────────────────────────────────
  // NEW (2026-10-09) — CONTRACT CHANGE (75 → 76 routes). The route it replaces, `POST /api/vrcs/:id/verify`,
  // addressed a VRC by a numeric `id` that `listVrcsForSelf()` never returned, so its lookup could never match;
  // it was deleted in `86eb1e8` and its body pasted over `GET /api/vrcs` on the way out.
  //
  // Addressed by the VTC store's own composite key instead. Neither candidate identity works for this: a rowid
  // is node-local (the DTO doc calls it an unstable identity), and a `VtcCredentialDto` has no UUID at all —
  // while `(subjectVid, issuerVid, claimType)` is exactly what `VtcStore.getVrc` keys on and what `GET /api/vrcs`
  // can already supply for every credential it lists.
  //
  // A verification that could not be ATTEMPTED is reported as 404, not as `valid: false`: "I cannot check this"
  // and "this did not check out" are different answers, and only the second is evidence against a credential.
  app.post('/api/vrcs/verify', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const body = (req.body ?? {}) as { subjectVid?: unknown; issuerVid?: unknown; claimType?: unknown };
    try {
      return await requireStack().credentials.verify({
        subjectVid: typeof body.subjectVid === 'string' ? body.subjectVid : '',
        issuerVid: typeof body.issuerVid === 'string' ? body.issuerVid : '',
        claimType: typeof body.claimType === 'string' ? body.claimType : '',
      });
    } catch (err: any) {
      const code = err?.code as string | undefined;
      if (code === 'not_found') return reply.code(404).send({ error: { code, message: err.message } });
      if (code === 'invalid_input') return reply.code(400).send({ error: { code, message: err.message } });
      return reply.code(500).send({ error: { message: err.message } });
    }
  });

  // Addressed by credential UUID — the trust stack's identifier standard. These two routes took a numeric rowid
  // until 2026-10-10, which no DTO published; see `credentials.revoke()`'s interface note.
  app.get('/api/vrcs/:uuid/signatures', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const uuid = String((req.params as any).uuid ?? '').trim();
    if (!uuid) return reply.code(400).send({ error: { message: 'uuid is required' } });
    try {
      const rows = await requireStack().credentials.signatures(uuid);
      if (!rows) return reply.code(404).send({ error: { message: `credential ${uuid} not found` } });
      return rows;
    } catch (err: any) {
      return reply.code(500).send({ error: { message: err.message } });
    }
  });

  app.post('/api/vrcs/:uuid/revoke', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const uuid = String((req.params as any).uuid ?? '').trim();
    if (!uuid) return reply.code(400).send({ error: { message: 'uuid is required' } });
    try {
      const revoked = await requireStack().credentials.revoke(uuid);
      if (!revoked) return reply.code(404).send({ error: { message: `credential ${uuid} not found` } });
      return revoked;
    } catch (err: any) {
      return reply.code(500).send({ error: { message: err.message } });
    }
  });

  // ── Credential Factory View Models ──────────────────────────────────────
  // Delegated to `stack.credentials.viewModels()`, which reads the same factory but owns the grouping and the
  // issue-form introspection. The query string is passed through as-is; the domain types it.
  app.get('/api/credentials', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    try {
      const query = req.query as { scenario?: string; kind?: string; status?: string };
      // Typed by the LAYER's filter contract, not by `src/`'s factory types — the adapter talks to `trust-app-api`.
      const filters: CredentialViewFilters = {
        ...(query.kind ? { kind: query.kind as CredentialViewFilters['kind'] } : {}),
        ...(query.scenario ? { scenario: query.scenario as CredentialViewFilters['scenario'] } : {}),
        ...(query.status ? { status: query.status as CredentialViewFilters['status'] } : {}),
      };
      return await requireStack().credentials.viewModels(filters);
    } catch (err: any) {
      return reply.code(500).send({ error: { message: err.message } });
    }
  });

  // ── Personhood Ceremony ────────────────────────────────────────────────
  app.post('/api/relationships/:remoteVid/acknowledge', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { remoteVid: remoteDid } = req.params as any;
    if (!remoteDid) return reply.code(400).send({ error: { message: 'remoteDid is required' } });
    try {
      return reply.code(200).send(await requireStack().relationships.acknowledge(remoteDid));
    } catch (err: any) {
      return reply.code(500).send({ error: { message: err.message } });
    }
  });

  // POST /api/relationships/:remoteVid/ceremony/reset — tear down a pending
  // personhood ceremony (session + relationship) so a fresh OOBI exchange +
  // connect can be attempted. Mirrors the 60s ack-deadline reset.
  app.post('/api/relationships/:remoteVid/ceremony/reset', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { remoteVid: remoteDid } = req.params as any;
    if (!remoteDid) return reply.code(400).send({ error: { message: 'remoteDid is required' } });
    try {
      const result = await requireStack().relationships.resetCeremony(remoteDid);
      if (!result.success) return reply.code(502).send({ error: { message: result.error || 'Reset failed' } });
      return reply.code(200).send(result);
    } catch (err: any) {
      return reply.code(500).send({ error: { message: err.message } });
    }
  });

  app.get('/api/relationships/:remoteVid/ceremony-status', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { remoteVid: remoteDid } = req.params as any;
    return requireStack().relationships.ceremonyStatus(remoteDid);
  });

  // ── Verified Channel ─────────────────────────────────────────────────
  app.post('/api/relationships/:remoteVid/verify', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { remoteVid: remoteDid } = req.params as any;
    if (!remoteDid) return reply.code(400).send({ error: { message: 'remoteDid is required' } });
    try {
      // Delegated: the domain resolves the local identity uuid through `identities-repo` rather than the
      // inline SELECT ... JOIN this route used to run, and it opens its own DataSource.
      return reply.code(200).send(await requireStack().relationships.verify(remoteDid));
    } catch (err: any) {
      return reply.code(500).send({ error: { message: err.message } });
    }
  });

  app.get('/api/relationships/:remoteVid/vrc', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { remoteVid: remoteDid } = req.params as any;
    if (!remoteDid) return reply.code(400).send({ error: { message: 'remoteDid is required' } });
    try {
      return await requireStack().relationships.vrc(remoteDid);
    } catch (err: any) {
      return reply.code(500).send({ error: { message: err.message } });
    }
  });

  // ── DTG RelationshipCredential status ────────────────────────────────
  app.get('/api/relationships/:remoteVid/dtg-vrc', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { remoteVid: remoteDid } = req.params as any;
    if (!remoteDid) return reply.code(400).send({ error: { message: 'remoteDid is required' } });
    try {
      // Delegated: both identity uuids come from `identities-repo` on the agent's own database, instead of the
      // two inline SELECT ... JOIN statements this route used to run through getActiveDb().
      return await requireStack().relationships.dtgVrc(remoteDid);
    } catch (err: any) {
      return reply.code(500).send({ error: { message: err.message } });
    }
  });

  // ── Connect (OOBI paste) ────────────────────────────────────────────
  app.post('/api/connect', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { oobi } = req.body as { oobi?: string };
    if (!oobi) {
      return reply.code(400).send({ error: { message: 'oobi is required' } });
    }
    try {
      const cleaned = oobi.replace(/\s+/g, '');
      if (!cleaned) {
        return reply.code(400).send({ error: { message: 'invalid OOBI' } });
      }
      await requireStack().relationships.connect(cleaned);
      console.log(`[web-server:connect] OK — RFI initiated for ${cleaned.slice(0, 16)}...`);
      return reply.code(200).send({ ok: true, message: 'Connection initiated' });
    } catch (err: any) {
      // Re-pasting an OOBI for an already-verified relationship is refused with
      // 409 Conflict + a machine-readable code so the web UI can surface an
      // acknowledgment-required modal and stay in the pre-paste state.
      //
      // Detected by the stable `code` property ALONE. It used to also test
      // `err instanceof RelationshipAlreadyExistsError`, with a comment claiming the pair guarded against
      // module duplication — but `code` is a plain string property and survives duplication, while
      // `instanceof` is exactly what duplication breaks. So the extra test was the fragile half, and it was
      // the last thing keeping a `src/` import in this file.
      const isRelationshipExists = err?.code === 'RELATIONSHIP_EXISTS';
      if (isRelationshipExists) {
        console.log(`[web-server:connect] Refusing duplicate OOBI connect (409 RELATIONSHIP_EXISTS): ${err?.message}`);
        return reply.code(err?.statusCode ?? 409).send({
          error: {
            message: err?.message ?? 'You already have a relationship with this peer.',
            code: 'RELATIONSHIP_EXISTS',
          },
        });
      }
      console.error(`[web-server:connect] Connect failed (500): ${err?.message ?? String(err)}`);
      return reply.code(500).send({ error: { message: err?.message ?? String(err) } });
    }
  });

  // ── Bootstrap ─────────────────────────────────────────────────────────
  app.get('/api/bootstrap/status', async (_req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    // `connected` reports only the bootstrap CONTROL connection. It is NOT "everything is fine": a peer can be
    // connected to the bootstrap server while its relay session is about to expire or while the utility-server
    // connection is down. `connectivity` is the live, layer-aware view that features gate on.
    //
    // This body used to hand-roll the whole shape out of five `deps.agent` reaches; `connectivity.status()`
    // returns exactly this DTO, so the route is now a pass-through and the derivation lives in one place.
    return requireStack().connectivity.status();
  });

  app.post('/api/bootstrap/refresh', async (_req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    return requireStack().connectivity.refresh();
  });

  // ── OOBI ─────────────────────────────────────────────────────────────
  app.get('/api/oobi', async (_req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    return requireStack().relationships.oobi();
  });

  // ── Name Registration ────────────────────────────────────────────────
  // Delegated to `stack.names` — one domain call per route, no agent internals.
  function requireStack(): TrustStack {
    if (!deps.stack) {
      throw new Error('trust-app-api layer not configured (WebServerDeps.stack)');
    }
    return deps.stack;
  }

  app.post('/api/names/register', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { name, namespace, profileUuid } = req.body as { name?: string; namespace?: string; profileUuid?: string };
    if (!name || !namespace) {
      return reply.code(400).send({ error: { message: 'name and namespace are required' } });
    }
    try {
      return await requireStack().names.register({ name, namespace, profileUuid });
    } catch (err: any) {
      return reply.code(500).send({ error: { message: err.message } });
    }
  });

  app.get('/api/names/resolve', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { nameUri } = req.query as { nameUri?: string };
    if (!nameUri) {
      return reply.code(400).send({ error: { message: 'nameUri query parameter is required' } });
    }
    try {
      const result = await requireStack().names.resolve(String(nameUri));
      if (!result) return { notFound: true };
      return {
        peerId: result.peerId,
        did: result.did,
        multiaddrs: result.multiaddrs,
        rCard: result.rCard ?? undefined,
      };
    } catch (err: any) {
      return reply.code(500).send({ error: { message: err.message } });
    }
  });

  app.post('/api/names/revoke', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { name, namespace } = req.body as { name?: string; namespace?: string };
    if (!name || !namespace) {
      return reply.code(400).send({ error: { message: 'name and namespace are required' } });
    }
    try {
      return await requireStack().names.revoke({ name, namespace });
    } catch (err: any) {
      return reply.code(500).send({ error: { message: err.message } });
    }
  });

  app.get('/api/names', async (_req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    try {
      return await requireStack().names.list();
    } catch (err: any) {
      return reply.code(500).send({ error: { message: err.message } });
    }
  });

  // ── Recovery (Phase H) ───────────────────────────────────────────────
  app.get('/api/recovery/state', async (_req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    try {
      // `identity.recoveryState()` owns the connected-check and throws a typed `utility_server_unavailable`
      // when the server is unreachable — which this route maps back to its original 503, so the wire behaviour
      // is unchanged and the reach is gone.
      const state = await requireStack().identity.recoveryState();
      if (!state) return reply.code(404).send({ notFound: true });
      return state;
    } catch (err: any) {
      if (err?.code === 'utility_server_unavailable') {
        return reply.code(503).send({ error: 'Utility server not connected.' });
      }
      return reply.code(500).send({ error: err?.message ?? 'Unknown error' });
    }
  });

  app.get('/api/recovery/lookup', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { did } = req.query as any;
    if (!did) return reply.code(400).send({ error: 'Missing "did" query parameter' });
    try {
      return await requireStack().identity.lookup(String(did));
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? 'Unknown error' });
    }
  });

  app.post('/api/utility-server/connect', async (req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    const { utilityServerOobi } = req.body as any;
    if (!utilityServerOobi) return reply.code(400).send({ error: 'Missing "utilityServerOobi"' });
    try {
      return await requireStack().connectivity.connectUtility(String(utilityServerOobi));
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? 'Unknown error' });
    }
  });

  app.get('/api/utility-server/status', async (_req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    // `connectivity.utilityStatus()` returns exactly this shape — `{ connected, did, vid }`, including the
    // deprecated `vid` alias — so the route is a pass-through and the two reaches go.
    return requireStack().connectivity.utilityStatus();
  });

  app.post('/api/utility-server/push-identity', async (_req, reply) => {
    if (!hasAgent(deps.agent)) return reply.code(401).send({ error: { message: 'No active VTA' } });
    try {
      // `connectivity.pushIdentity()` already reports the "queued but unacknowledged" case with
      // `{ ok: false, pending: true, error }` — which is what the hand-rolled `getProfileSyncStatus()` fallback
      // here was reconstructing.
      return await requireStack().connectivity.pushIdentity();
    } catch (err: any) {
      return reply.code(500).send({ error: err?.message ?? 'Unknown error' });
    }
  });

  return app;
}

export { WEB_DIR };