require('dotenv').config();
const { Telegraf } = require('telegraf');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const BOT3_TOKEN   = process.env.TELEGRAM_BOT3_TOKEN;
const ACCESS_CODE  = process.env.BOT3_ACCESS_CODE;
const VISUAL_SVC   = process.env.VISUAL_SERVICE_URL || 'http://localhost:3002';
const BOT4_ENABLED = !!process.env.TELEGRAM_BOT4_TOKEN; // Bot4 активен если задан токен

if (!BOT3_TOKEN) { console.error('TELEGRAM_BOT3_TOKEN не задан'); process.exit(1); }
if (!ACCESS_CODE) { console.error('BOT3_ACCESS_CODE не задан'); process.exit(1); }

const sleep = ms => new Promise(r => setTimeout(r, ms));

const BASE_DIR      = path.join(os.homedir(), '.marketingdna-client-sessions');
const RESULTS_DIR   = path.join(BASE_DIR, 'visual_results');
const TRIGGERS_DIR  = path.join(BASE_DIR, 'triggers');
const BOT3_SESS_DIR = path.join(BASE_DIR, 'bot3_sessions');

if (!fs.existsSync(BOT3_SESS_DIR)) fs.mkdirSync(BOT3_SESS_DIR, { recursive: true });

const bot = new Telegraf(BOT3_TOKEN, { handlerTimeout: 300000 });

// Persistent sessions — survive bot restarts
function getSession(id) {
  const file = path.join(BOT3_SESS_DIR, `${id}.json`);
  try {
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { /* ignore */ }
  return { authorized: false };
}
function saveSession3(id, data) {
  try {
    fs.writeFileSync(path.join(BOT3_SESS_DIR, `${id}.json`), JSON.stringify(data, null, 2));
  } catch { /* ignore */ }
}

const SECTION_LABELS = {
  photos:     '📸 Фото постов (8 шт)',
  carousels:  '🎠 Слайды каруселей',
  stories:    '📱 Stories (15 шт)',
  covers:     '🖼 Обложки',
  highlights: '🔵 Highlights (обложки разделов)',
  videos:     '🎬 Видео B-roll (8 шт)',
};

// ── Auth ───────────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  await ctx.reply('👋 Marketing DNA — Менеджер\n\nВведите код доступа:');
});

function requireAuth(fn) {
  return async (ctx) => {
    if (!getSession(ctx.chat.id).authorized) {
      return ctx.reply('Введите код доступа: /start');
    }
    return fn(ctx);
  };
}

// ── Text handler (auth + video feedback) ──────────────────────────────────────

bot.on('text', async (ctx, next) => {
  const sess = getSession(ctx.chat.id);

  // Если это команда (/something) — пропускаем все awaiting-обработчики
  // чтобы команда дошла до bot.command() хендлеров
  if (ctx.message.text.trim().startsWith('/')) return next();

  // Auth
  if (!sess.authorized) {
    if (ctx.message.text.trim() === ACCESS_CODE) {
      sess.authorized = true;
      saveSession3(ctx.chat.id, sess);
      await ctx.reply(
        '✅ Доступ открыт.\n\n' +
        'Когда визуал для клиента будет готов — получите уведомление здесь.\n\n' +
        'Команды:\n' +
        '/queue — очередь на проверку\n' +
        '/review_{chatId} — начать проверку\n' +
        '/test_paid {chatId} {тариф} — тест без вопросов (быстро)\n' +
        '/test_paid_full {chatId} {тариф} — полный тест с вопросами клиенту (реальный флоу)\n' +
        '/test_quality {chatId} {тариф} — тест качества: 1 штука каждого типа с реальными текстами\n' +
        '  тарифы: a (Старт) / standard (Стандарт) / v (Профи)'
      );
    } else {
      await ctx.reply('❌ Неверный код. Попробуйте ещё раз:');
    }
    return;
  }

  // (ручная отправка Metricool ссылки убрана — теперь всё автоматически)

  // Custom video: manager wrote their own scenario
  if (sess.awaitingCustomVideo) {
    sess.awaitingCustomVideo = false;
    saveSession3(ctx.chat.id, sess);
    const scenario = ctx.message.text.trim();
    const { default: fetch } = await import('node-fetch');
    await ctx.reply(`✅ Сценарий принят — генерирую видео (~5-10 мин)...`);
    await fetch(`${VISUAL_SVC}/custom_video`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario, chatId: String(ctx.chat.id) }),
    }).catch(e => ctx.reply(`⚠️ Ошибка: ${e.message}`));
    return;
  }

  // Custom carousel: manager wrote their own scenario
  if (sess.awaitingCustomCarousel) {
    sess.awaitingCustomCarousel = false;
    saveSession3(ctx.chat.id, sess);
    const scenario = ctx.message.text.trim();
    const { default: fetch } = await import('node-fetch');
    await ctx.reply(`✅ Тема принята — генерирую 7 слайдов (~5-10 мин)...`);
    await fetch(`${VISUAL_SVC}/custom_carousel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scenario, chatId: String(ctx.chat.id) }),
    }).catch(e => ctx.reply(`⚠️ Ошибка: ${e.message}`));
    return;
  }

  // Waiting for regen feedback
  if (sess.awaitingRegenFeedback) {
    const { section, index, clientChatId } = sess.awaitingRegenFeedback;
    sess.awaitingRegenFeedback = null;
    saveSession3(ctx.chat.id, sess);

    const feedback = ctx.message.text.trim();
    const sectionLabels = { ph: 'Фото', ca: 'Слайд', co: 'Обложка', st: 'Story', hl: 'Highlight' };
    const label = `${sectionLabels[section] || section} ${index + 1}`;

    await ctx.reply(`🔄 Перегенерирую «${label}»${feedback !== '+' ? ` с учётом: "${feedback}"` : ''}...\nПришлю когда будет готово.`);

    const { default: fetch } = await import('node-fetch');
    await fetch(`${VISUAL_SVC}/regen_item`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ clientChatId, section, index, feedback: feedback !== '+' ? feedback : '' }),
    }).catch(e => ctx.reply(`⚠️ Ошибка: ${e.message}`));
    return;
  }

  // ── Visual sample handlers (проверяем ДО старых paid-package обработчиков) ───

  if (sess.awaitingSampleFragRegen) {
    const { clientChatId, fragIndex } = sess.awaitingSampleFragRegen;
    sess.awaitingSampleFragRegen = null;
    saveSession3(ctx.chat.id, sess);
    const feedback = ctx.message.text.trim();
    await ctx.reply(`🔄 Перегенерирую фрагмент ${fragIndex + 1}${feedback !== '+' ? ` — с учётом: "${feedback}"` : ''}...\nПришлю когда будет готово.`);
    const { default: fetch } = await import('node-fetch');
    await fetch(`${VISUAL_SVC}/regen_sample_fragment`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ clientChatId, fragIndex, feedback: feedback !== '+' ? feedback : '' }),
    }).catch(e => ctx.reply(`⚠️ Ошибка: ${e.message}`));
    return;
  }

  if (sess.awaitingSampleRegen) {
    const { type, clientChatId, index } = sess.awaitingSampleRegen;
    sess.awaitingSampleRegen = null;
    saveSession3(ctx.chat.id, sess);
    const feedback = ctx.message.text.trim();
    const label    = VS_TYPE_LABELS[type] || type;
    await ctx.reply(`🔄 Перегенерирую ${label}${type === 'c' ? ` (слайд ${index + 1})` : ''}${feedback !== '+' ? ` — с учётом: "${feedback}"` : ''}...\nПришлю когда будет готово.`);
    const { default: fetch } = await import('node-fetch');
    await fetch(`${VISUAL_SVC}/regen_sample_slot`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ clientChatId, type, index, feedback: feedback !== '+' ? feedback : '' }),
    }).catch(e => ctx.reply(`⚠️ Ошибка: ${e.message}`));
    return;
  }

  if (sess.awaitingSampleTextEdit) {
    const { type, clientChatId, index } = sess.awaitingSampleTextEdit;
    sess.awaitingSampleTextEdit = null;
    saveSession3(ctx.chat.id, sess);
    const newText = ctx.message.text.trim();
    await ctx.reply(`✅ Применяю новый текст: "${newText}"...`);
    const { default: fetch } = await import('node-fetch');
    await fetch(`${VISUAL_SVC}/edit_sample_text`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ clientChatId, type, index, text: newText }),
    }).catch(e => ctx.reply(`⚠️ Ошибка: ${e.message}`));
    return;
  }

  // Редактирование подписи к карусели
  if (sess.awaitingCarouselCapEdit) {
    if (ctx.message.text.trim().startsWith('/')) {
      sess.awaitingCarouselCapEdit = null;
      saveSession3(ctx.chat.id, sess);
      return;
    }
    const { ci, clientChatId } = sess.awaitingCarouselCapEdit;
    sess.awaitingCarouselCapEdit = null;
    saveSession3(ctx.chat.id, sess);

    const newCaption = ctx.message.text.trim();
    const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
    let data = {};
    try { data = JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch {}
    if (!data.prompts) data.prompts = {};
    if (!data.prompts.carouselPostCaptions) data.prompts.carouselPostCaptions = [];
    data.prompts.carouselPostCaptions[ci] = newCaption;
    try { fs.writeFileSync(resultPath, JSON.stringify(data, null, 2)); } catch {}
    await ctx.reply(`✅ Подпись Карусели ${ci + 1} обновлена:\n\n${newCaption}`);
    return;
  }

  // Waiting for text edit input (paid package)
  if (sess.awaitingTextEdit) {
    if (ctx.message.text.trim().startsWith('/')) {
      sess.awaitingTextEdit = null;
      saveSession3(ctx.chat.id, sess);
      return;
    }

    const { section, index, clientChatId } = sess.awaitingTextEdit;
    sess.awaitingTextEdit = null;
    saveSession3(ctx.chat.id, sess);

    const newText = ctx.message.text.trim();
    const key = `${section}_${index}`;
    const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
    let data = {};
    try { data = JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch {}
    if (!data.editedTexts) data.editedTexts = {};
    data.editedTexts[key] = newText;
    try { fs.writeFileSync(resultPath, JSON.stringify(data, null, 2)); } catch {}

    if (section === 'video') {
      const { default: fetch } = await import('node-fetch');
      await fetch(`${VISUAL_SVC}/regen_video`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ clientChatId, videoIndex: index, subtitleOverride: newText }),
      }).catch(() => {});
      await ctx.reply(`✅ Субтитр для Видео ${index + 1} обновлён — пересобираю видео...\n\n"${newText}"`);
      return;
    }

    const sectionLabels = { ph: 'Фото', ca: 'Слайд', co: 'Обложка', st: 'Story', hl: 'Highlight' };
    const label = `${sectionLabels[section] || section} ${index + 1}`;
    await ctx.reply(`✅ Текст для «${label}» сохранён — пересобираю картинку с новым текстом...`);

    const { default: fetch } = await import('node-fetch');
    await fetch(`${VISUAL_SVC}/preview_edit`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ clientChatId, section, index, text: newText }),
    }).catch(() => {});
    return;
  }

  // Waiting for video script edit feedback (before Veo3 generation)
  if (sess.awaitingVideoScriptEdit) {
    const { clientChatId } = sess.awaitingVideoScriptEdit;
    sess.awaitingVideoScriptEdit = null;
    saveSession3(ctx.chat.id, sess);
    const feedback = ctx.message.text.trim();
    await ctx.reply(`✅ Перерабатываю сценарии с учётом вашего комментария...`);
    const { default: fetch } = await import('node-fetch');
    await fetch(`${VISUAL_SVC}/rewrite_video_scripts`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ clientChatId, feedback }),
    }).catch(e => ctx.reply(`⚠️ Ошибка: ${e.message}`));
    return;
  }

  // Waiting for video feedback
  if (sess.awaitingVideoFeedback) {
    const feedback     = ctx.message.text.trim();
    const clientChatId = sess.reviewing;
    const videoIndex   = sess.videoFeedbackIndex;
    sess.awaitingVideoFeedback = false;
    sess.videoFeedbackIndex    = null;

    await ctx.reply(`🔄 Анализирую фидбек и запускаю переделку видео ${videoIndex + 1}...\n\nПолучите уведомление когда будет готово.`);

    const { default: fetch } = await import('node-fetch');
    await fetch(`${VISUAL_SVC}/regen_video`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ clientChatId, videoIndex, feedback }),
    }).catch(e => ctx.reply(`⚠️ Ошибка: ${e.message}`));
    return;
  }

  return next();
});

// ── Commands ───────────────────────────────────────────────────────────────────

// ── /cycle_health — статус checkAnalyticsCycle ────────────────────────────────
bot.command('cycle_health', requireAuth(async (ctx) => {
  const healthPath = path.join(BASE_DIR, 'cycle_health.json');
  let h = {};
  try { h = JSON.parse(fs.readFileSync(healthPath, 'utf8')); } catch {}

  if (!h.lastRunAt) {
    return ctx.reply('⚠️ cycle_health.json не найден.\n\nЦикл ещё ни разу не запускался после последнего деплоя — это нормально если деплой был только что. Проверьте через час.');
  }

  const lastRun    = new Date(h.lastRunAt);
  const minsAgo    = Math.round((Date.now() - h.lastRunAt) / 60000);
  const status     = minsAgo < 90 ? '✅ Работает' : minsAgo < 180 ? '⚠️ Задержка' : '🔴 Возможен сбой';

  await ctx.reply(
    `${status} — checkAnalyticsCycle\n\n` +
    `Последний запуск: ${lastRun.toLocaleString('ru-RU')} (${minsAgo} мин назад)\n` +
    `Всего запусков: ${h.runsTotal || 0}\n\n` +
    `Цикл должен запускаться каждые 60 мин.\nЕсли задержка >90 мин — проверьте логи Railway.`
  );
}));

bot.command('queue', requireAuth(async (ctx) => {
  const lines = [];

  // ── Раздел 1: активные генерации (из queue_status.json) ──────────────────
  const STATUS_PATH = path.join(BASE_DIR, 'queue_status.json');
  if (fs.existsSync(STATUS_PATH)) {
    try {
      const status = JSON.parse(fs.readFileSync(STATUS_PATH, 'utf8'));
      const freeIds  = status.free  || [];
      const paidIds  = status.paid  || [];
      const ageSec   = Math.round((Date.now() - (status.updatedAt || 0)) / 1000);

      if (freeIds.length > 0) {
        lines.push(`⚙️ Генерация бесплатных (${freeIds.length}):`);
        for (const id of freeIds) {
          const sess = (() => { try { return JSON.parse(fs.readFileSync(path.join(BASE_DIR, `${id}.json`), 'utf8')); } catch { return null; } })();
          const name = sess?.name || sess?.bot2Data?.name || id;
          lines.push(`  • ${name} (${id})`);
        }
      }
      if (paidIds.length > 0) {
        lines.push(`⚙️ Генерация платных (${paidIds.length}):`);
        for (const id of paidIds) {
          const sess = (() => { try { return JSON.parse(fs.readFileSync(path.join(BASE_DIR, `${id}.json`), 'utf8')); } catch { return null; } })();
          const name = sess?.name || sess?.bot2Data?.name || id;
          lines.push(`  • ${name} (${id})`);
        }
      }
      if (freeIds.length === 0 && paidIds.length === 0) lines.push('⚙️ Активных генераций нет');
      lines.push(`(обновлено ${ageSec} сек назад)\n`);
    } catch {}
  }

  // ── Раздел 2: бесплатные — ждут одобрения (pending/) ─────────────────────
  const PENDING_DIR = path.join(BASE_DIR, 'pending');
  if (fs.existsSync(PENDING_DIR)) {
    const pendingFiles = fs.readdirSync(PENDING_DIR).filter(f => f.endsWith('.json') && !f.includes('demo'));
    if (pendingFiles.length > 0) {
      lines.push(`🆓 Бесплатных ждут одобрения (${pendingFiles.length}):`);
      for (const f of pendingFiles) {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(PENDING_DIR, f), 'utf8'));
          const name = d.clientData?.name || d.name || f.replace('.json', '');
          lines.push(`  • ${name} — нажми send_free в Bot3`);
        } catch {}
      }
      lines.push('');
    }
  }

  // ── Раздел 3: платные — ждут одобрения (results/) ────────────────────────
  if (fs.existsSync(RESULTS_DIR)) {
    const resultFiles = fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith('.results.json'));
    if (resultFiles.length > 0) {
      lines.push(`💳 Платных ждут одобрения (${resultFiles.length}):`);
      for (const f of resultFiles) {
        try {
          const d = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf8'));
          const approved = Object.keys(d.approved || {}).length;
          const total    = getSections(d.packageKey).length;
          const cname = (d.clientName && d.clientName !== '—') ? d.clientName : (d.clientChatId || '?');
          lines.push(`  • ${cname} — ${approved}/${total} разделов ✅  /review_${d.clientChatId}`);
        } catch {}
      }
    }
  }

  if (lines.length === 0) return ctx.reply('Всё чисто — нет ни активных генераций, ни пакетов на одобрение.');
  await ctx.reply('📋 Статус клиентов:\n\n' + lines.join('\n'));
}));

bot.hears(/^\/review_(\d+)$/, requireAuth(async (ctx) => {
  const clientChatId = ctx.match[1];
  const sess         = getSession(ctx.chat.id);
  const resultPath   = path.join(RESULTS_DIR, `${clientChatId}.results.json`);

  if (!fs.existsSync(resultPath)) return ctx.reply('❌ Результаты не найдены.');

  const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  sess.reviewing    = clientChatId;
  sess.reviewData   = data;
  sess.sections     = getSections(data.packageKey);
  sess.sectionIndex = 0;
  sess.awaitingVideoFeedback = false;
  saveSession3(ctx.chat.id, sess);

  await ctx.reply(
    `🔍 Проверка — *${data.clientName}*\n\n${sess.sections.length} разделов.`,
    { parse_mode: 'Markdown' }
  );
  await showSection(ctx, sess);
}));

// ── Section display ────────────────────────────────────────────────────────────

function getSections(packageKey) {
  const s = ['photos', 'carousels', 'stories', 'covers'];
  if (packageKey.includes('pkg_v') || packageKey.includes('pkg_standard')) {
    s.push('highlights');
    s.push('videos');
  }
  return s;
}

async function showSection(ctx, sess) {
  const section = sess.sections[sess.sectionIndex];
  if (!section) { await showFinalApproval(ctx, sess); return; }

  if (section === 'videos') {
    await showVideos(ctx, sess);
  } else {
    await showImageSection(ctx, sess, section);
  }
}

async function showImageSection(ctx, sess, section) {
  const data         = sess.reviewData;
  const label        = SECTION_LABELS[section];
  const clientChatId = sess.reviewing;
  const secCode      = { photos: 'ph', carousels: 'ca', stories: 'st', covers: 'co', highlights: 'hl' }[section];
  const itemLabel    = { ph: 'Фото', ca: 'Карусель', st: 'Story', co: 'Обложка', hl: 'Highlight' }[secCode] || 'Элемент';

  await ctx.reply(
    `─────────────────────\n` +
    `Раздел ${sess.sectionIndex + 1}/${sess.sections.length}: *${label}*`,
    { parse_mode: 'Markdown' }
  );

  if (section === 'carousels') {
    // Карусели группами по 7 слайдов — с оверлеем если есть
    const slideMedia = getSectionMedia(data, section);
    const groups = data.prompts?.carouselGroups || [7, 7, 7, 7].slice(0, Math.ceil(slideMedia.length / 7));
    let slideIdx = 0;
    for (let ci = 0; ci < groups.length; ci++) {
      const count    = groups[ci] || 7;
      const batch    = slideMedia.slice(slideIdx, slideIdx + count);
      const startSlide = slideIdx;
      slideIdx += count;
      if (batch.length === 0) continue;

      await ctx.reply(`Карусель ${ci + 1}/${groups.length} (${batch.length} слайдов):`);
      for (let i = 0; i < batch.length; i += 10) {
        const group = batch.slice(i, i + 10);
        await ctx.replyWithMediaGroup(
          group.map(m => ({ type: 'photo', media: m }))
        ).catch(async () => {
          for (const m of group) await ctx.replyWithPhoto(m).catch(() => {});
        });
      }
      const carCap = (data.prompts?.carouselPostCaptions || [])[ci];
      if (carCap) {
        await sleep(60);
        await ctx.reply(`📝 Подпись к посту:\n\n${carCap}`).catch(() => {});
      }
      await ctx.reply(`Карусель ${ci + 1}:`, {
        reply_markup: { inline_keyboard: [[
          { text: '🔄 Переделать',      callback_data: `ri_regen_ca_${startSlide}_${clientChatId}` },
          { text: '✏️ Изм. заголовок',  callback_data: `ri_edit_ca_${startSlide}_${clientChatId}` },
          { text: '✏️ Изм. подпись',    callback_data: `ri_edit_cap_ca_${ci}_${clientChatId}` },
        ]]}
      });
    }

  } else {
    // Фото, Stories, Обложки — каждый с оверлеем + подпись к посту + кнопки
    const mediaItems = getSectionMedia(data, section);
    const captions   = section === 'photos'  ? (data.prompts?.photoCaptions  || []) :
                       section === 'stories' ? (data.prompts?.storyCaptions  || []) : [];

    for (let i = 0; i < mediaItems.length; i++) {
      if (i > 0) await sleep(60); // не превышаем лимит Telegram 30 сообщ/сек
      await ctx.replyWithPhoto(mediaItems[i], {
        caption: `${itemLabel} ${i + 1} / ${mediaItems.length}`,
      }).catch(() => {});

      // Подпись к посту (текст для публикации)
      if (captions[i]) {
        await sleep(60);
        await ctx.reply(`📝 Подпись к посту:\n\n${captions[i]}`).catch(() => {});
      }

      await sleep(60);
      await ctx.reply(`${itemLabel} ${i + 1}:`, {
        reply_markup: { inline_keyboard: [[
          { text: '🔄 Переделать',  callback_data: `ri_regen_${secCode}_${i}_${clientChatId}` },
          { text: '✏️ Изм. текст',  callback_data: `ri_edit_${secCode}_${i}_${clientChatId}` },
        ]]}
      });
    }
  }

  // Подвал раздела
  await ctx.reply('Раздел проверен?', {
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Раздел ок',       callback_data: `approve_${section}` }],
      [{ text: '🔄 Переделать всё',  callback_data: `regen_${section}` }],
    ]},
  });
}

async function showVideos(ctx, sess) {
  const data      = sess.reviewData;
  const videoData = data.results.videoData || [];
  const valid     = videoData.filter(v => v?.localPath && fs.existsSync(v.localPath));

  await ctx.reply(
    `─────────────────────\n` +
    `Раздел ${sess.sectionIndex + 1}/${sess.sections.length}: *🎬 Видео B-roll*\n` +
    `Готово: ${valid.length}/${videoData.length}`,
    { parse_mode: 'Markdown' }
  );

  for (let i = 0; i < videoData.length; i++) {
    const v = videoData[i];
    if (!v?.localPath || !fs.existsSync(v.localPath)) {
      await ctx.reply(`⚠️ Видео ${i + 1} не сгенерировалось`);
      continue;
    }
    await ctx.replyWithVideo({ source: v.localPath }, { caption: `Видео ${i + 1}/${videoData.length}` })
      .catch(() => ctx.reply(`⚠️ Не удалось отправить видео ${i + 1}`));

    const isApproved = data.results.videoApproved?.[i];
    await ctx.reply(`Видео ${i + 1}:`, {
      reply_markup: {
        inline_keyboard: [
          [
            { text: isApproved ? '✅ Одобрено' : '✅ Ок', callback_data: `approve_video_${i}` },
            { text: '🔄 Переделать', callback_data: `regen_video_${i}` },
          ],
        ],
      },
    });
  }

  await ctx.reply('Когда все видео одобрены — нажмите продолжить:', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '➡️ Все видео проверены, продолжить', callback_data: 'videos_done' }],
      ],
    },
  });
}

// Возвращает лучший источник изображения: локальный файл с оверлеем или URL
function getBestMedia(rawUrl, localPath) {
  if (localPath && fs.existsSync(localPath)) return { source: fs.createReadStream(localPath) };
  if (rawUrl) return rawUrl;
  return null;
}

function getSectionUrls(data, section) {
  if (section === 'photos')     return data.results.photos          || [];
  if (section === 'stories')    return data.results.stories         || [];
  if (section === 'carousels')  return data.results.carouselSlides  || [];
  if (section === 'covers')     return data.results.covers          || [];
  if (section === 'highlights') return data.results.highlights      || [];
  return [];
}

function getSectionMedia(data, section) {
  const raw   = getSectionUrls(data, section);
  const local = {
    photos:     data.results.photosLocalPaths         || [],
    stories:    data.results.storiesLocalPaths        || [],
    carousels:  data.results.carouselSlidesLocalPaths || [],
    covers:     data.results.coversLocalPaths         || [],
    highlights: data.results.highlightsLocalPaths     || [],
  }[section] || [];
  return raw.map((url, i) => getBestMedia(url, local[i])).filter(Boolean);
}

// ── Callbacks ──────────────────────────────────────────────────────────────────

// Image section approve
bot.action(/^approve_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const section = ctx.match[1];
  if (section.startsWith('video')) return; // handled separately
  const sess = getSession(ctx.chat.id);
  if (!sess.reviewing) return;

  const resultPath = path.join(RESULTS_DIR, `${sess.reviewing}.results.json`);
  const data       = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  data.approved[section] = true;
  fs.writeFileSync(resultPath, JSON.stringify(data, null, 2));
  sess.reviewData = data;
  sess.sectionIndex++;
  saveSession3(ctx.chat.id, sess);

  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply(`✅ ${SECTION_LABELS[section]} — одобрено`);
  await showSection(ctx, sess);
});

// ── Переделать конкретный элемент (фото/story/обложку/слайд) ─────────────────
bot.action(/^ri_regen_([a-z]+)_(\d+)_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery();
  const section      = ctx.match[1]; // ph / ca / st / co
  const index        = Number(ctx.match[2]);
  const clientChatId = ctx.match[3];
  const sess         = getSession(ctx.chat.id);
  const itemLabel    = { ph: 'Фото', ca: 'Карусель', st: 'Story', co: 'Обложка', hl: 'Highlight' }[section] || 'Элемент';

  sess.awaitingRegenFeedback = { section, index, clientChatId };
  saveSession3(ctx.chat.id, sess);

  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply(
    `✏️ Что изменить в «${itemLabel} ${index + 1}»?\n\n` +
    `Опишите что не нравится (например: "слишком тёмное", "другой цвет", "другая сцена").\n` +
    `Или напишите *+* чтобы просто переделать без правок.`,
    { parse_mode: 'Markdown' }
  );
}));

// ── Изменить текст на конкретном изображении ──────────────────────────────────
bot.action(/^ri_edit_([a-z]+)_(\d+)_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery();
  const section      = ctx.match[1];
  const index        = Number(ctx.match[2]);
  const clientChatId = ctx.match[3];
  const sess         = getSession(ctx.chat.id);
  const itemLabel    = { ph: 'Фото', ca: 'Слайд', st: 'Story', co: 'Обложка' }[section] || 'Элемент';

  sess.awaitingTextEdit = { section, index, clientChatId };
  saveSession3(ctx.chat.id, sess);

  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply(
    `✏️ Напишите новый текст для «${itemLabel} ${index + 1}»:\n\n` +
    `Это текст который будет поверх изображения. Максимум 6-8 слов.`
  );
}));

// ── Редактирование подписи к посту карусели ──────────────────────────────────

bot.action(/^ri_edit_cap_ca_(\d+)_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery();
  const ci           = Number(ctx.match[1]);
  const clientChatId = ctx.match[2];
  const sess         = getSession(ctx.chat.id);
  sess.awaitingCarouselCapEdit = { ci, clientChatId };
  saveSession3(ctx.chat.id, sess);
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply(`✏️ Напишите новую подпись к посту для Карусели ${ci + 1}:\n\n(Это текст который публикуется вместе с каруселью в соцсети)`);
}));

// ── После предпросмотра: "изм. снова" — handled by et_(ph|ca|co|st) at line ~1505 ──

// ── Принять новый текст (изображение уже сохранено) ─────────────────────────
bot.action(/^ri_accept_([a-z]+)_(\d+)_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery('✅ Принято');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  const section  = ctx.match[1];
  const index    = Number(ctx.match[2]);
  const label    = { ph: 'Фото', ca: 'Слайд', st: 'Story', co: 'Обложка' }[section] || 'Элемент';
  await ctx.reply(`✅ ${label} ${index + 1} — сохранено с новым текстом`);
}));

// ri_({section})_{index}_{clientId} — handled by handler at line ~1469
// Image section regen
bot.action(/^regen_(?!lib_)(?!video)(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const section = ctx.match[1];
  const sess = getSession(ctx.chat.id);
  if (!sess.reviewing) return;

  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply(`🔄 Переделываю *${SECTION_LABELS[section]}*...`, { parse_mode: 'Markdown' });

  const { default: fetch } = await import('node-fetch');
  await fetch(`${VISUAL_SVC}/regen`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ clientChatId: sess.reviewing, section }),
  }).catch(e => ctx.reply(`⚠️ Ошибка: ${e.message}`));
});

// ── Одобрение видео-сценариев ДО генерации Veo3 ──────────────────────────────

bot.action(/^va_ok_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery('✅ Запускаю генерацию!');
  const clientChatId = ctx.match[1];
  const approvedPath = path.join(RESULTS_DIR, `${clientChatId}.video_scripts_approved.json`);
  fs.writeFileSync(approvedPath, JSON.stringify({ approvedAt: Date.now() }));
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply(`✅ Сценарии одобрены — запускаю генерацию видео Veo3...\n\nПришлю каждое видео по готовности.`);
}));

bot.action(/^va_edit_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery();
  const clientChatId = ctx.match[1];
  const sess = getSession(ctx.chat.id);
  sess.awaitingVideoScriptEdit = { clientChatId };
  saveSession3(ctx.chat.id, sess);
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply(`✏️ Напишите что нужно изменить в сценариях.\n\nНапример: "видео слишком generic, добавь больше деталей про продукт" или "сцены повторяются, сделай разнообразнее".`);
}));

// Individual video approve
bot.action(/^approve_video_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const videoIndex = Number(ctx.match[1]);
  const sess       = getSession(ctx.chat.id);
  if (!sess.reviewing) return;

  const resultPath = path.join(RESULTS_DIR, `${sess.reviewing}.results.json`);
  const data       = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  data.results.videoApproved = data.results.videoApproved || {};
  data.results.videoApproved[videoIndex] = true;
  fs.writeFileSync(resultPath, JSON.stringify(data, null, 2));
  sess.reviewData = data;

  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply(`✅ Видео ${videoIndex + 1} — одобрено`);
});

// Заменить библиотечное видео на свежую генерацию Veo3
bot.action(/^regen_lib_(\d+)_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery();
  const videoIndex   = Number(ctx.match[1]);
  const clientChatId = ctx.match[2];
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply(`🎬 Запускаю Veo3 для Видео ${videoIndex + 1}... (~7-10 мин)\n\nПришлю когда будет готово.`);
  const { default: fetch } = await import('node-fetch');
  await fetch(`${VISUAL_SVC}/force_generate_video`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ clientChatId, videoIndex }),
  }).catch(e => ctx.reply(`⚠️ Ошибка: ${e.message}`));
}));

// Individual video regen
bot.action(/^regen_video_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const videoIndex = Number(ctx.match[1]);
  const sess       = getSession(ctx.chat.id);
  if (!sess.reviewing) return;

  sess.awaitingVideoFeedback = true;
  sess.videoFeedbackIndex    = videoIndex;
  saveSession3(ctx.chat.id, sess);

  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply(
    `✏️ Опишите что не так в видео ${videoIndex + 1}:\n\n` +
    `Например: "первая сцена слишком тёмная" или "нет движения, всё статично"\n\n` +
    `Сервис сам определит какие фрагменты переделать.`
  );
});

// All videos reviewed → proceed
bot.action('videos_done', async (ctx) => {
  await ctx.answerCbQuery();
  const sess = getSession(ctx.chat.id);
  if (!sess.reviewing) return;

  const resultPath = path.join(RESULTS_DIR, `${sess.reviewing}.results.json`);
  const data       = JSON.parse(fs.readFileSync(resultPath, 'utf8'));

  // Check all videos approved
  const videoData    = data.results.videoData || [];
  const videoApproved = data.results.videoApproved || {};
  const allApproved  = videoData.every((_, i) => videoApproved[i]);

  if (!allApproved) {
    const pending = videoData.map((_, i) => videoApproved[i] ? null : i + 1).filter(Boolean);
    await ctx.reply(`⚠️ Ещё не одобрены видео: ${pending.join(', ')}.\n\nПроверьте их выше.`);
    return;
  }

  data.approved['videos'] = true;
  fs.writeFileSync(resultPath, JSON.stringify(data, null, 2));
  sess.reviewData = data;

  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply('✅ Все видео одобрены');
  sess.sectionIndex++;
  await showSection(ctx, sess);
});

// ── Final approval ─────────────────────────────────────────────────────────────

async function showFinalApproval(ctx, sess) {
  const data     = sess.reviewData;
  const total    = sess.sections.length;
  const approved = Object.keys(data.approved || {}).length;

  if (approved < total) {
    await ctx.reply(`⚠️ Одобрено ${approved}/${total} разделов.\n\nВернитесь: /review_${sess.reviewing}`);
    return;
  }

  await ctx.reply(
    `🎉 Все разделы одобрены!\n\nКлиент: *${data.clientName}*\n\nОтправить клиенту?`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📤 Отправить клиенту', callback_data: `deliver_${sess.reviewing}` }],
          [{ text: '⏸ Подождать',          callback_data: 'deliver_cancel' }],
        ],
      },
    }
  );
}

bot.action(/^deliver_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const clientChatId = ctx.match[1];
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

  if (BOT4_ENABLED) {
    // Пишем trigger — bot4.js подхватит и отправит финальный пакет менеджеру
    let clientName = clientChatId;
    let packageKey = 'pkg_a';
    try {
      const rp = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
      if (fs.existsSync(rp)) {
        const d = JSON.parse(fs.readFileSync(rp, 'utf8'));
        clientName = d.clientName || clientChatId;
        packageKey = d.packageKey || 'pkg_a';
      }
    } catch {}
    fs.writeFileSync(
      path.join(TRIGGERS_DIR, `${clientChatId}.bot4_review.trigger`),
      JSON.stringify({ clientChatId, clientName, packageKey, timestamp: Date.now() }, null, 2)
    );
    await ctx.reply(`📋 Финальный пакет *${clientName}* отправлен в Bot4 на проверку.`, { parse_mode: 'Markdown' });
  } else {
    // Bot4 не настроен — доставляем напрямую (старое поведение)
    fs.writeFileSync(
      path.join(TRIGGERS_DIR, `${clientChatId}.approved.trigger`),
      JSON.stringify({ clientChatId, approvedAt: Date.now() }, null, 2)
    );
    await ctx.reply(`✅ Пакет поставлен в очередь доставки клиенту.`);
  }

  const sess = getSession(ctx.chat.id);
  sess.reviewing = null;
  sess.reviewData = null;
  sess.sectionIndex = 0;
  saveSession3(ctx.chat.id, sess);
});

bot.action('deliver_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply('Понял. Пакет не отправлен.');
});


// ── Бесплатный пакет — одобрить и отправить клиенту ──────────────────────────

bot.action(/^send_free_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery();
  const clientChatId = ctx.match[1];
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

  fs.writeFileSync(
    path.join(TRIGGERS_DIR, `${clientChatId}.free_approved.trigger`),
    JSON.stringify({ clientChatId, approvedAt: Date.now() }, null, 2)
  );
  await ctx.reply(`✅ Пакет поставлен в очередь доставки клиенту (chatId: ${clientChatId}).`);
}));

bot.action(/^retry_free_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery('Запускаю перегенерацию...');
  const clientChatId = ctx.match[1];
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

  const retryPath = path.join(BASE_DIR, 'triggers', `${clientChatId}.retry.json`);
  if (!fs.existsSync(retryPath)) {
    await ctx.reply(`❌ Данные клиента ${clientChatId} не найдены — клиенту нужно пройти анкету заново.`);
    return;
  }
  const data = JSON.parse(fs.readFileSync(retryPath, 'utf8'));
  fs.writeFileSync(
    path.join(BASE_DIR, 'triggers', `${clientChatId}.trigger`),
    JSON.stringify(data, null, 2)
  );
  await ctx.reply(`🔄 Перегенерация запущена для chatId ${clientChatId}.\nОтветы клиента сохранены — анкету проходить заново не нужно.`);
}));

// Перегенерация одного изображения бесплатного пакета
// callback_data: regen_fs_{slotCode}_{clientChatId}
// slotCode: c0-c6 = слайды карусели, cv = обложка, ph = фото, st = сторис
bot.action(/^regen_fs_([a-z0-9]+)_(\d+)$/, requireAuth(async (ctx) => {
  const slotCode     = ctx.match[1];
  const clientChatId = ctx.match[2];
  const slotLabels   = {
    c0: 'Слайд 1', c1: 'Слайд 2', c2: 'Слайд 3', c3: 'Слайд 4',
    c4: 'Слайд 5', c5: 'Слайд 6', c6: 'Слайд 7',
    cv: 'Обложка', ph: 'AI-фото', st: 'Сторис',
  };
  const label        = slotLabels[slotCode] || slotCode;

  await ctx.answerCbQuery(`Перегенерирую: ${label}...`);

  const { default: fetch } = await import('node-fetch');
  fetch(`${VISUAL_SVC}/regen_free_image`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ clientChatId, slotCode }),
  }).catch(e => ctx.reply(`❌ Ошибка запуска: ${e.message}`));

  await ctx.reply(`🔄 Запущена перегенерация: ${label} (chatId: ${clientChatId})\nПришлю новое изображение когда будет готово.`);
}));

// Отправить переведённые видео клиенту (после перевода субтитров)
bot.hears(/^\/send_trans_videos_(\d+)_([a-z]+)$/, requireAuth(async (ctx) => {
  const clientChatId = ctx.match[1];
  const targetLang   = ctx.match[2];

  const { LANG_NAMES } = require('./src/languages');
  const langName = LANG_NAMES[targetLang] || targetLang;

  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  if (!fs.existsSync(resultPath)) {
    await ctx.reply('❌ Результаты клиента не найдены.');
    return;
  }

  const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const videoData = data.results?.videoData || [];

  const transVideos = videoData
    .map((v, i) => {
      const transPath = v?.rawPath?.replace('.mp4', `_${targetLang}.mp4`);
      return transPath && fs.existsSync(transPath) ? { path: transPath, index: i } : null;
    })
    .filter(Boolean);

  if (transVideos.length === 0) {
    await ctx.reply(`⚠️ Переведённые видео для ${langName} не найдены. Возможно ещё генерируются.`);
    return;
  }

  await ctx.reply(`📤 Отправляю ${transVideos.length} видео с субтитрами (${langName}) клиенту...`);

  const bot2Token = process.env.TELEGRAM_BOT2_TOKEN;
  const { Telegraf: TelegrafInner } = require('telegraf');
  const bot2inner = new TelegrafInner(bot2Token);

  for (const v of transVideos) {
    try {
      await bot2inner.telegram.sendVideo(clientChatId, { source: v.path },
        { caption: `🎬 Видео ${v.index + 1} — ${langName}` }
      );
    } catch (e) {
      await ctx.reply(`⚠️ Ошибка при отправке видео ${v.index + 1}: ${e.message}`);
    }
  }

  await ctx.reply(`✅ Видео на ${langName} отправлены клиенту.`);
}));

// metricool_link_sent — устарел, ссылка теперь отправляется автоматически

// ── Корректировки контента (Вариант А — отправить клиенту после одобрения) ────

bot.action(/^send_corrections_(\d+)_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

  const clientChatId = ctx.match[1];
  const cycle        = ctx.match[2];

  const sessFile = path.join(BASE_DIR, `${clientChatId}.json`);
  let clientSess;
  try { clientSess = JSON.parse(fs.readFileSync(sessFile, 'utf8')); }
  catch { return ctx.reply('Сессия клиента не найдена.'); }

  const corrections = clientSess.lastCorrections?.text;
  if (!corrections) return ctx.reply('Корректировки не найдены в сессии клиента.');

  // Отправляем клиенту через Bot2
  const bot2Token = process.env.TELEGRAM_BOT2_TOKEN;
  if (!bot2Token) return ctx.reply('TELEGRAM_BOT2_TOKEN не задан — не могу отправить клиенту.');

  const { Telegraf: TelegrafInner } = require('telegraf');
  const bot2inner = new TelegrafInner(bot2Token);
  try {
    await bot2inner.telegram.sendMessage(clientChatId,
      `📊 *Следующие 15 дней контента*\n\n` +
      `На основе статистики ваших публикаций мы обновили контент-план.\n\n` +
      `${corrections}`,
      { parse_mode: 'Markdown' }
    );

    // Если есть вторая волна визуалов — доставляем через Bot1
    if (clientSess.wave2Pending && !clientSess.wave2DeliveredAt) {
      await ctx.reply(`✅ Корректировки отправлены. Запускаю доставку визуалов (вторые 15 дней)...`);
      // Создаём .wave2.trigger чтобы Bot1 подхватил и вызвал deliverVisualPackage
      const triggerPath = path.join(TRIGGERS_DIR, `${clientChatId}.wave2.trigger`);
      fs.writeFileSync(triggerPath, JSON.stringify({ clientChatId, cycle, ts: Date.now() }));
    } else {
      await ctx.reply(`✅ Корректировки (цикл ${cycle}) отправлены клиенту ${clientChatId}.`);
    }
  } catch (e) {
    await ctx.reply(`Ошибка отправки клиенту: ${e.message}`);
  }
}));

bot.action(/^corrections_skip_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply('Понял — корректировки не отправлены.');
}));

// ── Корректировки контента (Вариант В — из скриншотов, запускает генерацию) ──

bot.action(/^gen_corrections_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply('⏳ Генерирую скорректированный контент на следующие 15 дней...');

  const clientChatId = ctx.match[1];
  const sessFile = path.join(BASE_DIR, `${clientChatId}.json`);
  let clientSess;
  try { clientSess = JSON.parse(fs.readFileSync(sessFile, 'utf8')); }
  catch { return ctx.reply('Сессия клиента не найдена.'); }

  try {
    const { buildContentCorrectionPrompt } = require('./src/analytics_instruction');
    const { ask, SONNET } = require('./src/claude');

    // Для Варианта В нет машинных данных — генерируем на основе профиля бизнеса и лучших практик
    const correctionPrompt = buildContentCorrectionPrompt(clientSess, null);
    const corrections = await ask(correctionPrompt, SONNET);

    clientSess.lastCorrections = { text: corrections, date: Date.now(), cycle: clientSess.analyticsCycles || 1 };
    fs.writeFileSync(sessFile, JSON.stringify(clientSess, null, 2));

    await ctx.reply(
      `✏️ *Скорректированный контент — ${clientSess.clientName || clientChatId}*\n\n` +
      `${corrections}\n\n_Проверьте и нажмите кнопку чтобы отправить клиенту._`,
      {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Отправить клиенту', callback_data: `send_corrections_${clientChatId}_${clientSess.analyticsCycles || 1}` },
            { text: '✏️ Не отправлять',    callback_data: `corrections_skip_${clientChatId}` },
          ]],
        },
      }
    );
  } catch (e) {
    await ctx.reply(`Ошибка генерации: ${e.message}`);
  }
}));

// ── Visual Sample — кнопки 🔄 Переделать / ✏️ Изм. текст ────────────────────────

const VS_TYPE_LABELS = { c: 'слайд карусели', ph: 'фото-пост', co: 'обложку', st: 'сторис', v: 'видео' };

// Переделать картинку — сначала спрашиваем что изменить
bot.action(/^vs_regen_(c|ph|co|st)_(\d+)(?:_(\d+))?$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  const type         = ctx.match[1];
  const clientChatId = ctx.match[2];
  const index        = ctx.match[3] !== undefined ? Number(ctx.match[3]) : 0;
  const label        = VS_TYPE_LABELS[type] || type;
  const sess = getSession(ctx.chat.id);
  sess.awaitingSampleRegen = { type, clientChatId, index };
  saveSession3(ctx.chat.id, sess);
  await ctx.reply(
    `✏️ Что изменить в «${label}${type === 'c' ? ` слайд ${index + 1}` : ''}»?\n\n` +
    `Напишите что не так (например: "убрать людей", "другой угол съёмки", "светлее фон")\n` +
    `Или напишите + чтобы перегенерировать без изменений.`
  );
}));

// Переделать видео целиком
bot.action(/^vs_regen_v_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery('Запускаю перегенерацию...');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  const clientChatId = ctx.match[1];
  await ctx.reply(`🔄 Перегенерирую видео (все 4 фрагмента)...\nОжидание ~15-20 мин.`);
  const { default: fetch } = await import('node-fetch');
  await fetch(`${VISUAL_SVC}/regen_sample_slot`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ clientChatId, type: 'v', index: 0 }),
  }).catch(e => ctx.reply(`⚠️ Ошибка: ${e.message}`));
}));

// После регенерации видео — кнопка "Продолжить проверку"
bot.action(/^review_resume_(.+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply(`Продолжите проверку: /review_${ctx.match[1]}`);
}));

// Фрагмент видео — оставить
bot.action(/^vs_frag_ok_(\d+)_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery('✅ Фрагмент сохранён');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: '✅ Оставлен', callback_data: 'noop' }]] }).catch(() => {});
}));

// Фрагмент видео — переделать (спрашиваем что изменить)
bot.action(/^vs_frag_regen_(\d+)_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [[{ text: '🔄 Переделывается...', callback_data: 'noop' }]] }).catch(() => {});
  const clientChatId = ctx.match[1];
  const fragIndex    = Number(ctx.match[2]);
  const sess = getSession(ctx.chat.id);
  sess.awaitingSampleFragRegen = { clientChatId, fragIndex };
  saveSession3(ctx.chat.id, sess);
  await ctx.reply(
    `✏️ Что изменить во фрагменте ${fragIndex + 1}?\n\n` +
    `Напишите что не так (например: "экран ноутбука смотрит не туда", "слишком темно", "убрать людей")\n` +
    `Или напишите + чтобы переделать без указаний.`
  );
}));

// Убрать текст с картинки
bot.action(/^vs_notxt_(c|ph|co|st)_(\d+)(?:_(\d+))?$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery('Убираю текст...');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  const type         = ctx.match[1];
  const clientChatId = ctx.match[2];
  const index        = ctx.match[3] !== undefined ? Number(ctx.match[3]) : 0;
  const { default: fetch } = await import('node-fetch');
  await fetch(`${VISUAL_SVC}/edit_sample_text`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ clientChatId, type, index, text: '' }),
  }).catch(e => ctx.reply(`⚠️ Ошибка: ${e.message}`));
}));

// Изменить текст на картинке
bot.action(/^vs_edit_(c|ph|co|st)_(\d+)(?:_(\d+))?$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery();
  const type         = ctx.match[1];
  const clientChatId = ctx.match[2];
  const index        = ctx.match[3] !== undefined ? Number(ctx.match[3]) : 0;
  const label        = VS_TYPE_LABELS[type] || type;
  const sess = getSession(ctx.chat.id);
  sess.awaitingSampleTextEdit = { type, clientChatId, index };
  saveSession3(ctx.chat.id, sess);
  await ctx.reply(`✏️ Введите новый текст для «${label}${type === 'c' ? ` слайд ${index + 1}` : ''}»:\n(максимум 6 слов)`);
}));

// Изменить хук видео
bot.action(/^vs_edit_hook_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery();
  const clientChatId = ctx.match[1];
  const sess = getSession(ctx.chat.id);
  sess.awaitingSampleTextEdit = { type: 'hook', clientChatId, index: 0 };
  saveSession3(ctx.chat.id, sess);
  await ctx.reply('✏️ Введите новый хук для видео (первые 3-4 слова на экране):');
}));

// Изменить тему видео
bot.action(/^vs_edit_theme_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery();
  const clientChatId = ctx.match[1];
  const sess = getSession(ctx.chat.id);
  sess.awaitingSampleTextEdit = { type: 'theme', clientChatId, index: 0 };
  saveSession3(ctx.chat.id, sess);
  await ctx.reply('✏️ Введите новую тему для видео (5 слов, середина видео):');
}));

// Изменить CTA видео
bot.action(/^vs_edit_cta_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery();
  const clientChatId = ctx.match[1];
  const sess = getSession(ctx.chat.id);
  sess.awaitingSampleTextEdit = { type: 'cta', clientChatId, index: 0 };
  saveSession3(ctx.chat.id, sess);
  await ctx.reply('✏️ Введите новый CTA для видео (призыв к действию в конце):');
}));

// ── /test_paid — запуск платной генерации без Stripe ──────────────────────────
// Использование: /test_paid {clientChatId} {tariff}
// tariff: a = Старт, standard = Стандарт, v = Профи
bot.command('test_paid', requireAuth(async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 3) {
    return ctx.reply(
      '⚠️ Использование:\n' +
      '/test_paid {chatId} {тариф}\n\n' +
      'Тарифы:\n' +
      '• a — Тариф Старт (€150)\n' +
      '• standard — Тариф Стандарт (€250)\n' +
      '• v — Тариф Профи (€350)\n\n' +
      'Пример:\n/test_paid 71950950 standard'
    );
  }

  const clientChatId = parts[1].trim();
  const tariffCode   = parts[2].toLowerCase().trim();

  const tariffMap = {
    a:        'pkg_a',
    start:    'pkg_a',
    standard: 'pkg_standard',
    v:        'pkg_v',
    profi:    'pkg_v',
  };
  const packageKey = tariffMap[tariffCode];
  if (!packageKey) {
    return ctx.reply('❌ Неверный тариф. Используйте: a, standard или v');
  }

  const tariffNames = {
    pkg_a:        'Тариф Старт',
    pkg_standard: 'Тариф Стандарт',
    pkg_v:        'Тариф Профи',
  };

  // Читаем существующую сессию клиента
  const sessFile = path.join(BASE_DIR, `${clientChatId}.json`);
  if (!fs.existsSync(sessFile)) {
    return ctx.reply(
      `❌ Сессия клиента ${clientChatId} не найдена.\n\n` +
      `Клиент должен сначала пройти бесплатную анкету (Bot1) — ` +
      `тогда появятся данные для генерации.`
    );
  }

  let clientSess;
  try { clientSess = JSON.parse(fs.readFileSync(sessFile, 'utf8')); }
  catch (e) { return ctx.reply(`❌ Ошибка чтения сессии: ${e.message}`); }

  if (!fs.existsSync(TRIGGERS_DIR)) fs.mkdirSync(TRIGGERS_DIR, { recursive: true });

  const triggerData = {
    chatId:     String(clientChatId),
    name:       clientSess.name || 'Тестовый клиент',
    email:      clientSess.email || 'test@test.com',
    packageKey,
    paidAnswers: [],
    _testMode:  true,
    timestamp:  Date.now(),
  };

  const triggerFile = path.join(TRIGGERS_DIR, `${clientChatId}.paid.trigger`);
  fs.writeFileSync(triggerFile, JSON.stringify(triggerData, null, 2));

  await ctx.reply(
    `✅ Тестовый запуск платной генерации\n\n` +
    `👤 Клиент: ${triggerData.name} (${clientChatId})\n` +
    `📦 Пакет: ${tariffNames[packageKey]}\n\n` +
    `Bot1 подхватит триггер и запустит генерацию.\n` +
    `Когда визуал будет готов — получите уведомление здесь.\n\n` +
    `Проверить очередь: /queue`
  );
}));

// ── /test_quality — тест качества: 1 штука каждого типа с реальными текстами ────
// Использование: /test_quality {chatId} {тариф}
bot.command('test_quality', requireAuth(async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 3) {
    return ctx.reply(
      '⚠️ Использование:\n' +
      '/test_quality {chatId} {тариф}\n\n' +
      'Тарифы: a · standard · v\n\n' +
      'Что генерирует:\n' +
      '• Полный текстовый пакет (статья, анализ, контент-план)\n' +
      '• 1 карусель (7 слайдов) с текстом\n' +
      '• 1 фото-пост с текстом\n' +
      '• 1 сторис с текстом\n' +
      '• 1 обложка с текстом\n' +
      '• 1 видео с хуком и CTA\n\n' +
      'Пример:\n/test_quality 71950950 v'
    );
  }

  const clientChatId = parts[1].trim();
  const tariffCode   = parts[2].toLowerCase().trim();
  const tariffMap    = { a: 'pkg_a', start: 'pkg_a', standard: 'pkg_standard', v: 'pkg_v', profi: 'pkg_v' };
  const packageKey   = tariffMap[tariffCode];
  if (!packageKey) return ctx.reply('❌ Неверный тариф. Используйте: a, standard или v');

  const tariffNames = { pkg_a: 'Старт', pkg_standard: 'Стандарт', pkg_v: 'Профи' };

  const sessFile = path.join(BASE_DIR, `${clientChatId}.json`);
  let clientSess = {};
  if (fs.existsSync(sessFile)) {
    try { clientSess = JSON.parse(fs.readFileSync(sessFile, 'utf8')); }
    catch (e) { return ctx.reply(`❌ Ошибка чтения сессии: ${e.message}`); }
  }

  if (!fs.existsSync(TRIGGERS_DIR)) fs.mkdirSync(TRIGGERS_DIR, { recursive: true });

  const triggerData = {
    chatId:      String(clientChatId),
    name:        clientSess.name || 'Тестовый клиент',
    email:       clientSess.email || 'test@test.com',
    packageKey,
    paidAnswers: [],
    _qualityTest: true,
    _testMode:   true,
    timestamp:   Date.now(),
  };

  // Используем paid_init.trigger — клиент получит настоящие 12 вопросов через Bot2
  fs.writeFileSync(
    path.join(TRIGGERS_DIR, `${clientChatId}.paid_init.trigger`),
    JSON.stringify(triggerData, null, 2)
  );

  await ctx.reply(
    `🔬 Тест качества запущен — полный флоу\n\n` +
    `👤 Клиент: ${triggerData.name} (${clientChatId})\n` +
    `📦 ${tariffNames[packageKey]}\n\n` +
    `Что произойдёт:\n` +
    `1. Bot2 пришлёт клиенту 12 настоящих вопросов\n` +
    `2. После ответов — полная текстовая генерация\n` +
    `3. Визуал: 1 карусель · 1 фото · 1 сторис · 1 обложка · 1 видео\n` +
    `4. Все с реальными текстами — как у клиентов\n\n` +
    `Следите за Bot2 на стороне клиента (chatId: ${clientChatId}).`
  );
}));

// ── /save_library {chatId} — сохранить фото/видео клиента в общую библиотеку ──
bot.command('save_library', requireAuth(async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    return ctx.reply('⚠️ Использование:\n/save_library {chatId}\n\nПример:\n/save_library 71950950\n\nСохраняет фото и видео из последней генерации в общую библиотеку для повторного использования.');
  }

  const clientChatId = parts[1].trim();
  const { default: fetch } = await import('node-fetch');

  // Проверяем есть ли results.json
  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  const freePromptsPath = path.join(BASE_DIR, 'pending', `${clientChatId}.json`);
  const hasPaid = fs.existsSync(resultPath);
  const hasFree = fs.existsSync(freePromptsPath);

  if (!hasPaid && !hasFree) {
    return ctx.reply(`❌ Файлы генерации для ${clientChatId} не найдены.\nВозможно, сессия уже была сброшена или генерация не завершилась.`);
  }

  await ctx.reply(`⏳ Сохраняю в библиотеку...`);

  try {
    if (hasPaid) {
      await fetch(`${VISUAL_SVC}/save_approved_content`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientChatId, packageType: 'paid' }),
      });
    }
    if (hasFree) {
      await fetch(`${VISUAL_SVC}/save_approved_content`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientChatId, packageType: 'free' }),
      });
    }
    await ctx.reply(
      `✅ Запрос отправлен.\n\n` +
      `Фото и видео из генерации ${clientChatId} сохраняются в общую библиотеку.\n` +
      `Займёт ~1 минуту. После этого можно делать /reset_client ${clientChatId}.`
    );
  } catch (e) {
    await ctx.reply(`❌ Ошибка: ${e.message}`);
  }
}));

// ── /check_payment {chatId} — ручное восстановление если Stripe webhook потерялся ──
bot.command('check_payment', requireAuth(async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    return ctx.reply(
      '⚠️ Использование:\n/check_payment {chatId}\n\n' +
      'Пример: /check_payment 71950950\n\n' +
      'Создаёт paid_init.trigger вручную если клиент заплатил но онбординг не начался.\n' +
      'Данные берутся из сессии клиента в Bot2.'
    );
  }
  const clientChatId = parts[1].trim();
  const SESSION_DIR  = path.join(BASE_DIR, '..', 'bot2_sessions').normalize
    ? path.normalize(path.join(BASE_DIR, '..', 'bot2_sessions'))
    : path.join(BASE_DIR, '..', 'bot2_sessions');

  // Читаем сессию клиента из Bot2
  const sessionPaths = [
    path.join(BASE_DIR, `${clientChatId}.json`),
    path.join(path.dirname(BASE_DIR), `${clientChatId}.json`),
    path.join(os.homedir(), '.marketingdna-client-sessions', `${clientChatId}.json`),
  ];
  let clientSession = null;
  for (const sp of sessionPaths) {
    try {
      if (fs.existsSync(sp)) { clientSession = JSON.parse(fs.readFileSync(sp, 'utf8')); break; }
    } catch {}
  }

  if (!clientSession) {
    return ctx.reply(`❌ Сессия клиента ${clientChatId} не найдена.\n\nПроверьте chatId — клиент должен был написать /start в Bot2.`);
  }

  const name       = clientSession.name || '—';
  const email      = clientSession.email || '—';
  const packageKey = clientSession.paidPackageKey || clientSession.packageKey;

  if (!packageKey) {
    return ctx.reply(
      `❌ У клиента ${clientChatId} (${name}) нет packageKey в сессии.\n\n` +
      `Доступные поля: ${Object.keys(clientSession).join(', ')}\n\n` +
      `Укажите тариф вручную командой:\n/test_paid ${clientChatId} v`
    );
  }

  // Проверяем — не запущен ли уже онбординг
  const paidInitPath = path.join(TRIGGERS_DIR, `${clientChatId}.paid_init.trigger`);
  const paidPath     = path.join(TRIGGERS_DIR, `${clientChatId}.paid.trigger`);
  if (fs.existsSync(paidInitPath) || fs.existsSync(paidPath)) {
    return ctx.reply(`⚠️ Для клиента ${clientChatId} уже есть active trigger — онбординг должен был запуститься.\nЕсли застрял — используйте /reset_client ${clientChatId} и повторите.`);
  }

  if (!fs.existsSync(TRIGGERS_DIR)) fs.mkdirSync(TRIGGERS_DIR, { recursive: true });
  fs.writeFileSync(paidInitPath, JSON.stringify({
    chatId: String(clientChatId), name, email, packageKey, timestamp: Date.now(), source: 'manual_check_payment',
  }, null, 2));

  await ctx.reply(
    `✅ paid_init.trigger создан для ${clientChatId}\n\n` +
    `Клиент: ${name}\nПакет: ${packageKey}\n\n` +
    `Онбординг запустится в течение 1-2 минут — Bot2 отправит клиенту первый вопрос.`
  );
}));

// ── /test_addlang {chatId} {lang} — симуляция оплаты доп. языка без Stripe ───
bot.command('test_addlang', requireAuth(async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 3) {
    return ctx.reply(
      '⚠️ Использование:\n/test_addlang {chatId} {lang}\n\n' +
      'Языки: ru | lv | en\n\n' +
      'Пример: /test_addlang 71950950 lv\n\n' +
      'Создаёт addlang-триггер напрямую без Stripe.\n' +
      'Клиент должен уже иметь платный пакет (paidPackageKey в сессии).'
    );
  }
  const clientChatId = parts[1].trim();
  const lang         = parts[2].trim().toLowerCase();
  const validLangs   = ['ru', 'lv', 'en'];
  if (!validLangs.includes(lang)) {
    return ctx.reply(`❌ Язык "${lang}" не поддерживается. Используйте: ru | lv | en`);
  }

  // Читаем сессию клиента
  const sessionPaths = [
    path.join(BASE_DIR, `${clientChatId}.json`),
    path.join(os.homedir(), '.marketingdna-client-sessions', `${clientChatId}.json`),
  ];
  let clientSession = null;
  for (const sp of sessionPaths) {
    try {
      if (fs.existsSync(sp)) { clientSession = JSON.parse(fs.readFileSync(sp, 'utf8')); break; }
    } catch {}
  }
  if (!clientSession) {
    return ctx.reply(`❌ Сессия клиента ${clientChatId} не найдена.`);
  }

  const packageKey = clientSession.paidPackageKey || clientSession.packageKey;
  if (!packageKey) {
    return ctx.reply(`❌ У клиента ${clientChatId} нет paidPackageKey — нужно сначала завершить платный онбординг.`);
  }

  const baseLang = clientSession.contentLanguage || 'ru';
  if (lang === baseLang) {
    return ctx.reply(`❌ Язык "${lang}" уже является основным языком пакета (${baseLang}). Выберите другой.`);
  }

  // Проверяем нет ли уже активного триггера
  const triggerPath = path.join(TRIGGERS_DIR, `${clientChatId}.addlang_${lang}.trigger`);
  if (fs.existsSync(triggerPath)) {
    return ctx.reply(`⚠️ Триггер addlang_${lang} уже существует для ${clientChatId}. Ждём обработки.`);
  }

  if (!fs.existsSync(TRIGGERS_DIR)) fs.mkdirSync(TRIGGERS_DIR, { recursive: true });
  fs.writeFileSync(triggerPath, JSON.stringify({
    chatId:     String(clientChatId),
    lang,
    packageKey,
    name:       clientSession.name || '—',
    timestamp:  Date.now(),
    source:     'test_addlang',
  }, null, 2));

  const LANG_NAMES = { ru: '🇷🇺 Русский', lv: '🇱🇻 Латышский', en: '🇬🇧 Английский' };
  await ctx.reply(
    `✅ addlang_${lang}.trigger создан для ${clientChatId}\n\n` +
    `Клиент: ${clientSession.name || '—'}\n` +
    `Пакет: ${packageKey}\n` +
    `Доп. язык: ${LANG_NAMES[lang] || lang}\n\n` +
    `Перевод запустится в течение 1-2 минут. Результат придёт в Bot3 на проверку.`
  );
}));

// ── /reset_client — полный сброс сессии клиента для чистого теста ───────────
bot.command('reset_client', requireAuth(async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('⚠️ Использование:\n/reset_client {chatId}\n\nПример:\n/reset_client 71950950');

  const clientChatId = parts[1].trim();
  const deleted = [];

  // Удаляем основной файл сессии
  const sessFile = path.join(BASE_DIR, `${clientChatId}.json`);
  if (fs.existsSync(sessFile)) { fs.unlinkSync(sessFile); deleted.push(sessFile); }

  // Удаляем результаты визуала (фото/видео/сторис) и visual.json — при сбросе старые промпты опасны
  // done_snapshot нужен для /retry_paid
  const KEEP_IN_TRIGGERS = [`${clientChatId}.done_snapshot.json`]; // сохраняем для retry
  const KEEP_IN_VISUAL_QUEUE = [];                                   // visual.json тоже удаляем

  // Triggers: удаляем всё кроме done_snapshot
  if (fs.existsSync(TRIGGERS_DIR)) {
    const files = fs.readdirSync(TRIGGERS_DIR).filter(f =>
      (f.startsWith(`${clientChatId}.`) || f.startsWith(`${clientChatId}_`)) &&
      !KEEP_IN_TRIGGERS.includes(f)
    );
    for (const f of files) {
      try { fs.unlinkSync(path.join(TRIGGERS_DIR, f)); deleted.push(f); } catch {}
    }
  }

  // Results: удаляем всё (это выходные файлы — фото, видео, json)
  if (fs.existsSync(RESULTS_DIR)) {
    const files = fs.readdirSync(RESULTS_DIR).filter(f => f.startsWith(`${clientChatId}.`) || f.startsWith(`${clientChatId}_`));
    for (const f of files) {
      try { fs.unlinkSync(path.join(RESULTS_DIR, f)); deleted.push(f); } catch {}
    }
  }

  // Visual queue: удаляем всё кроме visual.json (он нужен для /run_visual)
  const visualQueueDir = path.join(BASE_DIR, 'visual_queue');
  if (fs.existsSync(visualQueueDir)) {
    const files = fs.readdirSync(visualQueueDir).filter(f =>
      (f.startsWith(`${clientChatId}.`) || f.startsWith(`${clientChatId}_`)) &&
      !KEEP_IN_VISUAL_QUEUE.includes(f)
    );
    for (const f of files) {
      try { fs.unlinkSync(path.join(visualQueueDir, f)); deleted.push(f); } catch {}
    }
  }

  // Pending: удаляем полностью
  const pendingDir = path.join(BASE_DIR, 'pending');
  if (fs.existsSync(pendingDir)) {
    const files = fs.readdirSync(pendingDir).filter(f => f.startsWith(`${clientChatId}.`) || f.startsWith(`${clientChatId}_`));
    for (const f of files) {
      try { fs.unlinkSync(path.join(pendingDir, f)); deleted.push(f); } catch {}
    }
  }

  await ctx.reply(
    `✅ Сессия клиента ${clientChatId} полностью сброшена\n\n` +
    (deleted.length
      ? `Удалено файлов: ${deleted.length}\n${deleted.map(f => `• ${path.basename(f)}`).join('\n')}`
      : 'Файлов не найдено — сессия уже чистая') +
    `\n\n⚠️ История "что уже получал" сохранена (для защиты от повторного контента).\n\nТеперь запускай тест с чистого листа:\n/test_quality ${clientChatId} v`
  );
}));

// ── /test_free — тест генерации бесплатного визуала (5 слайдов карусели + обложка) ──
// Использование: /test_free {clientChatId}
bot.command('test_free', requireAuth(async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    return ctx.reply('⚠️ Использование:\n/test_free {chatId}\n\nПример:\n/test_free 71950950');
  }

  const clientChatId = parts[1].trim();
  const pendingFile  = path.join(BASE_DIR, 'pending', `${clientChatId}.json`);

  if (!fs.existsSync(pendingFile)) {
    return ctx.reply(
      `❌ Pending-файл для ${clientChatId} не найден.\n\n` +
      `Клиент должен сначала пройти бесплатную анкету (Bot1) — ` +
      `тогда генерируются carouselScript и coverExample.`
    );
  }

  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pendingFile, 'utf8')); }
  catch (e) { return ctx.reply(`❌ Ошибка чтения pending-файла: ${e.message}`); }

  const { carouselScript, coverExample } = pkg;
  if (!carouselScript) {
    return ctx.reply(`❌ carouselScript не найден в pending-файле для ${clientChatId}.`);
  }

  // Сбрасываем старые результаты чтобы перегенерировать
  for (const suffix of ['free_visuals.json', 'free_visuals_notified', 'visuals_6done', 'free_photo.json']) {
    const f = path.join(RESULTS_DIR, `${clientChatId}.${suffix}`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  const { default: fetch } = await import('node-fetch');
  const VISUAL_URL = process.env.VISUAL_SERVICE_URL || 'http://localhost:3002';
  const resp = await fetch(`${VISUAL_URL}/generate_free_visuals`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientChatId, carouselScript, coverExample }),
  }).catch(() => null);

  if (!resp?.ok) {
    return ctx.reply(`❌ visual.js не ответил. Проверьте что сервис запущен: /queue`);
  }

  const clientName = pkg.clientData?.name || 'Клиент';
  await ctx.reply(
    `✅ Тест бесплатного визуала запущен\n\n` +
    `👤 ${clientName} (${clientChatId})\n` +
    `🖼 Генерирую: 5 слайдов карусели + 1 обложка\n\n` +
    `Результат придёт сюда как Bot3-уведомление (~10-15 мин).`
  );
}));

// ── /test_paid_full — полный реальный флоу с вопросами клиенту ────────────────
// Создаёт paid_init.trigger → Bot1 задаёт клиенту вопросы через Bot2 → клиент отвечает → генерация
bot.command('test_paid_full', requireAuth(async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 3) {
    return ctx.reply(
      '⚠️ Использование:\n' +
      '/test_paid_full {chatId} {тариф}\n\n' +
      'Тарифы:\n' +
      '• a — Тариф Старт (€150)\n' +
      '• standard — Тариф Стандарт (€250)\n' +
      '• v — Тариф Профи (€350)\n\n' +
      'Отличие от /test_paid:\n' +
      'Клиент получит уточняющие вопросы в Bot2 — точно как после реальной оплаты.\n' +
      'Генерация начнётся только после того как он ответит.\n\n' +
      'Пример:\n/test_paid_full 71950950 v'
    );
  }

  const clientChatId = parts[1].trim();
  const tariffCode   = parts[2].toLowerCase().trim();

  const tariffMap = {
    a:        'pkg_a',
    start:    'pkg_a',
    standard: 'pkg_standard',
    v:        'pkg_v',
    profi:    'pkg_v',
  };
  const packageKey = tariffMap[tariffCode];
  if (!packageKey) {
    return ctx.reply('❌ Неверный тариф. Используйте: a, standard или v');
  }

  const tariffNames = {
    pkg_a:        'Тариф Старт',
    pkg_standard: 'Тариф Стандарт',
    pkg_v:        'Тариф Профи',
  };

  const sessFile = path.join(BASE_DIR, `${clientChatId}.json`);
  if (!fs.existsSync(sessFile)) {
    return ctx.reply(
      `❌ Сессия клиента ${clientChatId} не найдена.\n\n` +
      `Клиент должен сначала пройти бесплатную анкету (Bot2) — ` +
      `тогда появятся данные для генерации.`
    );
  }

  let clientSess;
  try { clientSess = JSON.parse(fs.readFileSync(sessFile, 'utf8')); }
  catch (e) { return ctx.reply(`❌ Ошибка чтения сессии: ${e.message}`); }

  if (!fs.existsSync(TRIGGERS_DIR)) fs.mkdirSync(TRIGGERS_DIR, { recursive: true });

  // paid_init.trigger — Bot1 запустит startPaidOnboarding() → вопросы клиенту через Bot2
  const triggerData = {
    chatId:     String(clientChatId),
    name:       clientSess.name || 'Тестовый клиент',
    email:      clientSess.email || 'test@test.com',
    packageKey,
    _testMode:  true,
    timestamp:  Date.now(),
  };

  const triggerFile = path.join(TRIGGERS_DIR, `${clientChatId}.paid_init.trigger`);
  fs.writeFileSync(triggerFile, JSON.stringify(triggerData, null, 2));

  await ctx.reply(
    `✅ Полный тест запущен — ${tariffNames[packageKey]}\n\n` +
    `👤 Клиент: ${triggerData.name} (${clientChatId})\n\n` +
    `Что произойдёт:\n` +
    `1. Bot2 пришлёт клиенту сообщение об "оплате"\n` +
    `2. Клиент ответит на уточняющие вопросы\n` +
    `3. После ответов — автоматически запустится генерация\n` +
    `4. Когда визуал готов — получите уведомление здесь\n\n` +
    `Следите за Bot2 на стороне клиента.`
  );
}));

// ── Mini video regen: mini_rv_{index}_{clientId} — переделать видео с фидбеком ──
bot.action(/^mini_rv_(\d+)_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery('Уточните что изменить...');
  const videoIndex   = Number(ctx.match[1]);
  const clientChatId = ctx.match[2];
  const sess = getSession(ctx.chat.id);
  sess.awaitingVideoFeedback = true;
  sess.videoFeedbackIndex    = videoIndex;
  sess.reviewing             = clientChatId;
  saveSession3(ctx.chat.id, sess);
  await ctx.reply(
    `🔄 Переделываю видео\n\n` +
    `Опишите что именно поменять в ролике:\n\n` +
    `Примеры:\n` +
    `• "добавить более тёплые тона, закатный свет"\n` +
    `• "показать продукт крупным планом, без людей"\n` +
    `• "более динамичное — быстрое движение камеры"\n` +
    `• "другой интерьер, современный офис"`
  );
}));

// ── Per-item regen: ri_{section}_{index}_{clientId} ───────────────────────────
// section codes: ph=фото, ca=карусель слайд, co=обложка, st=story

bot.action(/^ri_([a-z]+)_(\d+)_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery('Уточните что изменить...');
  const section      = ctx.match[1];
  const index        = Number(ctx.match[2]);
  const clientChatId = ctx.match[3];

  const sectionLabels = { ph: 'Фото', ca: 'Слайд', co: 'Обложка', st: 'Story', hl: 'Highlight' };
  const label = `${sectionLabels[section] || section} ${index + 1}`;

  const sess = getSession(ctx.chat.id);
  sess.awaitingRegenFeedback = { section, index, clientChatId };
  saveSession3(ctx.chat.id, sess);

  await ctx.reply(
    `🔄 Перегенерирую «${label}»\n\n` +
    `Напишите что именно изменить (или отправьте "+" чтобы просто переделать без изменений):\n\n` +
    `Примеры:\n• "убрать человека из кадра"\n• "добавить больше деталей продукта"\n• "другой угол съёмки"\n• "+"`
  );
}));

// ── Per-item text edit: et_{section}_{index}_{clientId} ───────────────────────
// section codes: ph=фото, ca=карусель слайд, co=обложка, st=story
// НЕ включает video — у него отдельный обработчик et_video ниже

bot.action(/^et_(ph|ca|co|st)_(\d+)_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery('Введите новый текст...');
  const section      = ctx.match[1];
  const index        = Number(ctx.match[2]);
  const clientChatId = ctx.match[3];

  const sess = getSession(ctx.chat.id);
  sess.awaitingTextEdit = { section, index, clientChatId };
  saveSession3(ctx.chat.id, sess);

  const sectionLabels = { ph: 'Фото', ca: 'Слайд', co: 'Обложка', st: 'Story', hl: 'Highlight' };
  const label = `${sectionLabels[section] || section} ${index + 1}`;
  await ctx.reply(`✏️ Введите новый текст/подпись для «${label}»:\n\n(Это заменит текущий текст при отправке клиенту)`);
}));

// ── Убрать текст с изображения: notxt_{section}_{index}_{clientId} ───────────
// Используется и для paid-пакета (notxt_ca/ph/co/st) и для free-пакета (notxt_ca/co)
bot.action(/^notxt_(ca|ph|co|st|cv)_(\d+)_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery('Убираю текст...');
  const section      = ctx.match[1];
  const index        = Number(ctx.match[2]);
  const clientChatId = ctx.match[3];

  const sectionMap   = { ca: 'carousel', ph: 'photos', co: 'covers', st: 'stories', cv: 'covers' };
  const sectionLabels = { ca: 'Слайд', ph: 'Фото', co: 'Обложка', st: 'Story', cv: 'Обложка' };
  const label = `${sectionLabels[section] || section} ${index + 1}`;

  await ctx.reply(`🚫 Убираю текст с «${label}»...`);

  const { default: fetch } = await import('node-fetch');
  await fetch(`${VISUAL_SVC}/remove_text_overlay`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ clientChatId, section: sectionMap[section] || section, index }),
  }).catch(e => ctx.reply(`⚠️ Ошибка: ${e.message}`));
}));

// ── /library — video library stats ───────────────────────────────────────────
// ── /history {chatId} — история контента клиента по месяцам ─────────────────
bot.command('history', requireAuth(async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const chatId = parts[1];

  if (!chatId) {
    // Без аргумента — показываем список всех клиентов с историей
    const historyDir = path.join(BASE_DIR, 'history');
    if (!fs.existsSync(historyDir)) {
      return ctx.reply('📭 История пуста — ни один пакет ещё не завершён.');
    }
    const files = fs.readdirSync(historyDir).filter(f => f.endsWith('.history.json'));
    if (!files.length) return ctx.reply('📭 История пуста.');

    const lines = ['📋 Клиенты с историей контента:\n'];
    for (const f of files) {
      try {
        const rec = JSON.parse(fs.readFileSync(path.join(historyDir, f), 'utf8'));
        const months = (rec.history || []).map(h => h.month).join(', ');
        lines.push(`• ${rec.name || '—'} (${rec.clientId}) — ${months}`);
      } catch {}
    }
    lines.push('\nИспользование: /history {chatId}');
    return ctx.reply(lines.join('\n'));
  }

  // Детальная история конкретного клиента
  const historyFile = path.join(BASE_DIR, 'history', `${chatId}.history.json`);
  if (!fs.existsSync(historyFile)) {
    return ctx.reply(`❌ История для клиента ${chatId} не найдена.\nИстория сохраняется автоматически когда генерация месяца завершается.`);
  }

  let rec;
  try { rec = JSON.parse(fs.readFileSync(historyFile, 'utf8')); }
  catch { return ctx.reply('❌ Ошибка чтения файла истории.'); }

  const lines = [`📊 История контента: ${rec.name || chatId}\n`];

  for (const m of (rec.history || [])) {
    lines.push(`━━━ ${m.month} (${m.packageKey || '—'}) ━━━`);
    if (m.carouselThemes?.length)  lines.push(`🎠 Карусели:\n  ${m.carouselThemes.join('\n  ')}`);
    if (m.videoThemes?.length)     lines.push(`🎬 Видео:\n  ${m.videoThemes.join('\n  ')}`);
    if (m.photoThemes?.length)     lines.push(`📸 Фото:\n  ${m.photoThemes.join('\n  ')}`);
    if (m.planTopics?.length)      lines.push(`📅 Посты (первые 8):\n  ${m.planTopics.slice(0, 8).join('\n  ')}`);
    lines.push('');
  }

  // Разбиваем на части если длинно
  const text = lines.join('\n');
  const LIMIT = 4000;
  for (let i = 0; i < text.length; i += LIMIT) {
    await ctx.reply(text.slice(i, i + LIMIT));
  }
}));

// ── /run_visual {chatId} [nv] — запустить визуал напрямую из visual.json ─────
// nv = no video | qt = 1 штука каждого (quality test mode)
bot.command('run_visual', requireAuth(async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    return ctx.reply(
      '⚠️ Использование:\n' +
      '/run_visual {chatId}        ← полный пакет\n' +
      '/run_visual {chatId} nv     ← полный пакет, без видео\n' +
      '/run_visual {chatId} nv qt  ← 1 карусель + 1 фото + 1 сторис + 1 обложка, без видео\n\n' +
      'Пример: /run_visual 71950950 nv qt'
    );
  }
  const clientChatId = parts[1].trim();
  const flags = parts.slice(2).map(p => p.toLowerCase());
  const noVideo   = flags.includes('nv');
  const qtMode    = flags.includes('qt');
  const { default: fetch } = await import('node-fetch');

  const visualJsonPath = path.join(BASE_DIR, 'visual_queue', `${clientChatId}.visual.json`);
  const VISUAL_QUEUE_DIR = path.join(BASE_DIR, 'visual_queue');
  if (!fs.existsSync(VISUAL_QUEUE_DIR)) fs.mkdirSync(VISUAL_QUEUE_DIR, { recursive: true });

  // Сначала пробуем восстановить visual.json из done_snapshot
  // (работает даже если visual.json был удалён /reset_client)
  try {
    const doneSnap = path.join(TRIGGERS_DIR, `${clientChatId}.done_snapshot.json`);
    if (fs.existsSync(doneSnap)) {
      const snapData = JSON.parse(fs.readFileSync(doneSnap, 'utf8'));
      let visualPkgRaw = {};
      try { visualPkgRaw = JSON.parse(fs.readFileSync(visualJsonPath, 'utf8')); } catch {}

      const scriptFields = ['videoScripts','carouselScripts','photoScripts','storiesScripts','covers','contentPlan','regionLabel','contentLanguage','paidPackageKey','businessProfile','audience','castdev'];
      for (const f of scriptFields) {
        if (!visualPkgRaw[f] && snapData[f]) visualPkgRaw[f] = snapData[f];
      }
      if (!visualPkgRaw.clientName || visualPkgRaw.clientName === '—') {
        visualPkgRaw.clientName = snapData.bot2Data?.name || snapData.name || '—';
      }
      if (!visualPkgRaw.clientChatId) visualPkgRaw.clientChatId = clientChatId;
      if (!visualPkgRaw.packageKey && snapData.paidPackageKey) visualPkgRaw.packageKey = snapData.paidPackageKey;
      // qualityTest флаг НЕ переносим из done_snapshot — /run_visual всегда запускает полную генерацию

      fs.writeFileSync(visualJsonPath, JSON.stringify(visualPkgRaw, null, 2));
      await ctx.reply(`🔧 visual.json восстановлен из done_snapshot.`);
    }
  } catch (e) {
    console.error('[run_visual] done_snapshot restore error:', e.message);
  }

  // Теперь проверяем — если visual.json всё ещё нет, значит нет и done_snapshot
  if (!fs.existsSync(visualJsonPath)) {
    return ctx.reply(`❌ visual.json для ${clientChatId} не найден и done_snapshot отсутствует.\nСначала должна пройти текстовая генерация.`);
  }

  const maxVideos = noVideo ? 0 : 1;
  const maxPerSection = qtMode ? 1 : undefined;

  try {
    const ctrl = new AbortController();
    const timeout = setTimeout(() => ctrl.abort(), 10000);
    try {
      await fetch(`${VISUAL_SVC}/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientChatId, maxVideos, ...(maxPerSection ? { maxPerSection } : {}) }),
        signal: ctrl.signal,
      });
    } finally {
      clearTimeout(timeout);
    }
    const mode = qtMode
      ? `🔬 Тест (1 шт каждого): 1 карусель · 1 фото · 1 сторис · 1 обложка${noVideo ? ' · без видео' : ' · 1 видео'}`
      : noVideo
        ? '📦 Полный пакет без видео'
        : '📦 Полный пакет';
    await ctx.reply(`🎨 Визуал запущен для ${clientChatId}\n\n${mode}\n\nМатериалы придут сюда в Bot3 по мере готовности (~10-15 мин).`);
  } catch (e) {
    await ctx.reply(`❌ Ошибка запуска визуала: ${e.message}\n\nПроверьте Railway — возможно visual.js упал или завис.`);
  }
}));

// ── /client_cost {chatId} — примерная себестоимость клиента ─────────────────
bot.command('client_cost', requireAuth(async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) return ctx.reply('⚠️ Использование:\n/client_cost {chatId}\n\nПример:\n/client_cost 71950950');

  const clientChatId = parts[1].trim();
  const resultPath   = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  const snapPath     = path.join(BASE_DIR, 'triggers', `${clientChatId}.done_snapshot.json`);

  let results = null;
  let snap    = null;
  try { results = JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch {}
  try { snap    = JSON.parse(fs.readFileSync(snapPath,   'utf8')); } catch {}

  if (!results && !snap) {
    return ctx.reply(`❌ Нет данных для клиента ${clientChatId}.\nПроверьте chatId.`);
  }

  const r = results?.results || {};

  // Подсчёт сгенерированных единиц
  const carouselCount = (r.carouselSlides  || []).filter(Boolean).length;
  const photoCount    = (r.photos          || []).filter(Boolean).length;
  const storyCount    = (r.stories         || []).filter(Boolean).length;
  const coverCount    = (r.covers          || []).filter(Boolean).length;
  const videoCount    = (r.videoData       || []).filter(v => v?.localPath).length;
  const libVideoCount = (r.videoData       || []).filter(v => v?.fromLibrary).length;
  const veo3Count     = videoCount - libVideoCount;

  // Примерные тарифы (USD)
  const RATES = {
    claude_text_block:  0.06,  // один блок генерации текста (block4-9)
    image_kie:          0.04,  // одно изображение Kie.ai
    video_veo3:         1.20,  // одно видео Veo3 (4 сцены по $0.30)
    video_library:      0.00,  // из библиотеки — бесплатно
    tavily:             0.01,  // один поиск Tavily
  };

  // Оцениваем блоки текста по наличию done_snapshot
  const textBlocksCount = snap ? 6 : 0; // block4→5→3→6→7→9
  const tavilyCount     = snap ? 3 : 0; // block4 кастдев + block3 конкуренты + block7 фразы

  const costImages = (carouselCount + photoCount + storyCount + coverCount) * RATES.image_kie;
  const costVideos = veo3Count * RATES.video_veo3;
  const costText   = textBlocksCount * RATES.claude_text_block;
  const costTavily = tavilyCount * RATES.tavily;
  const totalCost  = costImages + costVideos + costText + costTavily;

  const pkgKey      = snap?.paidPackageKey || results?.packageKey || '—';
  const pkgPrices   = { pkg_a: 150, pkg_standard: 250, pkg_v: 350 };
  const revenue     = pkgPrices[pkgKey] || 0;
  const margin      = revenue ? `${((revenue - totalCost) / revenue * 100).toFixed(0)}%` : '—';

  const lines = [
    `💰 Себестоимость — ${clientChatId}`,
    `Пакет: ${pkgKey} · Выручка: €${revenue}`,
    '',
    `📸 Изображений: ${carouselCount + photoCount + storyCount + coverCount} × $${RATES.image_kie} = $${costImages.toFixed(2)}`,
    `🎬 Видео Veo3: ${veo3Count} × $${RATES.video_veo3} = $${costVideos.toFixed(2)}`,
    `  (из библиотеки: ${libVideoCount} × $0 = $0.00)`,
    `📝 Текстовые блоки: ~${textBlocksCount} × $${RATES.claude_text_block} = $${costText.toFixed(2)}`,
    `🔍 Tavily поиск: ~${tavilyCount} × $${RATES.tavily} = $${costTavily.toFixed(2)}`,
    '',
    `Итого себестоимость: ~$${totalCost.toFixed(2)} (~€${(totalCost * 0.92).toFixed(2)})`,
    `Маржа: ${margin}`,
    '',
    `⚠️ Это оценка. Точные данные — в Anthropic Console и Kie.ai Dashboard.`,
  ];

  await ctx.reply(lines.join('\n'));
}));

// ── /debug_snapshot {chatId} — диагностика done_snapshot: что в нём и находятся ли промпты ──
bot.command('debug_snapshot', requireAuth(async (ctx) => {
  try {
    const parts = ctx.message.text.trim().split(/\s+/);
    if (parts.length < 2) return ctx.reply('Использование: /debug_snapshot {chatId}');
    const clientChatId = parts[1].trim();

    const snapPath = path.join(TRIGGERS_DIR, `${clientChatId}.done_snapshot.json`);
    if (!fs.existsSync(snapPath)) return ctx.reply(`done_snapshot.json для ${clientChatId} не найден.`);

    let snap;
    try { snap = JSON.parse(fs.readFileSync(snapPath, 'utf8')); } catch (e) {
      return ctx.reply(`Ошибка чтения: ${e.message}`);
    }

    const byPrefix = (text, prefix) => (text || '').split('\n')
      .filter(l => l.trim().toLowerCase().startsWith(prefix.toLowerCase()))
      .map(l => l.slice(l.toLowerCase().indexOf(prefix.toLowerCase()) + prefix.length).replace(/^[\s:]+/, '').trim())
      .filter(p => p.length > 10 && !p.startsWith('['));

    const byContains = (text, prefix) => (text || '').split('\n')
      .filter(l => l.toLowerCase().includes(prefix.toLowerCase()))
      .map(l => { const i = l.toLowerCase().indexOf(prefix.toLowerCase()); return l.slice(i + prefix.length).replace(/^[\s:]+/, '').trim(); })
      .filter(p => p.length > 10 && !p.startsWith('['));

    const carousel = snap.carouselScripts || '';
    const photos   = snap.photoScripts   || '';
    const stories  = snap.storiesScripts || '';
    const covers   = snap.covers         || '';

    // Сообщение 1: цифры (без Markdown — безопаснее)
    const msg1 = [
      `ДИАГНОСТИКА done_snapshot — ${clientChatId}`,
      '',
      `ПОЛЯ: ${['videoScripts','carouselScripts','photoScripts','storiesScripts','covers'].map(f => `${f}:${snap[f] ? 'YES' : 'NO'}`).join(' | ')}`,
      `qualityTest: ${snap._qualityTest ? 'TRUE (проблема!)' : 'нет'}`,
      '',
      `КАРУСЕЛИ (${carousel.length} симв.):`,
      `  byPrefix("Промпт для изображения"): ${byPrefix(carousel, 'Промпт для изображения').length}`,
      `  byContains("Промпт для изображения"): ${byContains(carousel, 'Промпт для изображения').length}`,
      `  byContains("Prompt"): ${byContains(carousel, 'Prompt').length}`,
      `  byContains("photorealistic"): ${byContains(carousel, 'photorealistic').length}`,
      '',
      `ФОТО (${photos.length} симв.):`,
      `  byPrefix("Промпт для AI-генерации"): ${byPrefix(photos, 'Промпт для AI-генерации').length}`,
      `  byContains("photorealistic"): ${byContains(photos, 'photorealistic').length}`,
      '',
      `СТОРИС (${stories.length} симв.):`,
      `  byContains("photorealistic"): ${byContains(stories, 'photorealistic').length}`,
      '',
      `ОБЛОЖКИ (${covers.length} симв.):`,
      `  byContains("photorealistic"): ${byContains(covers, 'photorealistic').length}`,
    ].join('\n');
    await ctx.reply(msg1);

    // Сообщение 2: первые 20 строк карусели (plain text)
    if (carousel.length > 0) {
      const first20 = carousel.split('\n').filter(l => l.trim()).slice(0, 20).join('\n');
      await ctx.reply('ПЕРВЫЕ 20 СТРОК carouselScripts:\n\n' + first20.slice(0, 1500));
    }
    // Сообщение 3: первые 10 строк фото
    if (photos.length > 0) {
      const first10 = photos.split('\n').filter(l => l.trim()).slice(0, 10).join('\n');
      await ctx.reply('ПЕРВЫЕ 10 СТРОК photoScripts:\n\n' + first10.slice(0, 800));
    }
  } catch (e) {
    await ctx.reply(`Ошибка в debug_snapshot: ${e.message}`);
  }
}));

bot.command('library', requireAuth(async (ctx) => {
  const { default: fetch } = await import('node-fetch');
  try {
    const r = await fetch(`${VISUAL_SVC}/library_stats`);
    const data = await r.json();
    await ctx.reply(
      `📚 Видеобиблиотека\n\n` +
      `Всего видео: ${data.count}\n` +
      `Занято места: ${data.totalMb} МБ\n\n` +
      `Видео автоматически сохраняются после каждой генерации и используются при поиске похожего контента для новых клиентов.`
    );
  } catch {
    await ctx.reply('⚠️ Не удалось получить статистику библиотеки');
  }
}));

// ── /visual_sample — полный визуальный образец: карусель+фото+обложка+сторис+видео ──
bot.command('visual_sample', requireAuth(async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  if (parts.length < 2) {
    return ctx.reply(
      '⚠️ Использование:\n' +
      '/visual_sample {chatId}       — пропускает уже готовые\n' +
      '/visual_sample {chatId} force — перегенерирует всё заново\n\n' +
      'Пример:\n/visual_sample 343330794 force'
    );
  }
  const clientChatId = parts[1].trim();
  const force = parts[2]?.toLowerCase() === 'force';

  await ctx.reply(
    `🧪 Запускаю визуальный образец для chatId ${clientChatId}...\n` +
    (force ? '🔄 Режим: перегенерация всего заново\n' : '♻️ Режим: пропускаю уже готовые\n') +
    '\nПридёт в Bot3 по мере готовности:\n🎠 Карусель → 📸 Фото → 🖼 Обложка → 📱 Сторис → 🎬 Видео'
  );

  const { default: fetch } = await import('node-fetch');
  await fetch(`${VISUAL_SVC}/generate_visual_sample`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientChatId, force }),
  }).catch(e => ctx.reply(`❌ Ошибка запуска: ${e.message}`));
}));

// ── /video_text — переналожить текст на существующее видео ───────────────────
bot.command('video_text', requireAuth(async (ctx) => {
  const parts = ctx.message.text.trim().split(/\n/);
  const firstLine = parts[0].trim().split(/\s+/);
  const clientChatId = firstLine[1];
  if (!clientChatId) {
    return ctx.reply(
      '⚠️ Использование (каждый текст с новой строки):\n\n' +
      '/video_text 343330794\n' +
      'Хук: [текст до 35 символов]\n' +
      'Тема: [текст до 35 символов]\n' +
      'CTA: [текст до 70 символов]\n\n' +
      'Пример:\n' +
      '/video_text 343330794\n' +
      'Хук: Māksla ir tev pieejama\n' +
      'Тема: Šeit neviens nevērtē\n' +
      'CTA: Pirmā nodarbība no €39'
    );
  }

  const hookText  = (parts.find(l => /^хук:/i.test(l.trim())) || '').replace(/^хук:\s*/i, '').trim();
  const themeText = (parts.find(l => /^тема:/i.test(l.trim())) || '').replace(/^тема:\s*/i, '').trim();
  const ctaText   = (parts.find(l => /^cta:/i.test(l.trim())) || '').replace(/^cta:\s*/i, '').trim();

  if (!hookText && !themeText && !ctaText) {
    return ctx.reply('⚠️ Укажи хотя бы один из текстов: Хук, Тема или CTA');
  }

  await ctx.reply(`🎬 Переналагаю текст на видео chatId ${clientChatId}...\n\nЖди ~30 сек`);
  const { default: fetch } = await import('node-fetch');
  await fetch(`${VISUAL_SVC}/resample_video_text`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ clientChatId, hookText, themeText, ctaText }),
  }).catch(e => ctx.reply(`❌ Ошибка: ${e.message}`));
}));

// ── /custom_video — создать видео по своему сценарию ─────────────────────────
bot.command('custom_video', requireAuth(async (ctx) => {
  const sess = getSession(ctx.chat.id);
  sess.awaitingCustomVideo = true;
  saveSession3(ctx.chat.id, sess);
  await ctx.reply(
    `🎬 Создание видео по своему сценарию\n\n` +
    `Опишите что хотите видеть в ролике — вольным текстом:\n\n` +
    `Примеры:\n` +
    `• "Кофейня утром: бариста готовит капучино, пар от кофе, тёплый свет"\n` +
    `• "Динамичный монтаж: продукт на столе, руки достают из упаковки, детали крупным планом"\n` +
    `• "Спокойная атмосфера: девушка в салоне, маска на лице, свечи, расслабление"\n\n` +
    `Я конвертирую в промпт для Veo3 и сгенерирую ролик до 30 сек.`
  );
}));

// ── /custom_carousel — создать карусель по своему сценарию ───────────────────
bot.command('custom_carousel', requireAuth(async (ctx) => {
  const sess = getSession(ctx.chat.id);
  sess.awaitingCustomCarousel = true;
  saveSession3(ctx.chat.id, sess);
  await ctx.reply(
    `🎠 Создание карусели по своему сценарию\n\n` +
    `Опишите тему и что должно быть в карусели:\n\n` +
    `Примеры:\n` +
    `• "7 признаков хорошего мастера маникюра — практические советы"\n` +
    `• "До/после: как изменился Instagram нашего клиента за месяц"\n` +
    `• "5 ошибок малого бизнеса в соцсетях — и как их исправить"\n\n` +
    `Я создам 7 слайдов с текстами и AI-изображениями.`
  );
}));

// ── Video subtitle edit: et_video_{videoIndex}_{clientId} ────────────────────
bot.action(/^et_video_(\d+)_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery('Введите хук, тему и CTA...');
  const videoIndex   = Number(ctx.match[1]);
  const clientChatId = ctx.match[2];
  const sess = getSession(ctx.chat.id);
  // Очищаем все другие состояния
  sess.awaitingVideoFeedback   = false;
  sess.awaitingRegenFeedback   = null;
  sess.awaitingSampleRegen     = null;
  sess.awaitingSampleFragRegen = null;
  sess.awaitingTextEdit = { section: 'video', index: videoIndex, clientChatId };
  saveSession3(ctx.chat.id, sess);
  await ctx.reply(
    `✏️ Новый текст для Видео ${videoIndex + 1}\n\n` +
    `Напишите три строки (каждую с новой строки):\n\n` +
    `Хук: [текст — первые 4 сек, макс 35 символов]\n` +
    `Тема: [текст — середина видео, макс 35 символов]\n` +
    `CTA: [текст — последние 8 сек, макс 70 символов]\n\n` +
    `Если хотите оставить часть без изменений — просто не пишите эту строку.`
  );
}));

// ── Scene regen: rscene_{videoIndex}_{clientId} ───────────────────────────────
bot.action(/^rscene_(\d+)_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery('Укажите какую сцену переснять...');
  const videoIndex   = Number(ctx.match[1]);
  const clientChatId = ctx.match[2];

  // Load scene list
  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  let scenes = [];
  try {
    const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    scenes = data.results?.videoData?.[videoIndex]?.scenes || [];
  } catch {}

  const sess = getSession(ctx.chat.id);
  // Очищаем ВСЕ другие состояния ожидания — иначе описание сцены уйдёт как субтитр
  sess.awaitingTextEdit        = null;
  sess.awaitingRegenFeedback   = null;
  sess.awaitingSampleRegen     = null;
  sess.awaitingSampleTextEdit  = null;
  sess.awaitingSampleFragRegen = null;
  sess.awaitingVideoFeedback   = true;
  sess.reviewing               = clientChatId;
  sess.videoFeedbackIndex      = videoIndex;
  saveSession3(ctx.chat.id, sess);

  const sceneList = scenes.map((s, i) => `${i + 1}. ${s.slice(0, 80)}`).join('\n');
  await ctx.reply(
    `🎬 Видео ${videoIndex + 1} — выберите что переснять:\n\n${sceneList || '(сцены не найдены)'}\n\n` +
    `Напишите номер сцены или опишите что не нравится — AI сам определит какую сцену переделать.`
  );
}));

// ── /set_logo {chatId} [position] — загрузить лого клиента ───────────────────
// position: br (право-низ, по умолчанию), bl, tr, tl
bot.command('set_logo', requireAuth(async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const clientChatId = parts[1];
  const position     = parts[2] || 'br';

  if (!clientChatId) {
    return ctx.reply(
      '⚠️ Использование: /set_logo {chatId} [позиция]\n\n' +
      'Позиции: br (право-низ), bl (лево-низ), tr (право-верх), tl (лево-верх)\n' +
      'После команды прикрепите PNG/JPG с логотипом.'
    );
  }

  const validPositions = ['br', 'bl', 'tr', 'tl'];
  if (!validPositions.includes(position)) {
    return ctx.reply(`⚠️ Неверная позиция "${position}". Используйте: br, bl, tr, tl`);
  }

  const sess = getSession(ctx.chat.id);
  sess.awaitingLogo = { clientChatId, position };
  saveSession3(ctx.chat.id, sess);

  await ctx.reply(
    `✅ Готов принять лого для клиента ${clientChatId}\n` +
    `Позиция: ${position === 'br' ? 'право-низ' : position === 'bl' ? 'лево-низ' : position === 'tr' ? 'право-верх' : 'лево-верх'}\n\n` +
    `Прикрепите PNG или JPG файл с логотипом:`
  );
}));

// Обработчик загрузки фото/документа для лого
bot.on(['photo', 'document'], requireAuth(async (ctx) => {
  const sess = getSession(ctx.chat.id);
  if (!sess.awaitingLogo) return;

  const { clientChatId, position } = sess.awaitingLogo;
  sess.awaitingLogo = null;
  saveSession3(ctx.chat.id, sess);

  try {
    // Получаем file_id — photo даёт массив (берём наибольшее), document — один файл
    let fileId;
    if (ctx.message.photo) {
      fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
    } else if (ctx.message.document) {
      fileId = ctx.message.document.file_id;
    }
    if (!fileId) { await ctx.reply('❌ Не удалось получить файл'); return; }

    // Скачиваем файл через Telegram API
    const token = process.env.TELEGRAM_BOT3_TOKEN;
    const { default: fetch } = await import('node-fetch');
    const fileInfo = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`).then(r => r.json());
    const filePath = fileInfo?.result?.file_path;
    if (!filePath) { await ctx.reply('❌ Не удалось получить путь к файлу'); return; }

    const fileUrl = `https://api.telegram.org/file/bot${token}/${filePath}`;
    const resp = await fetch(fileUrl);
    const buf  = await resp.buffer();

    // Сохраняем лого + позицию
    const logoPath = path.join(RESULTS_DIR, `${clientChatId}.logo.png`);
    const metaPath = path.join(RESULTS_DIR, `${clientChatId}.logo.json`);
    fs.writeFileSync(logoPath, buf);
    fs.writeFileSync(metaPath, JSON.stringify({ position, savedAt: Date.now() }, null, 2));

    await ctx.reply(
      `✅ Лого сохранено для клиента ${clientChatId}\n` +
      `Позиция: ${position}\n\n` +
      `Лого будет автоматически добавляться на все фото, карусели, сторис, обложки и видео при проверке и доставке.\n\n` +
      `Чтобы удалить лого: /remove_logo ${clientChatId}`
    );
  } catch (e) {
    await ctx.reply(`❌ Ошибка сохранения лого: ${e.message}`);
  }
}));

// /remove_logo {chatId} — удалить лого клиента
bot.command('remove_logo', requireAuth(async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const clientChatId = parts[1];
  if (!clientChatId) return ctx.reply('⚠️ Использование: /remove_logo {chatId}');

  const logoPath = path.join(RESULTS_DIR, `${clientChatId}.logo.png`);
  const metaPath = path.join(RESULTS_DIR, `${clientChatId}.logo.json`);
  let removed = false;
  for (const f of [logoPath, metaPath]) {
    if (fs.existsSync(f)) { fs.unlinkSync(f); removed = true; }
  }
  await ctx.reply(removed ? `✅ Лого клиента ${clientChatId} удалено` : `⚠️ Лого для ${clientChatId} не найдено`);
}));

bot.command('learning_stats', requireAuth(async (ctx) => {
  const { getLearningStats } = require('./src/prompt_learning');
  const s = getLearningStats();
  await ctx.reply(
    `🧠 Система самообучения\n\n` +
    `Накоплено правок: ${s.pendingFeedback} / ${s.threshold}\n` +
    `Циклов обучения: ${s.cyclesDone}\n` +
    `Уроков для фото: ${s.imageLessons}\n` +
    `Уроков для видео: ${s.videoLessons}\n` +
    `Последнее обновление: ${s.lastUpdated}`
  );
}));

// ── Тест предложения аналитики — без полной генерации ────────────────────────

// ── Демо-пакет: отправить клиенту (кнопка после visual_sample) ───────────────
bot.action(/^send_demo_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

  const clientChatId = ctx.match[1];
  const PENDING_DIR  = path.join(BASE_DIR, 'pending');
  const VISUAL_DIR   = path.join(BASE_DIR, 'visual_results');
  const pendingFile  = path.join(PENDING_DIR, `${clientChatId}.demo.json`);
  const bot2Token    = process.env.TELEGRAM_BOT2_TOKEN;

  if (!fs.existsSync(pendingFile)) return ctx.reply(`❌ Демо-файл не найден для chatId ${clientChatId}`);
  if (!bot2Token) return ctx.reply('❌ TELEGRAM_BOT2_TOKEN не задан');

  const pkg = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  const { default: fetch } = await import('node-fetch');

  const sendFile = async (filePath, caption, method) => {
    if (!fs.existsSync(filePath)) return false;
    const FormData = (await import('form-data')).default;
    const form = new FormData();
    form.append('chat_id', clientChatId);
    const fieldName = method === 'sendVideo' ? 'video' : 'photo';
    form.append(fieldName, fs.createReadStream(filePath), { filename: path.basename(filePath) });
    if (caption) form.append('caption', caption.slice(0, 1024));
    await fetch(`https://api.telegram.org/bot${bot2Token}/${method}`, { method: 'POST', body: form }).catch(() => {});
    return true;
  };

  const tgMsg = async (text) => {
    await fetch(`https://api.telegram.org/bot${bot2Token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: clientChatId, text: text.slice(0, 4000) }),
    }).catch(() => {});
  };

  // Текст поста (подпись к фото)
  if (pkg.photoExample) await tgMsg(`📝 Пример поста:\n\n${pkg.photoExample}`);

  // Фото поста
  await sendFile(path.join(VISUAL_DIR, `${clientChatId}_sample_photo.jpg`), '📸 Фото для поста', 'sendPhoto');

  // Карусель — все сгенерированные слайды
  for (let i = 0; i < 5; i++) {
    const slide = path.join(VISUAL_DIR, `${clientChatId}_sample_car_${i}.jpg`);
    if (!fs.existsSync(slide)) break;
    await sendFile(slide, i === 0 ? '🎠 Карусель' : null, 'sendPhoto');
  }

  // Обложка
  await sendFile(path.join(VISUAL_DIR, `${clientChatId}_sample_cover.jpg`), '🖼 Обложка', 'sendPhoto');

  // Сторис
  await sendFile(path.join(VISUAL_DIR, `${clientChatId}_sample_story.jpg`), '📱 Stories', 'sendPhoto');

  // Видео
  await sendFile(path.join(VISUAL_DIR, `${clientChatId}_sample_video.mp4`), '🎬 Видео', 'sendVideo');

  // Финальное сообщение клиенту
  await tgMsg('✅ Это ваш персональный демо-пакет, созданный специально под ваш бизнес.\n\nЕсли хотите получить полный месячный контент — напишите нам.');

  fs.unlinkSync(pendingFile);
  await ctx.reply(`✅ Демо-пакет отправлен клиенту ${clientChatId}`);
}));

bot.command('test_autopost', requireAuth(async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const clientChatId = parts[1];
  if (!clientChatId) return ctx.reply('Использование: /test_autopost {chatId}');

  const bot2Token = process.env.TELEGRAM_BOT2_TOKEN;
  if (!bot2Token) return ctx.reply('❌ TELEGRAM_BOT2_TOKEN не задан');

  const { default: fetch } = await import('node-fetch');
  await fetch(`https://api.telegram.org/bot${bot2Token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: clientChatId,
      parse_mode: 'Markdown',
      text:
        '📊 *Хотите чтобы мы отслеживали аналитику автоматически?*\n\n' +
        'Через 15 дней мы проанализируем реакцию вашей аудитории и скорректируем следующий контент — что зашло, что нет.\n\n' +
        'Для этого нужно подключить ваш Instagram — займёт 1 минуту.',
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [{ text: '✅ Да, подключить аналитику', callback_data: 'analytics_yes' }],
          [{ text: '❌ Нет, спасибо', callback_data: 'analytics_no' }],
        ]
      })
    })
  }).catch(e => ctx.reply(`❌ Ошибка: ${e.message}`));

  await ctx.reply(`✅ Предложение аналитики отправлено клиенту ${clientChatId}`);
}));

// ── Отправка текстового пакета клиенту после одобрения в Bot3 ───────────────
bot.action(/^send_text_(\d+)_(\d)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery();
  const clientChatId = ctx.match[1];
  const waveNum = ctx.match[2];

  const urlStorePath = path.join(BASE_DIR, `${clientChatId}.text_url_wave${waveNum}.json`);
  if (!fs.existsSync(urlStorePath)) {
    return ctx.reply(`❌ URL текстового пакета не найден для ${clientChatId} (wave${waveNum}).`);
  }

  let stored;
  try { stored = JSON.parse(fs.readFileSync(urlStorePath, 'utf8')); }
  catch { return ctx.reply('❌ Ошибка чтения URL файла.'); }

  const { url, clientName } = stored;
  const waveLabel = waveNum === '2' ? 'Вторые 15 дней' : 'Первые 15 дней';
  const waveMsg = waveNum === '2'
    ? '🎉 Вторая часть вашего контент-пакета готова!\n\n📋 Контент-план и статья на следующие 15 дней:\n'
    : '🎉 Ваш контент-пакет Marketing DNA готов!\n\n📋 Контент-план и статьи на первые 15 дней:\n';

  try {
    const { default: fetch } = await import('node-fetch');
    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT2_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: clientChatId, text: waveMsg + url }),
    });
    fs.unlinkSync(urlStorePath);
    await ctx.editMessageText(`✅ Текстовый пакет (${waveLabel}) отправлен клиенту ${clientName || clientChatId}.`).catch(() => {});
    await ctx.reply(`✅ Ссылка на текстовый пакет отправлена в Bot2 клиенту ${clientName || clientChatId}.`);
  } catch (e) {
    await ctx.reply(`❌ Ошибка отправки: ${e.message}`);
  }
}));

// ── Автопостинг — отправка ссылки Metricool клиенту ─────────────────────────

// send_metricool_link — устарел, ссылка теперь отправляется автоматически

bot.launch().then(() => console.log('[bot3] Manager Review Bot запущен'));
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
