// SPDX-License-Identifier: GPL-3.0-only OR LicenseRef-TrustStackers-Commercial
// Copyright (C) 2026 Trust Stackers

/**
 * Chat screen.
 *
 * Shown when the user selects a bidirectional relationship on the dashboard.
 * Displays a scrolling message history and an input box for sending messages.
 *
 * Keybindings:
 *   [Enter]   Send message (plain or confidential depending on mode)
 *   [Esc]     Return to dashboard
 *
 * Mode toggle: press [m] while the input box is NOT in readInput mode
 * (i.e. between sends) to toggle plain/confidential. The mode indicator
 * updates immediately.
 *
 * Uses readInput(callback) — the correct blessed API — instead of
 * inputOnFocus + .key() bindings, which conflict with the internal _done handler.
 */

import blessed from 'blessed';
import type { RelationshipDto, TrustStack } from '@p2p-trust-stack/app-api/index.js';
import { forceRepaint } from '../app.js';

// ---------------------------------------------------------------------------
// showChatScreen
// ---------------------------------------------------------------------------

export async function showChatScreen(
  screen: blessed.Widgets.Screen,
  stack: TrustStack,
  relationship: RelationshipDto,
  dashboardLog: blessed.Widgets.Log,
): Promise<void> {
  const remoteDidShort = relationship.remoteDid.slice(0, 20) + '...';
  let confidentialMode = false;
  let closed = false;

  // Force a full repaint immediately on entry — clears any stale diff-cache
  // artifacts from the previous screen (dashboard or prior chat visit).
  forceRepaint(screen);

  return new Promise((resolve) => {
    // ── Layout ──────────────────────────────────────────────────────────────

    // Is this peer a VERIFIED contact?
    //
    // The badge used to come from scanning `listVrcsForSelf()` for a VRC whose `issuer`/`subject` matched the
    // peer and whose `status` was `'issued'` — but a `Vrc` has **none of those fields** (it carries
    // `subjectVid`/`issuerVid`/`claim`/`issuedAt`), and `subjectVid` is a CESR key while a relationship is
    // addressed by DID, so the comparison could never be true either. The relationship itself already carries
    // the answer, and it is the field that means exactly what the badge claims.
    const verified = relationship.personhoodStatus === 'verified';

    const verifiedLabel = verified ? ' 🔒 VERIFIED' : '';

    const chatBox = blessed.box({
      parent: screen,
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      border: { type: 'line' },
      style: { border: { fg: verified ? 'green' : 'magenta' } },
      label: ` Chat with ${remoteDidShort}${verifiedLabel} `,
    });

    // Message history
    // bottom: 2 leaves room for: 1 row mode indicator + 1 row inputBox (no border)
    const messageLog = blessed.log({
      parent: chatBox,
      top: 0,
      left: 0,
      right: 0,
      bottom: 6,
      scrollable: true,
      alwaysScroll: true,
      scrollbar: { ch: '│', style: { fg: 'magenta' } },
      mouse: true,
      tags: true,
    });

    // Mode indicator — sits in the 1 row between messageLog and inputBox
    const modeIndicator = blessed.text({
      parent: chatBox,
      bottom: 5,
      left: 1,
      right: 1,
      height: 1,
      content: getModeLabel(confidentialMode),
      style: { fg: 'white' },
    });

    const inputBox = blessed.textbox({
      parent: chatBox,
      bottom: 1,
      left: 1,
      right: 1,
      height: 3,
      border: { type: 'line' },
      style: {
        border: { fg: 'white' },
        fg: 'white',
        bg: 'black', 
      },
      keys: true,
      mouse: true,
      label: ' Message - [Enter] Send  [Esc] Close chat ',
    });

    // ── Initial messages ────────────────────────────────────────────────────

    messageLog.log(`{cyan-fg}--- Chat with ${remoteDidShort} ---{/cyan-fg}`);
    messageLog.log(`{yellow-fg}Press [m] between messages to toggle plain/confidential mode.{/yellow-fg}`);
    messageLog.log('');

    // ── Incoming messages ───────────────────────────────────────────────────

    // Inbound messages.
    //
    // `message.received` deliberately does NOT carry the message body — it would duplicate every message into
    // the event outbox — so the text is read from the transcript. `recordInboundMessage` appends BEFORE it
    // emits, so the entry is always there by the time this runs. The `filter` means only this peer's messages
    // wake the handler at all.
    const messageHandler = async () => {
      try {
        const entry = await stack.messaging.latest(relationship.remoteDid);
        if (!entry) return;
        const tag = entry.confidential
          ? '{magenta-fg} [confidential]{/magenta-fg}'
          : '{white-fg} [plain]{/white-fg}';
        messageLog.log(`${tag} {cyan-fg}Peer:{/cyan-fg} ${entry.text}`);
        screen.render();
      } catch {
        /* a transcript read must never break the chat */
      }
    };
    const inboundSub = stack.on('message.received', messageHandler, { filter: { peerDid: relationship.remoteDid } });

    // ── Close helper ────────────────────────────────────────────────────────

    const closeChat = () => {
      if (closed) return;
      closed = true;
      // Release the subscription. The old `agent.onMessage(handler)` had no handle to release, so every visit
      // to this screen left a handler behind that kept logging into a destroyed widget.
      inboundSub.unsubscribe();
      chatBox.destroy();
      forceRepaint(screen);
      resolve();
    };

    // ── Send loop: readInput → send → loop ──────────────────────────────────

    const sendLoop = () => {
      if (closed) return;

      // Update mode indicator (inputBox has no border/label, so we only update modeIndicator)
      modeIndicator.setContent(getModeLabel(confidentialMode));
      inputBox.focus();
      // screen.render();
      forceRepaint(screen);

      inputBox.readInput(async (err, text) => {
        if (closed) return;

        // Esc or null → close chat
        if (err || text == null) {
          closeChat();
          return;
        }

        const trimmed = text.trim();
        if (!trimmed) {
          // Empty input — loop again
          sendLoop();
          return;
        }

        const body = new TextEncoder().encode(trimmed);
        const tag = confidentialMode
          ? '{magenta-fg} [confidential]{/magenta-fg}'
          : '{white-fg} [plain]{/white-fg}';

        try {
          // One call, not two branches: `messaging.send` takes confidentiality as an option, so the
          // plain/confidential split that used to pick between two runtime methods is now data.
          //
          // The runtime's per-step `onStatus` progress callback is deliberately NOT part of the domain
          // contract — callers act on the outcome, and the outcome is still reported: a failure lands in the
          // catch below, and the send's own error carries a typed `code` (e.g. `not_ready` for a one-sided
          // relationship).
          await stack.messaging.send(relationship.remoteDid, body, { confidential: confidentialMode });
          messageLog.log(`${tag} {green-fg}You:{/green-fg} ${trimmed}`);
          dashboardLog.log(`${tag} {green-fg}Sent to ${remoteDidShort}:{/green-fg} "${trimmed}"`);
          inputBox.clearValue();
        } catch (e) {
          messageLog.log(`{red-fg}Send error: ${(e as Error).message}{/red-fg}`);
        }


        // Loop for next message
        sendLoop();
      });
    };

    // [m] — toggle mode. We intercept 'm' at the screen level, but when
    // readInput is active the textbox captures all keystrokes first.
    // The trick: listen on the inputBox's keypress event (fires before
    // readInput's internal handler) and, if the box is empty and the user
    // presses 'm', toggle mode and suppress the character.
    //
    // We also keep the screen-level binding for the brief window between
    // readInput calls (e.g. while the send is in flight).
    inputBox.on('keypress', (ch: string, key: { name: string }) => {
      if (closed) return;
      // Only intercept 'm' when the input box is empty (user hasn't started typing).
      const currentValue = (inputBox as unknown as { value: string }).value ?? '';
      if ((key.name === 'm' || ch === 'm') && currentValue === '') {
        confidentialMode = !confidentialMode;
        modeIndicator.setContent(getModeLabel(confidentialMode));
        screen.render();
        // Prevent the 'm' from being inserted into the textbox.
        // blessed doesn't have a standard "consume" API, so we clear the value
        // immediately after the keypress handler runs.
        setImmediate(() => {
          const v = (inputBox as unknown as { value: string }).value ?? '';
          if (v === 'm') {
            inputBox.clearValue();
            screen.render();
          }
        });
      }
    });

    screen.key(['m'], () => {
      if (closed) return;
      // Only toggle if the input box is not focused / empty.
      const currentValue = (inputBox as unknown as { value: string }).value ?? '';
      if (currentValue === '') {
        confidentialMode = !confidentialMode;
        modeIndicator.setContent(getModeLabel(confidentialMode));
        screen.render();
      }
    });

    // Start the send loop
    sendLoop();
  });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getModeLabel(confidential: boolean): string {
  return confidential
    ? 'Confidential mode (HPKE-Auth encrypted)  [m] to switch'
    : 'Plain mode (signed, unencrypted)  [m] to switch to confidential';
}