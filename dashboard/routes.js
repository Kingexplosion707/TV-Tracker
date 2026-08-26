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

    res.json({
      botTag: client.user?.tag || null,
      botAvatar: client.user?.displayAvatarURL?.({ size: 128 }) || null,
      totalServers: client.guilds.cache.size,
      totalTrackedUsers,
      totalRecommendations,
      botPaused: getPaused(),
      uptimeSeconds: Math.floor((Date.now() - botStartedAt) / 1000),
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
