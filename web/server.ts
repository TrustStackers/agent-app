#!/usr/bin/env node

// SPDX-License-Identifier: GPL-3.0-only OR LicenseRef-TrustStackers-Commercial
// Copyright (C) 2026 Trust Stackers

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
 *   node --experimental-strip-types --loader ../../test-loader.mjs agent-app/web/server.ts alice secret
 *
 * If no agent name/passphrase is provided, the server starts showing the
 * VTA login screen. No bootstrap agent is created — the user must register
 * and activate a real VTA through the web UI.
 */

import {
  createNodeHost,
  createAgentStack,
  createBootstrapConfigApi,
  createLoggingConfigApi,
  type AgentHandle,
  type BootstrapConfigView,
  type Host,
  type TrustStack,
} from '@p2p-trust-stack/app-api/index.js';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWebServer } from '../src/web-server.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Where this component's bootstrap setting comes from.
 *
 * A CLIENT: the agent holds no seed, only the address and the peer ID to expect.
 * The precedence chain and the persistence rule live behind the layer in
 * `bootstrap-config.ts`, so the TUI reads and writes exactly the same thing.
 */
const bootstrapConfig = createBootstrapConfigApi({
  // `agent-app/.env` — one level up from `web/`.
  envPath: join(__dirname, '..', '.env'),
  onPersist: (message) => console.log(`[agent-web] ${message}`),
});

/**
 * Where this component's LOG VERBOSITY comes from.
 *
 * The same `.env` the bootstrap block lives in, so the npm script needs no
 * `P2PTS_LOG_LEVEL=info` prefix — that POSIX-only syntax is exactly what broke
 * `npm start` under PowerShell. `apply()` cannot throw, so an absent `.env` (a
 * LAN-only first run) simply leaves logging at its default.
 */
const loggingConfig = createLoggingConfigApi({
  envPath: join(__dirname, '..', '.env'),
  onApply: (message) => console.log(`[agent-web] ${message}`),
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Pre-fill values for the startup screen's bootstrap boxes.
 *
  * Reports WHERE the value came from (the persisted override, or the `.env`), so
 * the UI can say "default" vs "you set this". Never throws — the login screen has
 * to render even when nothing is configured.
 */
function bootstrapConfigView(): BootstrapConfigView {
  return bootstrapConfig.view();
}

/**
 * Persist the startup screen's bootstrap boxes, but ONLY when they differ from
 * this component's `.env` — the `.env` stays the machine default, and
 * `P2PTS_HOME/config.yaml` records a deliberate override.
 */
function persistBootstrapOverride(bootstrapHost?: string, bootstrapPeerId?: string): void {
  bootstrapConfig.recordOverride(bootstrapHost, bootstrapPeerId);
}

/** Remember the VTN this machine joined, so the next launch registers under it. */
function persistVtn(vtnKey: string): void {
  bootstrapConfig.recordVtn(vtnKey);
}

/**
 * The VTN this machine last joined, or undefined.
 *
 * Used to register under the right network from first contact on a restart. It
 * is deliberately undefined rather than defaulted when nothing is recorded: an
 * agent that has not chosen a VTN sends no `net` at all, instead of claiming
 * another network's key.
 */
function lastJoinedVtn(): string | undefined {
  return bootstrapConfig.lastVtn();
}

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
  // Verbosity first, so every later line is gated by the configured level.
  loggingConfig.apply();

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
    // The persisted/`.env` bootstrap target and the VTN this machine last joined,
    // so a restart re-registers under the same network from first contact.
    const bootstrapEnv = bootstrapConfig.resolve();
    const lastVtn = bootstrapConfig.lastVtn();
    if (existingNames.includes(creds.name)) {
      console.log(`[agent-web] Unlocking agent "${creds.name}"...`);
      agent = await host.unlockAgent({
        name: creds.name,
        passphrase: creds.passphrase,
        ...(bootstrapEnv ? { bootstrapEnv } : {}),
        ...(lastVtn ? { net: lastVtn } : {}),
      });
    } else {
      console.log(`[agent-web] Creating new agent "${creds.name}"...`);
      agent = await host.createAgent({
        name: creds.name,
        passphrase: creds.passphrase,
        ...(bootstrapEnv ? { bootstrapEnv } : {}),
        ...(lastVtn ? { net: lastVtn } : {}),
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
    params: {
      name: string;
      passphrase: string;
      bootstrapHost?: string;
      bootstrapPeerId?: string;
    },
  ): Promise<{ agent: AgentHandle; stack: TrustStack }> => {
    console.log(`[agent-web] Activating agent "${params.name}"...`);

    // Stop the current agent if one is running
    if (agent) {
      await agent.stop();
    }

    // The bootstrap boxes travel with activation. Record a value the user CHANGED
    // (so it survives a restart) — accepting the `.env` default records nothing.
    persistBootstrapOverride(params.bootstrapHost, params.bootstrapPeerId);

    // Resolve the effective target: a freshly typed value wins over the stored
    // one, which wins over `.env`. Empty everywhere = LAN-only mode.
    const bootstrapEnv = bootstrapConfig.resolve();

    // Unlock the requested agent — through the host, which owns the lifecycle.
    const newAgent = await host.unlockAgent({
      name: params.name,
      passphrase: params.passphrase,
      ...(bootstrapEnv ? { bootstrapEnv } : {}),
      // Re-register under the VTN this machine last joined. Absent on a first
      // run, in which case the agent sends NO `net` rather than a guessed one —
      // the login screen's VTN picker sets it.
      ...(lastJoinedVtn() ? { net: lastJoinedVtn()! } : {}),
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

    // ── Report the VTNs available to join ─────────────────────────────
    //
    // The agent has now registered with the bootstrap, so the peer directory is
    // populated. This does NOT auto-connect: several utility servers can share one
    // bootstrap, each serving its own VTN, so the user picks the network from the
    // login screen (`GET /api/vtns` → `POST /api/vtns/connect`) and the agent
    // dials the peer that serves it.
    try {
      const allPeers = (await stack.connectivity.status()).discoveredPeers;
      console.log(`[agent-web:discovery] total discovered peers: ${allPeers.length}`);
      const vtns = await stack.connectivity.vtns();
      if (vtns.length === 0) {
        console.log(
          '[agent-web:discovery] No VTNs discovered via bootstrap. Name registration stays ' +
          'unavailable until a utility server registers a namespace.',
        );
      } else {
        console.log(`[agent-web:discovery] VTNs available to join: ${vtns.length}`);
        for (const v of vtns) {
          console.log(
            `[agent-web:discovery]   ${v.vtnKey}${v.vtnName ? ` "${v.vtnName}"` : ''} — ` +
            `peer ${v.peerId.slice(0, 12)}... connected=${v.connected} reachable=${v.reachable}`,
          );
        }
      }
    } catch (err) {
      // A transport that cannot read discovery at all must not stop activation —
      // the agent is already up, which is what the caller asked for.
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
    // Pre-fill the startup screen's bootstrap boxes (config.yaml override → .env).
    bootstrapConfig: bootstrapConfigView,
    // Remember the VTN the user picked, so a restart registers under it.
    onVtnConnected: persistVtn,
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