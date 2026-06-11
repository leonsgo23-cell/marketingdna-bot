const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSIONS_DIR = path.join(os.homedir(), '.marketingdna-client-sessions');
const CODES_FILE = path.join(SESSIONS_DIR, 'access_codes.json');
const USAGE_FILE = path.join(SESSIONS_DIR, 'code_usage.json');

function loadCodes() {
  if (!fs.existsSync(CODES_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(CODES_FILE, 'utf8')); } catch { return {}; }
}

function loadUsage() {
  if (!fs.existsSync(USAGE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8')); } catch { return {}; }
}

function saveUsage(usage) {
  if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(USAGE_FILE, JSON.stringify(usage, null, 2));
}

// Возвращает null если код невалиден, или объект кода если валиден
function validateCode(code, chatId) {
  const codes = loadCodes();
  const usage = loadUsage();

  const normalized = code.trim().toUpperCase();
  const config = codes[normalized];
  if (!config) return null;

  // Проверяем срок действия
  if (config.expiry && new Date(config.expiry) < new Date()) return null;

  const users = usage[normalized] || [];

  // Этот пользователь уже активировал этот код
  if (users.includes(String(chatId))) return null;

  // Превышен лимит использований
  if (config.maxUses && users.length >= config.maxUses) return null;

  return { code: normalized, label: config.label || '', expiry: config.expiry, autoSend: config.autoSend || false, packageKey: config.packageKey || null, type: config.type || 'paid' };
}

function markCodeUsed(code, chatId) {
  const usage = loadUsage();
  const normalized = code.trim().toUpperCase();
  if (!usage[normalized]) usage[normalized] = [];
  if (!usage[normalized].includes(String(chatId))) {
    usage[normalized].push(String(chatId));
  }
  saveUsage(usage);
}

// Статистика использования кодов (для Александра)
function getCodeStats() {
  const codes = loadCodes();
  const usage = loadUsage();
  const lines = [];
  for (const [code, config] of Object.entries(codes)) {
    const used = (usage[code] || []).length;
    const max = config.maxUses || '∞';
    const expired = config.expiry && new Date(config.expiry) < new Date() ? ' ⛔ истёк' : '';
    lines.push(`${code} — ${used}/${max} использований, до ${config.expiry || 'бессрочно'}${expired} (${config.label || ''})`);
  }
  return lines.length > 0 ? lines.join('\n') : 'Коды не созданы';
}

module.exports = { validateCode, markCodeUsed, getCodeStats };
