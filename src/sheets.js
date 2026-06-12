/**
 * Google Sheets CRM integration
 *
 * Env vars needed:
 *   GOOGLE_SHEETS_ID          — ID таблицы (из URL: .../spreadsheets/d/{ID}/...)
 *   GOOGLE_SHEETS_CREDENTIALS — содержимое JSON-файла сервисного аккаунта (одной строкой)
 *
 * Листы в таблице (создаются автоматически если нет):
 *   "Клиенты"          — регистрация клиента (по одной записи на клиента)
 *   "История контента" — каждый завершённый месяц генерации
 */

const { google } = require('googleapis');

const SPREADSHEET_ID = process.env.GOOGLE_SHEETS_ID;

function getAuth() {
  const raw = process.env.GOOGLE_SHEETS_CREDENTIALS;
  if (!raw || !SPREADSHEET_ID) return null;
  try {
    const creds = JSON.parse(raw);
    return new google.auth.GoogleAuth({
      credentials: creds,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });
  } catch (e) {
    console.error('[sheets] ошибка парсинга credentials:', e.message);
    return null;
  }
}

async function getSheetsClient() {
  const auth = getAuth();
  if (!auth) return null;
  const client = await auth.getClient();
  return google.sheets({ version: 'v4', auth: client });
}

// ── Обеспечиваем существование листа ─────────────────────────────────────────

async function ensureSheet(sheets, title, headers) {
  try {
    const meta = await sheets.spreadsheets.get({ spreadsheetId: SPREADSHEET_ID });
    const exists = meta.data.sheets.some(s => s.properties.title === title);

    if (!exists) {
      await sheets.spreadsheets.batchUpdate({
        spreadsheetId: SPREADSHEET_ID,
        resource: {
          requests: [{ addSheet: { properties: { title } } }],
        },
      });
      // Добавляем заголовки
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${title}!A1`,
        valueInputOption: 'RAW',
        resource: { values: [headers] },
      });
    }
  } catch (e) {
    console.error(`[sheets] ensureSheet "${title}" error:`, e.message);
  }
}

// ── Добавить или обновить клиента (лист "Клиенты") ───────────────────────────

async function upsertClient({ chatId, name, email, source, registeredAt, packageKey, language, competitors, status, freePackagesCount }) {
  const sheets = await getSheetsClient();
  if (!sheets) return;

  const SHEET = 'Клиенты';
  const HEADERS = ['ChatId', 'Имя', 'Email', 'Источник', 'Дата регистрации', 'Тариф', 'Язык', 'Конкуренты', 'Статус', 'Бесплатных пакетов'];
  await ensureSheet(sheets, SHEET, HEADERS);

  try {
    // Ищем существующую строку по ChatId
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET}!A:A`,
    });
    const rows = res.data.values || [];
    const rowIndex = rows.findIndex(r => String(r[0]) === String(chatId));

    const row = [
      String(chatId),
      name    || '—',
      email   || '—',
      source  || '—',
      registeredAt || new Date().toISOString().slice(0, 10),
      packageKey   || '—',
      language     || 'ru',
      Array.isArray(competitors) ? competitors.join(', ') : (competitors || '—'),
      status  || 'активный',
      freePackagesCount !== undefined ? String(freePackagesCount) : '—',
    ];

    if (rowIndex > 0) {
      // Обновляем существующую строку (rowIndex +1 из-за заголовка, +1 из-за 1-based)
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET}!A${rowIndex + 1}`,
        valueInputOption: 'RAW',
        resource: { values: [row] },
      });
    } else {
      // Добавляем новую строку
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET}!A1`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        resource: { values: [row] },
      });
    }
    console.log(`[sheets] клиент ${chatId} (${name}) записан`);
  } catch (e) {
    console.error('[sheets] upsertClient error:', e.message);
  }
}

// ── Добавить строку истории контента (лист "История контента") ───────────────

async function appendContentHistory({ chatId, name, month, packageKey, language,
  carouselThemes, videoThemes, photoThemes, storyThemes, seoTopics, planTopics }) {

  const sheets = await getSheetsClient();
  if (!sheets) return;

  const SHEET = 'История контента';
  const HEADERS = [
    'ChatId', 'Имя', 'Месяц', 'Тариф', 'Язык',
    'Карусели', 'Видео', 'Фото', 'Stories', 'SEO-статьи',
    'Темы постов (план)', 'Дата записи',
  ];
  await ensureSheet(sheets, SHEET, HEADERS);

  const join = arr => Array.isArray(arr) ? arr.join(' | ') : (arr || '—');

  const row = [
    String(chatId),
    name        || '—',
    month       || new Date().toISOString().slice(0, 7),
    packageKey  || '—',
    language    || 'ru',
    join(carouselThemes),
    join(videoThemes),
    join(photoThemes),
    join(storyThemes),
    join(seoTopics),
    join(planTopics?.slice(0, 15)),
    new Date().toISOString().slice(0, 16).replace('T', ' '),
  ];

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: [row] },
    });
    console.log(`[sheets] история ${chatId} ${month} записана`);
  } catch (e) {
    console.error('[sheets] appendContentHistory error:', e.message);
  }
}

// ── История бесплатных пакетов (лист "Бесплатные пакеты") ────────────────────

async function appendFreePackageHistory({ chatId, name, business, city, language, packageNumber }) {
  const sheets = await getSheetsClient();
  if (!sheets) return;

  const SHEET = 'Бесплатные пакеты';
  const HEADERS = ['ChatId', 'Имя', 'Бизнес', 'Город', 'Язык', 'Пакет №', 'Дата'];
  await ensureSheet(sheets, SHEET, HEADERS);

  const row = [
    String(chatId),
    name         || '—',
    (business || '').slice(0, 150),
    city         || '—',
    language     || 'ru',
    String(packageNumber || 1),
    new Date().toISOString().slice(0, 16).replace('T', ' '),
  ];

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: [row] },
    });
    console.log(`[sheets] бесплатный пакет #${packageNumber} для ${chatId} записан`);
  } catch (e) {
    console.error('[sheets] appendFreePackageHistory error:', e.message);
  }
}

// ── История всех пакетов (лист "Все пакеты") ─────────────────────────────────

async function appendPackageHistory({ chatId, name, packageType, packageKey, language, status, details }) {
  const sheets = await getSheetsClient();
  if (!sheets) return;

  const SHEET = 'Все пакеты';
  const HEADERS = ['ChatId', 'Имя', 'Тип', 'Тариф', 'Язык', 'Статус', 'Детали', 'Дата'];
  await ensureSheet(sheets, SHEET, HEADERS);

  const row = [
    String(chatId),
    name        || '—',
    packageType || '—',   // 'free' | 'paid' | 'addlang'
    packageKey  || '—',
    language    || 'ru',
    status      || '—',   // 'delivered' | 'paid' | 'started' | 'approved'
    (details || '').slice(0, 200),
    new Date().toISOString().slice(0, 16).replace('T', ' '),
  ];

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: [row] },
    });
    console.log(`[sheets] пакет ${packageType}/${packageKey} для ${chatId} записан`);
  } catch (e) {
    console.error('[sheets] appendPackageHistory error:', e.message);
  }
}

// ── Вспомогательная: добавить дни к дате ─────────────────────────────────────

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// ── Добавить строку в "История" (каждое событие доставки) ─────────────────────
// Один клиент → много строк. Никогда не удаляется.
//
// event: 'free' | 'wave1' | 'wave2' | 'addlang'
// contentSummary: "4 карусели · 4 фото · 8 stories · 2 видео"
// link: URL HTML-страницы клиента
// nextAction: "Отправить Wave 2 · 16.06"
// nextDate: "2026-06-16"

async function appendClientHistory({ chatId, name, packageKey, language, event, contentSummary, link, nextAction, nextDate }) {
  const sheets = await getSheetsClient();
  if (!sheets) return;

  const SHEET = 'История';
  const HEADERS = ['Дата', 'Имя', 'ChatId', 'Пакет', 'Язык', 'Событие', 'Что получил', 'Ссылка', 'Следующее действие', 'Дата следующего действия'];
  await ensureSheet(sheets, SHEET, HEADERS);

  const EVENT_LABELS = {
    free:    'Бесплатный пакет',
    wave1:   'Платный — Wave 1 (дни 1–15)',
    wave2:   'Платный — Wave 2 (дни 16–30)',
    addlang: 'Доп. язык',
  };

  const PKG_LABELS = {
    free:         'Бесплатный',
    pkg_a:        'Старт €150',
    pkg_standard: 'Стандарт €250',
    pkg_v:        'Профи €350',
  };

  const row = [
    today(),
    name           || '—',
    String(chatId),
    PKG_LABELS[packageKey] || packageKey || '—',
    (language || 'ru').toUpperCase(),
    EVENT_LABELS[event] || event || '—',
    contentSummary || '—',
    link           || '—',
    nextAction     || '—',
    nextDate       || '—',
  ];

  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET}!A1`,
      valueInputOption: 'RAW',
      insertDataOption: 'INSERT_ROWS',
      resource: { values: [row] },
    });
    console.log(`[sheets] история ${event} для ${chatId} записана`);
  } catch (e) {
    console.error('[sheets] appendClientHistory error:', e.message);
  }
}

// ── Обновить или создать строку в "Дашборд" (один клиент = одна строка) ───────
// Обновляется при каждом ключевом событии.
//
// status: 'генерация' | 'на_проверке' | 'wave1_отправлена' | 'wave2_отправлена' | 'ждёт_продления' | 'завершён'

async function upsertDashboard({ chatId, name, packageKey, language, status,
  wave1Date, wave1Link, wave2Date, wave2Link, nextAction, nextDate }) {

  const sheets = await getSheetsClient();
  if (!sheets) return;

  const SHEET = 'Дашборд';
  const HEADERS = [
    'ChatId', 'Имя', 'Пакет', 'Язык', 'Статус',
    'Wave 1 отправлена', 'Ссылка Wave 1',
    'Wave 2 отправлена', 'Ссылка Wave 2',
    'Следующее действие', 'Дата следующего действия',
    'Последнее обновление',
  ];
  await ensureSheet(sheets, SHEET, HEADERS);

  const PKG_LABELS = {
    free:         'Бесплатный',
    pkg_a:        'Старт €150',
    pkg_standard: 'Стандарт €250',
    pkg_v:        'Профи €350',
  };

  const row = [
    String(chatId),
    name        || '—',
    PKG_LABELS[packageKey] || packageKey || '—',
    (language || 'ru').toUpperCase(),
    status      || '—',
    wave1Date   || '—',
    wave1Link   || '—',
    wave2Date   || '—',
    wave2Link   || '—',
    nextAction  || '—',
    nextDate    || '—',
    today(),
  ];

  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId: SPREADSHEET_ID,
      range: `${SHEET}!A:A`,
    });
    const rows = res.data.values || [];
    const rowIndex = rows.findIndex(r => String(r[0]) === String(chatId));

    if (rowIndex > 0) {
      await sheets.spreadsheets.values.update({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET}!A${rowIndex + 1}`,
        valueInputOption: 'RAW',
        resource: { values: [row] },
      });
    } else {
      await sheets.spreadsheets.values.append({
        spreadsheetId: SPREADSHEET_ID,
        range: `${SHEET}!A1`,
        valueInputOption: 'RAW',
        insertDataOption: 'INSERT_ROWS',
        resource: { values: [row] },
      });
    }
    console.log(`[sheets] дашборд ${chatId} (${status}) обновлён`);
  } catch (e) {
    console.error('[sheets] upsertDashboard error:', e.message);
  }
}

// ── Удобная проверка: настроен ли Sheets ─────────────────────────────────────

function isSheetsConfigured() {
  return !!(process.env.GOOGLE_SHEETS_ID && process.env.GOOGLE_SHEETS_CREDENTIALS);
}

module.exports = {
  upsertClient,
  appendContentHistory,
  appendFreePackageHistory,
  appendPackageHistory,
  appendClientHistory,
  upsertDashboard,
  addDays,
  isSheetsConfigured,
};
