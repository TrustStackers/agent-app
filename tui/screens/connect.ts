// SPDX-License-Identifier: GPL-3.0-only OR LicenseRef-TrustStackers-Commercial
// Copyright (C) 2026 Trust Stackers

/**
 * Connect to Peer screen.
 *
 * Shown when the user presses [c] on the dashboard.
 * Lets the user paste a peer's OOBI string to initiate a relationship (sendRfi).
 * Shows handshake progress in the dashboard log pane.
 *
 * Uses readInput(callback) — the correct blessed API — instead of
 * inputOnFocus + .key() bindings, which conflict with the internal _done handler.
 *
 * DEBUG: Instrumented to trace OOBI paste flow.
 *   REJECT  = readInput failed with error
 *   EMPTY   = empty/whitespace-only value
 *   ACCEPT  = readInput succeeded, passing to connectToPeer
 *   FAIL    = connectToPeer threw an error
 */

import blessed from 'blessed';
import type { TrustStack } from '@p2p-trust-stack/app-api/index.js';
import { forceRepaint } from '../app.js';

// ---------------------------------------------------------------------------
// showConnectScreen
// ---------------------------------------------------------------------------

export async function showConnectScreen(
  screen: blessed.Widgets.Screen,
  stack: TrustStack,
  logPane: blessed.Widgets.Log,
): Promise<void> {
  return new Promise((resolve) => {
    const overlay = blessed.box({
      parent: screen,
      top: 'center',
      left: 'center',
      width: '80%',
      height: 14,
      border: { type: 'line' },
      style: { border: { fg: 'green' } },
      label: ' Connect to Peer — Paste OOBI ',
    });

    blessed.text({
      parent: overlay,
      top: 1,
      left: 2,
      content: "Paste the peer's OOBI string below and press [Enter]:",
      style: { fg: 'white' },
    });

    // No inputOnFocus — it triggers blessed's internal readInput() which
    // conflicts with our manual readInput() call, causing Enter to be
    // consumed and the callback to never fire.
    const oobiInput = blessed.textbox({
      parent: overlay,
      top: 3,
      left: 2,
      right: 2,
      height: 1,
      keys: true,
      mouse: true,
      style: { fg: 'white', bg: 'blue' },
    });

    const statusText = blessed.text({
      parent: overlay,
      top: 5,
      left: 2,
      right: 2,
      height: 2,
      content: 'Paste OOBI and press Enter. Press Esc to cancel.',
      style: { fg: 'yellow' },
    });

    blessed.text({
      parent: overlay,
      bottom: 1,
      left: 2,
      content: '[Enter] Connect  [Esc] Cancel',
      style: { fg: 'yellow' },
    });

    const tryConnect = () => {
      oobiInput.clearValue();
      oobiInput.focus();
      screen.render();

      console.error('[OOBI] readInput called — waiting for Enter...');

      oobiInput.readInput(async (err, oobi) => {
        console.error('[OOBI] readInput callback fired:', {
          err: err ? String((err as Error)?.message ?? err) : null,
          oobiType: typeof oobi,
          oobiLength: oobi != null ? String(oobi).length : 0,
        });

        if (err) {
          console.error('[OOBI] REJECT');
          overlay.destroy();
          forceRepaint(screen);
          resolve();
          return;
        }

        // Strip all whitespace — terminal wrapping during paste injects
        // internal newlines that break CESR decoding.
        const cleaned = oobi != null ? String(oobi).replace(/\s+/g, '') : '';
        if (!cleaned) {
          console.error('[OOBI] EMPTY');
          overlay.destroy();
          forceRepaint(screen);
          resolve();
          return;
        }

        console.error(`[OOBI] ACCEPT length=${cleaned.length}`);

        statusText.setContent('Sending RFI... waiting for handshake...');
        screen.render();

        try {
          await stack.relationships.connect(cleaned);
          statusText.setContent('RFI sent! Waiting for peer to respond...');
          logPane.log('{green-fg}RFI sent. Waiting for handshake to complete...{/green-fg}');
          screen.render();

          await new Promise(r => setTimeout(r, 800));
          overlay.destroy();
          forceRepaint(screen);
          resolve();
        } catch (e) {
          const err = e as Error;
          // The layer's contract is the stable `code`, NOT the error CLASS. `instanceof` is the fragile half:
          // it breaks under module duplication, which is exactly the hazard here. `src/relationship/types.ts`
          // documents `code` as the distinguishable property, and the web adapter (`web-server.ts`) already
          // tests only this — the TUI reaching for the class was also the last direct `src/` import in
          // `agent-app/`, so dropping it is what lets the boundary guard cover the whole tree.
          const isRelationshipExists = (err as { code?: string })?.code === 'RELATIONSHIP_EXISTS';

          if (isRelationshipExists) {
            console.error('[OOBI] EXISTING: relationship already established — refusing duplicate connect, awaiting ack');
            // Do NOT re-arm the paste input: surface an acknowledgment-required
            // error and return to the pre-paste dashboard state on ack.
            showAlreadyConnectedAck(screen, overlay, logPane, err.message, () => {
              forceRepaint(screen);
              resolve();
            });
            return;
          }

          console.error('[OOBI] FAIL:', err.message);
          console.error('[OOBI] STACK:', err.stack);
          statusText.setContent(`Error: ${err.message}`);
          logPane.log(`{red-fg}Connect error: ${err.message}{/red-fg}`);
          screen.render();
          tryConnect();
        }
      });
    };

    tryConnect();
  });
}

// ---------------------------------------------------------------------------
// showAlreadyConnectedAck — acknowledgment-required error overlay
// ---------------------------------------------------------------------------
//
// Shown when a pasted OOBI resolves to an already-verified relationship.
// The connect attempt is refused (no RFI is sent) and the user must press the
// acknowledgment button to return to the dashboard — the pre-paste state.

function showAlreadyConnectedAck(
  screen: blessed.Widgets.Screen,
  overlay: blessed.Widgets.BoxElement,
  logPane: blessed.Widgets.Log,
  message: string,
  done: () => void,
): void {
  // Remove the paste overlay; we are no longer accepting an OOBI.
  overlay.destroy();

  const ackBox = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '72%',
    height: 10,
    border: { type: 'line' },
    style: { border: { fg: 'red' } },
    label: ' ⚠ Relationship Already Exists ',
    keys: true,
  });

  blessed.text({
    parent: ackBox,
    top: 1,
    left: 2,
    right: 2,
    content: message,
    style: { fg: 'white', bold: true },
  });

  const ackButton = blessed.button({
    parent: ackBox,
    top: 5,
    left: 'center',
    width: 26,
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
  const ack = () => {
    if (handled) return;
    handled = true;
    cleanup();
    logPane.log('{yellow-fg}Closed — this relationship already exists. No new connection was initiated.{/yellow-fg}');
    forceRepaint(screen);
    done();
  };

  const cleanup = () => {
    (screen as any).unkey('enter', ack);
    (screen as any).unkey('space', ack);
    ackButton.destroy();
    ackBox.destroy();
  };

  ackButton.on('press', ack);
  screen.key(['enter', 'space'], ack);
  ackButton.focus();
  screen.render();
}