/**
 * Dashboard screen.
 *
 * The main screen shown after an Agent is unlocked and started.
 * Layout:
 *   - Left pane: relationship list (remote VID, direction/status, live-updating)
 *     with a legend at the bottom explaining each connection-state label.
 *   - Right pane: event/message log (scrollable) — shows outbound/inbound
 *     connections, the technique used to establish them (direct P2P vs
 *     relay), disconnections, relationship state changes, and messages.
 *   - Bottom bar: keybinding hints
 *
 * Keybindings:
 *   [o]     Show my OOBI (text + QR code + clipboard copy)
 *   [c]     Connect to peer (paste OOBI)
 *   [d]     Discover peers via bootstrap server
 *   [n]     Network status (LAN/WAN IPs, change detection)
 *   [Enter] Open chat with selected relationship
 *   [g]     Re-register with bootstrap server
 *   [r]     Reconnect to selected peer
 *   [x]     Disconnect from selected peer (clear cached addresses)
 *   [q]     Quit (graceful agent.stop())
 *
 * ## Network-aware relationship display
 *
 * Each relationship entry shows a connection-state label (word, not an icon)
 * describing the relationship's transport reachability:
 *   CONNECTED     = direct connection active (established)
 *   RELAY-READY   = relay available, dial on demand
 *   DISCONNECTED  = no active connection, addresses may be stale
 *   INCOMPATIBLE  = network incompatible (different subnet)
 * A legend explaining these labels is shown at the bottom of the left pane.
 *
 * ## Network status overlay ([n])
 *
 * Shows current network profile (LAN IPs, WAN IP, listen port) and whether
 * the network has changed since last bootstrap registration.
 */

import blessed from 'blessed';
import { execSync } from 'node:child_process';
import { platform } from 'node:os';
import type {
  ConnectivityStatusDto,
  DiscoveredPeerDto,
  NetworkProfileDto,
  RelationshipDto,
  TrustStack,
} from '@p2p-trust-stack/app-api/index.js';
import { renderQr } from '../components/qr.js';
import { showConnectScreen } from './connect.js';
import { showChatScreen } from './chat.js';
import { showProfilesScreen } from './profiles.js';
import { showCredentialsScreen } from './credentials.js';
import { showDelegationsScreen } from './delegations.js';
import { showAuthScreen } from './auth.js';
import { forceRepaint } from '../app.js';

// ---------------------------------------------------------------------------
// Clipboard helper — copies text to the system clipboard.
// On Windows: uses clipboardy node package (handles clip/powershell/cmd).
// On macOS: pbcopy. On Linux: xclip or xsel. Falls back gracefully.
// ---------------------------------------------------------------------------

async function copyToClipboard(text: string): Promise<boolean> {
  const p = platform();

  // Windows: use clipboardy via dynamic import (ESM-compatible)
  if (p === 'win32') {
    try {
      const { default: clipboardy } = await import('clipboardy');
      if (typeof clipboardy.writeSync === 'function') {
        clipboardy.writeSync(text);
      } else if (typeof clipboardy.write === 'function') {
        await clipboardy.write(text);
      } else if (typeof clipboardy === 'function') {
        await (clipboardy as (text: string) => Promise<void>)(text);
      } else {
        throw new Error('clipboardy has no write function');
      }

      return true;
    } catch {
      return false;
    }
  }

  // macOS & Linux: use system clipboard utilities
  const cmds = ['pbcopy', 'xclip -selection clipboard', 'xsel --clipboard --input'];
  for (const cmd of cmds) {
    try {
      execSync(cmd, { input: text, stdio: ['pipe', 'ignore', 'ignore'] });
      return true;
    } catch {
      // try next
    }
  }
  return false;
}

// ---------------------------------------------------------------------------
// showDashboard
// ---------------------------------------------------------------------------

export async function showDashboard(
  screen: blessed.Widgets.Screen,
  stack: TrustStack,
): Promise<void> {

  // Read the render facts BEFORE the layout: the panes are labelled from them, so there is no "loading" state to
  // paint and then correct. `ctx` is refreshed by the helpers below rather than captured once.
  let ctx = await readContext(stack);

  // ── Layout ────────────────────────────────────────────────────────────────

  const leftPane = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    width: '40%',
    bottom: 3,
    border: { type: 'line' },
    style: { border: { fg: 'cyan' } },
    label: ` Agent: ${ctx.name} `,
  });

  const agentInfoText = blessed.text({
    parent: leftPane,
    top: 0,
    left: 1,
    right: 1,
    height: 5,
    content: formatAgentInfo(ctx),
    style: { fg: 'green' },
  });

  const relList = blessed.list({
    parent: leftPane,
    top: 6,
    left: 0,
    right: 0,
    bottom: 6,
    keys: true,
    vi: true,
    mouse: true,
    label: ' Relationships ',
    style: {
      selected: { bg: 'cyan', fg: 'black' },
      item: { fg: 'white' },
    },
  });

  // Legend explaining each connection-state label used in the relationship
  // list above. Placed at the bottom of the left pane so users always have
  // the meaning of each state visible without needing to look it up.
  blessed.text({
    parent: leftPane,
    bottom: 0,
    left: 1,
    right: 1,
    height: 6,
    tags: true,
    content:
      '{cyan-fg}── Connection state legend ──{/cyan-fg}\n' +
      '{green-fg}CONNECTED{/green-fg}    direct connection active\n' +
      '{yellow-fg}RELAY-READY{/yellow-fg}  relay available, dials on demand\n' +
      '{white-fg}DISCONNECTED{/white-fg} no active connection\n' +
      '{red-fg}INCOMPATIBLE{/red-fg} peer on an unreachable network',
    style: { fg: 'gray' },
  });

  const logPane = blessed.log({
    parent: screen,
    top: 0,
    left: '40%',
    right: 0,
    bottom: 3,
    border: { type: 'line' },
    style: { border: { fg: 'blue' } },
    label: ' Events & Messages (↑/↓ PgUp/PgDn to scroll) ',
    scrollable: true,
    alwaysScroll: true,
    scrollbar: { ch: '│', style: { fg: 'blue', inverse: true } },
    mouse: true,
    keys: true,
    vi: true,
    tags: true,
  });

  blessed.text({
    parent: screen,
    bottom: 0,
    left: 0,
    right: 0,
    height: 3,
    border: { type: 'line' },
    style: { border: { fg: 'cyan' }, fg: 'white', bg: 'blue' },
    content: '  [o] OOBI  [c] Connect  [d] Discover  [p] Profiles  [v] Creds  [e] Delegations  [a] Auth  [n] Network  [g] Re-reg  [r] Reconnect  [x] Disconnect  [q] Quit',
  });

  // ── State ─────────────────────────────────────────────────────────────────

  let relationships: RelationshipDto[] = [];

  async function refreshRelList() {
    // Re-read the context too: the connection-state label per row depends on discovered peers and the network
    // profile, both of which move.
    ctx = await readContext(stack);
    // Filter out utility-server (organization) relationships — they are
    // infrastructure (protocol messages), not chat peers. Only human-to-human
    // relationships are shown in the chat list.
    relationships = (await stack.relationships.list()).filter(
      r => (r.remoteSubjectKind ?? 'human') !== 'organization',
    );
    const items = relationships.map(r => formatRelationship(r, ctx));
    relList.setItems(items.length > 0 ? items : ['  (no relationships yet)']);
    screen.render();
  }

  async function refreshAgentInfo() {
    ctx = await readContext(stack);
    agentInfoText.setContent(formatAgentInfo(ctx));
    screen.render();
  }

  // ── Initial render ────────────────────────────────────────────────────────

  logPane.log('{green-fg}Agent started.{/green-fg}');
  logPane.log(`VID: ${ctx.vid.slice(0, 20)}...`);
  logPane.log(`Listening on: ${ctx.multiaddrs.join(', ')}`);

  // Show bootstrap + relay status.
  //
  // Rendered from the LIVE connectivity view rather than the single
  // `isBootstrapConnected()` boolean, so a peer whose relay session is about to
  // be cut off — or whose utility-server connection is down — no longer shows a
  // plain green "Bootstrap connected" that hides the problem.
  const connectivity = ctx.connectivity;
  if (connectivity) {
    const color = connectivity.layer === 'connected'
      ? 'green-fg'
      : connectivity.layer === 'relay-expiring'
        ? 'yellow-fg'
        : 'red-fg';
    logPane.log(`{${color}}${connectivity.layer.toUpperCase()}{/${color}} — ${connectivity.message}`);
    const relay = ctx.relayAddr;
    const peers = ctx.discoveredPeers;
    if (connectivity.relay.hasRelayedConnection) {
      const soonest = connectivity.relay.soonestExpiryMs;
      logPane.log(
        `  Relay: ${connectivity.relay.relayed.length} active connection(s)` +
        (soonest != null ? `, soonest grant expires in ~${Math.round(soonest / 1000)}s` : '') +
        (connectivity.hasRelayReservation ? ' (reservation held)' : ' (NO reservation — unreachable via relay)'),
      );
    } else if (connectivity.hasRelayReservation) {
      logPane.log('  Relay: reservation held — reachable via relay, no active relayed connection.');
    } else if (relay) {
      logPane.log('  {yellow-fg}Relay: no reservation yet — peers on another WAN cannot reach this agent until one is established.{/yellow-fg}');
    }
    logPane.log(`  Peers discovered: ${peers.length}` + (relay ? ' (relay available)' : ''));
  } else if (ctx.bootstrapConnected) {
    logPane.log(`{green-fg}✓ Bootstrap connected.{/green-fg} Peers discovered: ${ctx.discoveredPeers.length}` + (ctx.relayAddr ? ' (relay available)' : ''));
  } else {
    logPane.log('{yellow-fg}Bootstrap unavailable. LAN-only mode.{/yellow-fg}');
  }

  logPane.log('');
  logPane.log('Press {yellow-fg}[o]{/yellow-fg} OOBI, {yellow-fg}[c]{/yellow-fg} Connect, {yellow-fg}[d]{/yellow-fg} Discover peers.');

  await refreshRelList();
  relList.focus();
  screen.render();

  // ── Live updates ──────────────────────────────────────────────────────────
  //
  // Every subscription here is a BUS event, so the dashboard never touches the runtime. The four ceremony
  // callbacks the runtime exposes (`onCeremonyPrompt`/`AckChange`/`Complete`/`Expired`) arrive as ONE event with
  // a `step` field — `relationship.ceremony` — which is why this is one subscription rather than four.

  stack.on('relationship.changed', (p) => {
    const didShort = p.peerDid.slice(0, 16) + '...';
    logPane.log(`{cyan-fg}Relationship update:{/cyan-fg} ${didShort} → ${p.status}`);
    void refreshRelList();
  });

  stack.on('message.received', (p) => {
    // `message.received` deliberately carries no body — it would duplicate every message into the event outbox —
    // so the text comes from the transcript, which `recordInboundMessage` appends to BEFORE it emits.
    void (async () => {
      try {
        const entry = await stack.messaging.latest(p.peerDid);
        if (!entry) return;
        const didShort = p.peerDid.slice(0, 16) + '...';
        const tag = entry.confidential ? '{magenta-fg}🔒 [confidential]{/magenta-fg}' : '{white-fg}📨 [plain]{/white-fg}';
        logPane.log(`${tag} from ${didShort}: "${entry.text}"`);
        screen.render();
      } catch { /* a transcript read must never break the dashboard */ }
    })();
  });

  // Raw transport connection events — shows how (and when) each peer
  // actually connects/disconnects at the libp2p level: direction
  // (inbound/outbound), technique (direct TCP/WebSocket vs circuit-relay),
  // and disconnections. This is distinct from `relationship.changed`, which
  // only reflects the higher-level TSP handshake state.
  const onConnectionOpen = (event: { peerId: string; direction: string; method: string }) => {
    const peerShort = event.peerId.length > 20 ? event.peerId.slice(0, 16) + '…' : event.peerId;
    const dirIcon = event.direction === 'inbound' ? '⬅' : '➡';
    const dirLabel = event.direction === 'inbound' ? 'Inbound' : 'Outbound';
    const color = event.method.includes('relay') ? 'yellow' : 'green';
    logPane.log(
      `{${color}-fg}${dirIcon} ${dirLabel} connection{/${color}-fg} ${peerShort} — via {bold}${event.method}{/bold}`,
    );
    screen.render();
  };
  stack.on('connection.open', onConnectionOpen);
  stack.on('connection.close', (event) => {
    const peerShort = event.peerId.length > 20 ? event.peerId.slice(0, 16) + '…' : event.peerId;
    logPane.log(`{red-fg}✗ Disconnected{/red-fg} from ${peerShort}`);
    screen.render();
  });

  // ── Personhood ceremony ──────────────────────────────────────────────────
  stack.on('relationship.ceremony', (p) => {
    if (p.step === 'prompt') {
      // The relationship is re-read through the layer rather than taken from the event, because the overlay needs
      // the whole record (direction, transport, personhood status) and the event carries only the peer DID.
      void (async () => {
        const rel = await stack.relationships.get(p.peerDid);
        if (!rel) return;
        showCeremonyPromptOverlay(screen, stack, p.peerDid, rel, () => {
          void refreshRelList();
          relList.focus();
          forceRepaint(screen);
        });
      })();
      return;
    }
    const didShort = p.peerDid.slice(0, 16) + '...';
    if (p.step === 'complete') {
      logPane.log(`{green-fg}🎉 DTG VRC issued with ${didShort}{/green-fg}`);
    } else if (p.step === 'expired') {
      logPane.log('{red-fg}⏱ Ceremony expired with ' + didShort + ' — connection attempt cleared. Re-paste the OOBI to retry.{/red-fg}');
    } else {
      // `ack` / `failed` / `reset` — logged so a ceremony's progress is visible without a dedicated pane.
      const detail = p.error ? ` — ${p.error}` : '';
      logPane.log(`{cyan-fg}Ceremony ${p.step}{/cyan-fg} with ${didShort}${detail}`);
    }
    void refreshRelList();
    screen.render();
  });

  stack.on('duplicate.connect.notice', (p) => {
    showDuplicateConnectNoticeOverlay(screen, logPane, p.peerDid, p.remoteName, () => {
      forceRepaint(screen);
    });
  });


  screen.key(['o'], async () => {
    await showOobiOverlay(screen, stack, logPane);
    relList.focus();
    forceRepaint(screen);
  });

  screen.key(['c'], async () => {
    await showConnectScreen(screen, stack, logPane);
    await refreshRelList();
    relList.focus();
    forceRepaint(screen);
  });

  // [d] Discover peers via bootstrap server
  screen.key(['d'], async () => {
    logPane.log('{cyan-fg}[d] Discovering peers via bootstrap server...{/cyan-fg}');
    screen.render();
    try {
      // Through the layer: `connectivity.refresh()` is what the runtime's `refreshBootstrapPeers()` did, and
      // `relationships.connectDiscovered()` owns the OOBI construction a discovery record needs.
      const { peers } = await stack.connectivity.refresh();
      if (peers.length > 0) {
        logPane.log(`{green-fg}[d] Found ${peers.length} peers on bootstrap server:{/green-fg}`);
        for (const peer of peers) {
          const peerShort = peer.peerId.slice(0, 16) + '...';
          const addrCount = peer.multiaddrs.length;
          logPane.log(`  ${peerShort} (${addrCount} addrs) ${peer.connected ? '✓ connected' : ''}`);
        }
        // Auto-connect to discovered peers that aren't yet connected
        let connectedCount = 0;
        for (const peer of peers) {
          const existing = relationships.find(r => r.remoteTransport?.peerId === peer.peerId);
          if (!existing) {
            try {
              await stack.relationships.connectDiscovered(peer);
              connectedCount++;
              logPane.log(`{green-fg}[d] Connecting to ${peer.peerId.slice(0, 12)}...{/green-fg}`);
            } catch (e) {
              logPane.log(`{red-fg}[d] Failed to connect to ${peer.peerId.slice(0, 12)}: ${(e as Error).message}{/red-fg}`);
            }
          }
        }
        if (connectedCount > 0) {
          await refreshRelList();
        }
      } else {
        logPane.log('{yellow-fg}[d] No peers discovered on bootstrap server.{/yellow-fg}');
      }
      await refreshAgentInfo();
    } catch (e) {
      logPane.log(`{red-fg}[d] Bootstrap query failed: ${(e as Error).message}{/red-fg}`);
    }
    relList.focus();
    screen.render();
  });

  relList.on('select', async (_item, index) => {
    if (relationships.length === 0) return;
    const selected = relationships[index];
    if (!selected || selected.direction !== 'bidirectional') {
      logPane.log('{yellow-fg}Select a bidirectional relationship to chat.{/yellow-fg}');
      screen.render();
      return;
    }
    // Utility-server (organization) relationships are not chat peers — they
    // have no chat capability. This is a defensive check; the list is already
    // filtered in refreshRelList().
    if ((selected as any).remoteSubjectKind === 'organization') {
      logPane.log('{yellow-fg}This is a utility server — not a chat peer.{/yellow-fg}');
      screen.render();
      return;
    }
    forceRepaint(screen);
    await showChatScreen(screen, stack, selected, logPane);
    relList.focus();
    forceRepaint(screen);
  });

  // [n] Network status overlay
  screen.key(['n'], async () => {
    await showNetworkOverlay(screen, stack, ctx, logPane);
    relList.focus();
    forceRepaint(screen);
  });

  // [g] Re-register with bootstrap (manual, always available)
  screen.key(['g'], async () => {
    logPane.log('{cyan-fg}[g] Re-registering with bootstrap server...{/cyan-fg}');
    screen.render();
    try {
      // `connectivity.refresh()` is the same re-registration the runtime's `reRegisterWithBootstrap()` performed.
      // The per-step progress callback is not part of the domain contract — the outcome is what the caller acts
      // on, and a failure still lands in the catch below.
      const { count } = await stack.connectivity.refresh();
      logPane.log(`{green-fg}[g] Re-registration complete — ${count} peer(s) known.{/green-fg}`);
      await refreshRelList();
      await refreshAgentInfo();
    } catch (e) {
      logPane.log(`{red-fg}[g] Re-registration failed: ${(e as Error).message}{/red-fg}`);
    }
    relList.focus();
    screen.render();
  });

  // [r] Reconnect — attempt to re-dial an established peer.
  //
  // The refresh-then-dial sequence the runtime performed is now `relationships.reconnect()`, which owns it. The
  // per-step status callback is not part of the contract, so the log shows the attempt and the outcome.
  screen.key(['r'], async () => {
    const idx = (relList as unknown as { selected: number }).selected ?? 0;
    const rel = relationships[idx];
    if (!rel) {
      logPane.log('{yellow-fg}[r] No peer selected. Use ↑/↓ to select one.{/yellow-fg}');
      screen.render();
      return;
    }
    if (rel.direction !== 'bidirectional' || rel.status !== 'established') {
      logPane.log('{yellow-fg}[r] Selected peer is not yet established. Only established peers can be reconnected.{/yellow-fg}');
      screen.render();
      return;
    }
    const shortDid = rel.remoteDid.slice(0, 12) + '...';
    logPane.log(`{cyan-fg}[r] Attempting to reconnect to ${shortDid}...{/cyan-fg}`);
    logPane.log('{cyan-fg}    Refreshing peer list from bootstrap server...{/cyan-fg}');
    screen.render();
    try {
      await stack.relationships.reconnect(rel.remoteDid);
      logPane.log(`{green-fg}[r] Reconnected to ${shortDid}. You can now send messages.{/green-fg}`);
    } catch (e) {
      const msg = (e as Error).message;
      logPane.log(`{red-fg}[r] Reconnect failed: ${msg}{/red-fg}`);
      logPane.log(`{yellow-fg}    Tip: Ask the other person to press [c] and paste your OOBI to re-establish the connection.{/yellow-fg}`);
    }
    screen.render();
  });

  // [x] Disconnect — clear cached addresses, force fresh discovery on next connect
  screen.key(['x'], async () => {
    const idx = (relList as unknown as { selected: number }).selected ?? 0;
    const rel = relationships[idx];
    if (!rel) {
      logPane.log('{yellow-fg}[x] No peer selected. Use ↑/↓ to select one.{/yellow-fg}');
      screen.render();
      return;
    }
    const shortDid = rel.remoteDid.slice(0, 12) + '...';
    logPane.log(`{cyan-fg}[x] Disconnecting from ${shortDid}...{/cyan-fg}`);
    try {
      await stack.relationships.disconnect(rel.remoteDid);
      logPane.log(`{green-fg}[x] Disconnected from ${shortDid}. Cached addresses cleared.{/green-fg}`);
      await refreshRelList();
    } catch (e) {
      logPane.log(`{red-fg}[x] Disconnect failed: ${(e as Error).message}{/red-fg}`);
    }
    screen.render();
  });

  screen.key(['q', 'C-c'], async () => {
    logPane.log('{yellow-fg}Shutting down...{/yellow-fg}');
    screen.render();
    await stack.stop();
    screen.destroy();
    process.exit(0);
  });

  // [p] Profiles screen
  screen.key(['p'], async () => {
    forceRepaint(screen);
    await showProfilesScreen(screen, stack);
    relList.focus();
    forceRepaint(screen);
  });

  // [v] Credentials screen
  screen.key(['v'], async () => {
    forceRepaint(screen);
    await showCredentialsScreen(screen, stack);
    relList.focus();
    forceRepaint(screen);
  });

  // [e] Delegations screen
  screen.key(['e'], async () => {
    forceRepaint(screen);
    await showDelegationsScreen(screen, stack);
    relList.focus();
    forceRepaint(screen);
  });

  // [a] Auth screen
  screen.key(['a'], async () => {
    forceRepaint(screen);
    await showAuthScreen(screen, stack);
    relList.focus();
    forceRepaint(screen);
  });

  // [V] Verify peer (personhood proof) — send challenge over TSP
  //
  // This hand-rolled a `personhood_challenge` payload with a locally-generated nonce and sent it as a raw
  // message — the same shape of fake as the auth screen's `[c]`, and it was not the protocol the peer's agent
  // answers. `relationships.verify()` builds the REAL challenge, re-dials the peer and sends it, and returns the
  // nonce it actually used.
  screen.key(['V'], async () => {
    const idx = (relList as unknown as { selected: number }).selected ?? 0;
    const rel = relationships[idx];
    if (!rel) {
      logPane.log('{yellow-fg}[V] No peer selected. Use ↑/↓ to select one.{/yellow-fg}');
      screen.render();
      return;
    }
    if (rel.direction !== 'bidirectional' || rel.status !== 'established') {
      logPane.log('{yellow-fg}[V] Selected peer is not yet established. Only established peers can be verified.{/yellow-fg}');
      screen.render();
      return;
    }
    const shortDid = rel.remoteDid.slice(0, 12) + '...';
    logPane.log(`{cyan-fg}[V] Initiating personhood proof with ${shortDid}...{/cyan-fg}`);
    screen.render();

    try {
      const result = await stack.relationships.verify(rel.remoteDid);
      logPane.log(`{green-fg}[V] ${result.message} to ${shortDid}. Awaiting response...{/green-fg}`);
      logPane.log(`{cyan-fg}    Nonce: ${result.nonce}{/cyan-fg}`);
      logPane.log(`{yellow-fg}    The peer's agent will auto-sign and respond.{/yellow-fg}`);
    } catch (e) {
      logPane.log(`{red-fg}[V] Failed: ${(e as Error).message}{/red-fg}`);
    }
    screen.render();
  });

  // Keep the dashboard alive
  await new Promise<void>(() => { /* lives until [q] or Ctrl-C */ });
}

// ---------------------------------------------------------------------------
// showOobiOverlay
//
// Displays the OOBI with a [y] Copy to Clipboard button, the full OOBI string
// in a scrollable box, and a QR code for phone scanning.
// ---------------------------------------------------------------------------

async function showOobiOverlay(
  screen: blessed.Widgets.Screen,
  stack: TrustStack,
  logPane: blessed.Widgets.Log,
): Promise<void> {
  const { oobi } = await stack.relationships.oobi();
  const qr = await renderQr(oobi);

  logPane.log('{green-fg}OOBI overlay opened. Press [y] to copy to clipboard.{/green-fg}');

  // ── Overlay ────────────────────────────────────────────────────────────────

  const overlay = blessed.box({
    parent: screen,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    border: { type: 'line' },
    style: { border: { fg: 'green' } },
    label: ' My OOBI — Share this with a peer ',
    scrollable: true,
    alwaysScroll: true,
    mouse: true,
    keys: true,
  });

  let row = 1;

  // ── Section 1: Copy button ──────────────────────────────────────────────────

  blessed.text({
    parent: overlay,
    top: row++,
    left: 2,
    content: '── Copy OOBI to clipboard ──────────────────────────────────────────────────',
    style: { fg: 'green', bold: true },
  });
  row++;

  // Status text — updated when [y] is pressed
  const copyStatus = blessed.text({
    parent: overlay,
    top: row++,
    left: 2,
    right: 2,
    height: 1,
    content: 'Press [y] to copy your OOBI to the clipboard, then paste it to your peer.',
    style: { fg: 'yellow' },
  });

  row += 2;

  // ── Section 2: Full OOBI string ─────────────────────────────────────────────

  blessed.text({
    parent: overlay,
    top: row++,
    left: 2,
    content: '── Full OOBI string (for reference) ────────────────────────────────────────',
    style: { fg: 'green', bold: true },
  });
  row++;

  // Break the OOBI into 70-char lines so it fits in the overlay
  const oobiChunkSize = 70;
  for (let i = 0; i < oobi.length; i += oobiChunkSize) {
    blessed.text({
      parent: overlay,
      top: row++,
      left: 4,
      content: oobi.slice(i, i + oobiChunkSize),
      style: { fg: 'white' },
    });
  }

  row += 2;

  // ── Section 3: QR code ─────────────────────────────────────────────────────

  blessed.text({
    parent: overlay,
    top: row++,
    left: 2,
    content: '── QR Code (scan with phone camera) ────────────────────────────────────────',
    style: { fg: 'green', bold: true },
  });
  row++;

  const qrLines = qr.split('\n');
  for (const line of qrLines) {
    if (!line) continue;
    blessed.text({
      parent: overlay,
      top: row++,
      left: 4,
      content: line,
      style: { fg: 'white', bg: 'black' },
    });
  }

  row += 2;

  // ── Footer ─────────────────────────────────────────────────────────────────

  blessed.text({
    parent: overlay,
    top: row,
    left: 2,
    content: '[y] Copy OOBI to clipboard   [Esc] or [o] Close',
    style: { fg: 'yellow' },
  });

  overlay.focus();
  screen.render();

  // ── Key handlers ────────────────────────────────────────────────────────────

  await new Promise<void>(resolve => {
    // [y] — copy to clipboard
    screen.key(['y'], async () => {
      const ok = await copyToClipboard(oobi);
      if (ok) {
        copyStatus.setContent('✓ OOBI copied to clipboard! Paste it to your peer.');
        copyStatus.style.fg = 'green';
        logPane.log('{green-fg}✓ OOBI copied to clipboard.{/green-fg}');
      } else {
        copyStatus.setContent('✗ Clipboard not available. See QR code or OOBI string above.');
        copyStatus.style.fg = 'red';
        const plat = platform();
        const hint = plat === 'win32' ? 'clipboardy' : 'pbcopy/xclip';
        logPane.log(`{red-fg}✗ Could not copy to clipboard (${hint} not available).{/red-fg}`);
      }
      screen.render();
    });

    // [Esc] or [o] — close
    screen.key(['escape', 'o'], () => {
      overlay.destroy();
      forceRepaint(screen);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/**
 * The identity + connectivity facts the dashboard renders, read from the layer **once per refresh**.
 *
 * The helpers below used to take an `AgentHandle` and call synchronous getters on it. The layer's equivalents are
 * async, and reading them per relationship row would be an N+1 — so the facts are gathered once and passed as
 * data. It also means a formatter *cannot* reach for the agent, which is what kept the coupling alive.
 */
interface DashContext {
  name: string;
  vid: string;
  did: string;
  multiaddrs: string[];
  bootstrapConnected: boolean;
  relayAddr: string | undefined;
  discoveredPeers: DiscoveredPeerDto[];
  connectivity: ConnectivityStatusDto | undefined;
  networkProfile: NetworkProfileDto | undefined;
  networkChanged: boolean;
}

/** Read every fact the dashboard renders, in one pass. */
async function readContext(stack: TrustStack): Promise<DashContext> {
  const id = await stack.identity.current();
  const status = await stack.connectivity.status();
  return {
    name: id.name ?? '(unnamed)',
    vid: id.vid ?? '',
    did: id.did ?? '',
    multiaddrs: id.multiaddrs ?? [],
    bootstrapConnected: status.bootstrapConnected,
    relayAddr: status.relayAddr,
    discoveredPeers: status.discoveredPeers,
    connectivity: status.connectivity,
    networkProfile: await stack.connectivity.networkProfile(),
    // `networkChanged()` is the pull form of the `network.changed` event, and it needs an active agent — so a read
    // that fails is "not changed" rather than a crash in a per-row formatter.
    networkChanged: (() => { try { return stack.connectivity.networkChanged(); } catch { return false; } })(),
  };
}

function formatAgentInfo(ctx: DashContext): string {
  // Two DIFFERENT identifiers, deliberately shown side by side: the VID is the
  // CESR-encoded TSP transport identity (still used by TSP), the DID is the
  // Rev-3 identity reference. Do not collapse these names.
  const vidShort = ctx.vid.slice(0, 20) + '...';
  const didShort = ctx.did.slice(0, 30) + '...';
  const bootstrapStatus = ctx.bootstrapConnected
    ? '✓ Bootstrap connected'
    : '✗ Bootstrap unavailable (LAN mode)';
  return `VID: ${vidShort}\nDID: ${didShort}\nBootstrap: ${bootstrapStatus}\nDiscovered: ${ctx.discoveredPeers.length} peers`;
}

function formatRelationship(r: RelationshipDto, ctx: DashContext): string {
  const didShort = r.remoteDid.slice(0, 16) + '...';
  const dirIcon = r.direction === 'bidirectional' ? '⇄' : r.direction === 'outbound' ? '→' : '←';
  const statusIcon = r.status === 'established' ? '✓' : '⏳';

  // Connection state label (word-based, not an icon) based on relationship
  // state and bootstrap info. See legend rendered at the bottom of the left
  // pane for the meaning of each label.
  const connLabel = getConnectionStateLabel(r, ctx);

  return ` [${connLabel}] ${statusIcon} ${dirIcon} ${didShort}  [${r.status}]`;
}

/**
 * Determine the connection-state label for a relationship.
 * CONNECTED    = direct connection active (established with direct addrs)
 * RELAY-READY  = relay available, dial on demand
 * DISCONNECTED = no active connection, addresses may be stale
 * INCOMPATIBLE = network incompatible (different subnet)
 *
 * These words are shown inline in the relationship list, and explained in
 * the legend rendered at the bottom of the left pane (see showDashboard).
 */
function getConnectionStateLabel(r: RelationshipDto, ctx: DashContext): string {
  if (r.status !== 'established' || !r.remoteTransport) {
    return 'DISCONNECTED';
  }

  const bootstrapPeer = ctx.discoveredPeers.find(p => p.peerId === r.remoteTransport?.peerId);

  // Check if there's a relay address available
  if (bootstrapPeer?.relayAddr) {
    return 'RELAY-READY';
  }

  const peerMultiaddrs = bootstrapPeer?.multiaddrs ?? [];
  const transportMultiaddrs = r.remoteTransport.multiaddrs ?? [];

  // Check if the peer has direct addresses
  if (peerMultiaddrs.length > 0 || transportMultiaddrs.length > 0) {
    // Check if addresses are from a different network (LAN-only addrs when we're on WAN)
    if (ctx.networkProfile && transportMultiaddrs.length > 0) {
      const hasLanAddrs = transportMultiaddrs.some(a =>
        /\/ip4\/(192\.168\.\d+\.\d+|10\.\d+\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+)/.test(a)
      );
      if (hasLanAddrs && ctx.networkChanged) {
        return 'INCOMPATIBLE';
      }
    }
    return 'CONNECTED';
  }

  return 'DISCONNECTED';
}

/**
 * Show the network status overlay.
 * Displays LAN IPs, WAN IP, listen port, and whether the network has changed.
 */
async function showNetworkOverlay(
  screen: blessed.Widgets.Screen,
  stack: TrustStack,
  ctx: DashContext,
  logPane: blessed.Widgets.Log,
): Promise<void> {
  // Passed in rather than read here: the overlay renders the SAME facts the left pane does, and reading them
  // twice would let the two disagree.
  const profile = ctx.networkProfile;
  const networkChanged = ctx.networkChanged;

  const overlay = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '70%',
    height: 14,
    border: { type: 'line' },
    style: { border: { fg: networkChanged ? 'red' : 'green' } },
    label: ` Network Status ${networkChanged ? ' — ⚠ CHANGED' : ''} `,
    keys: true,
  });

  let row = 1;

  blessed.text({
    parent: overlay,
    top: row++,
    left: 2,
    content: '── Current Network Profile ─────────────────────────────────────────────────',
    style: { fg: 'green', bold: true },
  });
  row++;

  if (profile) {
    blessed.text({
      parent: overlay,
      top: row++,
      left: 4,
      content: `WAN IP   : ${profile.wanIp ?? '(not available)'}`,
      style: { fg: 'white' },
    });
    row++;
    blessed.text({
      parent: overlay,
      top: row++,
      left: 4,
      content: `LAN IPs  : ${profile.lanIps.join(', ') || '(none detected)'}`,
      style: { fg: 'white' },
    });
    row++;
    blessed.text({
      parent: overlay,
      top: row++,
      left: 4,
      content: `Port     : ${profile.listenPort}`,
      style: { fg: 'white' },
    });
    row++;
    const capturedAt = new Date(profile.capturedAt * 1000);
    blessed.text({
      parent: overlay,
      top: row++,
      left: 4,
      content: `Captured : ${capturedAt.toLocaleString()}`,
      style: { fg: 'white' },
    });
  } else {
    blessed.text({
      parent: overlay,
      top: row++,
      left: 4,
      content: '  No network profile available (bootstrap not connected).',
      style: { fg: 'yellow' },
    });
  }

  row += 2;

  blessed.text({
    parent: overlay,
    top: row++,
    left: 2,
    content: '── Network Change Detection ────────────────────────────────────────────────',
    style: { fg: 'green', bold: true },
  });
  row++;

  if (networkChanged) {
    blessed.text({
      parent: overlay,
      top: row++,
      left: 4,
      content: '⚠ Network appears to have CHANGED since last registration.',
      style: { fg: 'red', bold: true },
    });
    row++;
    blessed.text({
      parent: overlay,
      top: row++,
      left: 4,
      content: 'Your LAN/WAN addresses differ from when you last registered.',
      style: { fg: 'yellow' },
    });
    row++;
    blessed.text({
      parent: overlay,
      top: row++,
      left: 4,
      content: 'Press [g] to re-register with bootstrap server.',
      style: { fg: 'cyan', bold: true },
    });
  } else {
    blessed.text({
      parent: overlay,
      top: row++,
      left: 4,
      content: '✓ Network appears stable (same as last registration).',
      style: { fg: 'green' },
    });
  }

  row += 2;

  // Footer
  blessed.text({
    parent: overlay,
    top: row,
    left: 2,
    content: `[g] Re-register   [Esc] or [n] Close`,
    style: { fg: 'yellow' },
  });

  overlay.focus();
  screen.render();

  await new Promise<void>(resolve => {
    screen.key(['g'], async () => {
      logPane.log('{cyan-fg}[g] Re-registering with bootstrap server...{/cyan-fg}');
      screen.render();
      try {
        await stack.connectivity.refresh();
        logPane.log('{green-fg}[g] Re-registration complete.{/green-fg}');
        overlay.destroy();
        forceRepaint(screen);
        resolve();
      } catch (e) {
        logPane.log(`{red-fg}[g] Re-registration failed: ${(e as Error).message}{/red-fg}`);
        screen.render();
        // Stay on overlay to let user try again
      }
    });

    screen.key(['escape', 'n'], () => {
      overlay.destroy();
      forceRepaint(screen);
      resolve();
    });
  });
}

// ---------------------------------------------------------------------------
// Ceremony Prompt Overlay
// ---------------------------------------------------------------------------

async function showCeremonyPromptOverlay(
  screen: blessed.Widgets.Screen,
  stack: TrustStack,
  remoteDid: string,
  _rel: RelationshipDto,
  onDone: () => void,
): Promise<void> {
  return new Promise(resolve => {
    const didShort = remoteDid.slice(0, 24) + '...';
    const overlay = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 55,
      height: 12,
      border: { type: 'line' },
      style: { border: { fg: 'green' } },
      label: ' 🤝 Personhood Ceremony ',
      keys: true,
    });

    blessed.text({
      parent: overlay, top: 1, left: 2, right: 2,
      content: `${didShort} says they know you.`,
      style: { fg: 'white' },
    });

    blessed.text({
      parent: overlay, top: 3, left: 2, right: 2,
      content: 'Do you know this person?',
      style: { fg: 'yellow', bold: true },
    });

    blessed.text({
      parent: overlay, bottom: 1, left: 2,
      content: '[y] Yes, I know them   [n] No',
      style: { fg: 'green' },
    });

    overlay.focus();
    screen.render();

    function yesHandler() {
      cleanup();
      // Through the layer. The runtime's `acknowledgeRemotePeer` is fire-and-forget; `relationships.acknowledge()`
      // is the same operation and announces it on the bus, which is what refreshes the list.
      void stack.relationships.acknowledge(remoteDid).catch(() => { /* best-effort ack */ });
      onDone();
      forceRepaint(screen);
      resolve();
    }

    function noHandler() {
      cleanup();
      onDone();
      forceRepaint(screen);
      resolve();
    }

    function cleanup() {
      (screen as any).unkey('y', yesHandler);
      (screen as any).unkey('n', noHandler);
      (screen as any).unkey('escape', noHandler);
      overlay.destroy();
    }

    screen.key(['y'], yesHandler);
    screen.key(['n', 'escape'], noHandler);
  });
}
// ---------------------------------------------------------------------------
// Duplicate Connect Notice Overlay
// ---------------------------------------------------------------------------

/**
 * Shown when an already-connected peer pastes an OOBI + presses Connect for
 * a relationship that is already established (VRC exchanged). Both agents
 * display: "You already have a relationship with <name>." plus a Close button.
 * Closing the prompt returns the display to the pre-OOBI-share state.
 */
async function showDuplicateConnectNoticeOverlay(
  screen: blessed.Widgets.Screen,
  logPane: blessed.Widgets.Log,
  remoteDid: string,
  remoteName: string | null,
  onDone: () => void,
): Promise<void> {
  return new Promise(resolve => {
    const who = remoteName && remoteName.trim()
      ? remoteName.trim()
      : `${remoteDid.slice(0, 24)}...`;
    const overlay = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 60,
      height: 11,
      border: { type: 'line' },
      style: { border: { fg: 'red' } },
      label: ' ⚠ Relationship Already Exists ',
      keys: true,
    });

    blessed.text({
      parent: overlay,
      top: 2,
      left: 2,
      right: 2,
      content: `You already have a relationship with ${who}.`,
      style: { fg: 'white', bold: true },
    });

    const closeButton = blessed.button({
      parent: overlay,
      bottom: 1,
      left: 'center',
      width: 18,
      height: 3,
      content: ' Close ',
      align: 'center',
      valign: 'middle',
      mouse: true,
      keys: true,
      style: {
        bg: 'red',
        fg: 'white',
        bold: true,
        focus: { bg: 'green' },
        hover: { bg: 'green' },
      },
    });

    let handled = false;
    function closeHandler() {
      if (handled) return;
      handled = true;
      cleanup();
      logPane.log('{yellow-fg}Closed — this relationship already exists. No new connection was initiated.{/yellow-fg}');
      forceRepaint(screen);
      onDone();
      resolve();
    }

    function cleanup() {
      (screen as any).unkey('enter', closeHandler);
      (screen as any).unkey('space', closeHandler);
      closeButton.destroy();
      overlay.destroy();
    }

    closeButton.on('press', closeHandler);
    screen.key(['enter', 'space'], closeHandler);
    closeButton.focus();
    screen.render();
  });
}
