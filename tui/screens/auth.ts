/**
 * VTA Auth TUI screen — Challenge/response authentication between peers.
 *
 * Allows a user to issue a nonce challenge to a relationship, have the
 * peer auto-sign it, and verify the response.
 *
 * Keybindings:
 *   [Enter] — Select relationship to authenticate
 *   [c]     — Issue challenge to selected peer
 *   [Esc]   — Close
 */

import blessed from 'blessed';
import type { RelationshipDto, TrustStack } from '@p2p-trust-stack/app-api/index.js';
import { forceRepaint } from '../app.js';

export async function showAuthScreen(
  screen: blessed.Widgets.Screen,
  stack: TrustStack,
): Promise<void> {
  const box = blessed.box({
    parent: screen, top: 0, left: 0, right: 0, bottom: 0,
    border: { type: 'line' }, style: { border: { fg: 'green' } },
    label: ' VTA Authentication ',
    keys: true,
  });

  const me = await stack.identity.current();
  blessed.text({
    parent: box, top: 0, left: 1, right: 1, height: 3,
    style: { fg: 'green' },
    content: `Agent: ${me.name ?? '(unnamed)'}\nVID: ${(me.vid ?? '').slice(0, 30)}…`,
  });

  // Relationship list
  const relList = blessed.list({
    parent: box, top: 4, left: 1, width: '50%', bottom: 3,
    keys: true, vi: true, mouse: true,
    border: { type: 'line' },
    label: ' Relationships ',
    style: { selected: { bg: 'green', fg: 'black' }, item: { fg: 'white' } },
  });

  // Result/status pane
  const resultBox = blessed.box({
    parent: box, top: 4, left: '50%+1', right: 1, bottom: 3,
    border: { type: 'line' },
    label: ' Auth Status ',
    scrollable: true,
    keys: true, vi: true, mouse: true,
  });

  blessed.text({
    parent: box, bottom: 0, left: 0, right: 0, height: 3,
    border: { type: 'line' },
    style: { border: { fg: 'green' }, fg: 'white', bg: 'green' },
    content: '  [c] Issue Challenge   [Enter] Select Peer   [Esc] Close',
  });

  let relationships: RelationshipDto[] = [];
  async function refresh() {
    try {
      // Filter out utility-server (organization) relationships — they are not
      // chat/vetting peers. Only human-to-human relationships are vetting-eligible.
      relationships = (await stack.relationships.list()).filter(
        r => r.direction === 'bidirectional' && (r.remoteSubjectKind ?? 'human') !== 'organization',
      );
    } catch (e) {
      relationships = [];
      resultBox.setContent(`  Could not load relationships: ${(e as Error).message}`);
    }
    const items = relationships.length
      ? relationships.map(r => `  ${r.remoteDid.slice(0, 20)}… [${r.status}]`)
      : ['  (no bidirectional relationships)'];
    relList.setItems(items);
    screen.render();
  }

  await refresh();
  relList.focus();
  screen.render();

  // [c] Issue challenge
  //
  // This used to generate a random nonce LOCALLY, print "Challenge sent. Awaiting peer response…", and send
  // NOTHING — the comment admitted it ("In a full implementation, this sends a TSP_GEN message…"). The real
  // mechanism already existed and was already wired for the web app: `relationships.verify(peerDid)` builds a
  // personhood challenge, re-dials the peer and sends it. So the key now does what it always claimed to.
  screen.key(['c'], async () => {
    const idx = (relList as unknown as { selected: number }).selected ?? 0;
    if (relationships.length === 0) {
      resultBox.setContent('  No bidirectional relationships available.\n  Connect via OOBI first, then authenticate.');
      screen.render();
      return;
    }
    const rel = relationships[idx];
    if (!rel) return;

    resultBox.setContent(`  Issuing challenge to peer: ${rel.remoteDid.slice(0, 20)}…\n  Status: sending…`);
    screen.render();

    try {
      const result = await stack.relationships.verify(rel.remoteDid);
      resultBox.setContent(
        `  Challenge sent to: ${rel.remoteDid.slice(0, 20)}…\n  Nonce: ${result.nonce}\n\n`
        + `  ✅ ${result.message}\n`
        + `  The peer's agent will auto-sign this nonce with its Ed25519 key.\n`
        + `  When the signed response arrives, the signature is verified and a\n`
        + `  personhood event is recorded.`,
      );
      showStatus(screen, 'Challenge sent. Awaiting peer response…', 'yellow');
    } catch (e: any) {
      resultBox.setContent(`  Error: ${e.message}`);
      showStatus(screen, `Failed: ${e.message}`, 'red');
    }
    screen.render();
  });

  await new Promise<void>(resolve => {
    screen.key(['escape'], () => { box.destroy(); forceRepaint(screen); resolve(); });
  });
}

function showStatus(s: blessed.Widgets.Screen, msg: string, c: string) {
  const el = blessed.text({ parent: s, bottom: 4, left: 'center', width: 60, height: 1, content: msg, style: { fg: c, bg: 'black' } });
  s.render();
  setTimeout(() => { el.destroy(); s.render(); }, 3000);
}