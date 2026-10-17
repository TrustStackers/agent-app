// SPDX-License-Identifier: GPL-3.0-only OR LicenseRef-TrustStackers-Commercial
// Copyright (C) 2026 Trust Stackers

/**
 * Shared navigation for the agent web UI.
 * Injects a collapsible left-sidebar navigation into every page.
 *
 * Nav structure (collapsible left sidebar):
 *   Dashboard            (standalone)
 *   Identity             (👤): VTAs | Profiles | Agent Names | Recovery | Server Sign-in
 *   Credentials          (🪪) — standalone link → credentials.html
 *   Trust Network        (🕸️): Trust Graph | Chat
 *   Communities          (🏛️): Communities | Invitations | Create Community
 *   Spaces               (🚀) — standalone link → spaces.html
 *
 * Auth-aware: items that require an active agent are hidden until
 * `/api/identity` confirms an active session. Each group is hidden while
 * logged out. Group open/collapsed state is remembered across navigations,
 * defaulting to the group that contains the active page on first visit.
 */
(function() {
  const nav = document.getElementById('main-nav');
  if (!nav) return;

  const pageId = document.documentElement.getAttribute('data-page') ||
                 document.body.getAttribute('data-page') || '';
  const subPageId = document.body.getAttribute('data-subpage') || '';

  // Nav sections in display order. A section is either a plain link or a
  // collapsible group of links.
  const sections = [
    { type: 'link', item: { id: 'dashboard', href: 'dashboard.html', label: '🏠 Dashboard', requiresAuth: true, page: 'dashboard' } },
    { type: 'group', group: {
        id: 'identity',
        label: '👤 Identity',
        items: [
          { id: 'vtas',     href: 'register.html',      label: 'VTAs',              requiresAuth: true, page: 'vtas',      subpage: 'register' },
          { id: 'profiles', href: 'profiles.html',      label: 'Profiles',          requiresAuth: true, page: 'vtas',      subpage: 'profiles' },
          { id: 'names',    href: 'name-register.html', label: 'Agent Names',       requiresAuth: true, page: 'names' },
          { id: 'recovery', href: 'recovery.html',      label: 'Recovery',          requiresAuth: true, page: 'recovery' },
          { id: 'sign',     href: 'sign.html',          label: 'Server Sign-in',    requiresAuth: true, page: 'sign' },
        ],
      } },
    { type: 'link', item: { id: 'credentials', href: 'credentials.html', label: '🪪 Credentials', requiresAuth: true, page: 'credentials' } },
    { type: 'group', group: {
        id: 'network',
        label: '🕸️ Trust Network',
        items: [
          { id: 'graph', href: 'graph.html', label: 'Trust Graph', requiresAuth: true, page: 'graph' },
          { id: 'chat',  href: 'chat.html',  label: 'Chat',        requiresAuth: true, page: 'chat' },
        ],
      } },
    { type: 'group', group: {
        id: 'communities',
        label: '🏛️ Communities',
        items: [
          { id: 'communities', href: 'communities.html', label: 'Communities',      requiresAuth: true, page: 'communities' },
          { id: 'invitations', href: 'invitations.html', label: 'Invitations',      requiresAuth: true, page: 'invitations' },
          { id: 'vtc-create',  href: 'vtc-create.html',  label: 'Create Community', requiresAuth: true, page: 'vtc-create' },
          { id: 'rules',       href: 'rules.html',       label: 'Rules',            requiresAuth: true, page: 'rules' },
        ],
      } },
    { type: 'link', item: { id: 'spaces', href: 'spaces.html', label: '🚀 Spaces', requiresAuth: true, page: 'spaces' } },
  ];

  // ── Rendering helpers ─────────────────────────────────────────────────
  function isItemActive(item) {
    if (item.page !== pageId) return false;
    if (item.subpage && item.subpage !== subPageId) return false;
    return true;
  }

  function renderLink(item) {
    const active = isItemActive(item) ? ' class="active"' : '';
    const hidden = item.requiresAuth ? ' style="display:none"' : '';
    return '<a href="' + item.href + '"' + active + hidden + ' data-requires-auth="' + item.requiresAuth + '">' + item.label + '</a>';
  }

  // ── Collapsible-group open/closed state (persisted across navigation) ─
  var NAV_STATE_KEY = 'nav-open-state';
  var openState = {};
  try { openState = JSON.parse(localStorage.getItem(NAV_STATE_KEY) || '{}') || {}; } catch (e) { openState = {}; }
  function saveOpenState() {
    try { localStorage.setItem(NAV_STATE_KEY, JSON.stringify(openState)); } catch (e) {}
  }

  // Build nav: sections (standalone links + collapsible groups) + footer.
  let mainHtml = '<div class="nav-groups">';

  sections.forEach(function(s) {
    if (s.type === 'link') {
      mainHtml += renderLink(s.item);
      return;
    }
    var g = s.group;
    const allAuth = g.items.every(function(i) { return i.requiresAuth; });
    const groupActive = g.items.some(isItemActive);
    const isOpen = (typeof openState[g.id] !== 'undefined') ? openState[g.id] : groupActive;
    const openAttr = isOpen ? ' open' : '';
    const hiddenAttr = allAuth ? ' style="display:none"' : '';
    mainHtml +=
      '<details class="nav-group" data-group="' + g.id + '" data-group-requires-auth="' + allAuth + '"' + openAttr + hiddenAttr + '>' +
      '<summary>' + g.label + '</summary>' +
      '<div class="nav-group-items">' + g.items.map(renderLink).join('') + '</div>' +
      '</details>';
  });
  mainHtml += '</div>';

  mainHtml += '<div class="nav-footer">';
  // The active VTA name is a LINK to its profile page (full DID + identity detail).
  mainHtml += '<a href="vta-profile.html" id="nav-agent-info" class="nav-agent" style="display:none;" title="View this VTA\u2019s profile"></a>';
  mainHtml += '<a href="#" onclick="logoutAgent(event)" id="logout-link" style="display:none;">🚪 Log Out</a>';
  mainHtml += '</div>';

  nav.innerHTML = mainHtml;

  // Persist the user's expand/collapse choices on each group.
  nav.querySelectorAll('.nav-group').forEach(function(d) {
    d.addEventListener('toggle', function() {
      openState[d.getAttribute('data-group')] = d.open;
      saveOpenState();
    });
  });

  // ── Auth-aware visibility ─────────────────────────────────────────────
  function updateNavAuth(data) {
    var isActive = !!(data && data.active);
    // Toggle nav items that require authentication
    nav.querySelectorAll('[data-requires-auth="true"]').forEach(function(a) {
      a.style.display = isActive ? '' : 'none';
    });
    // Toggle groups whose items all require authentication
    nav.querySelectorAll('[data-group-requires-auth="true"]').forEach(function(d) {
      d.style.display = isActive ? '' : 'none';
    });
    // Agent name
    var agentEl = document.getElementById('nav-agent-info');
    if (agentEl) {
      if (isActive && data.name) {
        agentEl.innerHTML = '<span class="nav-agent-badge nav-agent-active">🟢</span> ' + escapeHtml(data.name);
        agentEl.style.display = '';
      } else {
        agentEl.style.display = 'none';
      }
    }
    // Log Out link
    var logoutEl = document.getElementById('logout-link');
    if (logoutEl) {
      logoutEl.style.display = isActive ? '' : 'none';
    }
  }

  fetch('/api/identity')
    .then(function(r) { return r.ok ? r.json() : null; })
    .then(function(data) { updateNavAuth(data); })
    .catch(function() { /* keep everything hidden */ });

  // ── Unread badge — PUSHED, not polled ────────────────────────────────
  // Was `GET /api/messages/unread?since=<load time>` every 2 s. The server now pushes a `message` event for
  // every inbound message (from the event bus), so the badge counts events instead of re-asking.
  //
  // The semantics are identical: the old poll counted messages received since the page loaded (its `since` was
  // `Date.now()` at load), and the badge now increments per event. What changes is that there is no timer and
  // no request — and no window where a message is invisible for up to two seconds.
  var unreadSinceLoad = 0;
  var chatLink = nav.querySelector('a[href="chat.html"]');
  if (chatLink && window.AgentStack) {
    window.AgentStack.on('message', function () {
      unreadSinceLoad++;
      var existing = chatLink.querySelector('.nav-badge');
      if (existing) {
        existing.textContent = unreadSinceLoad > 99 ? '99+' : unreadSinceLoad;
      } else {
        var badge = document.createElement('span');
        badge.className = 'nav-badge';
        badge.textContent = unreadSinceLoad > 99 ? '99+' : unreadSinceLoad;
        badge.style.cssText = 'background:#ef4444;color:white;border-radius:10px;padding:1px 6px;font-size:10px;margin-left:3px;';
        chatLink.appendChild(badge);
      }
    });
  }

  // ── Pending-invitations badge — PUSHED, not polled ─────────────────────
  // Was `GET /api/invitations` every 5 s. Nothing announced an arriving invitation, so the badge had to keep
  // asking; the receive path now emits `invitation.received` (a VIC *is* an invitation), and declining emits
  // `invitation.changed`, so the badge re-reads only when the answer can actually have changed.
  //
  // The initial read stays: the badge has to be correct on first paint, before any event can arrive.
  var inviteLink = nav.querySelector('a[href="invitations.html"]');
  if (inviteLink && window.AgentStack) {
    function refreshInvitationBadge() {
      fetch('/api/invitations')
        .then(function(r) { return r.ok ? r.json() : null; })
        .then(function(data) {
          if (!inviteLink) return;
          var count = data && data.length ? data.length : 0;
          var existing = inviteLink.querySelector('.nav-badge');
          if (count > 0) {
            if (existing) {
              existing.textContent = count > 99 ? '99+' : count;
            } else {
              var badge = document.createElement('span');
              badge.className = 'nav-badge';
              badge.textContent = count > 99 ? '99+' : count;
              badge.style.cssText = 'background:#f59e0b;color:white;border-radius:10px;padding:1px 6px;font-size:10px;margin-left:3px;';
              inviteLink.appendChild(badge);
            }
          } else if (existing) {
            existing.remove();
          }
        })
        .catch(function() {});
    }
    refreshInvitationBadge();
    window.AgentStack.on('invitation-received', refreshInvitationBadge);
    window.AgentStack.on('invitation-changed', refreshInvitationBadge);
  }
})();

function escapeHtml(s) {
  var d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

/**
 * Log out the current agent and return to the VTA selection screen.
 */
async function logoutAgent(event) {
  if (event) event.preventDefault();
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch (_) { /* ignore network errors */ }
  window.location.href = 'index.html';
}

/**
 * Check if there is an active agent. If not, redirect to the login page.
 * Call this at the top of every page that requires an active VTA.
 */
async function requireActiveAgent() {
  try {
    var resp = await fetch('/api/identity');
    if (!resp.ok) throw new Error('not ok');
    var data = await resp.json();
    if (!data.active) {
      window.location.href = 'index.html';
      return false;
    }
    return true;
  } catch (_) {
    window.location.href = 'index.html';
    return false;
  }
}
