// SPDX-License-Identifier: Apache-2.0
// Copyright (C) 2026 Trust Stackers

/**
 * Minimal boot sequence for an agent built on the P2P Trust Stack.
 *
 * This file is part of the `examples/` carve-out and is licensed
 * **Apache-2.0** (see ./LICENSE), not under the repository's GPL-3.0-only +
 * commercial dual license. Copy these patterns into your own application
 * freely. The SDK it imports (`@p2p-trust-stack/app-api`) is separately
 * licensed, so your own distribution still has to account for that.
 *
 * Run it:
 *
 *   AGENT_NAME=alice AGENT_PASSPHRASE=secret \
 *     node --experimental-strip-types boot-agent.ts
 *
 * The three things worth copying:
 *
 *   1. `createAgentStack` creates OR unlocks the agent but does NOT start it.
 *   2. Subscribe to the event bus BEFORE `start()`. The bus records events it
 *      saw, but you do not want to reconstruct your UI from a replay.
 *   3. `stop()` on the way out, so the keystore and databases close cleanly.
 */

import { createAgentStack } from '@p2p-trust-stack/app-api/index.js';

const stack = await createAgentStack({
  agent: {
    name: process.env.AGENT_NAME ?? 'alice',
    passphrase: process.env.AGENT_PASSPHRASE ?? 'change-me',
  },
});

// (2) Subscribe first.
stack.on('message.received', (event) => {
  console.log('message from', event.peerDid);
});

stack.on('connection.open', (event) => {
  console.log('peer up', event.peerId);
});

// (1) Only now start the runtime.
await stack.start((status) => console.log('[boot]', status));

const me = await stack.identity.current();
console.log('running as', me.did);

console.log('OOBI:', await stack.relationships.oobi());

// (3) Close cleanly on Ctrl-C.
process.once('SIGINT', () => {
  void stack.stop().then(() => process.exit(0));
});
