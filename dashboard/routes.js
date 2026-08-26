const express = require('express');
const { requireAuth, isAuthenticated, setSessionCookie, clearSessionCookie } = require('./auth');

// Discord snowflake IDs encode their creation time — no need to store a
// separate "postedAt" field on recentPosts entries just for the dashboard.
const DISCORD_EPOCH = 1420070400000n;
function snowflakeToDate(id) {
  try {
    const ms = (BigInt(id) >> 22n) + DISCORD_EPOCH;
    return new Date(Number(ms));
  } catch {
    return null;
  }
}

// Channel the "AniTracker - Feedback" webhook posts into (Make.com relays
// Webflow site-feedback submissions there). Webhook URLs are write-only —
// there's no way to list past messages through them — so the dashboard
// reads this channel directly via the bot's own client instead.
const FEEDBACK_CHANNEL_ID = process.env.FEEDBACK_CHANNEL_ID || '1541620519911034910';
const VALID_FEEDBACK_STATUSES = new Set(['resolved', 'disputed', 'later']);

// Parses a feedback message's plain-text content, e.g.:
//   📩 New AniTracker Submission!
//
//   ⭐ Rating: 4/5
//
//   💬 Feedback/Question: fasfasf
//
//   📧 Contact: fsafas
// The rating line is omitted entirely when the submitter leaves it blank,
// so every field here is optional except content, which falls back to the
// raw message if the label line is ever missing — never returns empty.
function parseFeedbackMessage(content) {
  const text = content || '';
  const ratingMatch = text.match(/⭐\s*Rating:\s*(\d+)\s*\/\s*5/i);
  const feedbackMatch = text.match(/💬\s*Feedback\/Question:\s*([\s\S]*?)(?:\n\s*\n|$)/i);
  const contactMatch = text.match(/📧\s*Contact:\s*([\s\S]*?)(?:\n\s*\n|$)/i);
  return {
    rating: ratingMatch ? Math.min(5, parseInt(ratingMatch[1], 10)) : null,
    content: feedbackMatch ? feedbackMatch[1].trim() : text.trim(),
    contact: contactMatch ? contactMatch[1].trim() : null,
  };
}

// Fetches + parses feedback submissions from the feedback channel, merging
// in this dashboard's own resolve/dispute/keep-for-later status. Returns []
// on any failure (bad channel id, bot removed, permissions) rather than
// throwing — callers like /overview must never break because of this.
async function fetchFeedbackMessages(client, loadData) {
  const channel = await client.channels.fetch(FEEDBACK_CHANNEL_ID).catch(() => null);
  if (!channel) return [];

  const fetched = await channel.messages.fetch({ limit: 100 }).catch(() => null); // Discord's per-call cap; no pagination in v1
  if (!fetched) return [];

  const data = await loadData();
  return [...fetched.values()]
    .filter((m) => m.webhookId || /📩\s*New AniTracker Submission/i.test(m.content)) // ignore any unrelated message someone posts in this channel
    .map((m) => {
      const parsed = parseFeedbackMessage(m.content);
      return {
        messageId: m.id,
        ...parsed,
        postedAt: snowflakeToDate(m.id),
        status: data.feedbackStatus[m.id] || null,
      };
    })
    .sort((a, b) => Number(b.messageId) - Number(a.messageId));
}

// client: the discord.js Client instance (for live guild/channel/user info)
// deps: { loadData, saveData, getPaused, setPaused, botStartedAt }
function buildDashboardRouter(client, deps) {
  const { loadData, saveData, getPaused, setPaused, botStartedAt } = deps;
  const router = express.Router();

  router.use(express.json());

  // ---- Auth ----------------------------------------------------------
  router.post('/login', (req, res) => {
    const { password } = req.body || {};
    const expected = process.env.DASHBOARD_PASSWORD;
    if (!expected) {
      return res.status(500).json({ error: 'DASHBOARD_PASSWORD is not configured on the server.' });
    }
    if (typeof password !== 'string' || password !== expected) {
      return res.status(401).json({ error: 'Incorrect password.' });
    }
    setSessionCookie(res);
    res.json({ ok: true });
  });

  router.post('/logout', (req, res) => {
    clearSessionCookie(res);
    res.json({ ok: true });
  });

  router.get('/me', (req, res) => {
    res.json({ authenticated: isAuthenticated(req) });
  });

  // Everything below requires a valid session.
  router.use(requireAuth);

  // ---- Overview --------------------------------------------------------
  router.get('/overview', async (req, res) => {
    const data = await loadData();
    const guildIds = Object.keys(data.guilds);
    const totalTrackedUsers = guildIds.reduce((sum, id) => sum + (data.guilds[id].users?.length || 0), 0);
    const totalRecommendations = guildIds.reduce((sum, id) => {
      const recs = data.guilds[id].recommendations || {};
      return sum + Object.values(recs).reduce((s, r) => s + (r.recommendedBy?.length || 0), 0);
    }, 0);

    const feedback = await fetchFeedbackMessages(client, loadData);
    const pendingFeedback = feedback.filter((f) => !f.status).length;

    res.json({
      botTag: client.user?.tag || null,
      botAvatar: client.user?.displayAvatarURL?.({ size: 128 }) || null,
      totalServers: client.guilds.cache.size,
      totalTrackedUsers,
      totalRecommendations,
      botPaused: getPaused(),
      uptimeSeconds: Math.floor((Date.now() - botStartedAt) / 1000),
      pendingFeedback,
    });
  });

  // ---- Servers -----------------------------------------------------------
  router.get('/servers', async (req, res) => {
    const data = await loadData();
    const servers = client.guilds.cache.map((guild) => {
      const guildData = data.guilds[guild.id];
      const channel = guildData?.channelId ? guild.channels.cache.get(guildData.channelId) : null;
      return {
        id: guild.id,
        name: guild.name,
        icon: guild.iconURL({ size: 64 }) || null,
        memberCount: guild.memberCount ?? null,
        trackedUserCount: guildData?.users?.length || 0,
        channelId: guildData?.channelId || null,
        channelName: channel ? `#${channel.name}` : null,
      };
    });
    servers.sort((a, b) => b.trackedUserCount - a.trackedUserCount);
    res.json({ servers });
  });

  router.get('/servers/:guildId/channels', async (req, res) => {
    const guild = client.guilds.cache.get(req.params.guildId);
    if (!guild) return res.status(404).json({ error: 'Server not found (bot may have been removed).' });
    try {
      await guild.channels.fetch();
    } catch {
      // Fall back to cache if a fresh fetch fails.
    }
    const channels = guild.channels.cache
      .filter((c) => c.isTextBased && c.isTextBased() && !c.isThread())
      .map((c) => ({ id: c.id, name: c.name }))
      .sort((a, b) => a.name.localeCompare(b.name));
    res.json({ channels });
  });

  // ---- Tracked users ----------------------------------------------------
  router.get('/users', async (req, res) => {
    const data = await loadData();
    const users = [];
    for (const [guildId, guildData] of Object.entries(data.guilds)) {
      const guild = client.guilds.cache.get(guildId);
      for (const u of guildData.users || []) {
        users.push({
          guildId,
          guildName: guild?.name || 'Unknown server',
          username: u.username,
          anilistId: u.id,
          avatar: u.avatar || null,
          addedBy: u.addedBy || null,
          streak: u.streak || 0,
        });
      }
    }
    users.sort((a, b) => a.username.localeCompare(b.username));
    res.json({ users, total: users.length });
  });

  // ---- Recent activity ----------------------------------------------------
  router.get('/activity', async (req, res) => {
    const data = await loadData();
    const limit = Math.min(parseInt(req.query.limit, 10) || 50, 300);
    const posts = [];
    for (const [guildId, guildData] of Object.entries(data.guilds)) {
      const guild = client.guilds.cache.get(guildId);
      for (const [messageId, info] of Object.entries(guildData.recentPosts || {})) {
        posts.push({
          guildId,
          guildName: guild?.name || 'Unknown server',
          messageId,
          animeTitle: info.animeTitle || null,
          addedBy: info.addedBy || null,
          postedAt: snowflakeToDate(messageId),
        });
      }
    }
    posts.sort((a, b) => Number(b.messageId) - Number(a.messageId));
    res.json({ activity: posts.slice(0, limit) });
  });

  // ---- Leaderboards ----------------------------------------------------
  router.get('/leaderboards/recommended', async (req, res) => {
    const data = await loadData();
    const byMedia = new Map();
    for (const guildData of Object.values(data.guilds)) {
      for (const [mediaId, rec] of Object.entries(guildData.recommendations || {})) {
        if (!rec.title || !rec.recommendedBy?.length) continue;
        const existing = byMedia.get(mediaId) || { mediaId, title: rec.title, siteUrl: rec.siteUrl, count: 0 };
        existing.count += rec.recommendedBy.length;
        byMedia.set(mediaId, existing);
      }
    }
    const list = [...byMedia.values()].sort((a, b) => b.count - a.count).slice(0, 25);
    res.json({
      list,
      note: 'Summed per-server for now — global cross-server vote dedup is planned for a future update.',
    });
  });

  router.get('/leaderboards/watched', async (req, res) => {
    const data = await loadData();
    const list = Object.entries(data.watchStats || {})
      .map(([mediaId, s]) => ({ mediaId, title: s.title, siteUrl: s.siteUrl, count: s.count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 25);
    res.json({
      list,
      note: 'Counts every new activity update posted for that title, across all servers, since this dashboard shipped.',
    });
  });

  router.get('/leaderboards/watchlater', async (req, res) => {
    const data = await loadData();
    const byUser = new Map();
    for (const guildData of Object.values(data.guilds)) {
      for (const [userId, list] of Object.entries(guildData.watchlist || {})) {
        if (!list.length) continue;
        const existing = byUser.get(userId) || { userId, titles: new Map() };
        for (const entry of list) existing.titles.set(entry.mediaId, entry);
        byUser.set(userId, existing);
      }
    }
    const users = [...byUser.values()]
      .map((u) => ({ userId: u.userId, count: u.titles.size, titles: [...u.titles.values()] }))
      .sort((a, b) => b.count - a.count);
    res.json({ users });
  });

  router.get('/leaderboards/linked', async (req, res) => {
    const data = await loadData();
    const accounts = Object.entries(data.linkedAccounts || {}).map(([discordId, info]) => ({
      discordId,
      ...info,
    }));
    res.json({
      accounts,
      note: 'Placeholder — populates once AniList sign-in (/signin) ships.',
    });
  });

  // ---- Feedback ----------------------------------------------------------
  router.get('/feedback', async (req, res) => {
    const channel = await client.channels.fetch(FEEDBACK_CHANNEL_ID).catch(() => null);
    if (!channel) {
      return res.status(502).json({ error: 'Could not reach the feedback channel (bot removed, bad channel id, or missing permissions).' });
    }
    const feedback = await fetchFeedbackMessages(client, loadData);
    res.json({ feedback });
  });

  router.post('/feedback/:messageId/status', async (req, res) => {
    const { status } = req.body || {};
    if (status !== null && !VALID_FEEDBACK_STATUSES.has(status)) {
      return res.status(400).json({ error: 'status must be resolved, disputed, later, or null.' });
    }
    const data = await loadData();
    if (status === null || status === undefined) {
      delete data.feedbackStatus[req.params.messageId];
    } else {
      data.feedbackStatus[req.params.messageId] = status;
    }
    await saveData(data);
    res.json({ ok: true, status: status || null });
  });

  // ---- Send message ----------------------------------------------------
  router.post('/send', async (req, res) => {
    const { guildId, channelId, message } = req.body || {};
    if (!guildId || !channelId || !message || !message.trim()) {
      return res.status(400).json({ error: 'guildId, channelId, and message are all required.' });
    }
    const guild = client.guilds.cache.get(guildId);
    if (!guild) return res.status(404).json({ error: 'Server not found.' });
    try {
      const channel = await guild.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        return res.status(400).json({ error: 'That channel is not a text channel.' });
      }
      await channel.send(message);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: `Failed to send: ${e.message}` });
    }
  });

  // ---- Bot controls ----------------------------------------------------
  router.post('/pause', async (req, res) => {
    setPaused(true);
    const data = await loadData();
    data.botPaused = true;
    await saveData(data);
    res.json({ ok: true, botPaused: true });
  });

  router.post('/resume', async (req, res) => {
    setPaused(false);
    const data = await loadData();
    data.botPaused = false;
    await saveData(data);
    res.json({ ok: true, botPaused: false });
  });

  router.post('/redeploy', async (req, res) => {
    const hookUrl = process.env.RENDER_DEPLOY_HOOK_URL;
    if (!hookUrl) {
      return res.status(500).json({ error: 'RENDER_DEPLOY_HOOK_URL is not configured on the server.' });
    }
    try {
      const resp = await fetch(hookUrl, { method: 'POST' });
      if (!resp.ok) throw new Error(`Deploy hook returned ${resp.status}`);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: `Failed to trigger redeploy: ${e.message}` });
    }
  });

  return router;
}

module.exports = { buildDashboardRouter };
