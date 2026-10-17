// SPDX-License-Identifier: GPL-3.0-only OR LicenseRef-TrustStackers-Commercial
// Copyright (C) 2026 Trust Stackers

/**
 * Shared personhood-ceremony panel for the agent web UI.
 *
 * Renders the "I know this person" gate IN PLACE inside the relationship row it
 * belongs to. One SERVER-OWNED 60s window drives every display: the deadline
 * comes from the relationship record (`relationships.created_at` +
 * `VRC_CEREMONY_ACK_TIMEOUT_MS`), so both peers' browsers count down to the
 * same absolute instant instead of each running a private timer of its own.
 *
 * Server state is the single source of truth. The only client-side state is an
 * optimistic `pressed` flag, which keeps the button hidden between the press
 * and the server echoing `localAcked` back (a poll can lag up to ~2s).
 *
 * States rendered (all copy lives here, so every surface reads the same):
 *   awaiting-both    window open, nobody pressed   -> button + countdown
 *   peer-confirmed   peer pressed first            -> button + countdown + notice
 *   awaiting-peer    local press recorded          -> countdown only
 *   creating         mutual ack; minting/sharing   -> "creating credentials"
 *   expired          window passed, not mutual     -> cancelled notice
 *   failed           saga failed at a step         -> failure notice
 *   done             ceremony complete             -> panel disappears (DTG)
 *
 * Classic script (no modules), matching assets/nav.js — the agent web UI is
 * plain HTML + classic scripts. Load AFTER assets/nav.js:
 *   <script src="assets/ceremony-panel.js"></script>
 *
 * Page wiring (typically from the existing /api/relationships poll):
 *   CeremonyPanel.setLog(addEvent);
 *   CeremonyPanel.setOnChange(function (vid) { /* refresh that row *\/ });
 *   CeremonyPanel.update(remoteDid, { ack: r.ack, phase: null });
 *   CeremonyPanel.render(remoteDid, document.getElementById('cer-' + did));
 */
(function () {
  'use strict';

  /** Countdown refresh cadence (ms). Cheaper than the 2s server poll. */
  var TICK_MS = 250;

  /** remoteDid -> { ack, phase, failedStep, lastError, pressed, resetRequested } */
  var states = {};
  /** remoteDid -> container element (the row's expansion div). */
  var containers = {};
  var ticker = null;
  var logFn = function () {};
  var onChange = null;

  function el(id) { return document.getElementById(id); }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function countId(remoteDid) { return 'cer-count-' + encodeURIComponent(remoteDid); }

  function stateFor(remoteDid) {
    if (!states[remoteDid]) {
      states[remoteDid] = {
        ack: null, phase: null, failedStep: null, lastError: null,
        pressed: false, resetRequested: false,
      };
    }
    return states[remoteDid];
  }

  function log(msg, cls) {
    try { logFn(msg, cls); } catch (e) { /* page logger must never break the panel */ }
  }

  // ── Server state ───────────────────────────────────────────────────────────────────────────────

  /**
   * Merge fresh server state for one peer.
   *
   * `patch.ack` is the server-owned window view; `patch.phase` is the saga
   * phase ('personhood' | 'minting' | 'sharing' | 'complete' | 'failed').
   * Callers may pass either or both; unknown fields are retained.
   */
  function update(remoteDid, patch) {
    if (!remoteDid) return null;
    var st = stateFor(remoteDid);
    if (patch) {
      if (patch.ack) st.ack = patch.ack;
      if (patch.phase) st.phase = patch.phase;
      if (typeof patch.failedStep !== 'undefined') st.failedStep = patch.failedStep;
      if (typeof patch.lastError !== 'undefined') st.lastError = patch.lastError;
    }
    // The server has recorded the press: drop the optimistic flag for good.
    if (st.ack && st.ack.localAcked) st.pressed = true;
    return st;
  }

  /** Which state applies for this peer right now. */
  function kindOf(st) {
    if (!st || !st.ack) return st && st.phase === 'failed' ? 'failed' : 'none';
    if (st.phase === 'complete') return 'done';
    if (st.phase === 'failed') return 'failed';
    // Mutual ack leaves the gate: the countdown is OVER even if the saga row
    // still reports phase 'personhood' (it does for as long as a mint leg is
    // retrying), because both users have already confirmed.
    if (st.ack.mutual) return 'creating';
    if (st.pressed && !st.ack.localAcked) return 'awaiting-peer';
    if (!st.ack.active) return 'expired';
    if (!st.ack.localAcked) return st.ack.remoteAcked ? 'peer-confirmed' : 'awaiting-both';
    return 'awaiting-peer';
  }

  function showCountdown(kind) {
    return kind === 'awaiting-both' || kind === 'peer-confirmed' || kind === 'awaiting-peer';
  }

  function showButton(kind) {
    return kind === 'awaiting-both' || kind === 'peer-confirmed';
  }

  function secondsLeft(st) {
    if (!st || !st.ack) return 0;
    return Math.max(0, Math.ceil((st.ack.deadlineMs - Date.now()) / 1000));
  }

  function messageFor(kind, st) {
    switch (kind) {
      case 'awaiting-both':
        return 'Confirm you know each other \u2014 both of you must press within the time shown.';
      case 'peer-confirmed':
        return 'The other agent has confirmed they know you \u2014 please confirm you know them.';
      case 'awaiting-peer':
        return 'You confirmed. Waiting for the other user to confirm\u2026';
      case 'creating':
        return 'Creating relationship credentials, please wait\u2026';
      case 'expired':
        return 'Ceremony cancelled \u2014 the confirmation window closed with nothing created. Start a new OOBI exchange to try again.';
      case 'failed':
        return 'Ceremony could not complete' +
          (st.failedStep ? ' (step "' + esc(st.failedStep) + '")' : '') +
          (st.lastError ? ': ' + esc(st.lastError) : '.') +
          ' Start a new OOBI exchange to try again.';
      default:
        return '';
    }
  }

  // ── Rendering ──────────────────────────────────────────────────────────────────────────────────

  /**
   * Render (or refresh) the ceremony expansion for one peer.
   *
   * Each poll rebuilds the markup, so the delegated click handler below is the
   * ONLY listener — nothing to unwire when a row is re-created.
   */
  function render(remoteDid, container) {
    if (!remoteDid) return;
    if (container) containers[remoteDid] = container;
    var node = containers[remoteDid];
    if (!node) return;
    var st = stateFor(remoteDid);
    var kind = kindOf(st);

    if (kind === 'none' || kind === 'done') {
      node.className = 'rel-ceremony';
      node.innerHTML = '';
      node.style.display = 'none';
      return;
    }

    node.style.display = '';
    node.className = 'rel-ceremony cer-' + kind;

    var html = '<span class="cer-msg">' + messageFor(kind, st) + '</span>';
    if (showCountdown(kind)) {
      html += '<span class="cer-count" id="' + countId(remoteDid) + '">'
        + '\u23f1 ' + secondsLeft(st) + 's</span>';
    }
    if (showButton(kind)) {
      html += '<button class="cer-btn" data-cer-action="press" data-cer-vid="'
        + esc(remoteDid) + '">I know this person</button>';
    }
    node.innerHTML = html;

    if (showCountdown(kind)) ensureTicker();
  }

  /** Refresh just the countdown text (never the button markup). */
  function tick() {
    var live = false;
    for (var vid in states) {
      var st = states[vid];
      var kind = kindOf(st);
      if (!showCountdown(kind)) continue;
      live = true;
      var left = secondsLeft(st);
      var span = el(countId(vid));
      if (span) span.textContent = '\u23f1 ' + left + 's';
      // Window closed and the pair never reached mutual ack. Ask the server to
      // clear the attempt now so the row disappears immediately instead of
      // waiting up to one driver tick (~4s). The server re-validates the gate,
      // so this is idempotent and cannot tear down a progressing ceremony.
      if (left <= 0 && !st.resetRequested && st.ack && st.ack.active) {
        st.resetRequested = true;
        requestReset(vid);
      }
    }
    if (!live) stopTicker();
  }

  function ensureTicker() {
    if (ticker) return;
    ticker = setInterval(tick, TICK_MS);
  }

  function stopTicker() {
    if (!ticker) return;
    clearInterval(ticker);
    ticker = null;
  }

  // ── Actions ────────────────────────────────────────────────────────────────────────────────────

  function post(path) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error((d && d.error && d.error.message) || ('HTTP ' + r.status));
        return d;
      });
    });
  }

  /**
   * The local user pressed "I know this person".
   *
   * One press per exchange: the button is hidden immediately and is NOT
   * restored even if the send fails — the window governs, and a fresh OOBI
   * exchange is the way to retry.
   */
  function press(remoteDid) {
    var st = stateFor(remoteDid);
    if (st.pressed) return;
    st.pressed = true;
    render(remoteDid);
    log('Acknowledging you know this person\u2026', 'c-info');
    post('/api/relationships/' + encodeURIComponent(remoteDid) + '/acknowledge')
      .then(function () {
        log('Confirmation recorded \u2014 waiting for the other user to confirm.', 'c-connect');
        if (onChange) onChange(remoteDid);
      })
      .catch(function (e) {
        log('Failed: ' + e.message
          + ' \u2014 the pending exchange will be cancelled; start a new OOBI exchange to try again.', 'c-err');
        if (onChange) onChange(remoteDid);
      });
  }

  /** Ask the server to clear the attempt (mirrors the server-side sweep). */
  function requestReset(remoteDid) {
    post('/api/relationships/' + encodeURIComponent(remoteDid) + '/ceremony/reset')
      .then(function (res) {
        if (res && res.reset) {
          log('Ceremony cancelled \u2014 nothing was created. Start a new OOBI exchange to try again.', 'c-err');
        }
        if (onChange) onChange(remoteDid);
      })
      .catch(function () { /* the server-side sweep is authoritative */ });
  }

  /** Drop all rendered/derived state for a peer (row gone, or exchange over). */
  function forget(remoteDid) {
    delete states[remoteDid];
    delete containers[remoteDid];
    if (!Object.keys(states).length) stopTicker();
  }

  /** Forget every peer NOT in `keepDids` (drives the "row disappeared" reset). */
  function prune(keepDids) {
    var keep = keepDids || {};
    for (var vid in states) {
      if (!keep[vid]) forget(vid);
    }
  }

  // ── Server-pushed lifecycle ────────────────────────────────────────────────────────────────────

  /**
   * Handle a ceremony-* SSE event pushed by the agent's web server, so both
   * displays react within milliseconds instead of waiting for the 2s poll.
   * Wire from the page's existing EventSource:
   *   ['ceremony-state','ceremony-expired','ceremony-complete','ceremony-failed']
   *     .forEach(function (n) { es.addEventListener(n, function (ev) {
   *       CeremonyPanel.handleSseEvent(n, JSON.parse(ev.data)); }); });
   */
  function handleSseEvent(name, data) {
    var remoteDid = data && (data.remoteDid || data.remoteVid);
    if (remoteDid) {
      if (name === 'ceremony-expired') {
        forget(remoteDid);
        log('Ceremony cancelled \u2014 the confirmation window closed and the connection attempt was cleared. '
          + 'Start a new OOBI exchange to try again.', 'c-err');
      } else if (name === 'ceremony-complete') {
        // Intentionally logged by the page's ceremony-status poll instead
        // (guarded so the line appears exactly once), not here.
      } else if (name === 'ceremony-failed') {
        log('Ceremony failed' + (data.step ? ' at step "' + data.step + '"' : '')
          + (data.error ? ': ' + data.error : ''), 'c-err');
      }
    }
    if (onChange) onChange(remoteDid);
  }

  // One delegated listener: rows are rebuilt on every poll, so per-button
  // listeners would leak and would need re-binding constantly.
  document.addEventListener('click', function (ev) {
    var btn = ev.target && ev.target.closest ? ev.target.closest('[data-cer-action]') : null;
    if (!btn) return;
    var vid = btn.getAttribute('data-cer-vid');
    if (!vid) return;
    if (btn.getAttribute('data-cer-action') === 'press') {
      ev.preventDefault();
      press(vid);
    }
  });

  window.CeremonyPanel = {
    /** Merge server state for a peer. */
    update: update,
    /** Render the row's ceremony expansion. */
    render: render,
    /** Press "I know this person" for a peer. */
    press: press,
    /** Forget a peer (row removed / exchange over). */
    forget: forget,
    /** Forget every peer not present in `keepDids`. */
    prune: prune,
    /** Apply a ceremony-* SSE event. */
    handleSseEvent: handleSseEvent,
    /** Event-log sink (the page's addEvent). */
    setLog: function (fn) { logFn = fn || function () {}; },
    /** Called after any state change so the page can refresh that row. */
    setOnChange: function (fn) { onChange = fn || null; },
    /** Read-only state for debugging. */
    debugState: function (remoteDid) {
      var st = states[remoteDid];
      return st ? { kind: kindOf(st), secondsLeft: secondsLeft(st), ack: st.ack, phase: st.phase } : null;
    },
  };
})();
