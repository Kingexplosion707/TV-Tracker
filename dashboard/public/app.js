const API = '/dashboard/api';

async function api(path, opts = {}) {
  const res = await fetch(`${API}${path}`, {
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
    ...opts,
  });
  if (res.status === 401) {
    showLogin();
    throw new Error('Not authenticated');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstChild;
}

function timeAgo(dateStr) {
  if (!dateStr) return '';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/* ---------------- Loading helpers ---------------- */

// Fills a container with N shimmer rows while its real data is in flight, so
// a view swap never flashes an empty panel. Cleared by the render's own
// innerHTML reset once the data lands.
function showSkeletonRows(container, count = 4) {
  if (!container) return;
  container.innerHTML = Array.from({ length: count }, () => '<div class="skeleton skeleton-row"></div>').join('');
}

function showSkeletonStats(container, count = 5) {
  if (!container) return;
  container.innerHTML = Array.from({ length: count }, () => '<div class="skeleton skeleton-stat"></div>').join('');
}

// Wraps an async click handler so the button disables + shows a spinner for
// the duration, preventing double-submits on Send / Pause / Redeploy.
async function withButtonLoading(btn, fn) {
  if (!btn) return fn();
  const wasDisabled = btn.disabled;
  btn.disabled = true;
  btn.classList.add('is-loading');
  try {
    return await fn();
  } finally {
    btn.classList.remove('is-loading');
    btn.disabled = wasDisabled;
  }
}

/* ---------------- Auth ---------------- */

function showLogin() {
  document.getElementById('login-screen').hidden = false;
  document.getElementById('app').hidden = true;
}

function showApp() {
  document.getElementById('login-screen').hidden = true;
  document.getElementById('app').hidden = false;
  window.scrollTo(0, 0);
  loadView('overview');
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('password-input').value;
  const errorEl = document.getElementById('login-error');
  const submitBtn = e.target.querySelector('button[type="submit"]');
  errorEl.hidden = true;
  try {
    await withButtonLoading(submitBtn, () =>
      api('/login', { method: 'POST', body: JSON.stringify({ password }) })
    );
    showApp();
  } catch (err) {
    errorEl.textContent = err.message;
    errorEl.hidden = false;
  }
});

document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/logout', { method: 'POST' }).catch(() => {});
  showLogin();
});

/* ---------------- Sidebar collapse ---------------- */

const SIDEBAR_COLLAPSE_KEY = 'anitracker:sidebarCollapsed';

// No stored preference yet -> default collapsed on narrow/mobile widths, so
// first-time mobile visitors get the compact icon rail instead of a wall of
// full-label nav buttons.
function getStoredCollapse() {
  try {
    const stored = localStorage.getItem(SIDEBAR_COLLAPSE_KEY);
    if (stored !== null) return stored === '1';
  } catch {}
  return window.innerWidth <= 900;
}

function setStoredCollapse(val) {
  try {
    localStorage.setItem(SIDEBAR_COLLAPSE_KEY, val ? '1' : '0');
  } catch {}
}

const sidebarEl = document.querySelector('.sidebar');
if (getStoredCollapse()) sidebarEl.classList.add('sidebar-collapsed');

const sidebarToggleBtn = document.getElementById('sidebar-toggle');
sidebarToggleBtn.setAttribute('aria-expanded', String(!sidebarEl.classList.contains('sidebar-collapsed')));
sidebarToggleBtn.addEventListener('click', () => {
  const collapsed = sidebarEl.classList.toggle('sidebar-collapsed');
  setStoredCollapse(collapsed);
  sidebarToggleBtn.setAttribute('aria-expanded', String(!collapsed));
});

/* ---------------- Nav ---------------- */

const viewTitles = {
  overview: 'Overview',
  servers: 'Servers',
  users: 'Tracked Users',
  activity: 'Recent Activity',
  leaderboards: 'Leaderboards',
  feedback: 'Feedback',
  send: 'Send Message',
  controls: 'Bot Controls',
};

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => loadView(btn.dataset.view));
});

// Shared by the Overview page's "View all" shortcut on the Recent Activity snippet.
document.querySelectorAll('[data-goto-view]').forEach((btn) => {
  btn.addEventListener('click', () => loadView(btn.dataset.gotoView));
});

function loadView(view) {
  document.querySelectorAll('.nav-item').forEach((b) => {
    const active = b.dataset.view === view;
    b.classList.toggle('active', active);
    if (active) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  });
  document.querySelectorAll('.view-panel').forEach((p) => (p.hidden = p.dataset.viewPanel !== view));
  document.getElementById('view-title').textContent = viewTitles[view] || view;

  if (view === 'overview') renderOverview();
  else if (view === 'servers') renderServers();
  else if (view === 'users') renderUsers();
  else if (view === 'activity') renderActivity();
  else if (view === 'leaderboards') renderLeaderboard(currentTab);
  else if (view === 'feedback') renderFeedback(currentFeedbackTab);
  else if (view === 'send') renderSend();
  else if (view === 'controls') renderControls();
}

/* ---------------- Overview ---------------- */

const RENDER_DASHBOARD_URL = 'https://dashboard.render.com/web/srv-d9pbdp2jnfac73ebhdq0';

async function renderOverview() {
  showSkeletonStats(document.getElementById('overview-stats'), 5);
  showSkeletonRows(document.getElementById('overview-activity-list'), 5);

  const data = await api('/overview');
  updateStatusPill(data.botPaused);

  const stats = document.getElementById('overview-stats');
  stats.innerHTML = '';
  const cards = [
    ['Servers', data.totalServers],
    ['Tracked Users', data.totalTrackedUsers],
    ['Recommend Votes', data.totalRecommendations],
    ['Pending Feedback', data.pendingFeedback ?? 0],
    ['Uptime', formatUptime(data.uptimeSeconds)],
  ];
  for (const [label, value] of cards) {
    stats.appendChild(el(`<div class="stat-card"><div class="stat-value">${value}</div><div class="stat-label">${label}</div></div>`));
  }

  const botCard = document.getElementById('overview-bot-card');
  botCard.innerHTML = '';
  botCard.appendChild(
    el(`
    <div class="list-row">
      ${data.botAvatar ? `<img class="avatar" src="${data.botAvatar}" />` : ''}
      <div class="row-main">
        <div class="row-title">${data.botTag || 'AniTracker'}</div>
        <div class="row-sub">${data.botPaused ? 'Polling paused' : 'Polling every few minutes'}</div>
      </div>
      <a class="btn btn-ghost btn-small" href="${RENDER_DASHBOARD_URL}" target="_blank" rel="noopener">Open on Render →</a>
    </div>
  `)
  );

  await renderOverviewActivitySnippet();
  wireSendForm({
    guildSelect: document.getElementById('overview-send-guild'),
    channelSelect: document.getElementById('overview-send-channel'),
    messageEl: document.getElementById('overview-send-message'),
    sendBtn: document.getElementById('overview-send-btn'),
    resultEl: document.getElementById('overview-send-result'),
  });
}

async function renderOverviewActivitySnippet() {
  const list = document.getElementById('overview-activity-list');
  list.innerHTML = '';
  try {
    const { activity } = await api('/activity?limit=5');
    if (!activity.length) return list.appendChild(el('<div class="empty-state">No activity posted yet.</div>'));
    for (const a of activity) list.appendChild(activityRow(a));
  } catch (err) {
    list.appendChild(el(`<div class="empty-state">Could not load activity: ${escapeHtml(err.message)}</div>`));
  }
}

function formatUptime(seconds) {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (h < 1) return `${m}m`;
  return `${h}h ${m}m`;
}

function updateStatusPill(paused) {
  const pill = document.getElementById('bot-status-pill');
  pill.textContent = paused ? '● Paused' : '● Running';
  pill.classList.toggle('status-running', !paused);
  pill.classList.toggle('status-paused', paused);
}

/* ---------------- Servers ---------------- */

async function renderServers() {
  showSkeletonRows(document.getElementById('servers-list'), 5);
  const { servers } = await api('/servers');
  document.getElementById('servers-count').textContent = servers.length;
  const list = document.getElementById('servers-list');
  list.innerHTML = '';
  if (!servers.length) return list.appendChild(el('<div class="empty-state">No servers yet.</div>'));
  for (const s of servers) {
    list.appendChild(
      el(`
      <div class="list-row">
        ${s.icon ? `<img class="avatar" src="${s.icon}" />` : '<div class="avatar"></div>'}
        <div class="row-main">
          <div class="row-title">${escapeHtml(s.name)}</div>
          <div class="row-sub">${s.channelName ? `Posting in ${escapeHtml(s.channelName)}` : 'No channel set'} · ${s.memberCount ?? '?'} members</div>
        </div>
        <div class="row-count">${s.trackedUserCount} tracked</div>
      </div>
    `)
    );
  }
}

/* ---------------- Users ---------------- */

async function renderUsers() {
  showSkeletonRows(document.getElementById('users-list'), 5);
  const { users, total } = await api('/users');
  document.getElementById('users-count').textContent = total;
  const list = document.getElementById('users-list');
  list.innerHTML = '';
  if (!users.length) return list.appendChild(el('<div class="empty-state">No one tracked yet.</div>'));
  for (const u of users) {
    list.appendChild(
      el(`
      <div class="list-row">
        ${u.avatar ? `<img class="avatar" src="${u.avatar}" />` : '<div class="avatar"></div>'}
        <div class="row-main">
          <div class="row-title">${escapeHtml(u.username)}</div>
          <div class="row-sub">${escapeHtml(u.guildName)}${u.streak ? ` · 🔥${u.streak}` : ''}</div>
        </div>
        ${u.addedBy ? `<div class="row-count">by ${u.addedBy}</div>` : ''}
      </div>
    `)
    );
  }
}

/* ---------------- Activity ---------------- */

function activityRow(a) {
  return el(`
    <div class="list-row">
      <div class="row-main">
        <div class="row-title">${escapeHtml(a.animeTitle || 'Activity update')}</div>
        <div class="row-sub">${escapeHtml(a.guildName)}${a.addedBy ? ` · tracked for ${a.addedBy}` : ''}</div>
      </div>
      <div class="row-count">${timeAgo(a.postedAt)}</div>
    </div>
  `);
}

async function renderActivity() {
  showSkeletonRows(document.getElementById('activity-list'), 8);
  const { activity } = await api('/activity?limit=100');
  const list = document.getElementById('activity-list');
  list.innerHTML = '';
  if (!activity.length) return list.appendChild(el('<div class="empty-state">No activity posted yet.</div>'));
  for (const a of activity) list.appendChild(activityRow(a));
}

/* ---------------- Leaderboards ---------------- */

let currentTab = 'recommended';
document.querySelectorAll('.tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t === tab));
    currentTab = tab.dataset.tab;
    renderLeaderboard(currentTab);
  });
});

async function renderLeaderboard(tab) {
  const content = document.getElementById('leaderboard-content');
  const noteEl = document.getElementById('leaderboard-note');
  showSkeletonRows(content, 6);
  noteEl.textContent = '';

  if (tab === 'recommended' || tab === 'watched') {
    const { list, note } = await api(`/leaderboards/${tab}`);
    content.innerHTML = '';
    noteEl.textContent = note || '';
    if (!list.length) return content.appendChild(el('<div class="empty-state">Nothing yet.</div>'));
    list.forEach((item, i) => {
      content.appendChild(
        el(`
        <div class="list-row">
          <div class="rank">${i + 1}</div>
          <div class="row-main">
            <div class="row-title">${item.siteUrl ? `<a href="${item.siteUrl}" target="_blank" style="color:inherit;text-decoration:none">${escapeHtml(item.title)}</a>` : escapeHtml(item.title)}</div>
          </div>
          <div class="row-count">${item.count} ${tab === 'watched' ? 'updates' : 'votes'}</div>
        </div>
      `)
      );
    });
  } else if (tab === 'watchlater') {
    const { users } = await api('/leaderboards/watchlater');
    content.innerHTML = '';
    if (!users.length) return content.appendChild(el('<div class="empty-state">No watch-later lists yet.</div>'));
    for (const u of users) {
      content.appendChild(
        el(`
        <div class="list-row">
          <div class="row-main">
            <div class="row-title">${u.userId}</div>
            <div class="row-sub">${escapeHtml(u.titles.map((t) => t.title).join(', '))}</div>
          </div>
          <div class="row-count">${u.count}</div>
        </div>
      `)
      );
    }
  } else if (tab === 'linked') {
    const { accounts, note } = await api('/leaderboards/linked');
    content.innerHTML = '';
    noteEl.textContent = note || '';
    if (!accounts.length) return content.appendChild(el('<div class="empty-state">No linked AniList accounts yet — coming with /signin.</div>'));
    for (const a of accounts) {
      content.appendChild(el(`<div class="list-row"><div class="row-main"><div class="row-title">${a.discordId}</div></div></div>`));
    }
  }
}

/* ---------------- Feedback ---------------- */

let currentFeedbackTab = 'all';
document.querySelectorAll('[data-feedback-tab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-feedback-tab]').forEach((b) => b.classList.toggle('active', b === btn));
    currentFeedbackTab = btn.dataset.feedbackTab;
    renderFeedback(currentFeedbackTab);
  });
});

const FEEDBACK_STATUS_LABELS = { resolved: 'Resolved', disputed: 'Disputed', later: 'Keep for Later' };

function feedbackCard(f) {
  const stars = f.rating
    ? `${'★'.repeat(f.rating)}${'☆'.repeat(5 - f.rating)} <span class="muted-note">${f.rating}/5</span>`
    : '<span class="muted-note">No rating given</span>';
  const statusLabel = FEEDBACK_STATUS_LABELS[f.status] || 'New';

  const node = el(`
    <div class="card feedback-card">
      <div class="card-header">
        <span class="badge feedback-badge-${f.status || 'new'}">${statusLabel}</span>
        <span class="muted-note">${timeAgo(f.postedAt)}</span>
      </div>
      <div class="feedback-rating">${stars}</div>
      <p class="feedback-content">${escapeHtml(f.content)}</p>
      <p class="muted-note">Contact: ${f.contact ? escapeHtml(f.contact) : '—'}</p>
      <div class="feedback-actions"></div>
    </div>
  `);

  const actions = node.querySelector('.feedback-actions');
  const actionDefs = [
    ['resolved', 'Resolve', 'btn-primary'],
    ['disputed', 'Dispute', 'btn-danger'],
    ['later', 'Keep for Later', 'btn-ghost'],
  ].filter(([status]) => status !== f.status);
  if (f.status) actionDefs.push([null, 'Reset to New', 'btn-ghost']);

  for (const [status, label, cls] of actionDefs) {
    const btn = el(`<button class="btn ${cls} btn-small">${label}</button>`);
    btn.onclick = async () => {
      btn.disabled = true;
      try {
        await api(`/feedback/${f.messageId}/status`, { method: 'POST', body: JSON.stringify({ status }) });
        renderFeedback(currentFeedbackTab);
      } catch (err) {
        btn.disabled = false;
        alert(`Error: ${err.message}`);
      }
    };
    actions.appendChild(btn);
  }

  return node;
}

async function renderFeedback(tab) {
  const list = document.getElementById('feedback-list');
  showSkeletonRows(list, 4);
  let feedback;
  try {
    ({ feedback } = await api('/feedback'));
  } catch (err) {
    list.innerHTML = '';
    list.appendChild(el(`<div class="empty-state">Could not load feedback: ${escapeHtml(err.message)}</div>`));
    return;
  }
  list.innerHTML = '';

  const filtered =
    tab === 'all' ? feedback : tab === 'new' ? feedback.filter((f) => !f.status) : feedback.filter((f) => f.status === tab);

  if (!filtered.length) return list.appendChild(el('<div class="empty-state">No feedback here.</div>'));
  for (const f of filtered) list.appendChild(feedbackCard(f));
}

/* ---------------- Send message ---------------- */

// Shared by the full Send Message view and the Overview page's Quick Send
// snippet, so both stay in sync with a single implementation.
async function wireSendForm({ guildSelect, channelSelect, messageEl, sendBtn, resultEl }) {
  async function populateChannels(guildId) {
    if (!guildId) return (channelSelect.innerHTML = '');
    const { channels } = await api(`/servers/${guildId}/channels`);
    channelSelect.innerHTML = channels.map((c) => `<option value="${c.id}">#${escapeHtml(c.name)}</option>`).join('');
  }

  const { servers } = await api('/servers');
  guildSelect.innerHTML = servers.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  await populateChannels(servers[0]?.id);
  guildSelect.onchange = () => populateChannels(guildSelect.value);

  sendBtn.onclick = async () => {
    resultEl.textContent = 'Sending…';
    try {
      await withButtonLoading(sendBtn, () =>
        api('/send', {
          method: 'POST',
          body: JSON.stringify({
            guildId: guildSelect.value,
            channelId: channelSelect.value,
            message: messageEl.value,
          }),
        })
      );
      resultEl.textContent = 'Sent ✓';
      messageEl.value = '';
    } catch (err) {
      resultEl.textContent = `Error: ${err.message}`;
    }
  };
}

async function renderSend() {
  await wireSendForm({
    guildSelect: document.getElementById('send-guild'),
    channelSelect: document.getElementById('send-channel'),
    messageEl: document.getElementById('send-message'),
    sendBtn: document.getElementById('send-btn'),
    resultEl: document.getElementById('send-result'),
  });
}

/* ---------------- Controls ---------------- */

async function renderControls() {
  const { botPaused } = await api('/overview');
  const btn = document.getElementById('pause-resume-btn');
  btn.textContent = botPaused ? 'Resume' : 'Pause';

  btn.onclick = async () => {
    const resultEl = document.getElementById('controls-result');
    try {
      const { botPaused: nowPaused } = await withButtonLoading(btn, () =>
        api(botPaused ? '/resume' : '/pause', { method: 'POST' })
      );
      updateStatusPill(nowPaused);
      resultEl.textContent = nowPaused ? 'Bot paused.' : 'Bot resumed.';
      renderControls();
    } catch (err) {
      resultEl.textContent = `Error: ${err.message}`;
    }
  };

  const redeployBtn = document.getElementById('redeploy-btn');
  redeployBtn.onclick = async () => {
    const resultEl = document.getElementById('controls-result');
    if (!confirm('Trigger a redeploy on Render now?')) return;
    resultEl.textContent = 'Triggering redeploy…';
    try {
      await withButtonLoading(redeployBtn, () => api('/redeploy', { method: 'POST' }));
      resultEl.textContent = 'Redeploy triggered ✓';
    } catch (err) {
      resultEl.textContent = `Error: ${err.message}`;
    }
  };
}

/* ---------------- Utils ---------------- */

function escapeHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------------- Boot ---------------- */

(async function boot() {
  try {
    const { authenticated } = await api('/me');
    if (authenticated) showApp();
    else showLogin();
  } catch {
    showLogin();
  }
})();
