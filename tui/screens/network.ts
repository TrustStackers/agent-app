// SPDX-License-Identifier: GPL-3.0-only OR LicenseRef-TrustStackers-Commercial
// Copyright (C) 2026 Trust Stackers

/**
 * Network screen — the TUI's bootstrap boxes + VTN picker.
 *
 * Web parity: `agent-app/web/index.html` has the same two steps, and both go
 * through `bootstrap-config.ts` / the `connectivity` domain, so the TUI and the
 * web UI read and write exactly the same values.
 *
 *   1. `promptBootstrapConfig` — the bootstrap host + peer ID, pre-filled from the
 *      saved override or `agent-app/.env`. The agent is a CLIENT: it holds no seed,
 *      only the address of the bootstrap/relay to register with and the peer ID to
 *      expect.
 *   2. `promptVtnJoin` — the VTNs the bootstrap peer directory advertises. One
 *      bootstrap server can host several utility servers, each serving its own
 *      VTN, so the user picks the NETWORK and the agent dials the server that
 *      serves it.
 */

import blessed from 'blessed';
import type { BootstrapConfigApi, TrustStack } from '@p2p-trust-stack/app-api/index.js';
import { forceRepaint } from '../app.js';

/** The two bootstrap boxes, as the user left them. */
export interface BootstrapChoice {
  host: string;
  peerId: string;
}

/**
 * Ask for the bootstrap server address + peer ID.
 *
 * Pre-filled from the saved override or `.env`, so accepting the default is just
 * [Enter]. Returns null when the user cancels — the caller then proceeds with
 * whatever is already configured (or LAN-only mode).
 */
export async function promptBootstrapConfig(
  screen: blessed.Widgets.Screen,
  config: BootstrapConfigApi,
): Promise<BootstrapChoice | null> {
  const view = config.view();

  const box = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '80%',
    height: 13,
    border: { type: 'line' },
    style: { border: { fg: 'cyan' } },
    label: ' Bootstrap Server ',
  });

  blessed.text({
    parent: box,
    top: 0,
    left: 2,
    right: 2,
    content: view.source === 'none'
      ? 'No bootstrap server configured — fill both in, or leave blank for LAN-only mode.'
      : view.source === 'config'
        ? 'Saved setting. Accept it, or change either value.'
        : 'Default from .env. Accept it, or change either value.',
    style: { fg: 'white' },
  });

  blessed.text({ parent: box, top: 2, left: 2, content: 'Host / IP', style: { fg: 'yellow' } });
  const hostInput = blessed.textbox({
    parent: box,
    top: 3,
    left: 2,
    right: 2,
    height: 1,
    value: view.host,
    keys: true,
    mouse: true,
    style: { fg: 'black', bg: 'blue' },
  });

  blessed.text({ parent: box, top: 5, left: 2, content: 'Peer ID', style: { fg: 'yellow' } });
  const peerInput = blessed.textbox({
    parent: box,
    top: 6,
    left: 2,
    right: 2,
    height: 1,
    value: view.peerId,
    keys: true,
    mouse: true,
    style: { fg: 'black', bg: 'blue' },
  });

  blessed.text({
    parent: box,
    bottom: 1,
    left: 2,
    content: '[Enter] Accept  [Esc] Keep current setting',
    style: { fg: 'yellow' },
  });

  screen.render();

  // `readInput()` with a callback (not `inputOnFocus`) — the blessed textbox
  // contract the sibling screens document: while a textbox is reading input it
  // owns every keystroke, so a screen-level key binding cannot fire meanwhile.
  const readField = (field: blessed.Widgets.TextboxElement): Promise<void> =>
    new Promise((resolve) => {
      field.readInput(() => resolve());
    });

  const host = await readField(hostInput).then(() => (hostInput.getValue() ?? '').trim());
  const peerId = await readField(peerInput).then(() => (peerInput.getValue() ?? '').trim());

  box.destroy();
  forceRepaint(screen);
  return { host, peerId };
}

/**
 * Show the VTNs the bootstrap advertises and join the chosen one.
 *
 * Returns the VTN key that was joined, or null when the user skipped / nothing was
 * available. A list of zero is reported in place rather than skipped silently: the
 * operator needs to know that no utility server has bound a namespace yet, because
 * name registration stays unavailable until one does.
 */
export async function promptVtnJoin(
  screen: blessed.Widgets.Screen,
  stack: TrustStack,
): Promise<string | null> {
  let vtns: Awaited<ReturnType<TrustStack['connectivity']['vtns']>>;
  try {
    vtns = await stack.connectivity.vtns();
  } catch (err) {
    showNotice(screen, `Could not list networks: ${(err as Error).message}`, 'red');
    return null;
  }

  if (vtns.length === 0) {
    showNotice(
      screen,
      'No networks (VTNs) are registered on this bootstrap server yet — name registration ' +
      'stays unavailable until a utility server binds a namespace.',
      'yellow',
    );
    return null;
  }

  const box = blessed.box({
    parent: screen,
    top: 'center',
    left: 'center',
    width: '70%',
    height: 12,
    border: { type: 'line' },
    style: { border: { fg: 'cyan' } },
    label: ' Join a Network (VTN) ',
  });

  blessed.text({
    parent: box,
    top: 0,
    left: 2,
    right: 2,
    content: 'Several utility servers can share one bootstrap server. Pick the network to join.',
    style: { fg: 'white' },
  });

  const list = blessed.list({
    parent: box,
    top: 2,
    left: 2,
    right: 2,
    bottom: 3,
    keys: true,
    vi: true,
    mouse: true,
    items: vtns.map(
      (v) => `  ${v.vtnKey.padEnd(16)}${v.vtnName ? v.vtnName + '  ' : ''}(${v.peerId.slice(0, 12)}…)`,
    ),
    style: { selected: { bg: 'cyan', fg: 'black' }, item: { fg: 'white' } },
  });

  blessed.text({
    parent: box,
    bottom: 1,
    left: 2,
    content: '[Enter] Join  [Esc] Skip (join later)',
    style: { fg: 'yellow' },
  });

  list.focus();
  screen.render();

  // The escape handler is declared OUTSIDE the promise so it can be unregistered
  // afterwards — a screen-level key binding that outlives this overlay would steal
  // [Esc] from the dashboard.
  let settle: ((index: number | null) => void) | null = null;
  const onEscape = () => settle?.(null);

  const chosen = await new Promise<number | null>((resolve) => {
    settle = resolve;
    screen.key(['escape'], onEscape);
    list.key(['enter'], () => resolve((list as unknown as { selected: number }).selected ?? 0));
    list.focus();
    screen.render();
  });

  // `removeKey` is typed as (keys, listener) in these typings, so it cannot
  // unregister a listener it was not handed — the sibling screens `unkey` with a
  // cast for the same reason.
  (screen as unknown as { unkey: (k: string, l: () => void) => void }).unkey('escape', onEscape);
  box.destroy();
  forceRepaint(screen);
  if (chosen === null) return null;

  const option = vtns[chosen];
  if (!option) return null;

  try {
    await stack.connectivity.connectVtn(option.vtnKey);
    showNotice(screen, `Joined ${option.vtnKey}.`, 'green');
    return option.vtnKey;
  } catch (err) {
    // The layer words the failure (bootstrap unreachable / relay refreshing / no
    // server for that VTN) — show it as-is rather than inventing a message.
    showNotice(screen, `Could not join ${option.vtnKey}: ${(err as Error).message}`, 'red');
    return null;
  }
}

/** A transient notice box. */
function showNotice(screen: blessed.Widgets.Screen, message: string, color: string): void {
  const el = blessed.text({
    parent: screen,
    bottom: 2,
    left: 'center',
    width: '80%',
    height: 3,
    border: { type: 'line' },
    content: message,
    style: { fg: color, border: { fg: color } },
  });
  screen.render();
  setTimeout(() => { el.destroy(); forceRepaint(screen); }, 3000);
}
