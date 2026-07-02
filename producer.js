// ============================================================================
// Bot5 — «Бот-Продюсер»: ведение собственных соцсетей Marketing DNA
// Этап 1: ежедневный Story Reel (EN+RU) с одобрением менеджером.
// Спецификация: claudeProject/specs/2026-07-02-bot-producer-spec.md
// ============================================================================
require('dotenv').config();
const { Telegraf } = require('telegraf');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const { askSonnet } = require('./src/claude');

const BOT5_TOKEN = process.env.TELEGRAM_BOT5_TOKEN;
if (!BOT5_TOKEN) { console.error('TELEGRAM_BOT5_TOKEN не задан'); process.exit(1); }

const BASE_DIR     = path.join(os.homedir(), '.marketingdna-client-sessions');
const PRODUCER_DIR = path.join(BASE_DIR, 'producer');
const DRAFTS_DIR   = path.join(PRODUCER_DIR, 'drafts');
const USERS_FILE   = path.join(PRODUCER_DIR, 'users.json');
const STATE_FILE   = path.join(PRODUCER_DIR, 'state.json');
const VISUAL_URL   = process.env.VISUAL_SERVICE_URL || 'http://localhost:3002';
// Час автогенерации по UTC (05:00 UTC = 08:00 Рига летом)
const DAILY_HOUR_UTC = parseInt(process.env.PRODUCER_HOUR_UTC || '5', 10);

const brand = require('./producer/brands/mdna.json');

for (const d of [PRODUCER_DIR, DRAFTS_DIR]) fs.mkdirSync(d, { recursive: true });

const bot = new Telegraf(BOT5_TOKEN, { handlerTimeout: 300000 });

// ── Пользователи (владелец + менеджер) ───────────────────────────────────────
function getUsers() {
  try { return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8')).chatIds || []; }
  catch { return []; }
}
function addUser(chatId) {
  const ids = getUsers();
  if (!ids.includes(chatId)) {
    ids.push(chatId);
    fs.writeFileSync(USERS_FILE, JSON.stringify({ chatIds: ids }, null, 2));
  }
}
async function notifyAll(text, extra = {}) {
  for (const id of getUsers()) {
    await bot.telegram.sendMessage(id, text, extra).catch(e => console.error('[producer] notify error:', e.message));
  }
}

function getState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function setState(patch) {
  fs.writeFileSync(STATE_FILE, JSON.stringify({ ...getState(), ...patch }, null, 2));
}

// ── Генерация дневного набора ────────────────────────────────────────────────
function todayRubric() {
  const key = brand.rubricByWeekday[new Date().getUTCDay()] || 'pain_tip';
  return brand.rubrics.find(r => r.key === key) || brand.rubrics[0];
}

function buildScriptPrompt(rubric, customTopic, feedback) {
  return `Ты — продюсер коротких видео для Instagram-аккаунтов бренда "${brand.name}" (${brand.site}).

ПРОДУКТ: ${brand.product}
АУДИТОРИЯ: ${brand.audience}
ГОЛОС БРЕНДА:\n${brand.voice.map(v => '- ' + v).join('\n')}
ЗАПРЕЩЕНО:\n${brand.forbidden.map(v => '- ' + v).join('\n')}
ВИЗУАЛЬНЫЙ СТИЛЬ: ${brand.visualStyle}

ЗАДАЧА: сценарий одного Story Reel (7 кадров по 2.5 сек) в рубрике «${rubric.title}»: ${rubric.desc}
${customTopic ? `\nТЕМА ЗАДАНА ПОЛЬЗОВАТЕЛЕМ: ${customTopic}` : ''}
${feedback ? `\nПРЕДЫДУЩИЙ ВАРИАНТ ОТКЛОНЁН. Комментарий менеджера: ${feedback}\nУчти его полностью.` : ''}

ПРАВИЛА СЦЕНАРИЯ:
- Кадр 1 = хук: боль или острый вопрос, 3-6 слов, останавливает скролл
- Кадры 2-5 = развитие, каждый кадр один шаг вперёд
- Кадр 6 = поворот: доказательство или неожиданный факт
- Кадр 7 = CTA: "${brand.cta.main_ru}" (EN-версия: "${brand.cta.main_en}")
- Текст кадра: 3-7 слов, разговорный, без жаргона
- EN-текст — НЕ перевод, а естественная английская формулировка той же мысли
- Кадры 1→7 читаются как нарастающая история
- Промпт изображения: на английском, конкретная сцена (место, объект, действие), реалистичная фотография, БЕЗ текста в кадре, вертикаль 9:16. Все 7 кадров — единый визуальный мир: одна палитра, прогрессия wide → medium → close-up → финальный открытый

ФОРМАТ ОТВЕТА — строго, без отклонений:
ТЕМА: [одна строка]
КАДР 1
RU: [текст на экране по-русски]
EN: [text on screen in English]
IMG: [image prompt in English]
КАДР 2
... (и так все 7 кадров)
ПОДПИСЬ_RU: [подпись к посту 2-4 предложения + 5 хэштегов, на русском]
ПОДПИСЬ_EN: [caption 2-4 sentences + 5 hashtags, in English]
СТОРИС 1
RU: [текст сторис]
EN: [story text]
IMG: [image prompt]
СТОРИС 2
...
СТОРИС 3
...`;
}

function parseScript(raw) {
  const get = (re) => { const m = raw.match(re); return m ? m[1].trim() : ''; };
  const topic = get(/ТЕМА:\s*(.+)/);

  const frames = [];
  const frameBlocks = raw.split(/КАДР\s+\d+/).slice(1);
  for (const b of frameBlocks.slice(0, 7)) {
    frames.push({
      ru:  (b.match(/RU:\s*(.+)/)  || [])[1]?.trim().replace(/\*+/g, '') || '',
      en:  (b.match(/EN:\s*(.+)/)  || [])[1]?.trim().replace(/\*+/g, '') || '',
      img: (b.match(/IMG:\s*(.+)/) || [])[1]?.trim() || '',
    });
  }

  const captionRu = get(/ПОДПИСЬ_RU:\s*([\s\S]*?)(?=ПОДПИСЬ_EN:)/);
  const captionEn = get(/ПОДПИСЬ_EN:\s*([\s\S]*?)(?=СТОРИС\s+1)/);

  const stories = [];
  const storyBlocks = raw.split(/СТОРИС\s+\d+/).slice(1);
  for (const b of storyBlocks.slice(0, 3)) {
    stories.push({
      ru:  (b.match(/RU:\s*(.+)/)  || [])[1]?.trim().replace(/\*+/g, '') || '',
      en:  (b.match(/EN:\s*(.+)/)  || [])[1]?.trim().replace(/\*+/g, '') || '',
      img: (b.match(/IMG:\s*(.+)/) || [])[1]?.trim() || '',
    });
  }
  return { topic, frames, captionRu, captionEn, stories };
}

function draftPath(id) { return path.join(DRAFTS_DIR, `${id}.json`); }
function loadDraft(id) {
  try { return JSON.parse(fs.readFileSync(draftPath(id), 'utf8')); } catch { return null; }
}
function saveDraft(d) { fs.writeFileSync(draftPath(d.id), JSON.stringify(d, null, 2)); }

async function generateDailySet({ customTopic = null, feedback = null, existingId = null } = {}) {
  const rubric = todayRubric();
  const id = existingId || `${new Date().toISOString().slice(0, 10)}_${Date.now().toString(36)}`;

  await notifyAll(`🤖 Генерирую сценарий дня — рубрика «${rubric.title}»${customTopic ? `, тема: ${customTopic}` : ''}…`);

  let parsed;
  try {
    const raw = await askSonnet(buildScriptPrompt(rubric, customTopic, feedback), { maxTokens: 3500, label: 'producer_script' });
    parsed = parseScript(raw);
    if (parsed.frames.length < 7 || parsed.frames.some(f => !f.ru || !f.en || !f.img)) {
      throw new Error(`неполный сценарий (кадров: ${parsed.frames.length})`);
    }
  } catch (e) {
    await notifyAll(`❌ Ошибка генерации сценария: ${e.message}\nПовтори: /today`);
    return;
  }

  const draft = {
    id, createdAt: new Date().toISOString(),
    rubric: rubric.key, rubricTitle: rubric.title,
    customTopic, ...parsed, status: 'pending_script',
  };
  saveDraft(draft);
  await sendScriptCard(draft);
}

async function sendScriptCard(d) {
  const framesTxt = d.frames.map((f, i) =>
    `${i + 1}. 🇷🇺 ${f.ru}\n    🇬🇧 ${f.en}`).join('\n');
  const storiesTxt = d.stories.map((s, i) =>
    `${i + 1}. 🇷🇺 ${s.ru} / 🇬🇧 ${s.en}`).join('\n');

  await notifyAll(
    `🎬 *Сценарий дня* — ${d.rubricTitle}\n` +
    `📌 Тема: ${d.topic}\n\n` +
    `*Story Reel, 7 кадров:*\n${framesTxt}\n\n` +
    `*Подпись RU:*\n${d.captionRu.slice(0, 400)}\n\n` +
    `*Подпись EN:*\n${d.captionEn.slice(0, 400)}\n\n` +
    `*Сторис (3):*\n${storiesTxt}`,
    { parse_mode: 'Markdown' }
  );
  await notifyAll('Что делаем со сценарием?', {
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Одобрить — делаем визуал', callback_data: `pr_ok_${d.id}` }],
      [{ text: '🔄 Переделать', callback_data: `pr_re_${d.id}` },
       { text: '✏️ С комментарием', callback_data: `pr_cm_${d.id}` }],
    ] },
  });
}

// ── Одобрение сценария → запуск визуала ─────────────────────────────────────
bot.action(/^pr_ok_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const d = loadDraft(ctx.match[1]);
  if (!d) return ctx.reply('⚠️ Черновик не найден');
  if (d.status !== 'pending_script') return ctx.reply(`⚠️ Уже в статусе: ${d.status}`);

  d.status = 'generating_visual';
  saveDraft(d);
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

  try {
    const { default: fetch } = await import('node-fetch');
    const r = await fetch(`${VISUAL_URL}/producer_story_reel`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        jobId: d.id,
        imagePrompts: d.frames.map(f => f.img),
        textsEn: d.frames.map(f => f.en),
        textsRu: d.frames.map(f => f.ru),
      }),
    });
    if (!r.ok) throw new Error(`visual service ${r.status}`);
    await notifyAll('🎨 Сценарий одобрен! Генерирую 7 картинок и собираю два видео (EN + RU). Обычно 10–20 минут — пришлю сюда.');
  } catch (e) {
    d.status = 'pending_script'; saveDraft(d);
    await ctx.reply(`❌ Не удалось запустить визуал: ${e.message}`);
  }
});

bot.action(/^pr_re_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const d = loadDraft(ctx.match[1]);
  if (!d) return ctx.reply('⚠️ Черновик не найден');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  generateDailySet({ customTopic: d.customTopic, feedback: 'вариант не понравился, предложи другой угол и другую тему в этой же рубрике', existingId: null })
    .catch(e => console.error('[producer] regen error:', e.message));
});

const awaitingComment = {}; // chatId → draftId
bot.action(/^pr_cm_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  awaitingComment[ctx.chat.id] = ctx.match[1];
  await ctx.reply('✏️ Напиши комментарий — что изменить (тему, хук, стиль). Переделаю с учётом.');
});

// ── Готовый визуал → карточка публикации ─────────────────────────────────────
async function sendVisualCard(d, done) {
  const slides = (done.slides || []).filter(p => p && fs.existsSync(p));
  if (slides.length) {
    for (const id of getUsers()) {
      await bot.telegram.sendMediaGroup(id,
        slides.slice(0, 10).map(p => ({ type: 'photo', media: { source: fs.readFileSync(p) } }))
      ).catch(e => console.error('[producer] mediaGroup:', e.message));
    }
  }
  for (const [lang, file, acc] of [['🇬🇧 EN', done.videoEn, brand.accounts.en], ['🇷🇺 RU', done.videoRu, brand.accounts.ru]]) {
    if (file && fs.existsSync(file)) {
      for (const id of getUsers()) {
        await bot.telegram.sendVideo(id, { source: fs.readFileSync(file) },
          { caption: `${lang} → @${acc}` }).catch(e => console.error('[producer] video:', e.message));
      }
    }
  }
  await notifyAll(
    `📋 *К публикации сегодня в ${brand.publishTimes.reels} (${brand.publishTimes.timezone})*\n\n` +
    `🇬🇧 @${brand.accounts.en} — видео EN + подпись:\n${d.captionEn}\n\n` +
    `🇷🇺 @${brand.accounts.ru} — видео RU + подпись:\n${d.captionRu}`,
    { parse_mode: 'Markdown' }
  );
  await notifyAll('Публикуем?', {
    reply_markup: { inline_keyboard: [
      [{ text: '✅ Беру в публикацию', callback_data: `pr_pub_${d.id}` }],
      [{ text: '🔄 Пересобрать видео', callback_data: `pr_rv_${d.id}` }],
    ] },
  });
}

bot.action(/^pr_pub_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const d = loadDraft(ctx.match[1]);
  if (d) { d.status = 'approved_publish'; d.approvedAt = new Date().toISOString(); saveDraft(d); }
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply('✅ Отмечено. Публикуй в оба аккаунта — файлы и подписи выше. (Автопубликация через Metricool — Этап 4.)');
});

bot.action(/^pr_rv_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const d = loadDraft(ctx.match[1]);
  if (!d) return ctx.reply('⚠️ Черновик не найден');
  d.status = 'pending_script'; saveDraft(d);
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply('Сценарий возвращён на одобрение — нажми «✅ Одобрить» ещё раз для повторной генерации, либо «Переделать».');
  await sendScriptCard(d);
});

// Опрос готовности визуала (visual.js пишет {id}.visual_done.json)
setInterval(() => {
  try {
    const files = fs.readdirSync(PRODUCER_DIR).filter(f => f.endsWith('.visual_done.json'));
    for (const f of files) {
      const p = path.join(PRODUCER_DIR, f);
      let done;
      try { done = JSON.parse(fs.readFileSync(p, 'utf8')); fs.unlinkSync(p); } catch { continue; }
      const d = loadDraft(done.jobId);
      if (!d) continue;
      if (done.error) {
        d.status = 'pending_script'; saveDraft(d);
        notifyAll(`❌ Ошибка визуала: ${done.error}\nСценарий можно одобрить повторно.`);
        continue;
      }
      d.status = 'visual_ready'; d.visual = done; saveDraft(d);
      sendVisualCard(d, done).catch(e => console.error('[producer] sendVisualCard:', e.message));
    }
  } catch (e) { console.error('[producer] poll error:', e.message); }
}, 10000);

// ── Ежедневный автозапуск ────────────────────────────────────────────────────
setInterval(() => {
  const now = new Date();
  const today = now.toISOString().slice(0, 10);
  if (now.getUTCHours() === DAILY_HOUR_UTC && getState().lastAutoDate !== today) {
    setState({ lastAutoDate: today });
    if (getUsers().length) {
      generateDailySet().catch(e => console.error('[producer] daily error:', e.message));
    }
  }
}, 60000);

// ── Команды ──────────────────────────────────────────────────────────────────
bot.command('start', async (ctx) => {
  addUser(ctx.chat.id);
  await ctx.reply(
    '🎬 Бот-Продюсер Marketing DNA\n\n' +
    `Веду аккаунты: @${brand.accounts.en} (EN) и @${brand.accounts.ru} (RU)\n\n` +
    `Каждое утро (~${8}:00 Рига) пришлю сценарий дня на одобрение.\n\n` +
    'Команды:\n' +
    '/today — сгенерировать сценарий сейчас\n' +
    '/idea <тема> — сценарий на свою тему\n' +
    '/status — что в работе\n\n' +
    'Ваш chatId: ' + ctx.chat.id
  );
});

bot.command('today', (ctx) => {
  ctx.reply('⏳ Пошёл генерировать…');
  generateDailySet().catch(e => console.error('[producer] today error:', e.message));
});

bot.command('idea', (ctx) => {
  const topic = ctx.message.text.replace(/^\/idea\s*/, '').trim();
  if (!topic) return ctx.reply('Напиши тему после команды: /idea как мастеру вести сторис');
  ctx.reply('⏳ Пошёл генерировать на твою тему…');
  generateDailySet({ customTopic: topic }).catch(e => console.error('[producer] idea error:', e.message));
});

bot.command('status', async (ctx) => {
  const drafts = fs.readdirSync(DRAFTS_DIR).filter(f => f.endsWith('.json'))
    .sort().slice(-5)
    .map(f => { try { return JSON.parse(fs.readFileSync(path.join(DRAFTS_DIR, f), 'utf8')); } catch { return null; } })
    .filter(Boolean);
  if (!drafts.length) return ctx.reply('Пока пусто. Запусти /today');
  const labels = {
    pending_script: '📝 ждёт одобрения сценария', generating_visual: '🎨 генерируется визуал',
    visual_ready: '🎬 визуал готов, ждёт публикации', approved_publish: '✅ взят в публикацию',
  };
  await ctx.reply(drafts.map(d =>
    `${d.createdAt.slice(0, 10)} — ${d.topic || d.rubricTitle}\n   ${labels[d.status] || d.status}`).join('\n\n'));
});

// Текст: комментарий к переделке
bot.on('text', async (ctx, next) => {
  const draftId = awaitingComment[ctx.chat.id];
  if (!draftId) return next();
  delete awaitingComment[ctx.chat.id];
  const d = loadDraft(draftId);
  await ctx.reply('⏳ Переделываю с учётом комментария…');
  generateDailySet({ customTopic: d?.customTopic, feedback: ctx.message.text })
    .catch(e => console.error('[producer] comment regen error:', e.message));
});

// ── Запуск (задержка 45с — избегаем 409 при редеплое, Bot4 стартует на 35с) ──
function launchWithRetry(delayMs = 0) {
  setTimeout(() => {
    bot.launch().catch(e => {
      if (e.message?.includes('409')) {
        console.log('[producer] 409 Conflict — повтор через 30 сек');
        launchWithRetry(30000);
      } else {
        console.error('[producer] Ошибка запуска:', e.message);
      }
    });
  }, delayMs);
}
launchWithRetry(45000);
console.log('[producer] Bot5 инициализирован — старт polling через 45 сек');

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
