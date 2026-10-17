// SPDX-License-Identifier: GPL-3.0-only OR LicenseRef-TrustStackers-Commercial
// Copyright (C) 2026 Trust Stackers

/**
 * Credentials TUI screen — View, verify, and manage credentials.
 *
 * Shows all credentials filtered by type/status, with verification
 * details and revocation support.
 *
 * Keybindings:
 *   [Enter] — Select credential for detail view
 *   [v]     — Verify selected credential
 *   [r]     — Revoke selected credential
 *   [f]     — Filter by type
 *   [s]     — Filter by status
 *   [Esc]   — Close
 */

import blessed from 'blessed';
import type { CredentialDto, TrustStack } from '@p2p-trust-stack/app-api/index.js';
import { forceRepaint } from '../app.js';

const VC_TYPE_LABELS: Record<string, string> = {
  vmc: 'VMC', vrc: 'VRC', vec: 'VEC', custom_endorsement: 'Custom', delegation: 'Delegation',
};

/**
 * One row, flattened from the `CredentialDto` union for display.
 *
 * The two stores are genuinely different shapes, so the flattening is explicit rather than assumed: the old
 * screen read `c.vcType` / `c.issuer` / `c.subject` / `c.status` off a raw `Vrc`, and **none of those fields
 * exist on that type** (`Vrc` carries `subjectVid` / `issuerVid` / `claim` / `issuedAt`), so every row rendered
 * `?` for its type, issuer and subject. Programming to a published DTO is what stops that class of bug.
 */
interface CredRow {
  source: 'dtg' | 'vtc';
  /** `vcType` for a DTG row, `claimType` for a VTC-store one. */
  label: string;
  issuer: string;
  subject: string;
  status: string;
  /**
   * The addressing triple for `credentials.verify()`, or null when this row cannot be verified.
   *
   * Only VTC-store credentials are verifiable: `verify()` resolves them by
   * `(subjectVid, issuerVid, claimType)`, which is the store's own key. A DTG row has a uuid and no such
   * triple.
   */
  verifyKey: { subjectVid: string; issuerVid: string; claimType: string } | null;
  /**
   * The uuid for `credentials.revoke()`, or null when this row has none.
   *
   * The exact mirror of `verifyKey`, and for the same reason: the two stores are keyed differently. A DTG row
   * has a uuid; the VTC store's CESR rows have no uuid at all, so they cannot be revoked by this API. Both
   * fields make "which store is this, and what can I do with it?" a compile-time distinction rather than a
   * runtime surprise.
   *
   * `revoke()` took a node-local SQLite rowid until 2026-10-10, which no DTO published — so this key was a
   * permanent stub. Now that it is uuid-addressed, the key is live for every DTG row.
   */
  credentialUuid: string | null;
}

function toRow(c: CredentialDto): CredRow {
  if (c.source === 'vtc') {
    return {
      source: 'vtc',
      label: c.claimType || 'vrc',
      issuer: c.issuerVid,
      subject: c.subjectVid,
      status: c.expiresAt && c.expiresAt * 1000 < Date.now() ? 'expired' : 'issued',
      verifyKey: { subjectVid: c.subjectVid, issuerVid: c.issuerVid, claimType: c.claimType },
      credentialUuid: null, // the VTC store's CESR rows have no uuid — see the field note
    };
  }
  return {
    source: 'dtg',
    label: c.vcType,
    issuer: c.issuerIdentityUuid,
    subject: c.subjectIdentityUuid,
    status: c.status,
    verifyKey: null,
    credentialUuid: c.uuid,
  };
}

export async function showCredentialsScreen(
  screen: blessed.Widgets.Screen,
  stack: TrustStack,
): Promise<void> {
  let filterType: string | null = null;
  let filterStatus: string | null = null;
  let selectedIndex = 0;
  let rows: CredRow[] = [];

  const box = blessed.box({
    parent: screen, top: 0, left: 0, right: 0, bottom: 0,
    border: { type: 'line' }, style: { border: { fg: 'yellow' } },
    label: ' Credentials ',
    keys: true,
  });

  // ── Stats header ────────────────────────────────────────────────────
  const statsText = blessed.text({
    parent: box, top: 0, left: 1, right: 1, height: 4,
    style: { fg: 'white' },
  });

  // Credential list
  const credList = blessed.list({
    parent: box, top: 5, left: 1, right: 1, bottom: 3,
    keys: true, vi: true, mouse: true,
    border: { type: 'line' },
    label: ' Credentials ',
    style: { selected: { bg: 'yellow', fg: 'black' }, item: { fg: 'white' } },
  });

  // Filter status line
  blessed.text({
    parent: box, bottom: 0, left: 0, right: 0, height: 3,
    border: { type: 'line' },
    style: { border: { fg: 'yellow' }, fg: 'white', bg: 'yellow' },
    content: '  [v] Verify   [r] Revoke   [f] Filter Type   [s] Filter Status   [a] All   [Esc] Close',
  });

  function getFiltered(): CredRow[] {
    let creds = rows;
    if (filterType) creds = creds.filter(c => c.label === filterType);
    if (filterStatus) creds = creds.filter(c => c.status === filterStatus);
    return creds;
  }

  function renderStats(all: CredRow[]) {
    const count = (t: string) => all.filter(c => c.label === t).length;
    const vmc = count('vmc');
    const vrc = count('vrc');
    const vec = count('vec');
    const other = all.length - vmc - vrc - vec;
    const revoked = all.filter(c => c.status === 'revoked').length;
    const fType = filterType ? ` [Type: ${filterType}]` : '';
    const fStat = filterStatus ? ` [Status: ${filterStatus}]` : '';
    statsText.setContent(
      `  VMCs: ${vmc}  VRCs: ${vrc}  VECs: ${vec}  Other: ${other}  Revoked: ${revoked}${fType}${fStat}`,
    );
  }

  async function refresh() {
    try {
      rows = (await stack.credentials.list()).map(toRow);
    } catch (e) {
      rows = [];
      showStatusMsg(screen, `Could not load credentials: ${(e as Error).message}`, 'red');
    }
    renderStats(rows);

    const filtered = getFiltered();
    const items = filtered.length
      ? filtered.map((c, i) => {
          const prefix = i === selectedIndex ? '▶ ' : '  ';
          const type = VC_TYPE_LABELS[c.label] || c.label;
          return `${prefix}${type} — ${c.subject.slice(0, 16)}… (by ${c.issuer.slice(0, 16)}…) [${c.status}]`;
        })
      : ['  (no credentials)'];
    credList.setItems(items);
    screen.render();
  }

  await refresh();
  credList.focus();
  screen.render();

  // ── Selection ───────────────────────────────────────────────────────
  credList.on('select', async (_item, index) => {
    const creds = getFiltered();
    if (creds.length === 0) return;
    selectedIndex = index;
    const cred = creds[index];
    if (!cred) return;
    await showDetailOverlay(screen, cred);
    credList.focus();
  });

  // ── [v] Verify ──────────────────────────────────────────────────────
  screen.key(['v'], async () => {
    const creds = getFiltered();
    if (creds.length === 0) return;
    const cred = creds[selectedIndex];
    if (!cred) return;
    if (!cred.verifyKey) {
      // Not a "failed verification" — there is no way to ADDRESS this credential for verification. Saying so
      // is the point: the layer keeps "could not be checked" apart from "did not check out", and so does this.
      showStatusMsg(screen, 'This credential cannot be verified here: only VTC-issued credentials carry the issuer/subject/claim key the verifier addresses by.', 'yellow');
      return;
    }

    const overlay = blessed.box({
      parent: screen, top: 'center', left: 'center', width: 60, height: 12,
      border: { type: 'line' }, style: { border: { fg: 'yellow' } },
      label: ' Verify Credential ',
    });

    blessed.text({
      parent: overlay, top: 1, left: 2, content: 'Verifying…',
      style: { fg: 'yellow' },
    });
    screen.render();

    try {
      const result = await stack.credentials.verify(cred.verifyKey);
      const lines = result.valid
        ? [`  ✅ Valid — ${result.validSignatureCount} admin signature(s) verified.`]
        : [`  ❌ Not valid — ${result.reason ?? 'no reason given'}`];
      overlay.destroy();
      const resultBox = blessed.box({
        parent: screen, top: 'center', left: 'center', width: 60, height: 8,
        border: { type: 'line' },
        style: { border: { fg: result.valid ? 'green' : 'red' } },
        label: ' Verification Result ',
      });
      blessed.text({
        parent: resultBox, top: 1, left: 2, content: lines.join('\n'),
        style: { fg: result.valid ? 'green' : 'red' },
      });
      blessed.text({
        parent: resultBox, bottom: 1, left: 2, content: '[Esc] Close',
        style: { fg: 'yellow' },
      });
      resultBox.focus();
      screen.render();
      await new Promise<void>(resolve => {
        screen.key(['escape'], () => { resultBox.destroy(); forceRepaint(screen); resolve(); });
      });
    } catch (e: any) {
      // A `not_found` here means the check could not be ATTEMPTED (no such credential, or no governance
      // document for its issuer) — a different answer from "it did not check out".
      overlay.destroy();
      showStatusMsg(screen, `Verify error: ${e.message}`, 'red');
    }
    await refresh();
    credList.focus();
  });

  // ── [r] Revoke ──────────────────────────────────────────────────────
  // Live as of 2026-10-10.
  //
  // This was an honest stub whose message named a real blocker: the original handler printed "Revocation
  // requested. Credential status will update." and wrote NOTHING, and it could not be wired either, because
  // `credentials.revoke()` was addressed by a node-local SQLite rowid that no DTO published — there was no value
  // to pass it. The method takes a uuid now, and `StoredCredentialDto.uuid` is what `toRow` puts on
  // `credentialUuid`, so the key does the thing instead of describing why it cannot.
  //
  // VTC-store rows still cannot be revoked — that store's CESR credentials have no uuid at all. The key says so
  // rather than failing silently, which is the same distinction `verifyKey` draws in the other direction.
  screen.key(['r'], async () => {
    const creds = getFiltered();
    if (creds.length === 0) return;
    const cred = creds[selectedIndex];
    if (!cred) return;
    if (cred.status === 'revoked') {
      showStatusMsg(screen, 'Credential is already revoked.', 'yellow');
      return;
    }
    if (!cred.credentialUuid) {
      showStatusMsg(
        screen,
        'This credential lives in the VTC store, whose CESR rows carry no uuid — revoke it from the issuing community instead.',
        'yellow',
      );
      credList.focus();
      return;
    }
    const confirmed = await showConfirm(screen, 'Revoke this credential? This cannot be undone.');
    if (!confirmed) {
      credList.focus();
      return;
    }
    try {
      const revoked = await stack.credentials.revoke(cred.credentialUuid);
      showStatusMsg(
        screen,
        revoked
          ? `Revoked ${revoked.vcType} ${revoked.uuid.slice(0, 8)}…`
          : 'No such credential — the list may be stale. Reopen to refresh.',
        revoked ? 'green' : 'yellow',
      );
    } catch (e: any) {
      showStatusMsg(screen, `Revoke failed: ${e.message}`, 'red');
    }
    await refresh();
    credList.focus();
  });

  // ── [f] Filter by type ──────────────────────────────────────────────
  screen.key(['f'], async () => {
    filterType = await showFilterSelect(screen, ['vmc', 'vrc', 'vec', 'custom_endorsement', 'delegation'], 'Select type:');
    await refresh();
    credList.focus();
  });

  // ── [s] Filter by status ────────────────────────────────────────────
  screen.key(['s'], async () => {
    filterStatus = await showFilterSelect(screen, ['issued', 'pending_signatures', 'revoked', 'expired'], 'Select status:');
    await refresh();
    credList.focus();
  });

  // ── [a] Clear filters ───────────────────────────────────────────────
  screen.key(['a'], async () => {
    filterType = null;
    filterStatus = null;
    await refresh();
    credList.focus();
  });

  // ── [Esc] Close ─────────────────────────────────────────────────────
  await new Promise<void>(resolve => {
    screen.key(['escape'], () => {
      box.destroy();
      forceRepaint(screen);
      resolve();
    });
  });
}

// ── Helpers ──────────────────────────────────────────────────────────────

function showStatusMsg(screen: blessed.Widgets.Screen, msg: string, color: string) {
  const s = blessed.text({
    parent: screen, bottom: 4, left: 'center', width: 60, height: 1,
    content: msg, style: { fg: color, bg: 'black' },
  });
  screen.render();
  setTimeout(() => { s.destroy(); screen.render(); }, 2500);
}

async function showDetailOverlay(
  screen: blessed.Widgets.Screen,
  cred: CredRow,
): Promise<void> {
  return new Promise(resolve => {
    const lines = [
      `Source:   ${cred.source === 'vtc' ? 'VTC store (community-issued)' : 'DTG store'}`,
      `Type:     ${VC_TYPE_LABELS[cred.label] || cred.label}`,
      `Issuer:   ${cred.issuer || 'unknown'}`,
      `Subject:  ${cred.subject || 'unknown'}`,
      `Status:   ${cred.status}`,
      `Verifiable here: ${cred.verifyKey ? 'yes' : 'no'}`,
    ];

    const overlay = blessed.box({
      parent: screen, top: 'center', left: 'center', width: 65, height: 18,
      border: { type: 'line' }, style: { border: { fg: 'cyan' } },
      label: ' Credential Detail ',
      scrollable: true, keys: true, vi: true, mouse: true,
    });

    blessed.text({
      parent: overlay, top: 0, left: 1, right: 1, bottom: 2,
      content: lines.join('\n'),
      style: { fg: 'white' },
    });

    blessed.text({
      parent: overlay, bottom: 0, left: 2, content: '[Esc] Close',
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

async function showFilterSelect(
  screen: blessed.Widgets.Screen,
  options: string[],
  prompt: string,
): Promise<string | null> {
  return new Promise(resolve => {
    const overlay = blessed.box({
      parent: screen, top: 'center', left: 'center', width: 40, height: options.length + 6,
      border: { type: 'line' }, style: { border: { fg: 'cyan' } },
      label: ` ${prompt} `,
    });

    const list = blessed.list({
      parent: overlay, top: 1, left: 2, right: 2, bottom: 2,
      items: ['  (clear filter)', ...options.map(o => `  ${o}`)],
      keys: true, vi: true, mouse: true,
      style: { selected: { bg: 'cyan', fg: 'black' }, item: { fg: 'white' } },
    });

    list.focus();
    screen.render();

    list.on('select', (_item, index) => {
      overlay.destroy();
      forceRepaint(screen);
      resolve(index === 0 ? null : options[index - 1]);
    });

    (screen as any).onceKey('escape', () => {
      overlay.destroy();
      forceRepaint(screen);
      resolve(null);
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
    function cleanup() {
      (screen as any).unkey('y', yes);
      (screen as any).unkey('n', no);
      (screen as any).unkey('escape', no);
    }

    screen.key(['y'], yes);
    screen.key(['n', 'escape'], () => { overlay.destroy(); forceRepaint(screen); resolve(false); });
  });
}