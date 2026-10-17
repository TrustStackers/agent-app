// SPDX-License-Identifier: GPL-3.0-only OR LicenseRef-TrustStackers-Commercial
// Copyright (C) 2026 Trust Stackers

/**
 * Profiles TUI screen — Full profile management with claims, visibility,
 * R-Card preview, and default profile selection.
 *
 * Layout:
 *   - Top: VTA selector (choose which identity to manage)
 *   - Left pane: Profile list with Manage/Set Default/Remove buttons
 *   - Right pane: Claims for selected profile + Add Claim form + R-Card
 *
 * Keybindings:
 *   [Enter] — Select profile to manage claims
 *   [c]     — Create new profile
 *   [d]     — Set selected as default
 *   [r]     — Remove selected profile
 *   [a]     — Add claim to selected profile
 *   [p]     — Preview R-Card
 *   [Esc]   — Close screen
 */

import blessed from 'blessed';
import type { ProfileDto, TrustStack } from '@p2p-trust-stack/app-api/index.js';
import { forceRepaint } from '../app.js';

export async function showProfilesScreen(
  screen: blessed.Widgets.Screen,
  stack: TrustStack,
): Promise<void> {
  let selectedProfileId: string | null = null;
  let profiles: ProfileDto[] = [];
  // Read once, up front: the layout below renders it before any refresh runs.
  const me = await stack.identity.current();

  const box = blessed.box({
    parent: screen, top: 0, left: 0, right: 0, bottom: 0,
    border: { type: 'line' }, style: { border: { fg: 'magenta' } },
    label: ' Profiles & Claims ',
    keys: true,
  });

  // ── Layout ──────────────────────────────────────────────────────────
  const infoText = blessed.text({
    parent: box, top: 0, left: 1, right: 1, height: 3,
    content: formatVtaInfo(me.name, me.did),
    style: { fg: 'green' },
  });

  // Left: profile list
  const profileList = blessed.list({
    parent: box, top: 4, left: 1, width: '50%', bottom: 3,
    keys: true, vi: true, mouse: true,
    border: { type: 'line' },
    label: ' Profiles ',
    style: { selected: { bg: 'magenta', fg: 'black' }, item: { fg: 'white' } },
  });

  // Right: claims panel
  const claimsBox = blessed.box({
    parent: box, top: 4, left: '50%+1', right: 1, bottom: 3,
    border: { type: 'line' },
    label: ' Claims ',
    scrollable: true,
    keys: true, vi: true, mouse: true,
  });

  // Bottom bar
  blessed.text({
    parent: box, bottom: 0, left: 0, right: 0, height: 3,
    border: { type: 'line' },
    style: { border: { fg: 'magenta' }, fg: 'white', bg: 'magenta' },
    content:
      '  [c] Create Profile   [d] Set Default   [r] Remove Profile   [a] Add Claim   [p] Preview R-Card   [Esc] Close',
  });

  // ── Helpers ─────────────────────────────────────────────────────────
  // The identity is passed as DATA rather than as a handle: a formatter has no business holding the agent.
  function formatVtaInfo(name: string | undefined, did: string | undefined): string {
    return `Agent: ${name ?? '(unnamed)'}\nDID: ${(did ?? '').slice(0, 40)}…`;
  }

  async function refreshProfiles() {
    profiles = await stack.profiles.list();
    // Also refresh the R-Card sync status so the user can tell when the
    // utility server hasn't yet acknowledged a profile change.
    const sync = await stack.profiles.syncStatus();
    const syncLine = sync.pending
      ? `  ⚠ R-Card sync PENDING — ${sync.lastError ?? 'retry scheduled'}`.slice(0, 78)
      : '  R-Card sync: up to date with utility server';
    infoText.setContent(`${formatVtaInfo(me.name, me.did)}\n${syncLine}`);
    const items = profiles.length
      ? profiles.map(p => `  ${p.isDefault ? '★ ' : '  '}${p.label.padEnd(20)} [${p.visibility}] ${p.purpose ? ' — ' + p.purpose.slice(0, 30) : ''}`)
      : ['  (no profiles yet)'];
    profileList.setItems(items);
    screen.render();
  }

  async function refreshClaims() {
    if (selectedProfileId === null) {
      claimsBox.setContent('  Select a profile to view claims.');
      screen.render();
      return;
    }
    const claims = await stack.profiles.claims(selectedProfileId);
    const lines = claims.length
      ? claims.map(c => {
          const val = c.disclosure === 'zkp_only'
            ? `commitment: ${(c.commitment || '').slice(0, 16)}…`
            : c.claimValue || '(no value)';
          return `  ${c.claimKey}: ${val}  [${c.disclosure}]`;
        })
      : ['  No claims yet. Press [a] to add one.'];
    const profile = profiles.find(p => p.uuid === selectedProfileId);
    const header = profile
      ? `  Profile: ${profile.label} (${profile.visibility})${profile.isDefault ? ' [Default]' : ''}\n  Purpose: ${profile.purpose || '—'}\n${'─'.repeat(40)}`
      : '';
    claimsBox.setContent(header + '\n' + lines.join('\n'));
    screen.render();
  }

  // ── Initial render ──────────────────────────────────────────────────
  refreshProfiles();
  profileList.focus();
  screen.render();

  // ── Profile selection ───────────────────────────────────────────────
  profileList.on('select', (_item, index) => {
    if (profiles.length === 0) return;
    const selected = profiles[index];
    if (!selected) return;
    selectedProfileId = selected.uuid;
    refreshClaims();
  });

  // ── Key bindings ─────────────────────────────────────────────────────
  // [c] Create new profile
  screen.key(['c'], async () => {
    const result = await showCreateProfileOverlay(screen, stack);
    if (result) {
      refreshProfiles();
    }
    profileList.focus();
  });

  // [d] Set default
  screen.key(['d'], async () => {
    if (selectedProfileId === null) {
      showStatus(screen, 'Select a profile first using [Enter].', 'yellow');
      return;
    }
    try {
      // Awaited. The old handler fired `agent.updateProfile(...)` without awaiting it, so a refusal was
      // swallowed and the refresh below raced the write it was meant to reflect.
      await stack.profiles.update(selectedProfileId, { setDefault: true });
      showStatus(screen, 'Default profile updated.', 'green');
      await refreshProfiles();
    } catch (e: any) {
      showStatus(screen, `Error: ${e.message}`, 'red');
    }
  });

  // [r] Remove profile
  screen.key(['r'], async () => {
    if (selectedProfileId === null) {
      showStatus(screen, 'Select a profile first using [Enter].', 'yellow');
      return;
    }
    if (profiles.length <= 1) {
      showStatus(screen, 'Cannot remove the last profile.', 'red');
      return;
    }
    const confirmed = await showConfirmOverlay(screen, `Remove profile? This deletes all claims.`);
    if (!confirmed) return;
    try {
      await stack.profiles.remove(selectedProfileId);
      selectedProfileId = null;
      await refreshProfiles();
      claimsBox.setContent('  Select a profile to view claims.');
      showStatus(screen, 'Profile removed.', 'green');
    } catch (e: any) {
      showStatus(screen, `Error: ${e.message}`, 'red');
    }
  });

  // [a] Add claim
  screen.key(['a'], async () => {
    if (selectedProfileId === null) {
      showStatus(screen, 'Select a profile first using [Enter].', 'yellow');
      return;
    }
    const result = await showAddClaimOverlay(screen, stack, selectedProfileId);
    if (result) refreshClaims();
    profileList.focus();
  });

  // [p] Preview R-Card
  screen.key(['p'], async () => {
    if (selectedProfileId === null) {
      showStatus(screen, 'Select a profile first using [Enter].', 'yellow');
      return;
    }
    await showRCardOverlay(screen, stack, selectedProfileId);
    profileList.focus();
  });

  // [Esc] Close
  await new Promise<void>(resolve => {
    screen.key(['escape'], () => {
      box.destroy();
      forceRepaint(screen);
      resolve();
    });
  });
}

// ── Overlay Helpers ──────────────────────────────────────────────────────

function showStatus(screen: blessed.Widgets.Screen, msg: string, color: string) {
  const status = blessed.text({
    parent: screen, bottom: 4, left: 'center', width: 60, height: 1,
    content: msg, style: { fg: color, bg: 'black' },
  });
  screen.render();
  setTimeout(() => { status.destroy(); screen.render(); }, 2500);
}

async function showCreateProfileOverlay(
  screen: blessed.Widgets.Screen,
  stack: TrustStack,
): Promise<boolean> {
  let result = false;
  return new Promise(resolve => {
    const overlay = blessed.box({
      parent: screen, top: 'center', left: 'center', width: 50, height: 12,
      border: { type: 'line' }, style: { border: { fg: 'magenta' } },
      label: ' Create Profile ',
    });

    blessed.text({ parent: overlay, top: 1, left: 2, content: 'Label:', style: { fg: 'white' } });
    const labelInput = blessed.textbox({
      parent: overlay, top: 1, left: 10, width: 30, height: 1,
      style: { fg: 'yellow', bg: 'black' }, keys: true, mouse: true,
    });

    blessed.text({ parent: overlay, top: 3, left: 2, content: 'Purpose:', style: { fg: 'white' } });
    const purposeInput = blessed.textbox({
      parent: overlay, top: 3, left: 10, width: 30, height: 1,
      style: { fg: 'yellow', bg: 'black' }, keys: true, mouse: true,
    });

    blessed.text({ parent: overlay, top: 5, left: 2, content: 'Visibility (private/selective/public):', style: { fg: 'white' } });
    const visInput = blessed.textbox({
      parent: overlay, top: 5, left: 40, width: 10, height: 1,
      style: { fg: 'yellow', bg: 'black' }, keys: true, mouse: true,
    });

    blessed.text({ parent: overlay, bottom: 1, left: 2, content: '[Enter] Create  [Esc] Cancel', style: { fg: 'yellow' } });

    labelInput.focus();
    screen.render();

    labelInput.readInput(async (err, labelVal) => {
      if (err || !labelVal || !labelVal.trim()) { overlay.destroy(); screen.render(); resolve(false); return; }
      purposeInput.focus();
      screen.render();
      purposeInput.readInput(async (_e2, purposeVal) => {
        visInput.focus();
        screen.render();
        visInput.readInput(async (_e3, visVal) => {
          const visibility = (visVal?.trim() || 'private') as any;
          try {
            await stack.profiles.create({
              label: labelVal.trim(),
              purpose: purposeVal?.trim() || undefined,
              visibility,
            });
            result = true;
          } catch (e: any) {
            showStatus(screen, `Error: ${e.message}`, 'red');
          }
          overlay.destroy();
          forceRepaint(screen);
          resolve(result);
        });
      });
    });
  });
}

async function showAddClaimOverlay(
  screen: blessed.Widgets.Screen,
  stack: TrustStack,
  profileUuid: string,
): Promise<boolean> {
  let result = false;
  return new Promise(resolve => {
    const overlay = blessed.box({
      parent: screen, top: 'center', left: 'center', width: 55, height: 14,
      border: { type: 'line' }, style: { border: { fg: 'cyan' } },
      label: ' Add Claim ',
    });

    blessed.text({ parent: overlay, top: 1, left: 2, content: 'Key:', style: { fg: 'white' } });
    const keyInput = blessed.textbox({
      parent: overlay, top: 1, left: 8, width: 30, height: 1,
      style: { fg: 'yellow', bg: 'black' }, keys: true, mouse: true,
    });

    blessed.text({ parent: overlay, top: 3, left: 2, content: 'Value:', style: { fg: 'white' } });
    const valInput = blessed.textbox({
      parent: overlay, top: 3, left: 8, width: 30, height: 1,
      style: { fg: 'yellow', bg: 'black' }, keys: true, mouse: true,
    });

    blessed.text({ parent: overlay, top: 5, left: 2, content: 'Disclosure (always/discretionary/never/zkp_only):', style: { fg: 'white' } });
    const discInput = blessed.textbox({
      parent: overlay, top: 6, left: 2, width: 20, height: 1,
      style: { fg: 'yellow', bg: 'black' }, keys: true, mouse: true,
    });

    blessed.text({ parent: overlay, bottom: 1, left: 2, content: '[Enter] Add  [Esc] Cancel', style: { fg: 'yellow' } });

    keyInput.focus();
    screen.render();

    keyInput.readInput(async (err, keyVal) => {
      if (err || !keyVal || !keyVal.trim()) { overlay.destroy(); screen.render(); resolve(false); return; }
      valInput.focus();
      screen.render();
      valInput.readInput(async (_e2, valueVal) => {
        discInput.focus();
        screen.render();
        discInput.readInput(async (_e3, discVal) => {
          try {
            await stack.profiles.addClaim({
              profileUuid,
              claimKey: keyVal.trim(),
              claimValue: valueVal?.trim() || null,
              disclosure: (discVal?.trim() || 'discretionary') as any,
            });
            result = true;
          } catch (e: any) {
            showStatus(screen, `Error: ${e.message}`, 'red');
          }
          overlay.destroy();
          forceRepaint(screen);
          resolve(result);
        });
      });
    });
  });
}

async function showRCardOverlay(
  screen: blessed.Widgets.Screen,
  stack: TrustStack,
  profileUuid: string,
): Promise<void> {
  return new Promise(async resolve => {
    // Own-profile convenience: request ALL of this profile's discretionary
    // claim keys so the preview shows the full card rather than hiding them.
    let requestedKeys: string[] = [];
    try {
      const allClaims = await stack.profiles.claims(profileUuid);
      requestedKeys = allClaims
        .filter(c => c.disclosure === 'discretionary')
        .map(c => String(c.claimKey))
        .filter(k => k.length > 0);
    } catch { /* fall back to public-only card */ }

    const card = await stack.profiles.card(profileUuid, requestedKeys.length > 0 ? requestedKeys : undefined);
    const lines = [
      `  Profile: ${card.label}`,
      `  Purpose: ${card.purpose || '—'}`,
      `  Visibility: ${card.visibility}`,
      `  Identity UUID: ${card.identityUuid}`,
      '',
      '  Claims:',
      ...card.claims.map(c => {
        const val = c.value ?? (c.commitment ? `commitment:${c.commitment.slice(0, 20)}…` : '(hidden)');
        return `    ${c.key}: ${val} [${c.disclosure}]`;
      }),
    ];

    const overlay = blessed.box({
      parent: screen, top: 'center', left: 'center', width: 60, height: 18,
      border: { type: 'line' }, style: { border: { fg: 'green' } },
      label: ' R-Card Preview ',
      scrollable: true, keys: true, vi: true, mouse: true,
    });

    blessed.text({
      parent: overlay, top: 0, left: 2, right: 2, bottom: 2,
      content: lines.join('\n'),
      style: { fg: 'white' },
    });

    blessed.text({
      parent: overlay, bottom: 0, left: 2,
      content: '[Esc] Close',
      style: { fg: 'yellow' },
    });

    overlay.focus();
    screen.render();

    screen.key(['escape'], () => {
      overlay.destroy();
      forceRepaint(screen);
      resolve();
    });
  });
}

async function showConfirmOverlay(
  screen: blessed.Widgets.Screen,
  message: string,
): Promise<boolean> {
  return new Promise(resolve => {
    const overlay = blessed.box({
      parent: screen, top: 'center', left: 'center', width: 40, height: 8,
      border: { type: 'line' }, style: { border: { fg: 'red' } },
      label: ' Confirm ',
    });

    blessed.text({
      parent: overlay, top: 1, left: 2, right: 2,
      content: message, style: { fg: 'white' },
    });

    blessed.text({
      parent: overlay, bottom: 1, left: 2,
      content: '[y] Yes  [n] No',
      style: { fg: 'yellow' },
    });

    overlay.focus();
    screen.render();

    function yesHandler() { cleanup(); resolve(true); }
    function noHandler() { cleanup(); resolve(false); }
    function cleanup() {
      (screen as any).unkey('y', yesHandler);
      (screen as any).unkey('n', noHandler);
      (screen as any).unkey('escape', noHandler);
    }

    screen.key(['y'], yesHandler);
    screen.key(['n', 'escape'], () => { overlay.destroy(); forceRepaint(screen); resolve(false); });
  });
}