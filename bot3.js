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
        'Команды:\n/queue — очередь на проверку\n/review_{chatId} — начать проверку'
      );
    } else {
      await ctx.reply('❌ Неверный код. Попробуйте ещё раз:');
    }
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

  const bot2Token = process.env.TELEGRAM_BOT_TOKEN;
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
  const bot2Token = process.env.TELEGRAM_BOT_TOKEN;
  if (!bot2Token) return ctx.reply('TELEGRAM_BOT_TOKEN не задан — не могу отправить клиенту.');

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

bot.launch().then(() => console.log('[bot3] Manager Review Bot запущен'));
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
