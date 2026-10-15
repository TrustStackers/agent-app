#!/usr/bin/env node
/**
 * Trust Agent TUI — entrypoint.
 *
 * Bootstraps the blessed screen, shows the Agent Picker, starts the selected
 * Agent, then hands off to the Dashboard.
 *
 * Usage:
 *   npm run tui
 *   # or directly:
 *   node --experimental-strip-types --loader ./test-loader.mjs agent-app/tui/app.ts
 */

import blessed from 'blessed';
import { createNodeHost, createAgentStack, type TrustStack } from '@p2p-trust-stack/app-api/index.js';
import { showAgentPicker } from './screens/agent-picker.js';
import { showDashboard } from './screens/dashboard.js';

// ---------------------------------------------------------------------------
// forceRepaint — forces blessed to discard its diff cache and do a full
// terminal repaint.  This is the same thing a manual terminal resize triggers
// internally (screen.alloc()), which is why resizing clears rendering noise.
// Call this immediately after destroying a widget that occupied significant
// screen real estate, before rendering the next screen.
// ---------------------------------------------------------------------------

export function forceRepaint(screen: blessed.Widgets.Screen): void {
  // screen.realloc() calls alloc(true) which:
  //   1. Resets this.lines[] and this.olines[] to blank space cells
  //   2. Marks every line as dirty (dirty=true)
  //   3. Calls program.clear() — sends ESC[2J to the terminal, physically
  //      erasing every character on screen
  // The subsequent screen.render() then redraws every widget from scratch
  // because all lines are dirty.  This is the same sequence a terminal resize
  // triggers, which is why resizing always clears rendering noise.
  // Using realloc() (dirty=true) instead of plain alloc() (dirty=false) is
  // critical: without dirty=true the draw loop skips every line and nothing
  // gets redrawn.
  (screen as unknown as { realloc(): void }).realloc();
  screen.render();
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // Create the blessed screen.
  // ignoreLocked: ['tab'] ensures Tab keystrokes propagate through textbox
  // "input mode" so screen-level Tab handlers can cycle between fields.
  const screen = blessed.screen({
    smartCSR: false,
    title: 'Trust Agent',
    fullUnicode: true,
    dockBorders: true,
    ignoreLocked: ['tab'],
  });

  // Global Ctrl-C handler (fallback if dashboard hasn't registered it yet)
  screen.key(['C-c'], () => {
    screen.destroy();
    process.exit(0);
  });

  // Each agent owns its own database under P2PTS_HOME/vta/<agentKey>/ — the
  // agent picker lists them by scanning those directories (no shared database).
  //
  // The HOST owns `home` and the per-agent layout, so it is what lists, creates, unlocks and deletes agents.
  // This file needs nothing else from the layer: no `AgentApi` facade, and no runtime import but the
  // `AgentHandle` TYPE (which the screens still program to — see the `agent-app-facade` ratchet in
  // `boundary-guard.test.ts`).
  const host = createNodeHost();

  try {
    // Step 1 + 1b: pick an agent and hand it straight to the layer, which ADOPTS it.
    //
    // The picker owns creation/unlock and the layer owns everything above it — but both must answer for the SAME
    // identity, which is what `adopt` guarantees (letting the stack create its own agent would leave the two
    // drifting). The handle is never named here: it goes from the picker into `adopt`, and everything after this
    // reads through `stack`. That is what took this file off the `agent-app-facade` ratchet.
    const stack: TrustStack = await createAgentStack({
      host,
      adopt: await showAgentPicker(screen, host),
    });

    // Step 2: Show "starting..." message
    const startingBox = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: 50,
      height: 5,
      border: { type: 'line' },
      content: `\n  Starting agent "${(await stack.identity.current()).name ?? '(unnamed)'}"...\n  Booting libp2p node...`,
      style: { border: { fg: 'cyan' }, fg: 'white' },
    });
    screen.render();

    // Step 3: Start the agent (boots real libp2p node)
    await stack.start();

    startingBox.destroy();
    forceRepaint(screen);

    // Step 4: Show the dashboard (runs until [q] or Ctrl-C)
    await showDashboard(screen, stack);

  } catch (err) {
    // "User quit" from the agent picker is normal — exit cleanly.
    if ((err as Error)?.message === 'User quit') {
      screen.destroy();
      process.exit(0);
    }
    // Show error and exit
    screen.destroy();
    console.error('Trust Agent error:', err);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});