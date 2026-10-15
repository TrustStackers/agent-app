#!/usr/bin/env node
/**
 * Agent Web Server — entrypoint.
 *
 * Starts the agent web UI on port 24004. The server boots without a specific
 * VTA active — the user selects one on the login page by name + passphrase,
 * which triggers POST /api/activate to unlock and start the selected VTA.
 *
 * Usage:
 *   npm run web
 *   # or with env vars:
 *   AGENT_NAME=alice AGENT_PASSPHRASE=secret npm run web
 *   # or with args:
 *   node --experimental-strip-types --loader ./test-loader.mjs web/server.ts alice secret
 *
 * If no agent name/passphrase is provided, the server starts showing the
 * VTA login screen. No bootstrap agent is created — the user must register
 * and activate a real VTA through the web UI.
 */

import {
  createNodeHost,
  createAgentStack,
  type AgentHandle,
  type Host,
  type TrustStack,
} from '@p2p-trust-stack/app-api/index.js';
import { buildWebServer } from '../src/web-server.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveNamePassphrase(): { name: string; passphrase: string } | null {
  // Prefer command-line args: node agent-app/web/server.ts <name> <passphrase>
  const argv = process.argv.slice(2);
  const name = argv[0] ?? process.env.AGENT_NAME ?? '';
  const passphrase = argv[1] ?? process.env.AGENT_PASSPHRASE ?? '';
  if (name && passphrase) return { name, passphrase };
  return null;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const PORT = parseInt(process.env.AGENT_WEB_PORT ?? '24010', 10);
  const creds = resolveNamePassphrase();

  // Each agent owns its own database under P2PTS_HOME/vta/<agentKey>/ — there
  // is no shared database to open here. An agent's database is opened when it
  // is unlocked and started (POST /api/activate, or the AGENT_NAME bootstrap).
  //
  // NOTE: this file is the COMPOSITION ROOT. It reaches the agent lifecycle through the **`Host` seam**, not
  // through the runtime's factories: the host owns `home` and the per-agent layout, so it is what lists, creates
  // and unlocks agents. `createAgentStack({ adopt })` then adopts the handle this file holds, so there is one
  // active agent rather than two.
  //
  // It used to import `createAgent`/`unlockAgent`/`defaultRegistry` from `trust-app-api/runtime/` — the last VALUE
  // reaches outside the layer, and the reason the `agent-app-facade` ratchet counted three value-import lines.
  const host: Host = createNodeHost();

  // ── Resolve the initial agent ────────────────────────────────────────
  // If credentials are provided via args/env, activate that agent.
  // Otherwise the server starts with no active agent — the login page is shown.
  let agent: AgentHandle | null = null;

  /**
   * The trust-app-api layer the adapter delegates to.
   *
   * It **adopts** the same handle this file owns, so there is one active agent, not two: the adapter keeps its
   * mutable `agent` reference and the stack answers for the same identity. Every place that swaps `agent`
   * below must also call `stack.adopt(...)`.
   */
  let stack: TrustStack | null = null;

  if (creds) {
    // Named agent requested — unlock (or create) it, through the host.
    const existingNames = host.listAgents().map(a => a.name);
    if (existingNames.includes(creds.name)) {
      console.log(`[agent-web] Unlocking agent "${creds.name}"...`);
      agent = await host.unlockAgent({
        name: creds.name,
        passphrase: creds.passphrase,
      });
    } else {
      console.log(`[agent-web] Creating new agent "${creds.name}"...`);
      agent = await host.createAgent({
        name: creds.name,
        passphrase: creds.passphrase,
      });
    }
  } else {
    console.log('[agent-web] No AGENT_NAME set — starting in login-only mode.');
    console.log(
      `[agent-web] Visit http://127.0.0.1:${PORT} to register and activate a VTA.`,
    );
  }

  // ── Start the agent if one was resolved ────────────────────────────
  if (agent) {
    console.log('[agent-web] Starting agent...');
    await agent.start((msg: string) => console.log(`[agent-web] ${msg}`));
    console.log(`[agent-web] Agent: ${agent.getName()} (VID: ${agent.getVid().slice(0, 20)}...)`);
  }

  // ── Build the trust-app-api layer over the agent this file owns ─────────
  // `adopt` keeps one active agent: the stack answers for the same handle the adapter holds, so the two
  // cannot drift. Routes delegated to the layer go through `stack`; everything else still uses `agent`.
  if (agent) {
    stack = await createAgentStack({ adopt: agent });
  }

  // ── Activation callback — unlocks + starts a VTA ───────────────────
  const onActivateAgent = async (
    params: { name: string; passphrase: string },
  ): Promise<{ agent: AgentHandle; stack: TrustStack }> => {
    console.log(`[agent-web] Activating agent "${params.name}"...`);

    // Stop the current agent if one is running
    if (agent) {
      await agent.stop();
    }

    // Unlock the requested agent — through the host, which owns the lifecycle.
    const newAgent = await host.unlockAgent({
      name: params.name,
      passphrase: params.passphrase,
    });

    // Start the new agent
    await newAgent.start((msg: string) => console.log(`[agent-web] ${msg}`));

    // Replace the reference
    agent = newAgent;

    // Keep the layer in step — it must answer for the same identity the adapter now serves.
    if (stack) {
      await stack.adopt(newAgent);
    } else {
      stack = await createAgentStack({ adopt: newAgent });
    }

    console.log(`[agent-web] Agent "${params.name}" activated (VID: ${newAgent.getVid().slice(0, 20)}...)`);

    // ── Auto-discover and connect to utility servers ──────────────────
    // After the agent starts and registers with bootstrap, look for utility_server peers and auto-connect to the
    // first available one.
    //
    // Through the layer: `connectivity.status()` carries the discovered peers and `connectUtility()` is the same
    // operation the runtime's `configureUtilityServer` performed. This block used to call both on the handle.
    try {
      const allPeers = (await stack.connectivity.status()).discoveredPeers;
      console.log(`[agent-web:discovery] total discovered peers: ${allPeers.length}`);
      for (const p of allPeers) {
        console.log(`[agent-web:discovery]   peer ${p.peerId.slice(0, 12)}... type=${p.peerType ?? 'undefined'} vid=${p.vid?.slice(0, 12) ?? 'none'} connected=${p.connected} reachable=${p.reachable} addrs=${p.multiaddrs.length}`);
      }
      const utilityServers = allPeers.filter(p => p.peerType === 'utility_server');
      console.log(`[agent-web:discovery] utility servers found: ${utilityServers.length}`);
      if (utilityServers.length > 0) {
        const us = utilityServers[0];
        const vid = us.vid || us.peerId;
        console.log(`[agent-web:discovery] Auto-connecting to utility server ${us.peerId.slice(0, 12)}... (vid: ${vid.slice(0, 12)}..., addrs: ${us.multiaddrs.join(', ')})`);
        try {
          const { encodeOobi } = await import('@p2p-trust-stack/core/relationship/oobi.js');
          if (!us.did) {
            // Strict 4-item OOBI requires the server's real DID from discovery.
            console.warn(`[agent-web:discovery] utility server ${us.peerId.slice(0, 12)}... has no DID — strict OOBI cannot be built; skipping auto-connect`);
          } else {
            const oobi = encodeOobi({
              cesrVid: vid,
              peerId: us.peerId,
              multiaddrs: us.multiaddrs,
              did: us.did,
            });
            await stack.connectivity.connectUtility(oobi);
            console.log(`[agent-web:discovery] ✓ Auto-connected to utility server via bootstrap discovery`);
          }
        } catch (err) {
          console.warn(`[agent-web:discovery] Auto-connect to utility server failed: ${(err as Error)?.message ?? err}`);
        }
      } else {
        console.log('[agent-web:discovery] No utility servers discovered via bootstrap. Name registration will be unavailable until a utility server connects.');
      }
    } catch (err) {
      // A transport that cannot configure a utility server at all (or a failed status read) must not stop
      // activation — the agent is already up, which is what the caller asked for.
      console.warn(`[agent-web:discovery] Discovery skipped: ${(err as Error)?.message ?? err}`);
    }

    // Hand BOTH back: the adapter stores the handle on `deps.agent` and the layer on `deps.stack`, so
    // every delegated route answers through the same identity this callback just activated. Returning
    // only the handle is what left `deps.stack` undefined in login-only mode and bounced the dashboard.
    return { agent: newAgent, stack };
  };

  // ── Deactivation callback — stops the agent and returns to login ────
  const onDeactivateAgent = async (): Promise<void> => {
    if (agent) {
      console.log(`[agent-web] Deactivating agent "${agent.getName()}"...`);
      await agent.stop();
      agent = null;
      console.log('[agent-web] Agent deactivated. Returning to login screen.');
    }
  };

  // ── Build and start the Fastify web server ───────────────────────────
  const app = await buildWebServer({
    agent,
    host,
    stack: stack ?? undefined,
    onActivateAgent,
    onDeactivateAgent,
  });

  try {
    await app.listen({ port: PORT, host: '127.0.0.1' });
    console.log(`[agent-web] Web UI listening on http://127.0.0.1:${PORT}`);
    if (agent) {
      console.log(`[agent-web] Agent: ${agent.getName()} (VID: ${agent.getVid().slice(0, 20)}...)`);
    } else {
      console.log('[agent-web] No agent active — login screen ready.');
    }
  } catch (err: unknown) {
    const msg = (err as Error)?.message ?? String(err);
    if (msg.includes('EADDRINUSE')) {
      console.error(`[agent-web] Port ${PORT} is already in use. Set AGENT_WEB_PORT to override.`);
      process.exit(1);
    }
    throw err;
  }

  // ── Graceful shutdown ────────────────────────────────────────────────
  //
  // Ctrl-C used to leave the process running because `app.close()` never
  // resolved: the browser holds an open SSE stream on `/api/events`, and Fastify
  // only reaps *idle* connections by default. `buildWebServer` now sets
  // `forceCloseConnections: true`, so the SSE socket is destroyed and
  // `app.close()` returns. The guards below make the handler robust against the
  // *second* failure mode: a stalled `agent.stop()` (libp2p teardown) must never
  // keep the process alive once the HTTP server is down.
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return; // a second Ctrl-C must not re-run the teardown
    shuttingDown = true;
    console.log('\n[agent-web] Shutting down...');

    // Safety net: if the agent teardown hangs, exit anyway. `unref()` so this
    // timer alone never keeps the event loop alive on the normal path.
    const hardExit = setTimeout(() => {
      console.warn('[agent-web] Shutdown timed out — forcing exit.');
      process.exit(0);
    }, 5000);
    hardExit.unref();

    try { await app.close(); } catch { /* ignore */ }
    if (agent) {
      try { await agent.stop(); } catch { /* ignore */ }
    }
    clearTimeout(hardExit);
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch(err => {
  console.error('[agent-web] Fatal error:', err);
  process.exit(1);
});