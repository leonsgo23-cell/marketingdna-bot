require('dotenv').config();
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Telegraf, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const { getSession, resetSession, STEPS } = require('./src/state');
const { saveSession, deleteSession } = require('./src/persistence');

const TRIGGERS_DIR = path.join(os.homedir(), '.marketingdna-client-sessions', 'triggers');
const { transcribeVoice } = require('./src/voice');
const { sendSummaryDocument, buildSummaryText } = require('./src/summary');

const { startOnboarding, handleRegion, handleLinks } = require('./src/steps/block0_onboarding');
const {
  getBot2Data,
  startReturningClientFlow,
  handleReturningChoice,
  handleReturningCompetitors,
  handleReturningAnswer,
  buildReturningProfiles,
} = require('./src/steps/block0_returning');
const { runBlock1, handleBlock1Answer, buildBusinessProfile, askNextQuestion } = require('./src/steps/block1_unpacking');
const { runBlock2, handleBlock2Answer, buildAudienceProfile, askNextBlock2Question } = require('./src/steps/block2_audience');
const { askForCompetitors, handleCompetitorInput, runBlock3 } = require('./src/steps/block3_competitors');
const { runBlock4 } = require('./src/steps/block4_castdev');
const { runBlock5 } = require('./src/steps/block5_semantics');
const { runBlock6 } = require('./src/steps/block6_articles');
const { runBlock7 } = require('./src/steps/block7_scripts');
const { runBlock8 } = require('./src/steps/block8_covers');
const { runBlock9, runBlock9PlanA, runBlock9PlanB } = require('./src/steps/block9_calendar');

const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN, { handlerTimeout: 600000 });

// Блокируем всех кроме Александра
bot.use(async (ctx, next) => {
  if (ctx.chat && String(ctx.chat.id) !== String(ADMIN_CHAT_ID)) {
    await ctx.reply('⛔ Этот бот предназначен только для внутреннего использования.');
    return;
  }
  return next();
});

// /client <chatId> — запуск анализа для конкретного клиента
bot.command('client', async (ctx) => {
  const parts = ctx.message.text.trim().split(/\s+/);
  const targetId = parts[1];
  if (!targetId) {
    await ctx.reply('Укажи chatId клиента:\n/client 123456789\n\nChatId приходит в уведомлении от Бота №2 при завершении опроса клиентом.');
    return;
  }
  const chatId = ctx.chat.id;
  deleteSession(chatId);
  resetSession(chatId);
  const session = getSession(chatId);
  session.targetClientId = targetId;

  const bot2Data = getBot2Data(targetId);
  if (bot2Data) {
    await ctx.reply(`✅ Найдены данные клиента\nChatId: ${targetId}\nИмя: ${bot2Data.name || '—'}\nОписание: ${(bot2Data.description || '').slice(0, 200)}`);
    await startReturningClientFlow(ctx, session, bot2Data);
  } else {
    await ctx.reply(`⚠️ Данные от Бота №2 для chatId ${targetId} не найдены.\n\nЗапускаю стандартный опрос.`);
    await startOnboarding(ctx, session);
  }
  saveSession(chatId, session);
});

bot.command('start', async (ctx) => {
  const chatId = ctx.chat.id;
  deleteSession(chatId);
  resetSession(chatId);
  const session = getSession(chatId);

  await ctx.reply(
    '🧬 *Marketing DNA — внутренний бот*\n\n' +
    'Команды:\n' +
    '/client <chatId> — запустить анализ для клиента\n' +
    '/restart — начать новый анализ\n' +
    '/status — прогресс текущего анализа\n' +
    '/resume — продолжить с места остановки',
    { parse_mode: 'Markdown' }
  );
  saveSession(chatId, session);
});

bot.command('restart', async (ctx) => {
  const chatId = ctx.chat.id;
  deleteSession(chatId);
  resetSession(chatId);
  const session = getSession(chatId);
  await ctx.reply('🔄 Начинаем заново!');
  await startOnboarding(ctx, session);
});

bot.command('resume', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = getSession(chatId);

  const stepNames = {
    [STEPS.ONBOARDING]: 'Выбор региона',
    [STEPS.COLLECTING_LINKS]: 'Добавление ссылок',
    [STEPS.BLOCK1_ANSWERS]: `Шаг 1: распаковка бизнеса (вопрос ${session.questionIndex + 1})`,
    [STEPS.BLOCK2_ANSWERS]: `Шаг 2: целевая аудитория (вопрос ${session.questionIndex + 1})`,
    [STEPS.BLOCK3_INPUT]: 'Шаг 3: конкуренты',
    [STEPS.BLOCK3_COMPETITORS]: 'Шаг 3: анализ конкурентов (в процессе)',
    [STEPS.BLOCK4_CASTDEV]: 'Шаг 4: кастдев',
    [STEPS.BLOCK5_SEMANTICS]: 'Шаг 5: семантическое ядро',
    [STEPS.BLOCK6_HEADLINES]: 'Шаг 6: статьи для сайта',
    [STEPS.BLOCK7_ARTICLES]: 'Шаг 7: сценарии',
    [STEPS.BLOCK8_SCRIPTS]: 'Шаг 8: обложки',
    [STEPS.BLOCK9_CALENDAR]: 'Шаг 9: контент-план (объяснение)',
    [STEPS.BLOCK9_PLAN_A]: 'Шаг 9: контент-план А (в процессе)',
    [STEPS.BLOCK9_PLAN_B]: 'Шаг 9: контент-план Б (в процессе)',
    [STEPS.DONE]: 'Всё готово',
  };

  const currentStep = stepNames[session.step] || session.step;
  await ctx.reply(
    `📍 Твой прогресс сохранён.\nТекущий шаг: *${currentStep}*\n\nПросто напиши что-нибудь — продолжим с того места.`,
    { parse_mode: 'Markdown' }
  );

  if (session.step === STEPS.BLOCK1_ANSWERS && session.block1Questions) {
    await askNextQuestion(ctx, session);
  } else if (session.step === STEPS.BLOCK2_ANSWERS && session.block2Questions) {
    await askNextBlock2Question(ctx, session);
  } else if (session.step === STEPS.BLOCK3_INPUT) {
    await ctx.reply('Добавь конкурентов (название + ссылка) или напиши *не знаю*', { parse_mode: 'Markdown' });
  }
});

bot.command('status', async (ctx) => {
  const session = getSession(ctx.chat.id);
  const steps = [
    [STEPS.ONBOARDING, '⬜ Регион'],
    [STEPS.COLLECTING_LINKS, '⬜ Ссылки'],
    [STEPS.BLOCK1_ANSWERS, '⬜ Шаг 1: Распаковка бизнеса'],
    [STEPS.BLOCK2_ANSWERS, '⬜ Шаг 2: Целевая аудитория'],
    [STEPS.BLOCK3_INPUT, '⬜ Шаг 3: Конкуренты'],
    [STEPS.BLOCK4_CASTDEV, '⬜ Шаг 4: Кастдев'],
    [STEPS.BLOCK5_SEMANTICS, '⬜ Шаг 5: Семантическое ядро'],
    [STEPS.BLOCK6_HEADLINES, '⬜ Шаг 6: Статьи для сайта'],
    [STEPS.BLOCK7_ARTICLES, '⬜ Шаг 7: Сценарии'],
    [STEPS.BLOCK8_SCRIPTS, '⬜ Шаг 8: Обложки'],
    [STEPS.BLOCK9_PLAN_A, '⬜ Шаг 9: Контент-план А'],
    [STEPS.BLOCK9_PLAN_B, '⬜ Шаг 9: Контент-план Б'],
    [STEPS.DONE, '✅ Готово'],
  ];
  const currentIndex = steps.findIndex(([stepKey]) => stepKey === session.step);
  const list = steps.map(([, name], i) => {
    if (i < currentIndex) return name.replace('⬜', '✅');
    if (i === currentIndex) return name.replace('⬜', '▶️');
    return name;
  }).join('\n');
  await ctx.reply(`*Прогресс Marketing DNA:*\n\n${list}`, { parse_mode: 'Markdown' });
});

// Голосовые сообщения — транскрипция через Groq Whisper
bot.on(message('voice'), async (ctx) => {
  if (!process.env.GROQ_API_KEY) {
    await ctx.reply('🎤 Голосовые сообщения пока не поддерживаются.\n\nНапиши ответ текстом или используй /resume чтобы повторить вопрос.');
    return;
  }

  const chatId = ctx.chat.id;
  const session = getSession(chatId);
  await ctx.reply('🎤 Слушаю... распознаю голос.');

  try {
    const fileId = ctx.message.voice.file_id;
    const text = await transcribeVoice(bot, fileId);

    if (!text || text.length < 2) {
      await ctx.reply('Не удалось распознать голос. Попробуй ещё раз или напиши текстом.');
      return;
    }

    await ctx.reply(`📝 Распознано:\n_"${text}"_`, { parse_mode: 'Markdown' });
    await processTextMessage(ctx, chatId, session, text);
  } catch (err) {
    console.error('Ошибка транскрипции:', err.message);
    await ctx.reply('Не удалось распознать голос. Попробуй ещё раз или напиши текстом.');
  }
});

bot.on(message('text'), async (ctx) => {
  const chatId = ctx.chat.id;
  const session = getSession(chatId);
  const text = ctx.message.text;
  if (text.startsWith('/')) return;
  await processTextMessage(ctx, chatId, session, text);
});

async function processTextMessage(ctx, chatId, session, text) {
  try {
    switch (session.step) {

      case STEPS.RETURNING_CHOICE: {
        const choice = await handleReturningChoice(ctx, session, text);
        if (choice === 'restart') {
          await startOnboarding(ctx, session);
        }
        saveSession(chatId, session);
        break;
      }

      case STEPS.RETURNING_COMPETITORS: {
        await handleReturningCompetitors(ctx, session, text);
        saveSession(chatId, session);
        break;
      }

      case STEPS.RETURNING_QUESTIONS: {
        const done = await handleReturningAnswer(ctx, session, text);
        if (done) {
          await ctx.reply('⏳ Строю профиль бизнеса и аудитории на основе всех данных...');
          await buildReturningProfiles(session);
          saveSession(chatId, session);
          await runBlock3(ctx, session);
          saveSession(chatId, session);
        } else {
          saveSession(chatId, session);
        }
        break;
      }

      case STEPS.ONBOARDING:
        await handleRegion(ctx, session, text);
        break;

      case STEPS.COLLECTING_LINKS: {
        const done = await handleLinks(ctx, session, text);
        if (done) await runBlock1(ctx, session);
        break;
      }

      case STEPS.BLOCK1_ANSWERS: {
        const done = await handleBlock1Answer(ctx, session, text);
        if (done) {
          await ctx.reply('⏳ Обрабатываю ответы и строю профиль бизнеса...');
          await buildBusinessProfile(session);
          saveSession(chatId, session);
          await runBlock2(ctx, session);
        }
        break;
      }

      case STEPS.BLOCK2_ANSWERS: {
        const done = await handleBlock2Answer(ctx, session, text);
        if (done) {
          await ctx.reply('⏳ Строю портреты аудитории...');
          await buildAudienceProfile(session);
          await ctx.reply('✅ Целевая аудитория собрана! Переходим к конкурентам...');
          saveSession(chatId, session);
          await askForCompetitors(ctx, session);
        }
        break;
      }

      case STEPS.BLOCK3_INPUT: {
        const done = await handleCompetitorInput(ctx, session, text);
        if (done) {
          await runBlock3(ctx, session);
          saveSession(chatId, session);
        }
        break;
      }

      case STEPS.BLOCK3_COMPETITORS:
        if (session.competitors) {
          session.step = STEPS.BLOCK4_CASTDEV;
          saveSession(chatId, session);
          await runBlock4(ctx, session);
          saveSession(chatId, session);
        } else {
          await runBlock3(ctx, session);
          saveSession(chatId, session);
        }
        break;

      case STEPS.BLOCK4_CASTDEV:
        await runBlock4(ctx, session);
        saveSession(chatId, session);
        break;

      case STEPS.BLOCK5_SEMANTICS:
        await runBlock5(ctx, session);
        saveSession(chatId, session);
        break;

      case STEPS.BLOCK6_HEADLINES:
        await runBlock6(ctx, session);
        saveSession(chatId, session);
        break;

      case STEPS.BLOCK7_ARTICLES:
        await runBlock7(ctx, session);
        saveSession(chatId, session);
        break;

      case STEPS.BLOCK8_SCRIPTS:
        await runBlock8(ctx, session);
        saveSession(chatId, session);
        break;

      case STEPS.BLOCK9_CALENDAR:
        await runBlock9(ctx, session);
        saveSession(chatId, session);
        break;

      case STEPS.BLOCK9_PLAN_A:
        await runBlock9PlanA(ctx, session);
        saveSession(chatId, session);
        break;

      case STEPS.BLOCK9_PLAN_B:
        await runBlock9PlanB(ctx, session);
        saveSession(chatId, session);
        await sendFinalSummary(ctx, session);
        break;

      case STEPS.DONE:
        await ctx.reply('✅ Контент-пакет уже готов!\n\nНапиши /restart чтобы сделать анализ для другого бизнеса.');
        break;

      default:
        await ctx.reply('Что-то пошло не так. Напиши /resume чтобы продолжить или /restart чтобы начать заново.');
    }
  } catch (err) {
    console.error('Ошибка в шаге', session.step, err);
    saveSession(chatId, session);
    await ctx.reply(
      '⚠️ Что-то пошло не так на этом шаге.\n\n' +
      '✅ Твой прогресс сохранён — ничего не потеряно.\n\n' +
      'Напиши /resume чтобы продолжить с того же места, или /restart чтобы начать заново.'
    );
  }
}

async function sendFinalSummary(ctx, session) {
  await ctx.reply(
    '🧬 *Marketing DNA — пакет готов!*\n\n' +
    '✅ Семантическое ядро (слова / словосочетания / заголовки)\n' +
    '✅ 5 статей для сайта (SEO + GEO оптимизация)\n' +
    '✅ 8 видеосценариев с хуками (Reels / Shorts / TikTok)\n' +
    '✅ 5 сценариев каруселей\n' +
    '✅ 5 фото-концепций\n' +
    '✅ ТЗ на обложки (для Canva / Midjourney)\n' +
    '✅ Контент-план А — привлечение и прогрев (30 дней)\n' +
    '✅ Контент-план Б — активация и продажи (30 дней)\n\n' +
    `📍 Регион: ${session.regionLabel}\n\n` +
    '📄 Отправляю сводный документ...',
    { parse_mode: 'Markdown' }
  );
  await sendSummaryDocument(ctx, session);

  if (session.targetClientId) {
    await ctx.reply(
      `✅ Проверьте документ выше.\n\nОтправить результат клиенту (chatId: ${session.targetClientId})?`,
      Markup.inlineKeyboard([
        [Markup.button.callback('📤 Отправить клиенту', `send_client_${session.targetClientId}`)],
        [Markup.button.callback('⏸ Не отправлять', 'send_cancel')],
      ])
    );
  }
}

// Отправка результата клиенту через Бот №2
bot.action(/^send_client_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const clientChatId = ctx.match[1];
  const session = getSession(ctx.chat.id);

  try {
    const bot2 = new Telegraf(process.env.TELEGRAM_BOT2_TOKEN);
    const summaryText = buildSummaryText(session);

    await bot2.telegram.sendMessage(
      clientChatId,
      '🎉 *Ваш контент-пакет Marketing DNA готов!*\n\nАлександр проверил и подтвердил результат. Отправляю документ...',
      { parse_mode: 'Markdown' }
    );

    // Отправляем документ по частям (Telegram лимит 4096 символов)
    const LIMIT = 4000;
    for (let i = 0; i < summaryText.length; i += LIMIT) {
      await bot2.telegram.sendMessage(clientChatId, summaryText.slice(i, i + LIMIT));
    }

    await ctx.reply(`✅ Документ отправлен клиенту (chatId: ${clientChatId})`);
  } catch (err) {
    console.error('Ошибка отправки клиенту:', err.message);
    await ctx.reply(`⚠️ Не удалось отправить клиенту: ${err.message}`);
  }
});

bot.action('send_cancel', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.reply('Понял. Документ клиенту не отправлен.');
});

// ─── АВТО-ТРИГГЕР ОТ БОТ №2 ──────────────────────────────────────────────────

async function checkTriggers() {
  try {
    if (!fs.existsSync(TRIGGERS_DIR)) return;
    const files = fs.readdirSync(TRIGGERS_DIR).filter(f => f.endsWith('.trigger'));
    for (const file of files) {
      const triggerPath = path.join(TRIGGERS_DIR, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(triggerPath, 'utf8'));
        fs.unlinkSync(triggerPath);
      } catch {
        continue;
      }

      const clientChatId = data.chatId;
      deleteSession(ADMIN_CHAT_ID);
      resetSession(ADMIN_CHAT_ID);
      const session = getSession(ADMIN_CHAT_ID);
      session.targetClientId = clientChatId;

      const fakeCtx = {
        chat: { id: ADMIN_CHAT_ID },
        reply: (text, opts) => bot.telegram.sendMessage(ADMIN_CHAT_ID, text, opts || {}),
        replyWithDocument: (doc, opts) => bot.telegram.sendDocument(ADMIN_CHAT_ID, doc, opts || {}),
      };

      try {
        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `🔔 *Новый клиент завершил опрос!*\n\nИмя: ${data.name || '—'}\nChatId: \`${clientChatId}\`\n\nЗапускаю анализ...`,
          { parse_mode: 'Markdown' }
        );
        const bot2Data = getBot2Data(clientChatId);
        if (bot2Data) {
          await startReturningClientFlow(fakeCtx, session, bot2Data);
        } else {
          await startOnboarding(fakeCtx, session);
        }
        saveSession(ADMIN_CHAT_ID, session);
      } catch (e) {
        console.error('Auto-trigger flow error:', e.message);
        await bot.telegram.sendMessage(ADMIN_CHAT_ID, `⚠️ Ошибка авто-запуска для chatId ${clientChatId}: ${e.message}`).catch(() => {});
      }
    }
  } catch (e) {
    console.error('checkTriggers error:', e.message);
  }
}

setInterval(checkTriggers, 10000);

bot.launch();
console.log('🧬 Marketing DNA бот запущен');

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (бот продолжает работу):', err.message);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (бот продолжает работу):', err?.message || err);
});
