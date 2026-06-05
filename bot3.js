require('dotenv').config();
const { Telegraf } = require('telegraf');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const BOT3_TOKEN   = process.env.TELEGRAM_BOT3_TOKEN;
const ACCESS_CODE  = process.env.BOT3_ACCESS_CODE;
const VISUAL_SVC   = process.env.VISUAL_SERVICE_URL || 'http://localhost:3002';

if (!BOT3_TOKEN) { console.error('TELEGRAM_BOT3_TOKEN не задан'); process.exit(1); }
if (!ACCESS_CODE) { console.error('BOT3_ACCESS_CODE не задан'); process.exit(1); }

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
  photos:    '📸 Фото постов (8 шт)',
  carousels: '🎠 Слайды каруселей',
  stories:   '📱 Stories (15 шт)',
  covers:    '🖼 Обложки',
  videos:    '🎬 Видео B-roll (8 шт)',
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
        '  тарифы: a (Старт) / standard (Стандарт) / v (Профи)'
      );
    } else {
      await ctx.reply('❌ Неверный код. Попробуйте ещё раз:');
    }
    return;
  }

  // Waiting for regen feedback
  if (sess.awaitingRegenFeedback) {
    const { section, index, clientChatId } = sess.awaitingRegenFeedback;
    sess.awaitingRegenFeedback = null;
    saveSession3(ctx.chat.id, sess);

    const feedback = ctx.message.text.trim();
    const sectionLabels = { ph: 'Фото', ca: 'Слайд', co: 'Обложка', st: 'Story' };
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

  // Waiting for text edit input
  if (sess.awaitingTextEdit) {
    // If user sent a command — cancel edit mode and let command handlers take over
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

    // Video subtitle: trigger re-render with new text
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

    const sectionLabels = { ph: 'Фото', ca: 'Слайд', co: 'Обложка', st: 'Story' };
    const label = `${sectionLabels[section] || section} ${index + 1}`;
    await ctx.reply(`✅ Текст для «${label}» сохранён — пересобираю картинку с новым текстом...`);

    // Показываем предпросмотр с новым текстом поверх картинки
    const { default: fetch } = await import('node-fetch');
    await fetch(`${VISUAL_SVC}/preview_edit`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ clientChatId, section, index, text: newText }),
    }).catch(() => {});
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

bot.command('queue', requireAuth(async (ctx) => {
  if (!fs.existsSync(RESULTS_DIR)) return ctx.reply('Очередь пуста.');
  const files = fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith('.results.json'));
  if (!files.length) return ctx.reply('Очередь пуста — нечего проверять.');

  const lines = files.map(f => {
    const d       = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf8'));
    const approved = Object.keys(d.approved || {}).length;
    const total    = getSections(d.packageKey).length;
    return `• ${d.clientName} — ${approved}/${total} разделов ✅\n  /review_${d.clientChatId}`;
  });
  await ctx.reply('📋 Очередь на проверку:\n\n' + lines.join('\n\n'));
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
  if (packageKey.includes('pkg_v') || packageKey.includes('pkg_standard')) s.push('videos');
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
  const data  = sess.reviewData;
  const label = SECTION_LABELS[section];
  const urls  = getSectionUrls(data, section);
  const valid = urls.filter(Boolean);

  await ctx.reply(
    `─────────────────────\n` +
    `Раздел ${sess.sectionIndex + 1}/${sess.sections.length}: *${label}*\n` +
    `Готово: ${valid.length}/${urls.length}`,
    { parse_mode: 'Markdown' }
  );

  // Send images in groups of 10
  for (let i = 0; i < valid.length; i += 10) {
    const group = valid.slice(i, i + 10);
    await ctx.replyWithMediaGroup(group.map(u => ({ type: 'photo', media: u }))).catch(async () => {
      for (const u of group) await ctx.replyWithPhoto(u).catch(() => {});
    });
  }

  await ctx.reply('Как визуал?', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Раздел ок', callback_data: `approve_${section}` }],
        [{ text: '🔄 Переделать всё', callback_data: `regen_${section}` }],
      ],
    },
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

function getSectionUrls(data, section) {
  if (section === 'photos')    return data.results.photos          || [];
  if (section === 'stories')   return data.results.stories         || [];
  if (section === 'carousels') return data.results.carouselSlides  || [];
  if (section === 'covers')    return data.results.covers          || [];
  return [];
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

// Image section regen
bot.action(/^regen_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const section = ctx.match[1];
  if (section.startsWith('video')) return;
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

  fs.writeFileSync(
    path.join(TRIGGERS_DIR, `${clientChatId}.approved.trigger`),
    JSON.stringify({ clientChatId, approvedAt: Date.now() }, null, 2)
  );

  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply(`✅ Пакет поставлен в очередь доставки клиенту.`);

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
// slotCode: c0-c4 = слайды карусели, cv = обложка, ph = фото
bot.action(/^regen_fs_([a-z0-9]+)_(\d+)$/, requireAuth(async (ctx) => {
  const slotCode     = ctx.match[1];
  const clientChatId = ctx.match[2];
  const slotLabels   = { c0: 'Слайд 1', c1: 'Слайд 2', c2: 'Слайд 3', c3: 'Слайд 4', c4: 'Слайд 5', cv: 'Обложка', ph: 'AI-фото' };
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

bot.action(/^metricool_link_sent_(\d+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply('✅ Зафиксировано. Ждём пока клиент подключит Instagram — получите уведомление автоматически.');
});

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
      `📊 *Корректировки контента — следующие 15 дней*\n\n` +
      `На основе статистики ваших публикаций мы обновили контент-план.\n\n` +
      `${corrections}`,
      { parse_mode: 'Markdown' }
    );
    await ctx.reply(`✅ Корректировки (цикл ${cycle}) отправлены клиенту ${clientChatId}.`);
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

  const sectionLabels = { ph: 'Фото', ca: 'Слайд', co: 'Обложка', st: 'Story' };
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

bot.action(/^et_([a-z]+)_(\d+)_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery('Введите новый текст...');
  const section      = ctx.match[1];
  const index        = Number(ctx.match[2]);
  const clientChatId = ctx.match[3];

  const sess = getSession(ctx.chat.id);
  sess.awaitingTextEdit = { section, index, clientChatId };
  saveSession3(ctx.chat.id, sess);

  const sectionLabels = { ph: 'Фото', ca: 'Слайд', co: 'Обложка', st: 'Story' };
  const label = `${sectionLabels[section] || section} ${index + 1}`;
  await ctx.reply(`✏️ Введите новый текст/подпись для «${label}»:\n\n(Это заменит текущий текст при отправке клиенту)`);
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

// ── Video subtitle edit: et_video_{videoIndex}_{clientId} ────────────────────
bot.action(/^et_video_(\d+)_(\d+)$/, requireAuth(async (ctx) => {
  await ctx.answerCbQuery('Введите хук, тему и CTA...');
  const videoIndex   = Number(ctx.match[1]);
  const clientChatId = ctx.match[2];
  const sess = getSession(ctx.chat.id);
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
  sess.awaitingVideoFeedback = true;
  sess.reviewing             = clientChatId;
  sess.videoFeedbackIndex    = videoIndex;
  saveSession3(ctx.chat.id, sess);

  const sceneList = scenes.map((s, i) => `${i + 1}. ${s.slice(0, 80)}`).join('\n');
  await ctx.reply(
    `🎬 Видео ${videoIndex + 1} — выберите что переснять:\n\n${sceneList || '(сцены не найдены)'}\n\n` +
    `Напишите номер сцены или опишите что не нравится — AI сам определит какую сцену переделать.`
  );
}));

bot.launch().then(() => console.log('[bot3] Manager Review Bot запущен'));
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
