const fs   = require('fs');
const path = require('path');
const os   = require('os');

const HISTORY_DIR = path.join(os.homedir(), '.marketingdna-client-sessions', 'history');
if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });

// ── Извлечение тем из скриптов ───────────────────────────────────────────────

function extractThemes(scripts, headingPattern) {
  if (!scripts) return [];
  const matches = [...scripts.matchAll(headingPattern)];
  return matches
    .map(m => m[1]?.trim())
    .filter(t => t && t.length > 3 && !t.startsWith('['));
}

function parseHistoryTopics(session) {
  const carouselThemes = extractThemes(session.carouselScripts, /КАРУСЕЛЬ\s+\d+[:\s]+([^\n]+)/gi);
  const videoThemes    = extractThemes(session.videoScripts,    /ВИДЕО\s+\d+[:\s]+([^\n]+)/gi);
  const photoThemes    = extractThemes(session.photoScripts,    /ФОТО\s+\d+[:\s]+([^\n]+)/gi);

  // Контент-план — берём темы постов (строки с "пост" или пронумерованные)
  const planText = session.calendar || session.contentPlan || '';
  const planTopics = extractThemes(planText, /(?:День\s+\d+|Пост\s+\d+|\d+\.\s)[:\s–-]+([^\n]{10,60})/gi);

  return { carouselThemes, videoThemes, photoThemes, planTopics };
}

// ── Сохранение истории месяца ─────────────────────────────────────────────────

function saveClientHistory(clientChatId, session) {
  const id   = String(clientChatId);
  const file = path.join(HISTORY_DIR, `${id}.history.json`);

  let record = { clientId: id, name: session.bot2Data?.name || '—', history: [] };
  try {
    if (fs.existsSync(file)) record = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {}

  const now   = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  // Не дублируем если уже есть запись за этот месяц
  if (record.history.some(h => h.month === month)) {
    console.log(`[history] запись за ${month} уже есть для ${id}`);
    return;
  }

  const { carouselThemes, videoThemes, photoThemes, planTopics } = parseHistoryTopics(session);

  record.history.push({
    month,
    savedAt:        Date.now(),
    packageKey:     session.paidPackageKey || '—',
    carouselThemes,
    videoThemes,
    photoThemes,
    planTopics,
  });

  // Храним максимум 6 месяцев
  if (record.history.length > 6) record.history = record.history.slice(-6);

  try {
    fs.writeFileSync(file, JSON.stringify(record, null, 2));
    console.log(`[history] сохранено для ${id}: ${month}, ${carouselThemes.length} каруселей, ${videoThemes.length} видео`);
  } catch (e) {
    console.error('[history] ошибка сохранения:', e.message);
  }
}

// ── Загрузка истории и формирование инструкции для Claude ────────────────────

function loadHistoryInstruction(clientChatId) {
  const file = path.join(HISTORY_DIR, `${String(clientChatId)}.history.json`);
  if (!fs.existsSync(file)) return '';

  let record;
  try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return ''; }

  const months = record.history || [];
  if (months.length === 0) return '';

  const lines = ['ИСТОРИЯ ПРЕДЫДУЩИХ МЕСЯЦЕВ (не повторяй эти темы — развивай дальше, показывай новые углы):'];

  for (const m of months) {
    lines.push(`\n${m.month}:`);
    if (m.carouselThemes?.length)  lines.push(`  Карусели: ${m.carouselThemes.join(' | ')}`);
    if (m.videoThemes?.length)     lines.push(`  Видео: ${m.videoThemes.join(' | ')}`);
    if (m.photoThemes?.length)     lines.push(`  Фото: ${m.photoThemes.join(' | ')}`);
    if (m.planTopics?.length)      lines.push(`  Посты: ${m.planTopics.slice(0, 10).join(' | ')}`);
  }

  lines.push('\nПравило: каждый новый месяц — новый угол тех же сильных тем бизнеса. Не повтори ни одного заголовка из списка выше.');

  return lines.join('\n');
}

module.exports = { saveClientHistory, loadHistoryInstruction };
