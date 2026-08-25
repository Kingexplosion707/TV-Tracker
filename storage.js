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

async function loadData() {
  if (redis) {
    try {
      const raw = await redis.get(STORAGE_KEY);
      if (!raw) return { guilds: {} };
      return typeof raw === 'string' ? JSON.parse(raw) : raw;
    } catch (e) {
      console.error('Failed to load from Upstash, starting fresh this run:', e.message);
      return { guilds: {} };
    }
  }

  try {
    if (!fs.existsSync(LOCAL_PATH)) return { guilds: {} };
    return JSON.parse(fs.readFileSync(LOCAL_PATH, 'utf8'));
  } catch (e) {
    console.error('Failed to load local storage, starting fresh:', e.message);
    return { guilds: {} };
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
