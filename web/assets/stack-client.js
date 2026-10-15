/**
 * AgentStack — the shared browser client for the trust-app-api notification stream.
 *
 * ## Why this file exists
 *
 * Before it, every page did two things for itself: it opened its own `EventSource('/api/events')` (three pages
 * did, so one state change produced three connections), and it defined its own `apiGet`/`apiPost` helpers
 * (duplicated across the pages). Both are now here, once.
 *
 * ## One connection per BROWSER — not per page, not per tab
 *
 * A browser caps concurrent HTTP/1.1 connections to one origin at six, and that pool is shared by every tab and
 * by every request (HTML, assets, `fetch`). An SSE response never ends, so each open stream holds a slot for its
 * whole life. When every page opened its own stream, a handful of open tabs filled the pool and the NEXT page's
 * requests sat in the browser in `Stalled`/`Queueing` — never reaching the server — until a refresh freed a slot.
 * (The server log shows nothing, because the request never left the browser.)
 *
 * So the stream is now owned by ONE tab (the "leader") and every other tab receives the same events over a
 * `BroadcastChannel`. The wire contract is unchanged: `on(name, fn)` still takes the wire name the server emits
 * and handlers still receive the parsed payload. Nothing above this file knows how many tabs are open.
 *
 * ## Event names
 *
 * `on(name, fn)` takes the **wire** name the server emits. Those are currently the legacy names
 * (`message`, `ceremony-state`, `relationship-changed`, …) because the adapter translates bus events to them
 * so the existing pages keep working; migrating a page to a bus-shaped name is therefore a change in ONE
 * place — the translation table in `web-server.ts` — rather than in every page.
 *
 * ## Lifecycle
 *
 * The stream is opened lazily on the first `on()`. `pagehide` closes it deterministically so a navigated-away
 * page cannot leave a slot held, and the departing leader announces itself so another tab takes over at once.
 * Where `BroadcastChannel` is unavailable the tab simply owns its own stream (the previous behaviour), so the
 * file still works on an older browser.
 */
(function (global) {
  'use strict';

  /** Channel name shared by every tab of the app. */
  var CHANNEL = 'agent-stack-events';
  /** How long a starting tab listens for an existing leader before claiming the stream itself. */
  var ELECT_MS = 300;
  /** Leader -> followers liveness ping. */
  var HEARTBEAT_MS = 5000;
  /** A follower claims the stream after this long with no leader ping (`bye` makes the common case immediate). */
  var LEADER_TIMEOUT_MS = 15000;
  /** Spread simultaneous takeovers so two followers cannot both claim. */
  var TAKEOVER_JITTER_MS = 500;

  /** Wire name -> registered handlers. */
  var handlers = Object.create(null);
  /** Names that already have a listener attached to the local EventSource (leader only). */
  var attached = Object.create(null);
  /** The leader's EventSource; null in a follower, and before the first `on()`. */
  var source = null;
  var connected = false;
  /** Set by `pagehide`: no timer may reopen the stream while the page is going away. */
  var closing = false;
  /** Whether the channel/election machinery has been started for this document. */
  var started = false;

  var myId = Math.random().toString(36).slice(2) + '-' + Date.now().toString(36);
  var channel = null;
  /** 'leader' owns the EventSource; 'follower' receives the same events over the channel. */
  var role = 'follower';
  var electTimer = null;
  var jitterTimer = null;
  var heartbeatTimer = null;
  var leaderTimer = null;

  function parse(ev) {
    try { return JSON.parse(ev.data); } catch (e) { return null; }
  }

  function dispatch(name, data) {
    var list = handlers[name] || [];
    for (var i = 0; i < list.length; i++) {
      // One throwing handler must not starve the others, and must not kill the stream.
      try { list[i](data); } catch (e) { /* reported by the handler's own code */ }
    }
  }

  // ── The leader's transport ───────────────────────────────────────────────

  /** Attach a listener for `name` to the local stream (no-op for a follower, or a name already attached). */
  function attach(name) {
    if (!source || attached[name]) return;
    attached[name] = true;
    source.addEventListener(name, function (ev) {
      var data = parse(ev);
      dispatch(name, data);
      postChannel({ type: 'event', name: name, data: data });
    });
  }

  function openSource() {
    if (source || closing || !global.EventSource) return;
    attached = Object.create(null);
    source = new global.EventSource('/api/events');
    source.addEventListener('connected', function () { setConnected(true); });
    // EventSource reconnects on its own; this only tracks the badge state.
    source.onerror = function () { setConnected(false); };
    // Any name registered before the source existed needs its listener now.
    for (var name in handlers) attach(name);
  }

  function closeSource() {
    if (!source) return;
    try { source.close(); } catch (e) { /* already closed */ }
    source = null;
    attached = Object.create(null);
    connected = false;
  }

  function setConnected(value) {
    value = !!value;
    if (connected === value) return;
    connected = value;
    postChannel({ type: 'status', connected: value });
  }

  // ── Leadership: exactly one tab owns the stream ─────────────────────────

  function postChannel(msg) {
    if (!channel) return;
    msg.from = myId;
    try { channel.postMessage(msg); } catch (e) { /* channel closed */ }
  }

  function clearTimers() {
    if (electTimer) { clearTimeout(electTimer); electTimer = null; }
    if (jitterTimer) { clearTimeout(jitterTimer); jitterTimer = null; }
    if (leaderTimer) { clearTimeout(leaderTimer); leaderTimer = null; }
    if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  }

  function becomeLeader() {
    if (role === 'leader' || closing) return;
    clearTimers();
    role = 'leader';
    openSource();
    postChannel({ type: 'here' });
    heartbeatTimer = setInterval(function () { postChannel({ type: 'hb' }); }, HEARTBEAT_MS);
  }

  function becomeFollower() {
    clearTimers();
    role = 'follower';
    closeSource();
    armLeaderTimeout();
  }

  function armLeaderTimeout() {
    if (leaderTimer) clearTimeout(leaderTimer);
    leaderTimer = setTimeout(claimAfterJitter, LEADER_TIMEOUT_MS);
  }

  /** A leader answered (or pinged): stand down any pending election/claim and follow it. */
  function adoptLeader() {
    if (electTimer) { clearTimeout(electTimer); electTimer = null; }
    if (jitterTimer) { clearTimeout(jitterTimer); jitterTimer = null; }
    armLeaderTimeout();
  }

  /** A leader went quiet (or left): wait a jittered moment, then claim the stream if nobody is leading. */
  function claimAfterJitter() {
    if (leaderTimer) { clearTimeout(leaderTimer); leaderTimer = null; }
    if (closing || role === 'leader') return;
    if (jitterTimer) clearTimeout(jitterTimer);
    jitterTimer = setTimeout(function () {
      jitterTimer = null;
      if (!closing && role === 'follower') becomeLeader();
    }, Math.floor(Math.random() * TAKEOVER_JITTER_MS));
  }

  function onMessage(ev) {
    var m = ev.data;
    if (!m || m.from === myId) return;

    if (m.type === 'who') {
      // A starting tab is asking whether a stream is already running. Only the leader answers.
      if (role === 'leader') {
        postChannel({ type: 'here' });
        postChannel({ type: 'status', connected: connected });
      }
      return;
    }

    if (m.type === 'here' || m.type === 'hb') {
      if (role === 'leader') {
        // Two leaders (a split): the lower id keeps the stream and the other steps down. Self-heals.
        if (m.from < myId) becomeFollower();
      } else {
        adoptLeader();
      }
      return;
    }

    if (m.type === 'event') {
      if (role !== 'leader') dispatch(m.name, m.data);
      return;
    }

    if (m.type === 'status') {
      if (role !== 'leader') connected = !!m.connected;
      return;
    }

    if (m.type === 'bye') {
      // The leader is leaving; do not wait out the heartbeat timeout.
      if (role !== 'leader') claimAfterJitter();
    }
  }

  /** Ask who is leading; claim the stream if nobody answers. */
  function elect() {
    role = 'follower';
    if (electTimer) clearTimeout(electTimer);
    postChannel({ type: 'who' });
    electTimer = setTimeout(function () {
      electTimer = null;
      if (!closing && role === 'follower') becomeLeader();
    }, ELECT_MS);
  }

  function start() {
    if (started || closing) return;
    started = true;
    if (!global.BroadcastChannel) { becomeLeader(); return; }   // no sharing available — own the stream
    if (!channel) {
      try { channel = new global.BroadcastChannel(CHANNEL); }
      catch (e) { channel = null; becomeLeader(); return; }
    }
    channel.onmessage = onMessage;
    elect();
  }

  /** Deterministic teardown, called from `pagehide` so no connection slot is left held across a navigation. */
  function close() {
    if (closing) return;
    closing = true;
    clearTimers();
    if (role === 'leader') postChannel({ type: 'bye' });
    closeSource();
    role = 'follower';
    connected = false;
    started = false;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  /**
   * Subscribe to a server event.
   *
   * @returns {function} an unsubscribe function.
   */
  function on(name, fn) {
    if (typeof name !== 'string' || typeof fn !== 'function') {
      throw new Error('AgentStack.on(name, fn)');
    }
    if (!handlers[name]) handlers[name] = [];
    handlers[name].push(fn);
    start();
    attach(name);   // no-op unless THIS tab owns the stream
    return function off() {
      var list = handlers[name] || [];
      var i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    };
  }

  /** GET JSON; throws on a non-2xx response. */
  function get(path) {
    return fetch(path).then(function (r) {
      if (!r.ok) throw new Error(r.statusText);
      return r.json();
    });
  }

  /** POST JSON; throws with the server's `error.message` when the response is not ok. */
  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
    }).then(function (r) {
      return r.json().then(function (d) {
        if (!r.ok) throw new Error((d.error && d.error.message) || ('HTTP ' + r.status));
        return d;
      });
    });
  }

  global.AgentStack = {
    on: on,
    get: get,
    post: post,
    isConnected: function () { return connected; },
    /** Diagnostics only — true when THIS tab owns the shared stream (a follower returns false). */
    hasConnection: function () { return source !== null; },
    /** Diagnostics only — which role this tab plays: 'leader' owns the stream, 'follower' relays from it. */
    role: function () { return role; },
  };

  // Close the stream deterministically on navigation/tab-close, and rejoin the channel if the page is restored
  // from the back/forward cache (which freezes timers but keeps the document alive).
  global.addEventListener('pagehide', close);
  global.addEventListener('pageshow', function (ev) {
    closing = false;
    if (ev.persisted && !started && Object.keys(handlers).length) start();
  });
})(window);
