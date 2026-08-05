const fs = require('fs');
const path = require('path');

const STORAGE_PATH = path.join(__dirname, 'data', 'storage.json');

function loadData() {
  try {
    if (!fs.existsSync(STORAGE_PATH)) return { guilds: {} };
    return JSON.parse(fs.readFileSync(STORAGE_PATH, 'utf8'));
  } catch (e) {
    console.error('Failed to load storage, starting fresh:', e.message);
    return { guilds: {} };
  }
}

function saveData(data) {
  fs.mkdirSync(path.dirname(STORAGE_PATH), { recursive: true });
  fs.writeFileSync(STORAGE_PATH, JSON.stringify(data, null, 2));
}

module.exports = { loadData, saveData };
