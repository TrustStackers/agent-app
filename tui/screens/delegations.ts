// SPDX-License-Identifier: GPL-3.0-only OR LicenseRef-TrustStackers-Commercial
// Copyright (C) 2026 Trust Stackers

/**
 * Delegations TUI screen — Manage delegation links between existing VTAs.
 *
 * Shows all delegation relationships (principal → dependent) with
 * relationship type, scope, and status.
 *
 * Keybindings:
 *   [c] — Create new delegation
 *   [r] — Revoke selected delegation
 *   [Esc] — Close
 */

import blessed from 'blessed';
import type { DelegationDto, TrustStack } from '@p2p-trust-stack/app-api/index.js';
import { forceRepaint } from '../app.js';

const REL_TYPE_LABELS: Record<string, string> = {
  operates: 'Operates', owns: 'Owns', represents: 'Represents', employs: 'Employs',
};

export async function showDelegationsScreen(
  screen: blessed.Widgets.Screen,
  stack: TrustStack,
): Promise<void> {
  const box = blessed.box({
    parent: screen, top: 0, left: 0, right: 0, bottom: 0,
    border: { type: 'line' }, style: { border: { fg: 'cyan' } },
    label: ' Delegations ',
    keys: true,
  });

  blessed.text({
    parent: box, top: 0, left: 1, right: 1, height: 2,
    style: { fg: 'green' },
    content: `Agent: ${(await stack.identity.current()).name ?? '(unnamed)'}`,
  });

  const delList = blessed.list({
    parent: box, top: 3, left: 1, right: 1, bottom: 3,
    keys: true, vi: true, mouse: true,
    border: { type: 'line' },
    label: ' Delegation Links ',
    style: { selected: { bg: 'cyan', fg: 'black' }, item: { fg: 'white' } },
  });

  blessed.text({
    parent: box, bottom: 0, left: 0, right: 0, height: 3,
    border: { type: 'line' },
    style: { border: { fg: 'cyan' }, fg: 'white', bg: 'cyan' },
    content: '  [c] Create   [r] Revoke   [Esc] Close',
  });

  // The delegation list, from `stack.delegations`. The DTO is typed, so the old defensive reads
  // (`d.relationship_type`, `d.principal?.id`) are gone — those guessed at a row shape the layer never
  // published, which is what happens when a screen programs to the database instead of to a contract.
  let current: DelegationDto[] = [];
  const short = (u: string) => u.slice(0, 8);
  async function refresh() {
    try {
      current = await stack.delegations.list();
    } catch (e) {
      current = [];
      showStatus(screen, `Could not load delegations: ${(e as Error).message}`, 'red');
    }
    const items = current.length
      ? current.map(d => {
          const type = REL_TYPE_LABELS[d.relationshipType] || d.relationshipType;
          const status = d.revokedAt ? 'revoked' : 'active';
          return `  ${type}: ${short(d.principalIdentityUuid)} → ${short(d.dependentIdentityUuid)}`
            + `${d.scope ? ` [scope: ${d.scope}]` : ''} [${status}]`;
        })
      : ['  (no delegations)'];
    delList.setItems(items);
    screen.render();
  }

  await refresh();
  delList.focus();
  screen.render();

  // [c] Create
  screen.key(['c'], async () => {
    const result = await showCreateDelegation(screen, stack);
    if (result) await refresh();
    delList.focus();
  });

  // [r] Revoke — now REAL.
  //
  // This key used to print "Delegation revoked." and write nothing: there was no revoke anywhere on
  // `AgentHandle`, so the handler was decorative and the confirmation dialog was theatre. It calls
  // `delegations.revoke()` and reports what actually came back.
  screen.key(['r'], async () => {
    const idx = (delList as unknown as { selected: number }).selected ?? 0;
    if (current.length === 0 || idx >= current.length) return;
    const del = current[idx];
    if (del.revokedAt) {
      showStatus(screen, 'Already revoked.', 'yellow');
      return;
    }
    const confirmed = await showConfirm(screen, 'Revoke this delegation?');
    if (!confirmed) return;
    try {
      const revoked = await stack.delegations.revoke(del.uuid);
      showStatus(screen, revoked.revokedAt ? 'Delegation revoked.' : 'Could not revoke.', 'green');
    } catch (e) {
      showStatus(screen, `Error: ${(e as Error).message}`, 'red');
    }
    await refresh();
    delList.focus();
  });

  await new Promise<void>(resolve => {
    screen.key(['escape'], () => { box.destroy(); forceRepaint(screen); resolve(); });
  });
}

function showStatus(s: blessed.Widgets.Screen, msg: string, c: string) {
  const el = blessed.text({ parent: s, bottom: 4, left: 'center', width: 60, height: 1, content: msg, style: { fg: c, bg: 'black' } });
  s.render();
  setTimeout(() => { el.destroy(); s.render(); }, 2500);
}

async function showCreateDelegation(
  screen: blessed.Widgets.Screen,
  stack: TrustStack,
): Promise<boolean> {
  return new Promise(resolve => {
    const overlay = blessed.box({
      parent: screen, top: 'center', left: 'center', width: 62, height: 14,
      border: { type: 'line' }, style: { border: { fg: 'cyan' } },
      label: ' Create Delegation ',
    });

    // Both sides are identity UUIDs. The form used to ask for "Principal ID"/"Dependent ID" as NUMBERS and
    // pass them straight through — but the table keys on `principal_identity_uuid`, and no numeric identity id
    // exists anywhere in the model, so every create either threw or addressed nobody.
    blessed.text({ parent: overlay, top: 1, left: 2, content: 'Principal UUID:', style: { fg: 'white' } });
    const princInput = blessed.textbox({
      parent: overlay, top: 1, left: 18, width: 40, height: 1,
      style: { fg: 'yellow', bg: 'black' }, keys: true, mouse: true,
    });

    blessed.text({ parent: overlay, top: 3, left: 2, content: 'Dependent UUID:', style: { fg: 'white' } });
    const depInput = blessed.textbox({
      parent: overlay, top: 3, left: 18, width: 40, height: 1,
      style: { fg: 'yellow', bg: 'black' }, keys: true, mouse: true,
    });

    blessed.text({ parent: overlay, top: 5, left: 2, content: 'Type (operates/owns/represents/employs):', style: { fg: 'white' } });
    const typeInput = blessed.textbox({
      parent: overlay, top: 6, left: 2, width: 20, height: 1,
      style: { fg: 'yellow', bg: 'black' }, keys: true, mouse: true,
    });

    blessed.text({ parent: overlay, top: 8, left: 2, content: 'Scope (JSON, optional):', style: { fg: 'white' } });
    const scopeInput = blessed.textbox({
      parent: overlay, top: 9, left: 2, width: 40, height: 1,
      style: { fg: 'yellow', bg: 'black' }, keys: true, mouse: true,
    });

    blessed.text({ parent: overlay, bottom: 1, left: 2, content: '[Enter] Create  [Esc] Cancel', style: { fg: 'yellow' } });

    princInput.focus();
    screen.render();

    princInput.readInput(async (err, princVal) => {
      if (err || !princVal?.trim()) { overlay.destroy(); screen.render(); resolve(false); return; }
      depInput.focus();
      screen.render();
      depInput.readInput(async (_e2, depVal) => {
        if (!depVal?.trim()) { overlay.destroy(); screen.render(); resolve(false); return; }
        typeInput.focus();
        screen.render();
        typeInput.readInput(async (_e3, typeVal) => {
          scopeInput.focus();
          screen.render();
          scopeInput.readInput(async (_e4, scopeVal) => {
            try {
              await stack.delegations.create({
                principalIdentityUuid: princVal.trim(),
                dependentIdentityUuid: depVal.trim(),
                // The domain validates this against the table's CHECK set and reports `invalid_input` with the
                // allowed list, so the default here is a convenience rather than the only guard.
                relationshipType: (typeVal?.trim() || 'operates') as never,
                ...(scopeVal?.trim() ? { scope: scopeVal.trim() } : {}),
              });
              overlay.destroy();
              forceRepaint(screen);
              resolve(true);
            } catch (e: any) {
              showStatus(screen, `Error: ${e.message}`, 'red');
              overlay.destroy();
              forceRepaint(screen);
              resolve(false);
            }
          });
        });
      });
    });
  });
}

async function showConfirm(
  screen: blessed.Widgets.Screen,
  message: string,
): Promise<boolean> {
  return new Promise(resolve => {
    const overlay = blessed.box({
      parent: screen, top: 'center', left: 'center', width: 40, height: 8,
      border: { type: 'line' }, style: { border: { fg: 'red' } },
      label: ' Confirm ',
    });
    blessed.text({ parent: overlay, top: 1, left: 2, right: 2, content: message, style: { fg: 'white' } });
    blessed.text({ parent: overlay, bottom: 1, left: 2, content: '[y] Yes  [n] No', style: { fg: 'yellow' } });
    overlay.focus();
    screen.render();
    function yes() { cleanup(); resolve(true); }
    function no() { cleanup(); resolve(false); }
    function cleanup() { (screen as any).unkey('y', yes); (screen as any).unkey('n', no); }
    screen.key(['y'], yes);
    screen.key(['n'], () => { overlay.destroy(); forceRepaint(screen); resolve(false); });
  });
}