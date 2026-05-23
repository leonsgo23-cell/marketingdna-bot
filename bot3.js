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

const BASE_DIR     = path.join(os.homedir(), '.marketingdna-client-sessions');
const RESULTS_DIR  = path.join(BASE_DIR, 'visual_results');
const TRIGGERS_DIR = path.join(BASE_DIR, 'triggers');

const bot = new Telegraf(BOT3_TOKEN, { handlerTimeout: 300000 });

// In-memory sessions: { chatId: { authorized, reviewing, pos } }
const sessions = {};

function getSession(id) {
  if (!sessions[id]) sessions[id] = { authorized: false };
  return sessions[id];
}

// ── Auth ───────────────────────────────────────────────────────────────────────

bot.start(async (ctx) => {
  await ctx.reply(
    '👋 Marketing DNA — Менеджер\n\nВведите код доступа:'
  );
});

bot.on('text', async (ctx, next) => {
  const sess = getSession(ctx.chat.id);
  if (!sess.authorized) {
    if (ctx.message.text.trim() === ACCESS_CODE) {
      sess.authorized = true;
      await ctx.reply('✅ Доступ открыт.\n\nКогда визуал для клиента будет готов — вы получите уведомление здесь.\n\nКоманды:\n/queue — очередь на проверку\n/review_{chatId} — начать проверку');
    } else {
      await ctx.reply('❌ Неверный код. Попробуйте ещё раз:');
    }
    return;
  }
  return next();
});

function requireAuth(fn) {
  return async (ctx) => {
    if (!getSession(ctx.chat.id).authorized) {
      await ctx.reply('Введите код доступа сначала: /start');
      return;
    }
    return fn(ctx);
  };
}

// ── Commands ───────────────────────────────────────────────────────────────────

bot.command('queue', requireAuth(async (ctx) => {
  if (!fs.existsSync(RESULTS_DIR)) return ctx.reply('Очередь пуста.');
  const files = fs.readdirSync(RESULTS_DIR).filter(f => f.endsWith('.results.json'));
  if (!files.length) return ctx.reply('Очередь пуста — нечего проверять.');

  const lines = files.map(f => {
    const d = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, f), 'utf8'));
    const approved = Object.keys(d.approved || {}).length;
    const total    = getSections(d.packageKey).length;
    return `• ${d.clientName} — ${approved}/${total} разделов ✅\n  /review_${d.clientChatId}`;
  });
  await ctx.reply('📋 Очередь на проверку:\n\n' + lines.join('\n\n'));
}));

// /review_{clientChatId}
bot.hears(/^\/review_(\d+)$/, requireAuth(async (ctx) => {
  const clientChatId = ctx.match[1];
  const sess         = getSession(ctx.chat.id);
  const resultPath   = path.join(RESULTS_DIR, `${clientChatId}.results.json`);

  if (!fs.existsSync(resultPath)) {
    return ctx.reply('❌ Результаты не найдены для этого клиента.');
  }

  const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  sess.reviewing    = clientChatId;
  sess.reviewData   = data;
  sess.sections     = getSections(data.packageKey);
  sess.sectionIndex = 0;

  await ctx.reply(`🔍 Начинаем проверку — *${data.clientName}*\n\n${sess.sections.length} разделов к проверке.`, { parse_mode: 'Markdown' });
  await showSection(ctx, sess);
}));

// ── Section display ────────────────────────────────────────────────────────────

function getSections(packageKey) {
  const isProfi = packageKey.includes('pkg_v');
  const s = ['photos', 'carousels', 'stories', 'covers'];
  if (isProfi) s.push('videos');
  return s;
}

const SECTION_LABELS = {
  photos:    '📸 Фото постов (8 шт)',
  carousels: '🎠 Слайды каруселей',
  stories:   '📱 Stories (15 шт)',
  covers:    '🖼 Обложки',
  videos:    '🎬 Видео B-roll (8 шт)',
};

async function showSection(ctx, sess) {
  const section = sess.sections[sess.sectionIndex];
  if (!section) {
    await showFinalApproval(ctx, sess);
    return;
  }

  const data    = sess.reviewData;
  const label   = SECTION_LABELS[section];
  const urls    = getSectionUrls(data, section);
  const valid   = urls.filter(Boolean);

  await ctx.reply(
    `─────────────────────\n` +
    `Раздел ${sess.sectionIndex + 1}/${sess.sections.length}: *${label}*\n` +
    `Сгенерировано: ${valid.length}/${urls.length}`,
    { parse_mode: 'Markdown' }
  );

  if (section === 'videos') {
    await sendVideos(ctx, valid);
  } else {
    await sendImageGroups(ctx, valid);
  }

  await ctx.reply(
    `Как визуал?`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: `✅ Раздел ок`, callback_data: `approve_${section}` }],
          [{ text: `🔄 Переделать всё`, callback_data: `regen_${section}` }],
        ],
      },
    }
  );
}

function getSectionUrls(data, section) {
  if (section === 'photos')    return data.results.photos    || [];
  if (section === 'stories')   return data.results.stories   || [];
  if (section === 'carousels') return data.results.carouselSlides || [];
  if (section === 'covers')    return data.results.covers    || [];
  if (section === 'videos')    return data.results.videos    || [];
  return [];
}

async function sendImageGroups(ctx, urls) {
  const GROUP_SIZE = 10;
  for (let i = 0; i < urls.length; i += GROUP_SIZE) {
    const group = urls.slice(i, i + GROUP_SIZE);
    try {
      await ctx.replyWithMediaGroup(group.map(u => ({ type: 'photo', media: u })));
    } catch {
      // Fallback — send individually
      for (const u of group) {
        await ctx.replyWithPhoto(u).catch(() => ctx.reply(`⚠️ Не удалось загрузить: ${u}`));
      }
    }
  }
}

async function sendVideos(ctx, urls) {
  for (const u of urls) {
    await ctx.replyWithVideo(u).catch(() => ctx.reply(`🎬 Видео: ${u}`));
  }
}

// ── Callbacks ──────────────────────────────────────────────────────────────────

bot.action(/^approve_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const section = ctx.match[1];
  const sess    = getSession(ctx.chat.id);
  if (!sess.reviewing) return;

  const resultPath = path.join(RESULTS_DIR, `${sess.reviewing}.results.json`);
  const data       = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  data.approved[section] = true;
  fs.writeFileSync(resultPath, JSON.stringify(data, null, 2));
  sess.reviewData = data;

  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply(`✅ ${SECTION_LABELS[section]} — одобрено`);

  sess.sectionIndex++;
  await showSection(ctx, sess);
});

bot.action(/^regen_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const section = ctx.match[1];
  const sess    = getSession(ctx.chat.id);
  if (!sess.reviewing) return;

  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply(`🔄 Запускаю регенерацию раздела *${SECTION_LABELS[section]}*...\n\nПолучите уведомление когда будет готово.`, { parse_mode: 'Markdown' });

  const { default: fetch } = await import('node-fetch');
  await fetch(`${VISUAL_SVC}/regen`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ clientChatId: sess.reviewing, section }),
  }).catch(e => ctx.reply(`⚠️ Ошибка запуска регенерации: ${e.message}`));
});

// ── Final approval ─────────────────────────────────────────────────────────────

async function showFinalApproval(ctx, sess) {
  const data    = sess.reviewData;
  const total   = sess.sections.length;
  const approved = Object.keys(data.approved || {}).length;

  if (approved < total) {
    await ctx.reply(
      `⚠️ Одобрено ${approved}/${total} разделов.\n\nВернитесь к проверке: /review_${sess.reviewing}`
    );
    return;
  }

  await ctx.reply(
    `🎉 Все разделы одобрены!\n\n` +
    `Клиент: *${data.clientName}*\n\n` +
    `Отправить весь пакет клиенту?`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '📤 Отправить клиенту', callback_data: `deliver_${sess.reviewing}` }],
          [{ text: '⏸ Подождать', callback_data: 'deliver_cancel' }],
        ],
      },
    }
  );
}

bot.action(/^deliver_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const clientChatId = ctx.match[1];

  // Write approved trigger — Bot1 picks it up and delivers to client
  fs.writeFileSync(
    path.join(TRIGGERS_DIR, `${clientChatId}.approved.trigger`),
    JSON.stringify({ clientChatId, approvedAt: Date.now() }, null, 2)
  );

  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply(`✅ Пакет поставлен в очередь доставки клиенту ${clientChatId}.`);

  const sess = getSession(ctx.chat.id);
  sess.reviewing    = null;
  sess.reviewData   = null;
  sess.sectionIndex = 0;
});

bot.action('deliver_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply('Понял. Пакет не отправлен. Вернитесь когда будете готовы.');
});

bot.launch().then(() => console.log('[bot3] Manager Review Bot запущен'));
process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
