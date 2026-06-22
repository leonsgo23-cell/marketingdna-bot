require('dotenv').config();
const { Telegraf } = require('telegraf');
const fs   = require('fs');
const path = require('path');
const os   = require('os');

const BOT4_TOKEN = process.env.TELEGRAM_BOT4_TOKEN;
if (!BOT4_TOKEN) { console.error('TELEGRAM_BOT4_TOKEN не задан'); process.exit(1); }

const BASE_DIR      = path.join(os.homedir(), '.marketingdna-client-sessions');
const RESULTS_DIR   = path.join(BASE_DIR, 'visual_results');
const TRIGGERS_DIR  = path.join(BASE_DIR, 'triggers');
const MANAGER_FILE  = path.join(BASE_DIR, 'bot4_manager.json');
const VISUAL_BASE_URL = (process.env.VISUAL_BASE_URL || '').replace(/\/$/, '');

const bot = new Telegraf(BOT4_TOKEN, { handlerTimeout: 300000 });

// Сохранённый chatId менеджера
function getManagerChatId() {
  const fromEnv = process.env.BOT4_MANAGER_CHAT_ID;
  if (fromEnv) return fromEnv;
  try {
    if (fs.existsSync(MANAGER_FILE)) return JSON.parse(fs.readFileSync(MANAGER_FILE, 'utf8')).chatId;
  } catch {}
  return null;
}

// ── /start — менеджер регистрируется ─────────────────────────────────────────
bot.command('start', async (ctx) => {
  const chatId = ctx.chat.id;
  fs.writeFileSync(MANAGER_FILE, JSON.stringify({ chatId, registeredAt: new Date().toISOString() }));
  await ctx.reply(
    '✅ Bot4 активирован!\n\n' +
    'Сюда будут приходить финальные пакеты для проверки перед отправкой клиентам.\n\n' +
    'Ваш chatId: ' + chatId
  );
  console.log('[bot4] Менеджер зарегистрирован:', chatId);
});

// ── Финальная кнопка "Отправить клиенту" ─────────────────────────────────────
bot.action(/^final_send_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const clientChatId = ctx.match[1];

  // Обновляем HTML-страницу финальными изображениями перед доставкой
  try {
    const { updatePackPagePhoto, updatePackPageCover, updatePackPageCarousel } = require('./src/site_builder');
    const rp = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
    if (fs.existsSync(rp)) {
      const d = JSON.parse(fs.readFileSync(rp, 'utf8'));
      const r = d.results || {};
      if (r.photosLocalPaths?.[0]        && fs.existsSync(r.photosLocalPaths[0]))        updatePackPagePhoto(clientChatId, r.photosLocalPaths[0]);
      if (r.coversLocalPaths?.[0]        && fs.existsSync(r.coversLocalPaths[0]))        updatePackPageCover(clientChatId, r.coversLocalPaths[0]);
      if (r.carouselSlidesLocalPaths?.length) updatePackPageCarousel(clientChatId, r.carouselSlidesLocalPaths);
    }
  } catch (e) {
    console.error('[bot4] HTML update error:', e.message);
  }

  // Пишем approved.trigger — index.js доставит клиенту
  fs.writeFileSync(
    path.join(TRIGGERS_DIR, `${clientChatId}.approved.trigger`),
    JSON.stringify({ clientChatId, approvedAt: Date.now() }, null, 2)
  );

  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply(`✅ Отправлено! Клиент ${clientChatId} получает пакет прямо сейчас.`);
});

bot.action(/^final_hold_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Отложено');
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply('⏸ Отложено. Нажмите "📤 Отправить" в этом сообщении когда будете готовы.');
});

// ── Отправка финального пакета менеджеру ─────────────────────────────────────
async function sendFinalPackage(clientChatId, clientName, packageKey, managerChatId) {
  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  const snapPath   = path.join(BASE_DIR, `${clientChatId}.text_snapshot.json`);

  if (!fs.existsSync(resultPath)) {
    await bot.telegram.sendMessage(managerChatId, `⚠️ results.json для ${clientChatId} не найден — визуал ещё не готов?`);
    return;
  }

  const data    = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const snap    = fs.existsSync(snapPath) ? JSON.parse(fs.readFileSync(snapPath, 'utf8')) : {};
  const results = data.results || {};
  const isProfi    = (packageKey || '').includes('pkg_v');
  const isStandard = (packageKey || '').includes('pkg_standard');
  const htmlUrl    = VISUAL_BASE_URL ? `${VISUAL_BASE_URL}/pack/${clientChatId}` : null;
  const tariff     = isProfi ? 'Профи €350' : isStandard ? 'Стандарт €250' : 'Старт €150';

  const send = async (method, ...args) => {
    try { await bot.telegram[method](managerChatId, ...args); }
    catch (e) { console.error(`[bot4] ${method} error:`, e.message); }
  };

  // 1. Заголовок
  let header = `📦 *${clientName || clientChatId}* — ${tariff}\n📋 ChatId: \`${clientChatId}\``;
  if (htmlUrl) header += `\n\n📄 [Открыть документ клиента](${htmlUrl})`;
  header += `\n\n👇 Проверьте все материалы ниже и нажмите Отправить.`;
  await send('sendMessage', header, { parse_mode: 'Markdown', disable_web_page_preview: false });

  // 2. Карусель
  const carPaths = (results.carouselSlidesLocalPaths || []).filter(p => p && fs.existsSync(p));
  if (carPaths.length) {
    await send('sendMessage', `🎠 Карусель — ${carPaths.length} слайдов:`);
    for (let i = 0; i < carPaths.length; i += 10) {
      const batch = carPaths.slice(i, i + 10);
      await bot.telegram.sendMediaGroup(managerChatId,
        batch.map(p => ({ type: 'photo', media: { source: fs.readFileSync(p) } }))
      ).catch(async () => {
        for (const p of batch) await send('sendPhoto', { source: fs.readFileSync(p) });
      });
    }
  }

  // 3. Фото-посты
  const photoPaths = (results.photosLocalPaths || []).filter(p => p && fs.existsSync(p));
  if (photoPaths.length) {
    await send('sendMessage', `📸 Фото-посты — ${photoPaths.length} шт:`);
    for (const p of photoPaths) await send('sendPhoto', { source: fs.readFileSync(p) });
  }

  // 4. Stories
  const storyPaths = (results.storiesLocalPaths || []).filter(p => p && fs.existsSync(p));
  if (storyPaths.length) {
    await send('sendMessage', `📱 Stories — ${storyPaths.length} шт:`);
    for (const p of storyPaths) await send('sendPhoto', { source: fs.readFileSync(p) });
  }

  // 5. Обложки (Стандарт / Профи)
  if (isProfi || isStandard) {
    const coverPaths = (results.coversLocalPaths || []).filter(p => p && fs.existsSync(p));
    if (coverPaths.length) {
      await send('sendMessage', `🖼 Обложки Reels — ${coverPaths.length} шт:`);
      for (const p of coverPaths) await send('sendPhoto', { source: fs.readFileSync(p) });
    }
  }

  // 6. Видео
  const videoData   = results.videoData || [];
  const validVideos = videoData.filter(v => v?.localPath && fs.existsSync(v.localPath));
  if (validVideos.length) {
    await send('sendMessage', `🎬 Видео — ${validVideos.length} шт:`);
    for (const v of validVideos) {
      await bot.telegram.sendVideo(managerChatId, { source: fs.readFileSync(v.localPath) }).catch(async () => {
        await send('sendDocument', { source: fs.readFileSync(v.localPath), filename: 'video.mp4' });
      });
    }
  }

  // 7. Контент-план (фрагмент)
  const calText = snap.calendar || '';
  if (calText) {
    const snippet = calText.slice(0, 900);
    await send('sendMessage', `📅 Контент-план:\n\n${snippet}${calText.length > 900 ? '\n...' : ''}`);
  }

  // 8. Кнопка финальной отправки
  await bot.telegram.sendMessage(
    managerChatId,
    `✅ Всё проверено? Нажмите кнопку:`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: `📤 Отправить ${clientName || clientChatId}`, callback_data: `final_send_${clientChatId}` }],
          [{ text: '⏸ Отложить',                                 callback_data: `final_hold_${clientChatId}` }],
        ],
      },
    }
  );

  console.log(`[bot4] Пакет ${clientName} (${clientChatId}) отправлен менеджеру`);
}

// ── Polling trigger-файлов от Bot3 ───────────────────────────────────────────
async function checkBot4Triggers() {
  try {
    if (!fs.existsSync(TRIGGERS_DIR)) return;
    const files = fs.readdirSync(TRIGGERS_DIR).filter(f => f.endsWith('.bot4_review.trigger'));
    for (const file of files) {
      const triggerPath = path.join(TRIGGERS_DIR, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(triggerPath, 'utf8'));
        fs.unlinkSync(triggerPath);
      } catch { continue; }

      const managerChatId = getManagerChatId();
      if (!managerChatId) {
        console.error('[bot4] Менеджер не зарегистрирован — напишите /start в Bot4');
        // Алерт в Bot3 чтобы менеджер знал
        try {
          const { default: fetch } = await import('node-fetch');
          const bot3Token  = process.env.TELEGRAM_BOT3_TOKEN;
          const bot3ChatId = process.env.BOT3_MANAGER_CHAT_ID;
          if (bot3Token && bot3ChatId) {
            await fetch(`https://api.telegram.org/bot${bot3Token}/sendMessage`, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                chat_id: bot3ChatId,
                text: `⚠️ Bot4 не может доставить финальный пакет для клиента ${data.clientChatId} (${data.clientName || '—'})\n\nПричина: менеджер не зарегистрирован в Bot4.\n\nНапишите /start в Bot4 чтобы активировать его.`,
              }),
            });
          }
        } catch {}
        continue;
      }

      sendFinalPackage(data.clientChatId, data.clientName, data.packageKey, managerChatId)
        .catch(e => console.error('[bot4] sendFinalPackage error:', e.message));
    }
  } catch (e) {
    console.error('[bot4] checkBot4Triggers error:', e.message);
  }
}

setInterval(checkBot4Triggers, 5000);

// Запуск с задержкой 35 сек — даём Telegram время освободить старое соединение
// (polling-соединение с предыдущего деплоя может жить до 30 сек)
function launchWithRetry(delayMs = 0) {
  setTimeout(() => {
    bot.launch().catch(e => {
      if (e.message?.includes('409')) {
        console.log('[bot4] 409 Conflict — старый экземпляр ещё активен, повтор через 30 сек');
        launchWithRetry(30000);
      } else {
        console.error('[bot4] Ошибка запуска:', e.message);
      }
    });
  }, delayMs);
}

launchWithRetry(35000);
console.log('[bot4] Bot4 инициализирован — старт polling через 35 сек');

process.once('SIGINT',  () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
