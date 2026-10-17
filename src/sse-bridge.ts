// SPDX-License-Identifier: GPL-3.0-only OR LicenseRef-TrustStackers-Commercial
// Copyright (C) 2026 Trust Stackers

/**
 * SSE bridge — the ONE place the agent's event bus becomes browser pushes.
 *
 * Extracted from `web-server.ts`, which owns the HTTP surface and nothing else. Keeping the translation here means
 * the adapter file stays a thin layer over `trust-app-api` and this bus→wire table can be read on its own.
 *
 * ## Why the wire names are still the legacy ones
 *
 * The pages listen for `message`, `ceremony-state`, … — names that predate the bus. Translating HERE, rather than
 * in each page, is what lets the UI move to bus-shaped subscriptions one page at a time without a flag day.
 *
 * ## Why `message` is not a straight forward
 *
 * `message.received` deliberately carries no body: putting one on the bus would duplicate every message into the
 * durable outbox. The bridge therefore reads the entry that was just persisted. `receivedAt` is that entry's
 * `time`, which is the SAME row `GET /api/chat/:id/log` returns — that identity is what lets the UI de-duplicate
 * a live push against a transcript re-render sharing one DOM id.
 */
import type { TrustStack } from '@p2p-trust-stack/app-api/index.js';

/** A connected browser, as far as the hub is concerned. */
export interface SseClient {
  write(data: string): void;
  end(): void;
}

/** The set of connected browsers, and the only way to push to them. */
export interface SseHub {
  add(client: SseClient): void;
  remove(client: SseClient): void;
  /** Connected browser count — used by the bridge's diagnostic log. */
  clientCount(): number;
  broadcast(event: string, data: unknown): void;
}

/** Create the connection registry. One hub per server; every route shares it. */
export function createSseHub(): SseHub {
  const clients = new Set<SseClient>();
  return {
    add(client) { clients.add(client); },
    remove(client) { clients.delete(client); },
    clientCount() { return clients.size; },
    broadcast(event, data) {
      const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      for (const client of clients) {
        // A disconnected client throws on write; that must not stop the other clients receiving the event.
        try { client.write(payload); } catch { /* client disconnected */ }
      }
    },
  };
}

export interface SseBridgeOptions {
  hub: SseHub;
  /** The `trust-app-api` layer. Absent when the server runs without one. */
  stack?: TrustStack;
}

/**
 * Subscribe the hub to the bus.
 *
 * Every push this bridge makes now comes from a bus event. It used to hold the runtime handle for ONE
 * subscription (`onDuplicateConnectNotice`) because the catalogue had no event for it — the bridge was the
 * documented exception to the boundary. `duplicate.connect.notice` closed that, so the bridge takes only a
 * `TrustStack` and cannot reach the runtime at all.
 *
 * @returns a dispose function removing every subscription made here. Call it before re-bridging a newly
 * activated agent, so swapping agents cannot leave the previous agent's subscriptions attached.
 */
export function bridgeEventsToSse({ hub, stack }: SseBridgeOptions): () => void {
  if (!stack) return () => {};

  const subscriptions = [
    stack.on('message.received', (p) => {
      void (async () => {
        const entry = await stack.messaging.latest(p.peerDid);
        if (!entry) return;
        console.log(
          `[sse-bridge] ↑ 'message' → ${hub.clientCount()} client(s): peer=${p.peerDid.slice(0, 12)}...`,
        );
        hub.broadcast('message', {
          remoteDid: p.peerDid,
          body: entry.text,
          confidential: entry.confidential === true,
          receivedAt: entry.time,
        });
      })();
    }),

    // The runtime exposes the ceremony as five separate callbacks; the bus unifies them under
    // `relationship.ceremony` with `step` distinguishing the leg, so this is ONE subscription rather than five.
    stack.on('relationship.ceremony', (p) => {
      const name =
        p.step === 'failed' ? 'ceremony-failed'
        : p.step === 'expired' ? 'ceremony-expired'
        : p.step === 'complete' ? 'ceremony-complete'
        : 'ceremony-state';
      hub.broadcast(name, { remoteDid: p.peerDid });
    }),

    // A relationship changed. This name is NEW rather than legacy: the pages had no push for it and polled
    // `/api/relationships` every 2 s instead, so a migrated page opts into `relationship-changed` while an
    // unmigrated one simply never listens for it. The status is included so a page can decide whether to re-read.
    stack.on('relationship.changed', (p) => {
      hub.broadcast('relationship-changed', { remoteDid: p.peerDid, status: p.status });
    }),

    // A credential was delivered. Both names are NEW for the same reason as `relationship-changed`: the pages
    // polled (`nav.js` every 5 s for invitations, `credentials.html` every 3 s for the credential list) because
    // nothing announced an arrival. They carry only identity — a page re-reads its own endpoint for the shape it
    // renders, so the wire contract stays small.
    stack.on('credential.issued', (p) => {
      hub.broadcast('credential-issued', { uuid: p.uuid, vcType: p.vcType });
    }),

    // A VIC *is* an invitation, so the receive path emits both; the pages listen for the one they render.
    stack.on('invitation.received', (p) => {
      hub.broadcast('invitation-received', { uuid: p.uuid, communityUuid: p.communityUuid });
    }),

    // Declining an invitation is the other half of the badge: without this the badge would only ever go up.
    stack.on('invitation.changed', (p) => {
      hub.broadcast('invitation-changed', { uuid: p.uuid, status: p.status });
    }),

    // Revoking a credential changes the list the same way.
    stack.on('credential.changed', (p) => {
      hub.broadcast('credential-changed', { uuid: p.uuid, status: p.status });
    }),

    // A community arrived, or its governance changed. Both names are NEW for the same reason as
    // `relationship-changed`: `communities.html` and `rules.html` polled because nothing announced either.
    //
    // `kind` is carried on the wire rather than split into two names, so a page can decide what to re-read —
    // `membership` means the community list, `governance` means that community's rules. Sending one name with a
    // discriminator keeps the "one page, one handler" shape the other wire names already have.
    stack.on('community.changed', (p) => {
      hub.broadcast('community-changed', { communityUuid: p.communityUuid, kind: p.kind });
    }),

    // A governance-change proposal arrived, so the Rules page re-reads its pending list.
    stack.on('governance.proposal', (p) => {
      hub.broadcast('governance-proposal', { proposalId: p.proposalId, communityUuid: p.communityUuid });
    }),

    // A founding ceremony advanced (a co-signature landed). This retires the LAST poll: `communities.html`
    // polled `/api/ceremony-log` every 4 s precisely because nothing announced ceremony progress, and the
    // community does not exist before crystallization so no other event could carry it.
    stack.on('ceremony.step', (p) => {
      hub.broadcast('ceremony-step', { threadId: p.threadId, step: p.step });
    }),

    // Duplicate-connect notices. These used to be the ONE subscription taken directly on the runtime handle,
    // because the catalogue had no event for them — which made this file a place a caller could reach around
    // the layer. `duplicate.connect.notice` now exists, so the bridge is a pure bus consumer and the pages get
    // the same push without the layer carrying an exception.
    stack.on('duplicate.connect.notice', (p) => {
      hub.broadcast('duplicate-connect-notice', { remoteDid: p.peerDid, remoteName: p.remoteName });
    }),
  ];

  return () => { for (const sub of subscriptions) sub.unsubscribe(); };
}
