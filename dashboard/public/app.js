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

/* ---------------- Auth ---------------- */

function showLogin() {
  document.getElementById('login-screen').hidden = false;
  document.getElementById('app').hidden = true;
}

function showApp() {
  document.getElementById('login-screen').hidden = true;
  document.getElementById('app').hidden = false;
  loadView('overview');
}

document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const password = document.getElementById('password-input').value;
  const errorEl = document.getElementById('login-error');
  errorEl.hidden = true;
  try {
    await api('/login', { method: 'POST', body: JSON.stringify({ password }) });
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

/* ---------------- Nav ---------------- */

const viewTitles = {
  overview: 'Overview',
  servers: 'Servers',
  users: 'Tracked Users',
  activity: 'Recent Activity',
  leaderboards: 'Leaderboards',
  send: 'Send Message',
  controls: 'Bot Controls',
};

document.querySelectorAll('.nav-item').forEach((btn) => {
  btn.addEventListener('click', () => loadView(btn.dataset.view));
});

function loadView(view) {
  document.querySelectorAll('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
  document.querySelectorAll('.view-panel').forEach((p) => (p.hidden = p.dataset.viewPanel !== view));
  document.getElementById('view-title').textContent = viewTitles[view] || view;

  if (view === 'overview') renderOverview();
  else if (view === 'servers') renderServers();
  else if (view === 'users') renderUsers();
  else if (view === 'activity') renderActivity();
  else if (view === 'leaderboards') renderLeaderboard(currentTab);
  else if (view === 'send') renderSend();
  else if (view === 'controls') renderControls();
}

/* ---------------- Overview ---------------- */

async function renderOverview() {
  const data = await api('/overview');
  updateStatusPill(data.botPaused);

  const stats = document.getElementById('overview-stats');
  stats.innerHTML = '';
  const cards = [
    ['Servers', data.totalServers],
    ['Tracked Users', data.totalTrackedUsers],
    ['Recommend Votes', data.totalRecommendations],
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
    </div>
  `)
  );
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

async function renderActivity() {
  const { activity } = await api('/activity?limit=100');
  const list = document.getElementById('activity-list');
  list.innerHTML = '';
  if (!activity.length) return list.appendChild(el('<div class="empty-state">No activity posted yet.</div>'));
  for (const a of activity) {
    list.appendChild(
      el(`
      <div class="list-row">
        <div class="row-main">
          <div class="row-title">${escapeHtml(a.animeTitle || 'Activity update')}</div>
          <div class="row-sub">${escapeHtml(a.guildName)}${a.addedBy ? ` · tracked for ${a.addedBy}` : ''}</div>
        </div>
        <div class="row-count">${timeAgo(a.postedAt)}</div>
      </div>
    `)
    );
  }
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
  content.innerHTML = '';
  noteEl.textContent = '';

  if (tab === 'recommended' || tab === 'watched') {
    const { list, note } = await api(`/leaderboards/${tab}`);
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
    noteEl.textContent = note || '';
    if (!accounts.length) return content.appendChild(el('<div class="empty-state">No linked AniList accounts yet — coming with /signin.</div>'));
    for (const a of accounts) {
      content.appendChild(el(`<div class="list-row"><div class="row-main"><div class="row-title">${a.discordId}</div></div></div>`));
    }
  }
}

/* ---------------- Send message ---------------- */

async function renderSend() {
  const guildSelect = document.getElementById('send-guild');
  const channelSelect = document.getElementById('send-channel');
  const { servers } = await api('/servers');
  guildSelect.innerHTML = servers.map((s) => `<option value="${s.id}">${escapeHtml(s.name)}</option>`).join('');
  await populateChannels(servers[0]?.id);
  guildSelect.onchange = () => populateChannels(guildSelect.value);

  document.getElementById('send-btn').onclick = async () => {
    const resultEl = document.getElementById('send-result');
    resultEl.textContent = 'Sending…';
    try {
      await api('/send', {
        method: 'POST',
        body: JSON.stringify({
          guildId: guildSelect.value,
          channelId: channelSelect.value,
          message: document.getElementById('send-message').value,
        }),
      });
      resultEl.textContent = 'Sent ✓';
      document.getElementById('send-message').value = '';
    } catch (err) {
      resultEl.textContent = `Error: ${err.message}`;
    }
  };

  async function populateChannels(guildId) {
    if (!guildId) return (channelSelect.innerHTML = '');
    const { channels } = await api(`/servers/${guildId}/channels`);
    channelSelect.innerHTML = channels.map((c) => `<option value="${c.id}">#${escapeHtml(c.name)}</option>`).join('');
  }
}

/* ---------------- Controls ---------------- */

async function renderControls() {
  const { botPaused } = await api('/overview');
  const btn = document.getElementById('pause-resume-btn');
  btn.textContent = botPaused ? 'Resume' : 'Pause';

  btn.onclick = async () => {
    const resultEl = document.getElementById('controls-result');
    try {
      const { botPaused: nowPaused } = await api(botPaused ? '/resume' : '/pause', { method: 'POST' });
      updateStatusPill(nowPaused);
      resultEl.textContent = nowPaused ? 'Bot paused.' : 'Bot resumed.';
      renderControls();
    } catch (err) {
      resultEl.textContent = `Error: ${err.message}`;
    }
  };

  document.getElementById('redeploy-btn').onclick = async () => {
    const resultEl = document.getElementById('controls-result');
    if (!confirm('Trigger a redeploy on Render now?')) return;
    resultEl.textContent = 'Triggering redeploy…';
    try {
      await api('/redeploy', { method: 'POST' });
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
