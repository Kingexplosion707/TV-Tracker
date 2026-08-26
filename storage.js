const fs = require('fs');
const path = require('path');

const STORAGE_KEY = 'anitracker:data';
const LOCAL_PATH = path.join(__dirname, 'data', 'storage.json');

const hasUpstash = Boolean(process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN);

let redis = null;
if (hasUpstash) {
  // Lazy require so the package is only touched when actually configured —
  // keeps local dev working even before @upstash/redis env vars are set.
  const { Redis } = require('@upstash/redis');
  redis = new Redis({
    url: process.env.UPSTASH_REDIS_REST_URL,
    token: process.env.UPSTASH_REDIS_REST_TOKEN,
  });
  console.log('Storage: using Upstash Redis — data persists across restarts and redeploys.');
} else {
  console.log(
    'Storage: using local file storage — this will NOT survive a Render redeploy. Set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN to fix that.'
  );
}

// Ensures every top-level field the dashboard (and the rest of the bot)
// relies on exists, even for data blobs saved before these fields existed.
// Mirrors the same "backfill defaults on read" pattern index.js already
// uses for per-guild data via ensureGuildData.
function ensureTopLevel(data) {
  if (!data.guilds) data.guilds = {};
  if (typeof data.botPaused !== 'boolean') data.botPaused = false;
  // watchStats: global (cross-server) counter of how many times each root
  // anime/manga has shown up in a posted activity update. Keyed by the
  // resolved root AniList media id (same id used for the action buttons),
  // so seasons of the same show accumulate under one entry.
  if (!data.watchStats) data.watchStats = {};
  // linkedAccounts: Discord user id -> AniList account info, populated once
  // a real /signin OAuth flow exists. Empty scaffold for now so the
  // dashboard has a stable shape to read from.
  if (!data.linkedAccounts) data.linkedAccounts = {};
  // feedbackStatus: Discord message id (of a feedback submission posted by
  // the "AniTracker - Feedback" webhook) -> 'resolved' | 'disputed' | 'later'.
  // Absent entry means "New" (not yet triaged). Dashboard-only concern.
  if (!data.feedbackStatus) data.feedbackStatus = {};
  return data;
}

async function loadData() {
  if (redis) {
    try {
      const raw = await redis.get(STORAGE_KEY);
      if (!raw) return ensureTopLevel({ guilds: {} });
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return ensureTopLevel(parsed);
    } catch (e) {
      console.error('Failed to load from Upstash, starting fresh this run:', e.message);
      return ensureTopLevel({ guilds: {} });
    }
  }

  try {
    if (!fs.existsSync(LOCAL_PATH)) return ensureTopLevel({ guilds: {} });
    return ensureTopLevel(JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf8')));
  } catch (e) {
    console.error('Failed to load local storage, starting fresh:', e.message);
    return ensureTopLevel({ guilds: {} });
  }
}

async function saveData(data) {
  if (redis) {
    try {
      await redis.set(STORAGE_KEY, JSON.stringify(data));
    } catch (e) {
      console.error('Failed to save to Upstash:', e.message);
    }
    return;
  }

  try {
    fs.mkdirSync(path.dirname(LOCAL_PATH), { recursive: true });
    fs.writeFileSync(LOCAL_PATH, JSON.stringify(data, null, 2));
  } catch (e) {
    console.error('Failed to save local storage:', e.message);
  }
}

module.exports = { loadData, saveData };
