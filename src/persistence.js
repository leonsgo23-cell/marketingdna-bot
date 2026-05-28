const fs = require('fs');
const path = require('path');
const os = require('os');

// Храним в той же папке что и client-sessions — она на persistent volume Railway
const SESSIONS_DIR = path.join(os.homedir(), '.marketingdna-client-sessions', 'bot1_sessions');

if (!fs.existsSync(SESSIONS_DIR)) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
}

function saveSession(chatId, session) {
  try {
    fs.writeFileSync(
      path.join(SESSIONS_DIR, `${chatId}.json`),
      JSON.stringify(session, null, 2)
    );
  } catch (e) {
    console.error('Не удалось сохранить сессию:', e.message);
  }
}

function loadSession(chatId) {
  try {
    const filePath = path.join(SESSIONS_DIR, `${chatId}.json`);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    console.error('Не удалось загрузить сессию:', e.message);
  }
  return null;
}

function deleteSession(chatId) {
  try {
    const filePath = path.join(SESSIONS_DIR, `${chatId}.json`);
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
  } catch (e) {}
}

module.exports = { saveSession, loadSession, deleteSession };
