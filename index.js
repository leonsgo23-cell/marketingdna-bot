require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { Telegraf, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const { getSession, resetSession, STEPS } = require('./src/state');
const { saveSession, deleteSession } = require('./src/persistence');

const TRIGGERS_DIR = path.join(os.homedir(), '.marketingdna-client-sessions', 'triggers');
const CLIENT_SESSIONS_DIR = path.join(os.homedir(), '.marketingdna-client-sessions');
const { transcribeVoice } = require('./src/voice');
const { generateFreePackage, buildSalesOffer } = require('./src/steps/block_free_package');
const { crmLog } = require('./src/crm');
const { buildAndDeploy, buildFreePackJson, buildPaidPackJson } = require('./src/site_builder');
const { sendSummaryDocument, buildClientSummaryText } = require('./src/summary');
const { VIZITKA_QUESTIONS, EXPERT_QUESTIONS } = require('./src/website_questions');
const { isNonRussian, adminBlock } = require('./src/lang');
const { LANG_NAMES: LANG_NAMES_MAP } = require('./src/languages');

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

const ADMIN_CHAT_ID = (process.env.ADMIN_CHAT_ID || '').trim();
const bot = new Telegraf(process.env.TELEGRAM_BOT_TOKEN, { handlerTimeout: 600000 });

// Блокируем всех кроме Александра
bot.use(async (ctx, next) => {
  const chatId = ctx.chat?.id;
  const fromId = ctx.from?.id;
  const isAdmin = String(chatId) === String(ADMIN_CHAT_ID) || String(fromId) === String(ADMIN_CHAT_ID);
  if (!isAdmin) {
    console.warn(`[middleware] blocked: chatId=${chatId}, fromId=${fromId}, ADMIN_CHAT_ID=${ADMIN_CHAT_ID}`);
    if (ctx.chat) await ctx.reply('⛔ Этот бот предназначен только для внутреннего использования.');
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

    if (bot2Data.paidPackageKey) {
      // Тариф уже известен из клиентской сессии
      session.paidPackageKey = bot2Data.paidPackageKey;
      await startReturningClientFlow(ctx, session, bot2Data);
    } else {
      // Тариф не определён — спрашиваем
      await ctx.reply(
        `Выбери тариф для ${bot2Data.name || targetId}:`,
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔥 Тариф Старт (€150)', callback_data: `tariff_a_${targetId}` }],
              [{ text: '⭐ Тариф Стандарт (€250)', callback_data: `tariff_s_${targetId}` }],
              [{ text: '✨ Тариф Профи (€350)', callback_data: `tariff_v_${targetId}` }],
            ]
          }
        }
      );
    }
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
          await ctx.reply('✅ Целевая аудитория собрана! Переходим к кастдеву...');
          saveSession(chatId, session);
          await runBlock4(ctx, session);
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
          session.step = STEPS.BLOCK6_HEADLINES;
          saveSession(chatId, session);
          await runBlock6(ctx, session);
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
        // После семантики — переходим к конкурентам (новый порядок)
        if (session.step === STEPS.BLOCK3_INPUT) {
          await askForCompetitors(ctx, session);
          saveSession(chatId, session);
        }
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
  const isProfi    = (session.paidPackageKey || '').includes('pkg_v');
  const isStandard = (session.paidPackageKey || '').includes('pkg_standard');

  await ctx.reply(
    '🧬 *Marketing DNA — текстовый пакет готов!*\n\n' +
    '✅ Семантическое ядро (слова / словосочетания / заголовки)\n' +
    '✅ 5 статей для сайта (SEO + GEO оптимизация)\n' +
    (isProfi ? '✅ 8 ТЗ для AI-видео B-roll (Kling AI)\n' : isStandard ? '✅ 4 ТЗ для AI-видео B-roll (Kling AI)\n' : '✅ 8 сценариев для видео (подарок)\n') +
    '✅ 8 сценариев каруселей с промптами изображений\n' +
    '✅ 8 фото-концепций с промптами\n' +
    '✅ 15 концепций Stories с промптами\n' +
    '✅ ТЗ на обложки\n' +
    '✅ Контент-план 30 дней\n\n' +
    `📍 Регион: ${session.regionLabel}\n\n` +
    '📄 Отправляю сводный документ...',
    { parse_mode: 'Markdown' }
  );
  await sendSummaryDocument(ctx, session);

  // Сохраняем данные для Visual Service
  if (session.targetClientId) {
    const VISUAL_DIR = path.join(CLIENT_SESSIONS_DIR, 'visual_queue');
    if (!fs.existsSync(VISUAL_DIR)) fs.mkdirSync(VISUAL_DIR, { recursive: true });
    const visualPackage = {
      clientChatId:    session.targetClientId,
      clientName:      session.bot2Data?.name || '—',
      packageKey:      session.paidPackageKey || 'pkg_a',
      contentLanguage: session.contentLanguage || 'ru',
      regionLabel:     session.regionLabel || '',
      businessProfile: session.businessProfile || '',
      audience:        session.audience || '',
      castdev:         session.castdev || '',
      videoScripts:    session.videoScripts || '',
      carouselScripts: session.carouselScripts || '',
      photoScripts:    session.photoScripts || '',
      storiesScripts:  session.storiesScripts || '',
      covers:          session.covers || '',
      contentPlan:     session.contentPlan || '',
      timestamp:       Date.now(),
    };
    fs.writeFileSync(
      path.join(VISUAL_DIR, `${session.targetClientId}.visual.json`),
      JSON.stringify(visualPackage, null, 2)
    );

    // Сохраняем краткое резюме опубликованного контента для аналитики
    const clientSess = loadClientSession(session.targetClientId);
    if (clientSess) {
      const planSnippet = (session.contentPlan || '').slice(0, 1000);
      const videosSnippet = (session.videoScripts || '').slice(0, 500);
      const carouselsSnippet = (session.carouselScripts || '').slice(0, 500);
      clientSess.lastContentSummary = `Контент-план:\n${planSnippet}\n\nВидео:\n${videosSnippet}\n\nКарусели:\n${carouselsSnippet}`;
      saveSession(session.targetClientId, clientSess);
    }
  }

  if (session.targetClientId) {
    const clientSession = loadClientSession(session.targetClientId);
    if (clientSession && clientSession.autoSendApproved) {
      await deliverClientPackage(session.targetClientId, session);
      await ctx.reply(`🤖 Пакет отправлен клиенту автоматически (chatId: ${session.targetClientId}) — активирован авто-код.`);
    } else {
      await ctx.reply(
        `✅ Проверьте документ выше.\n\nДальше: запустить генерацию визуала (фото/видео) для клиента ${session.bot2Data?.name || session.targetClientId}?`,
        Markup.inlineKeyboard([
          [Markup.button.callback('🎨 Запустить генерацию визуала', `run_visual_${session.targetClientId}`)],
          [Markup.button.callback('📤 Отправить только текст', `send_client_${session.targetClientId}`)],
          [Markup.button.callback('⏸ Не отправлять', 'send_cancel')],
        ])
      );
    }
  }
}

// Доставка визуального пакета клиенту после одобрения менеджером
async function deliverVisualPackage(clientChatId) {
  const RESULTS_DIR = path.join(CLIENT_SESSIONS_DIR, 'visual_results');
  const resultPath  = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  if (!fs.existsSync(resultPath)) throw new Error('results.json not found');

  const data    = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const results = data.results;
  const isProfi = data.packageKey.includes('pkg_v') || data.packageKey.includes('pkg_standard');

  // Сначала доставляем текстовые материалы (HTML-страница с контент-планом, статьями, сценариями)
  let textDelivered = false;
  const snapshotPath = path.join(CLIENT_SESSIONS_DIR, `${clientChatId}.text_snapshot.json`);
  if (fs.existsSync(snapshotPath)) {
    try {
      const snapshot = JSON.parse(fs.readFileSync(snapshotPath, 'utf8'));
      await deliverClientPackage(clientChatId, snapshot);
      textDelivered = true;
      fs.unlinkSync(snapshotPath);
    } catch (e) {
      console.error('[deliverVisualPackage] text snapshot delivery error:', e.message);
    }
  }

  if (!textDelivered) {
    await bot2.telegram.sendMessage(clientChatId,
      '🎉 Ваш контент-пакет готов!\n\nОтправляю все материалы прямо сейчас...'
    );
  } else {
    await bot2.telegram.sendMessage(clientChatId, '🎨 А вот ваши AI-изображения и видео:');
  }

  const sendGroup = async (urls, caption) => {
    const valid = (urls || []).filter(Boolean);
    if (!valid.length) return;
    await bot2.telegram.sendMessage(clientChatId, caption);
    for (let i = 0; i < valid.length; i += 10) {
      const group = valid.slice(i, i + 10);
      await bot2.telegram.sendMediaGroup(clientChatId,
        group.map(u => ({ type: 'photo', media: u }))
      ).catch(async () => {
        for (const u of group) await bot2.telegram.sendPhoto(clientChatId, u).catch(() => {});
      });
    }
  };

  await sendGroup(results.photos,        '📸 Фото для постов:');
  await sendGroup(results.carouselSlides,'🎠 Слайды каруселей:');
  await sendGroup(results.stories,       '📱 Stories:');
  if (isProfi) {
    await sendGroup(results.covers,      '🖼 Обложки для видео:');
    const validVideos = (results.videoData || []).map(v => v?.localPath).filter(Boolean);
    if (validVideos.length) {
      await bot2.telegram.sendMessage(clientChatId, '🎬 *Видео B-roll:*', { parse_mode: 'Markdown' });
      for (const p of validVideos) {
        await bot2.telegram.sendVideo(clientChatId, { source: p }).catch(() =>
          bot2.telegram.sendMessage(clientChatId, '🎬 Видео готово — менеджер пришлёт отдельно')
        );
      }
    }
  }

  await bot2.telegram.sendMessage(clientChatId,
    '✅ Все материалы отправлены!\n\nЕсли есть вопросы — напишите здесь.',
    { parse_mode: 'Markdown' }
  );

  // Сохраняем дату доставки контента
  updateClientSession(clientChatId, { contentDeliveredAt: Date.now() });

  // Просим клиента нажать когда начнёт постить
  await new Promise(r => setTimeout(r, 1500));
  await bot2.telegram.sendMessage(clientChatId,
    '📅 *Один важный шаг*\n\n' +
    'Когда опубликуете первый пост из этого пакета — нажмите кнопку ниже.\n\n' +
    'Это нужно чтобы мы знали с какого дня отсчитывать время и вовремя проанализировать ' +
    'как реагирует ваша аудитория — и скорректировать следующий контент.',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '✅ Я опубликовал первый пост', callback_data: 'posting_started' }],
        ],
      },
    }
  );
}

// Запуск Visual Service для генерации фото/видео
bot.action(/^run_visual_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const clientChatId = ctx.match[1];
  const VISUAL_SERVICE_URL = process.env.VISUAL_SERVICE_URL || 'http://localhost:3002';

  // Сохраняем снапшот текстовых данных — deliverVisualPackage доставит их клиенту вместе с визуалом
  try {
    const adminSess = getSession(ctx.chat.id);
    const tariff = adminSess.paidPackageKey || 'pkg_a';
    const snapshotData = {
      targetClientId: clientChatId,
      paidPackageKey: tariff,
      contentGoal: adminSess.contentGoal,
      calendar: adminSess.calendar,
      articles: adminSess.articles,
      competitorsSummary: adminSess.competitorsSummary,
      recs: adminSess.recs,
      videoTips: adminSess.videoTips,
      clientData: adminSess.clientData,
      regionLabel: adminSess.regionLabel,
      videoScripts: adminSess.videoScripts,
      carouselScripts: adminSess.carouselScripts,
      photoScripts: adminSess.photoScripts,
      storiesScripts: adminSess.storiesScripts,
      covers: adminSess.covers,
    };
    const snapshotPath = path.join(CLIENT_SESSIONS_DIR, `${clientChatId}.text_snapshot.json`);
    fs.writeFileSync(snapshotPath, JSON.stringify(snapshotData, null, 2));
  } catch (e) {
    console.error('[run_visual] snapshot save error:', e.message);
  }

  try {
    const fetch = (await import('node-fetch')).default;
    await fetch(`${VISUAL_SERVICE_URL}/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientChatId }),
    });
    await ctx.reply(`🎨 Visual Service запущен для клиента ${clientChatId}.\n\nГенерация займёт 10-20 минут. Менеджер получит материалы в Bot3 на проверку.`);
  } catch (err) {
    console.error('Visual Service error:', err.message);
    await ctx.reply(`⚠️ Не удалось запустить Visual Service: ${err.message}\n\nПроверьте что visual.js запущен на Railway.`);
  }
});

// Отправка результата клиенту через Бот №2
bot.action(/^send_client_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const clientChatId = ctx.match[1];
  const session = getSession(ctx.chat.id);

  try {
    await deliverClientPackage(clientChatId, session);
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

// ─── ВЫБОР ТАРИФА (кнопки из уведомления об активации кода) ──────────────────

bot.action(/^tariff_([avs])_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const pkg = ctx.match[1] === 'v' ? 'pkg_v' : ctx.match[1] === 's' ? 'pkg_standard' : 'pkg_a';
  const targetId = ctx.match[2];
  const chatId = ctx.chat.id;

  deleteSession(chatId);
  resetSession(chatId);
  const session = getSession(chatId);
  session.targetClientId = targetId;
  session.paidPackageKey = pkg;

  const bot2Data = getBot2Data(targetId);
  if (bot2Data) {
    const tariffLabel = pkg === 'pkg_v' ? 'Профи' : pkg === 'pkg_standard' ? 'Стандарт' : 'Старт';
    await ctx.reply(`✅ Тариф ${tariffLabel} выбран. Запускаю анализ для ${bot2Data.name || targetId}...`);
    await startReturningClientFlow(ctx, session, bot2Data);
  } else {
    await ctx.reply(`⚠️ Данные клиента ${targetId} не найдены.`);
    return;
  }
  saveSession(chatId, session);
});

// ─── ЗАПУСК АНАЛИЗА ПЛАТНОГО КЛИЕНТА (кнопка из уведомления) ─────────────────

bot.action(/^run_client_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const targetId = ctx.match[1];
  const chatId = ctx.chat.id;

  deleteSession(chatId);
  resetSession(chatId);
  const session = getSession(chatId);
  session.targetClientId = targetId;

  const bot2Data = getBot2Data(targetId);
  if (bot2Data) {
    // Копируем paidPackageKey из клиентской сессии если есть
    if (bot2Data.paidPackageKey) {
      session.paidPackageKey = bot2Data.paidPackageKey;
    }
    await ctx.reply(`✅ Запускаю анализ для ${bot2Data.name || targetId}...`);
    await startReturningClientFlow(ctx, session, bot2Data);
  } else {
    await ctx.reply(`⚠️ Данные клиента ${targetId} не найдены. Запусти вручную: /client ${targetId}`);
    return;
  }
  saveSession(chatId, session);
});

// ─── ЗАПУСК ГЕНЕРАЦИИ ВТОРОГО ЯЗЫКА (addlang) ────────────────────────────────
bot.action(/^run_addlang_(\d+)_([a-z]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const targetId = ctx.match[1];
  const lang     = ctx.match[2];
  const chatId   = ctx.chat.id;

  deleteSession(chatId);
  resetSession(chatId);
  const session = getSession(chatId);
  session.targetClientId = targetId;
  session.addlangLang = lang;  // язык будет подставлен автоматически вместо вопроса

  const bot2Data = getBot2Data(targetId);
  if (bot2Data) {
    if (bot2Data.paidPackageKey) session.paidPackageKey = bot2Data.paidPackageKey;
    await ctx.reply(`✅ Запускаю генерацию на ${LANG_NAMES_MAP[lang] || lang} для ${bot2Data.name || targetId}.\nВопрос про язык будет пропущен — уже знаю что нужен ${LANG_NAMES_MAP[lang] || lang}.`);
    await startReturningClientFlow(ctx, session, bot2Data);
  } else {
    await ctx.reply(`⚠️ Данные клиента ${targetId} не найдены.`);
    return;
  }
  saveSession(chatId, session);
});

// ─── ОДОБРЕНИЕ БЕСПЛАТНОГО ПАКЕТА ────────────────────────────────────────────

// ─── ДОСТАВКА БЕСПЛАТНОГО ПАКЕТА (вызывается из checkTriggers по .free_approved.trigger) ───
async function deliverFreePackage(clientChatId) {
  const PENDING_DIR = path.join(CLIENT_SESSIONS_DIR, 'pending');
  const pendingFile = path.join(PENDING_DIR, `${clientChatId}.json`);

  if (!fs.existsSync(pendingFile)) {
    await bot3Notify(`⚠️ Pending-файл не найден для chatId ${clientChatId}. Возможно уже был отправлен.`);
    return;
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  } catch (e) {
    await bot3Notify(`⚠️ Ошибка чтения pending-файла: ${e.message}`);
    return;
  }

  try {
    const { contentPlan, seoArticle, videoScript, carouselScript, coverExample, photoExample, isPersonalBrand, siteUrl, clientData } = pkg;

    // Загружаем готовые AI-изображения
    const VISUAL_RESULTS = path.join(CLIENT_SESSIONS_DIR, 'visual_results');

    let freePhotoUrl = null;
    try {
      const p = path.join(VISUAL_RESULTS, `${clientChatId}.free_photo.json`);
      if (fs.existsSync(p)) freePhotoUrl = JSON.parse(fs.readFileSync(p, 'utf8')).url;
    } catch {}

    let carouselUrls = [];
    let coverUrl = null;
    try {
      const p = path.join(VISUAL_RESULTS, `${clientChatId}.free_visuals.json`);
      if (fs.existsSync(p)) {
        const v = JSON.parse(fs.readFileSync(p, 'utf8'));
        carouselUrls = (v.carouselUrls || []).filter(Boolean);
        coverUrl = (v.coverUrls || []).filter(Boolean)[0] || null;
      }
    } catch {}

    if (siteUrl) {
      await sendToClient(clientChatId, `Ваш бесплатный пакет готов! Смотрите все материалы здесь:\n\n${siteUrl}`);
    } else {
      await sendToClient(clientChatId, 'Контент-план на 7 дней:\n\n' + contentPlan);
      await sendToClient(clientChatId, '─────────────────────\nSEO-статья для сайта:\n\n' + seoArticle);
      await sendToClient(clientChatId, '─────────────────────\nСценарий ролика:\n\n' + videoScript);
      await sendToClient(clientChatId, '─────────────────────\nСценарий карусели:\n\n' + carouselScript);
      await sendToClient(clientChatId, '─────────────────────\nПример обложки для видео:\n\n' + coverExample);
      await sendToClient(clientChatId, '─────────────────────\nПример готового поста (AI-изображение + текст):\n\n' + photoExample);
    }

    // Отправляем готовые AI-изображения
    if (carouselUrls.length > 0) {
      await bot2.telegram.sendMessage(clientChatId, '🎠 Ваша карусель — готовые слайды:').catch(() => {});
      for (let i = 0; i < carouselUrls.length; i += 10) {
        const group = carouselUrls.slice(i, i + 10);
        if (group.length > 1) {
          await bot2.telegram.sendMediaGroup(clientChatId, group.map(url => ({ type: 'photo', media: url }))).catch(async () => {
            for (const url of group) await bot2.telegram.sendPhoto(clientChatId, url).catch(() => {});
          });
        } else {
          await bot2.telegram.sendPhoto(clientChatId, group[0]).catch(() => {});
        }
      }
    }

    if (coverUrl) {
      await bot2.telegram.sendPhoto(clientChatId, coverUrl, {
        caption: '🖼 Обложка для вашего видео/Reels'
      }).catch(() => {});
    }

    if (freePhotoUrl) {
      await bot2.telegram.sendPhoto(clientChatId, freePhotoUrl, {
        caption: '📸 Готовый пост — AI-изображение'
      }).catch(() => {});
    }
    // Скидочный оффер 20% — только если клиент ещё не получал скидку
    const clientSession = getBot2Data(clientChatId);
    const alreadyHadDiscount = clientSession?.discountUsed || clientSession?.discountSentAt;
    const discountExpiresAt = Date.now() + 48 * 60 * 60 * 1000;

    if (!alreadyHadDiscount) {
      updateClientSession(clientChatId, {
        discountSentAt: Date.now(),
        discountExpiresAt,
        discountReminders: [],
        isPersonalBrand,
      });

      await new Promise(r => setTimeout(r, 1000));
      await bot2.telegram.sendMessage(
        clientChatId,
        '🎁 В честь нашего знакомства и чтобы вам было легче принять положительное решение о сотрудничестве — мы делаем для вас специальное предложение.\n\n' +
        'Первый месяц со скидкой 20%:\n\n' +
        'Тариф Старт: ~€150~ → *€120/мес*\n' +
        'Тариф Стандарт: ~€250~ → *€200/мес*\n' +
        'Тариф Профи: ~€350~ → *€280/мес*\n\n' +
        'За этот месяц вы убедитесь насколько качественный контент мы готовим, увидите как легко с ним работать — и сколько времени высвобождается у вас и вашей команды. Оценив это на практике, платить полную цену со второго месяца будет уже совсем просто.\n\n' +
        '⏳ Предложение действует 48 часов — после истекает.\n\n' +
        'Выберите тариф:',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔥 Тариф Старт — €120/мес', callback_data: 'pkg_a_discount' }],
              [{ text: '⭐ Тариф Стандарт — €200/мес', callback_data: 'pkg_standard_discount' }],
              [{ text: '✨ Тариф Профи — €280/мес', callback_data: 'pkg_v_discount' }],
            ]
          }
        }
      );
      crmLog(clientChatId, 'discount_offer_shown', { expiresAt: discountExpiresAt });
    } else {
      // Повторное прохождение — полная цена
      await sendToClient(clientChatId, buildSalesOffer(isPersonalBrand));
      await bot2.telegram.sendMessage(clientChatId, 'Выберите тариф:', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔥 Тариф Старт — €150/мес', callback_data: 'pkg_a' }],
            [{ text: '⭐ Тариф Стандарт — €250/мес', callback_data: 'pkg_standard' }],
            [{ text: '✨ Тариф Профи — €350/мес', callback_data: 'pkg_v' }],
          ]
        }
      });
      crmLog(clientChatId, 'offer_shown_full_price', { reason: 'discount_already_used' });
    }

    // Предложение сайта — отдельным сообщением
    await new Promise(r => setTimeout(r, 1500));
    const wantsWebsite = pkg.wantsWebsite || pkg.clientData?.wantsWebsite || false;
    if (wantsWebsite) {
      await bot2.telegram.sendMessage(
        clientChatId,
        '─────────────────────\n\nВы указали что вас интересует и сайт — ответьте на несколько вопросов, это займёт 1 минуту.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🌐 Перейти к вопросам про сайт', callback_data: 'website_upsell' }],
            ]
          }
        }
      );
    } else {
      await bot2.telegram.sendMessage(
        clientChatId,
        '─────────────────────\n\nИ ещё одно.\n\n' +
        'Соцсети разогревают — сайт закрывает сделку. Заинтересованный человек переходит по ссылке и там принимает решение.\n\n' +
        'Мы делаем хорошие сайты быстро и недорого — персонально под ваш бренд и ваш продукт. ' +
        'Визитка от €150 (1–2 дня), сайт эксперта €299 (до 5 дней). Домен ~€10–15/год, помогаем подключить.\n\n' +
        'Если интересно — нажмите кнопку ниже.',
        {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🌐 Да, хочу узнать подробнее', callback_data: 'website_upsell' }],
              [{ text: 'Не сейчас', callback_data: 'website_no' }],
            ]
          }
        }
      );
    }

    updateClientSession(clientChatId, { step: 'done', isPersonalBrand });

    crmLog(clientChatId, 'free_delivered', {
      name: clientData?.name,
      email: clientData?.email,
      business: clientData?.description,
      isPersonalBrand,
    });

    fs.unlinkSync(pendingFile);
    await bot3Notify(`✅ Бесплатный пакет отправлен клиенту (chatId: ${clientChatId})`);
  } catch (e) {
    console.error('Ошибка доставки free пакета:', e.message);
    await bot3Notify(`⚠️ Ошибка доставки клиенту ${clientChatId}: ${e.message}`);
  }
}

bot.action(/^retry_free_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery('Запускаю повтор...');
  const clientChatId = ctx.match[1];
  await retryFreeGeneration(clientChatId, ctx);
});

bot.command('retry_free', async (ctx) => {
  console.log('[retry_free] команда получена от chatId:', ctx.chat?.id, 'fromId:', ctx.from?.id);
  try {
    const clientChatId = ctx.message.text.split(' ')[1];
    if (!clientChatId) return ctx.reply('Укажи chatId: /retry_free 71950950');
    await retryFreeGeneration(clientChatId, ctx);
  } catch (e) {
    console.error('[retry_free] ошибка:', e.message);
    await ctx.reply('❌ Ошибка: ' + e.message).catch(() => {});
  }
});

async function retryFreeGeneration(clientChatId, ctx) {
  const retryPath = path.join(TRIGGERS_DIR, `${clientChatId}.retry.json`);
  console.log('[retry_free] ищу файл:', retryPath, '— существует:', fs.existsSync(retryPath));
  if (!fs.existsSync(retryPath)) {
    return ctx.reply(`❌ Данные клиента ${clientChatId} не найдены. Клиенту нужно пройти анкету заново.`);
  }
  const data = JSON.parse(fs.readFileSync(retryPath, 'utf8'));
  const triggerPath = path.join(TRIGGERS_DIR, `${clientChatId}.trigger`);
  fs.writeFileSync(triggerPath, JSON.stringify(data, null, 2));
  console.log('[retry_free] trigger создан для', clientChatId);
  await ctx.reply(`🔄 Повтор генерации запущен для chatId ${clientChatId}.\nДанные клиента восстановлены из кэша — анкету проходить не нужно.`);
}

// ─── УТИЛИТА: отправить длинный текст клиенту через Bot #2 ───────────────────

const bot2 = new Telegraf(process.env.TELEGRAM_BOT2_TOKEN);

async function sendToClient(clientChatId, text) {
  const LIMIT = 4000;
  for (let i = 0; i < text.length; i += LIMIT) {
    await bot2.telegram.sendMessage(clientChatId, text.slice(i, i + LIMIT));
  }
}


function loadClientSession(clientChatId) {
  const file = path.join(CLIENT_SESSIONS_DIR, `${clientChatId}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

// Отправляет клиентский пакет через Bot #2 (используется и кнопкой и авто-отправкой)
async function deliverClientPackage(clientChatId, session) {
  const tariff = session.paidPackageKey || (session.isPersonalBrand ? 'pkg_a' : 'pkg_v');

  // Пробуем собрать красивую HTML-страницу
  let siteUrl = null;
  try {
    const jsonData = buildPaidPackJson(session, tariff);
    const { url } = await buildAndDeploy(jsonData, 'paid-pack-template.html', `paid-${clientChatId}`);
    siteUrl = url;
  } catch (buildErr) {
    console.error('Paid HTML build error for', clientChatId, buildErr.message);
  }

  if (siteUrl) {
    // Отправляем красивую страницу
    await bot2.telegram.sendMessage(
      clientChatId,
      `🎉 Ваш контент-пакет Marketing DNA готов!\n\n📋 Все материалы на одной странице:\n${siteUrl}`
    );
  } else {
    // Fallback: текст если HTML не сработал
    const summaryText = buildClientSummaryText(session);
    await bot2.telegram.sendMessage(clientChatId, '🎉 Ваш контент-пакет Marketing DNA готов!\n\nОтправляю материалы...');
    const LIMIT = 4000;
    for (let i = 0; i < summaryText.length; i += LIMIT) {
      await bot2.telegram.sendMessage(clientChatId, summaryText.slice(i, i + LIMIT));
    }
  }

  crmLog(clientChatId, 'paid_delivered');

  // После доставки — проверяем есть ли оплаченные доп. языки → запускаем переводы
  const clientSess = loadClientSession(clientChatId);
  const pendingLangs = clientSess?.lupsellPaid || (clientSess?.additionalLanguage ? [clientSess.additionalLanguage] : []);
  for (const lang of pendingLangs) {
    try {
      await runTranslationJob(clientChatId, lang, session);
    } catch (e) {
      console.error(`[translation] Ошибка перевода на ${lang} для ${clientChatId}:`, e.message);
    }
  }
}

// ─── BOT3 ХЕЛПЕРЫ ────────────────────────────────────────────────────────────

async function bot3Notify(text, replyMarkup) {
  const token  = process.env.TELEGRAM_BOT3_TOKEN;
  const chatId = process.env.BOT3_MANAGER_CHAT_ID;
  if (!token || !chatId) return;
  const { default: fetch } = await import('node-fetch');
  const body = { chat_id: chatId, text, parse_mode: 'Markdown' };
  if (replyMarkup) body.reply_markup = JSON.stringify(replyMarkup);
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  }).catch(e => console.error('[bot3Notify] error:', e.message));
}

async function sendFreeReviewToBot3(clientChatId, data, cLang, isPersonalBrand, siteUrl, content) {
  const token  = process.env.TELEGRAM_BOT3_TOKEN;
  const chatId = process.env.BOT3_MANAGER_CHAT_ID;
  if (!token || !chatId) return;

  const { default: fetch } = await import('node-fetch');
  const b3Send = async (text) => {
    const LIMIT = 4000;
    for (let i = 0; i < text.length; i += LIMIT) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text.slice(i, i + LIMIT), parse_mode: 'Markdown' }),
      }).catch(() => {});
    }
  };

  const langNote = isNonRussian(cLang) ? ` · Язык клиента: ${cLang.toUpperCase()}` : '';
  await b3Send(
    `🔔 *Бесплатный пакет — на проверку*\n\n` +
    `Имя: ${data.name || '—'}\nEmail: ${data.email || '—'}\nChatId: ${clientChatId}\n` +
    `Тип: ${isPersonalBrand ? 'Личный бренд' : 'Бизнес'}${langNote}\n\n` +
    `Проверьте материалы ниже:`
  );

  const blocks = [
    ['📅 КОНТЕНТ-ПЛАН 7 ДНЕЙ:', content.contentPlan],
    ['📝 SEO-СТАТЬЯ:', content.seoArticle],
    ['🎬 СЦЕНАРИЙ РОЛИКА:', content.videoScript],
    ['🎠 СЦЕНАРИЙ КАРУСЕЛИ:', content.carouselScript],
    ['🖼 ПРИМЕР ОБЛОЖКИ:', content.coverExample],
    ['📸 ПРИМЕР ФОТО:', content.photoExample],
  ];

  for (const [label, text] of blocks) {
    const block = await adminBlock(label, text, cLang);
    await b3Send(block);
  }

  if (siteUrl) await b3Send(`🌐 Страница для клиента:\n${siteUrl}`);

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: `✅ Проверьте материалы выше${siteUrl ? ' и страницу по ссылке' : ''}.\n\n⏳ *Изображения генерируются* — карусель (5 слайдов), обложка и фото придут отдельными сообщениями в течение 5-10 минут.\n\nОтправить клиенту можно только когда все изображения получены и проверены.\n\nОтправить клиенту *${data.name || clientChatId}*?`,
      parse_mode: 'Markdown',
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [{ text: '📤 Отправить клиенту', callback_data: `send_free_${clientChatId}` }],
          [{ text: '🔄 Перегенерировать',  callback_data: `retry_free_${clientChatId}` }],
        ]
      }),
    }),
  }).catch(() => {});
}

// ─── ПЕРЕВОД ПАКЕТА НА ДОП. ЯЗЫК ─────────────────────────────────────────────
async function generateFreshSeoArticles(session, targetLang, langName) {
  const biz      = (session.businessProfile || '').slice(0, 1500);
  const aud      = (session.audience || '').slice(0, 1000);
  const region   = session.regionLabel || '';
  const semantic = (session.semanticCore || '').slice(0, 1500);
  const gaps     = (session.competitorBrief || '').slice(0, 800);

  // Генерируем 5 свежих SEO-заголовков под целевой язык
  const headlinesRaw = await askSonnet(
    `Ты — SEO-стратег. Сгенерируй 5 заголовков для статей на сайте бизнеса.\n` +
    `Язык: ${langName}. Пиши заголовки ТОЛЬКО на этом языке.\n\n` +
    `Бизнес: ${biz}\nАудитория: ${aud}\nРегион: ${region}\n\n` +
    `Требования к заголовкам:\n` +
    `— Каждый отвечает на реальный вопрос который задают в поиске (Google, ChatGPT, Perplexity)\n` +
    `— Форматы: "Как...", "Почему...", "Что такое...", "Лучший... в [регион]", "[N] способов..."\n` +
    `— Разные темы: проблема клиента / решение / выбор / результат / локальный запрос\n\n` +
    `Верни ТОЛЬКО пронумерованный список из 5 заголовков, без пояснений.`,
    500
  );

  const headlines = headlinesRaw
    .split('\n')
    .map(l => l.replace(/^\d+[\.\)]\s*/, '').trim())
    .filter(Boolean)
    .slice(0, 5);

  const articles = [];
  for (let i = 0; i < headlines.length; i++) {
    const headline = headlines[i];
    const article = await askSonnet(
      `Ты — экспертный SEO + GEO копирайтер. Напиши статью для сайта бизнеса.\n` +
      `Язык: ${langName}. Пиши ТОЛЬКО на этом языке — это оригинальная статья, не перевод.\n\n` +
      `БИЗНЕС: ${biz}\n` +
      `АУДИТОРИЯ: ${aud}\n` +
      `РЕГИОН: ${region}\n` +
      `КЛЮЧЕВЫЕ СЛОВА: ${semantic}\n` +
      `НЕЗАКРЫТЫЕ ТЕМЫ КОНКУРЕНТОВ: ${gaps}\n\n` +
      `ТЕМА СТАТЬИ: ${headline}\n\n` +
      `СТРУКТУРА:\n` +
      `1. Заголовок (H1) — содержит главный поисковый запрос\n` +
      `2. Вступление (2-3 предложения) — ПРЯМОЙ ответ на главный вопрос темы.\n` +
      `   AI-ассистенты (ChatGPT, Perplexity, Claude) берут именно первый абзац как ответ — он должен быть самодостаточным.\n` +
      `3. Основная часть (2-3 раздела) — конкретные факты, цифры, примеры, сроки\n` +
      `4. FAQ-блок (3-4 вопроса) — реальные вопросы из поиска + прямые ответы 1-3 предложения.\n` +
      `   Именно этот блок цитируют ChatGPT / Perplexity когда отвечают на запросы пользователей.\n` +
      `5. Вывод + CTA\n` +
      `6. Мета-описание (150-160 знаков)\n\n` +
      `SEO-ТРЕБОВАНИЯ:\n` +
      `— Ключевые слова из семантического ядра вставлять естественно\n` +
      `— Упоминать регион, нишу, конкретные услуги — для локальных запросов\n` +
      `— Конкретные факты: сроки, цены, результаты, числа — там где применимо\n\n` +
      `GEO-ТРЕБОВАНИЯ (для ChatGPT / Perplexity / Claude):\n` +
      `— Давать ПРЯМЫЕ ответы на конкретные вопросы\n` +
      `— Пиши авторитетно: не "может помочь", а "даёт результат X за Y дней"\n` +
      `— FAQ с явными вопросами и однозначными ответами\n` +
      `— Первый абзац — самодостаточный ответ без необходимости читать дальше\n\n` +
      `ОБЪЁМ: 2000-2500 знаков. Без markdown-форматирования (никаких **, *, #, _).`,
      3000
    );
    articles.push(article);
  }

  return articles.join('\n\n─────────────────────\n\n');
}

async function runTranslationJob(clientChatId, targetLang, session) {
  const { LANG_NAMES: LN } = require('./src/languages');
  const langName = LN[targetLang] || targetLang;

  console.log(`[translation] Запускаю перевод на ${targetLang} для ${clientChatId}`);
  await bot.telegram.sendMessage(ADMIN_CHAT_ID,
    `🔄 Запускаю перевод пакета на *${langName}* для ${session.bot2Data?.name || clientChatId}...`,
    { parse_mode: 'Markdown' }
  ).catch(() => {});

  // SEO-статьи генерируем заново на целевом языке (не перевод — оригинальный контент под аудиторию)
  const freshArticles = await generateFreshSeoArticles(session, targetLang, langName);

  // Остальной контент — переводим
  const translateFields = {
    videoScripts:    session.videoScripts    || '',
    carouselScripts: session.carouselScripts || '',
    photoScripts:    session.photoScripts    || '',
    storiesScripts:  session.storiesScripts  || '',
    covers:          session.covers          || '',
    contentPlan:     session.contentPlan     || '',
  };

  const translated = { articles: freshArticles };
  for (const [key, text] of Object.entries(translateFields)) {
    if (!text.trim()) { translated[key] = ''; continue; }
    const prompt =
      `Переведи следующий маркетинговый контент на язык: ${langName}.\n` +
      `Сохраняй структуру, форматирование и эмодзи. Переводи только текст, не меняй логику и структуру.\n\n` +
      `Контент:\n${text}`;
    translated[key] = await ask(prompt, { model: HAIKU, maxTokens: 4000, label: `translate-${key}-${targetLang}` });
  }

  // Сохраняем перевод в очередь проверки менеджера
  const TRANS_DIR = path.join(CLIENT_SESSIONS_DIR, 'translation_queue');
  if (!fs.existsSync(TRANS_DIR)) fs.mkdirSync(TRANS_DIR, { recursive: true });
  const transData = {
    clientChatId,
    targetLang,
    clientName: session.bot2Data?.name || '—',
    packageKey: session.paidPackageKey || 'pkg_a',
    ...translated,
    timestamp: Date.now(),
  };
  const transFile = path.join(TRANS_DIR, `${clientChatId}_${targetLang}.json`);
  fs.writeFileSync(transFile, JSON.stringify(transData, null, 2));

  crmLog(clientChatId, 'translation_ready', { lang: targetLang });

  // Для Стандарт/Профи — перевести субтитры в уже готовых видео через visual-сервис
  const isProfiOrStandard = (session.paidPackageKey || '').includes('pkg_v') || (session.paidPackageKey || '').includes('pkg_standard');
  if (isProfiOrStandard) {
    const VISUAL_URL = process.env.VISUAL_SERVICE_URL || 'http://localhost:3002';
    const { default: fetch } = await import('node-fetch');
    fetch(`${VISUAL_URL}/translate_videos`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ clientChatId, targetLang }),
    }).catch(e => console.error('[translation] translate_videos error:', e.message));
  }

  // Уведомляем менеджера с документом для проверки
  const docText = [
    `📦 ПАКЕТ НА ${langName.toUpperCase()} — ${transData.clientName}`,
    `Пакет: ${transData.packageKey}\n`,
    transData.contentPlan    ? `📅 КОНТЕНТ-ПЛАН:\n${transData.contentPlan}\n` : '',
    transData.videoScripts   ? `🎬 СЦЕНАРИИ ВИДЕО:\n${transData.videoScripts}\n` : '',
    transData.carouselScripts? `🎠 КАРУСЕЛИ:\n${transData.carouselScripts}\n` : '',
    transData.photoScripts   ? `📸 ПОСТЫ:\n${transData.photoScripts}\n` : '',
    transData.storiesScripts ? `📱 STORIES:\n${transData.storiesScripts}\n` : '',
    transData.covers         ? `🎨 ОБЛОЖКИ:\n${transData.covers}\n` : '',
  ].filter(Boolean).join('\n');

  const tmpPath = path.join('/tmp', `translation_${clientChatId}_${targetLang}.txt`);
  fs.writeFileSync(tmpPath, docText, 'utf8');
  try {
    await bot.telegram.sendDocument(
      ADMIN_CHAT_ID,
      { source: tmpPath, filename: `${transData.clientName}_${targetLang}.txt` },
      {
        caption: `✅ Перевод на *${langName}* готов — ${transData.clientName}\n\nПроверьте документ и нажмите кнопку.`,
        parse_mode: 'Markdown',
        reply_markup: { inline_keyboard: [[{ text: `📤 Отправить клиенту (${langName})`, callback_data: `send_translation_${clientChatId}_${targetLang}` }]] }
      }
    );
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

// ─── ОТПРАВКА ПЕРЕВОДА КЛИЕНТУ ────────────────────────────────────────────────
bot.action(/^send_translation_(\d+)_([a-z]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const clientChatId = ctx.match[1];
  const targetLang   = ctx.match[2];
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

  const { LANG_NAMES: LN } = require('./src/languages');
  const langName = LN[targetLang] || targetLang;

  const TRANS_DIR = path.join(CLIENT_SESSIONS_DIR, 'translation_queue');
  const transFile = path.join(TRANS_DIR, `${clientChatId}_${targetLang}.json`);
  if (!fs.existsSync(transFile)) {
    await ctx.reply('⚠️ Файл перевода не найден.');
    return;
  }
  const transData = JSON.parse(fs.readFileSync(transFile, 'utf8'));

  // Строим HTML-страницу для клиента (тот же buildPaidPackJson но с переведёнными текстами)
  let siteUrl = null;
  try {
    const jsonData = buildPaidPackJson({ ...transData, contentLanguage: targetLang }, transData.packageKey);
    const { url } = await buildAndDeploy(jsonData, 'paid-pack-template.html', `paid-${clientChatId}-${targetLang}`);
    siteUrl = url;
  } catch {}

  if (siteUrl) {
    await bot2.telegram.sendMessage(clientChatId,
      `🎉 Ваш контент-пакет на *${langName}* готов!\n\n📋 Все материалы:\n${siteUrl}`,
      { parse_mode: 'Markdown' }
    );
  } else {
    const summaryLines = [
      transData.contentPlan    ? `📅 Контент-план:\n${transData.contentPlan}` : '',
      transData.videoScripts   ? `🎬 Сценарии видео:\n${transData.videoScripts}` : '',
      transData.carouselScripts? `🎠 Карусели:\n${transData.carouselScripts}` : '',
      transData.photoScripts   ? `📸 Посты:\n${transData.photoScripts}` : '',
    ].filter(Boolean).join('\n\n');
    await bot2.telegram.sendMessage(clientChatId, `🎉 Ваш пакет на ${langName} готов!\n\n${summaryLines}`.slice(0, 4000));
  }

  crmLog(clientChatId, 'translation_delivered', { lang: targetLang });
  await ctx.reply(`✅ Пакет на ${langName} отправлен клиенту.`);
});

// Обновляет Bot #2 сессию клиента (шаг + isPersonalBrand)
function updateClientSession(clientChatId, updates) {
  const file = path.join(CLIENT_SESSIONS_DIR, `${clientChatId}.json`);
  let session = { step: 'done', chatId: clientChatId };
  if (fs.existsSync(file)) {
    try { session = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { }
  }
  Object.assign(session, updates);
  fs.writeFileSync(file, JSON.stringify(session, null, 2));
}

// ─── ПЛАТНЫЕ ВОПРОСЫ (определены здесь, Bot #2 только собирает ответы) ────────

const PAID_ONBOARDING_QUESTIONS = [
  {
    key: 'content_goal',
    text:
      'Вопрос 1 из 6\n\n' +
      'Мы уже знаем вашу цель с первого знакомства — но за это время вы изучили свой бизнес глубже.\n\n' +
      'Подтвердите: какая главная цель вашего контента в этом месяце?\n\n' +
      '(Нажмите кнопку)',
    buttons: [
      [{ text: '🎯 Привлечь новых клиентов', callback_data: 'paid_cgoal_new' }],
      [{ text: '🔥 Продавать тем кто уже знает меня', callback_data: 'paid_cgoal_warm' }],
    ],
  },
  {
    key: 'monthly_focus',
    text:
      'Вопрос 2 из 6\n\n' +
      'Что особенного в вашем бизнесе этот месяц?\n\n' +
      'Акции, запуски новых продуктов, сезонные предложения, события — что важно упомянуть в контенте?\n\n' +
      'Пример: запускаем новый курс 15 мая, делаем скидку 20% на все услуги до конца месяца.',
  },
  {
    key: 'brand_voice',
    text:
      'Вопрос 3 из 6\n\n' +
      'Как звучит ваш бренд — какой тон и стиль?\n\n' +
      'Пример: экспертный и строгий / дружелюбный и простой / вдохновляющий и мотивирующий.',
  },
  {
    key: 'client_stories',
    text:
      'Вопрос 4 из 6\n\n' +
      'Есть ли живые истории клиентов, отзывы или результаты которые можно использовать в контенте?\n\n' +
      'Даже один конкретный пример — очень ценно.\n\n' +
      'Пример: клиент Анна за 3 месяца вышла на €2000 в месяц с нуля.',
  },
  {
    key: 'platforms',
    text:
      'Вопрос 5 из 6\n\n' +
      'На каких платформах хотите публиковать контент?\n\n' +
      '(Нажмите кнопку или напишите сами)',
  },
  {
    key: 'followers_count',
    text:
      'Вопрос 6 из 6\n\n' +
      'Сколько у вас сейчас подписчиков в Instagram?\n\n' +
      'Если аккаунта пока нет или он совсем новый — напишите: 0',
  },
];

async function startPaidOnboarding(clientChatId, packageKey) {
  const isStart = packageKey.includes('pkg_a');
  const packageLabel = isStart ? 'Пакет Старт' : 'Пакет Профи';

  await bot2.telegram.sendMessage(
    clientChatId,
    `Оплата получена — спасибо! Вы приобрели ${packageLabel}.\n\n` +
    `Чтобы подготовить пакет максимально точно под ваш бизнес, задам вам 6 уточняющих вопросов. ` +
    `Это займёт 2-3 минуты и даст нам всю необходимую информацию для глубокого исследования.`
  );

  // Записываем вопросы в сессию клиента — Bot #2 читает их оттуда
  updateClientSession(clientChatId, {
    step: 'paid_q1',
    paidPackageKey: packageKey,
    paidQuestions: PAID_ONBOARDING_QUESTIONS,
    paidAnswers: [],
  });

  await new Promise(r => setTimeout(r, 1000));

  const q1 = PAID_ONBOARDING_QUESTIONS[0];
  await bot2.telegram.sendMessage(clientChatId, q1.text, {
    reply_markup: { inline_keyboard: q1.buttons },
  });
}

// ─── АВТО-ТРИГГЕР ОТ БОТ №2 ──────────────────────────────────────────────────

async function checkTriggers() {
  try {
    if (!fs.existsSync(TRIGGERS_DIR)) return;
    const allFiles = fs.readdirSync(TRIGGERS_DIR);
    const freeTriggers      = allFiles.filter(f => /^\d+\.trigger$/.test(f));
    const paidInitTriggers  = allFiles.filter(f => /^\d+\.paid_init\.trigger$/.test(f));
    const paidTriggers      = allFiles.filter(f => /^\d+\.paid\.trigger$/.test(f));
    const codeTriggers      = allFiles.filter(f => /^\d+\.code\.trigger$/.test(f));
    const approvedTriggers      = allFiles.filter(f => /^\d+\.approved\.trigger$/.test(f));
    const freeApprovedTriggers  = allFiles.filter(f => /^\d+\.free_approved\.trigger$/.test(f));
    const addlangTriggers       = allFiles.filter(f => /^\d+\.addlang(?:_[a-z]+)?\.trigger$/.test(f));
    const totalFound = freeTriggers.length + paidInitTriggers.length + paidTriggers.length + codeTriggers.length + approvedTriggers.length + freeApprovedTriggers.length + addlangTriggers.length;
    if (totalFound > 0) console.log(`[checkTriggers v2] найдено файлов: ${totalFound} (free:${freeTriggers.length} free_approved:${freeApprovedTriggers.length} paid_init:${paidInitTriggers.length} paid:${paidTriggers.length} code:${codeTriggers.length} approved:${approvedTriggers.length} addlang:${addlangTriggers.length})`);

    // ── AddLang triggers — клиент оплатил второй язык ────────────────────────
    for (const file of addlangTriggers) {
      const triggerPath = path.join(TRIGGERS_DIR, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(triggerPath, 'utf8'));
        fs.unlinkSync(triggerPath);
      } catch { continue; }

      const clientChatId = String(data.chatId);
      const lang = data.lang;

      // Добавляем второй язык в сессию — НЕ меняем основной contentLanguage
      try {
        const clientSession = loadClientSession(clientChatId);
        if (clientSession) {
          // additionalLanguage = язык в очереди на генерацию
          // contentLanguage остаётся нетронутым (основной язык уже готов/в работе)
          clientSession.additionalLanguage = lang;
          saveSession(clientChatId, clientSession);
        }
      } catch (e) {
        console.error('[addlang] session update error:', e.message);
      }

      crmLog(clientChatId, 'addlang_trigger_received', { lang, packageKey: data.packageKey });

      await bot.telegram.sendMessage(
        ADMIN_CHAT_ID,
        `🌐 Клиент оплатил второй язык!\n\n` +
        `Имя: ${data.name || '—'}\nChatId: ${clientChatId}\nПакет: ${data.packageKey || '—'}\n` +
        `Язык: ${LANG_NAMES_MAP[lang] || lang}\n\n` +
        `Основной язык клиента остаётся прежним. Нажмите кнопку — запустится генерация пакета на *${LANG_NAMES_MAP[lang] || lang}*. Вопрос про язык будет пропущен автоматически.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: `▶️ Запустить генерацию — ${LANG_NAMES_MAP[lang] || lang}`, callback_data: `run_addlang_${clientChatId}_${lang}` }],
            ]
          }
        }
      ).catch(e => console.error('[addlang] admin notify error:', e.message));
    }

    // ── Free approved triggers — менеджер одобрил бесплатный пакет в Bot3 ────
    for (const file of freeApprovedTriggers) {
      const triggerPath = path.join(TRIGGERS_DIR, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(triggerPath, 'utf8'));
        fs.unlinkSync(triggerPath);
      } catch { continue; }

      const clientChatId = String(data.clientChatId);
      try {
        await deliverFreePackage(clientChatId);
        console.log('[free_approved] Бесплатный пакет доставлен клиенту', clientChatId);
      } catch (e) {
        console.error('[free_approved] Ошибка доставки', clientChatId, e.message);
      }
    }

    // ── Approved triggers — менеджер одобрил визуал в Bot3 ───────────────────
    for (const file of approvedTriggers) {
      const triggerPath = path.join(TRIGGERS_DIR, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(triggerPath, 'utf8'));
        fs.unlinkSync(triggerPath);
      } catch { continue; }

      const clientChatId = String(data.clientChatId);
      try {
        await deliverVisualPackage(clientChatId);
        console.log('[approved] Визуал доставлен клиенту', clientChatId);
      } catch (e) {
        console.error('[approved] Ошибка доставки', clientChatId, e.message);
      }
    }

    // ── Code triggers — клиент активировал код доступа ────────────────────────
    for (const file of codeTriggers) {
      const triggerPath = path.join(TRIGGERS_DIR, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(triggerPath, 'utf8'));
        fs.unlinkSync(triggerPath);
      } catch { continue; }

      const clientChatId = data.chatId;
      try {
        if (data.packageKey) {
          // Тариф известен из кода — кнопка запуска сразу
          const tariffLabel = data.packageKey === 'pkg_v' ? 'Профи (€350)' : data.packageKey === 'pkg_standard' ? 'Стандарт (€250)' : 'Старт (€150)';
          await bot.telegram.sendMessage(
            ADMIN_CHAT_ID,
            `🎟 Код активирован!\n\n` +
            `Код: ${data.code} (${data.label})\n` +
            `Имя: ${data.name}\nEmail: ${data.email}\nChatId: ${clientChatId}\n` +
            `Тариф: ${tariffLabel}\n\n` +
            `Запустить генерацию?`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: `▶️ Запустить (${tariffLabel})`, callback_data: `tariff_${data.packageKey === 'pkg_v' ? 'v' : data.packageKey === 'pkg_standard' ? 's' : 'a'}_${clientChatId}` }],
                ]
              }
            }
          );
        } else {
          // Тариф неизвестен — предлагаем выбрать
          await bot.telegram.sendMessage(
            ADMIN_CHAT_ID,
            `🎟 Код активирован!\n\n` +
            `Код: ${data.code} (${data.label})\n` +
            `Имя: ${data.name}\nEmail: ${data.email}\nChatId: ${clientChatId}\n\n` +
            `Выбери тариф для генерации:`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔥 Тариф Старт (€150)', callback_data: `tariff_a_${clientChatId}` }],
                  [{ text: '⭐ Тариф Стандарт (€250)', callback_data: `tariff_s_${clientChatId}` }],
                  [{ text: '✨ Тариф Профи (€350)', callback_data: `tariff_v_${clientChatId}` }],
                ]
              }
            }
          );
        }
      } catch (e) {
        console.error('code trigger notify error:', e.message);
      }
    }

    // ── Paid Init triggers — клиент подтвердил оплату ─────────────────────────
    for (const file of paidInitTriggers) {
      const triggerPath = path.join(TRIGGERS_DIR, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(triggerPath, 'utf8'));
        fs.unlinkSync(triggerPath);
      } catch { continue; }

      const clientChatId = data.chatId;
      try {
        await startPaidOnboarding(clientChatId, data.packageKey);
        crmLog(clientChatId, 'paid_onboarding_started', { package: data.packageKey });
        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `💳 Клиент подтвердил оплату!\n\n` +
          `Имя: ${data.name || '—'}\nEmail: ${data.email || '—'}\nChatId: ${clientChatId}\n` +
          `Пакет: ${data.packageKey}\n\nЗадаю клиенту 4 уточняющих вопроса.`
        );
      } catch (e) {
        console.error('paid_init error for', clientChatId, e.message);
        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `⚠️ Ошибка paid_init для chatId ${clientChatId}: ${e.message}`
        ).catch(() => {});
      }
    }

    // ── Paid triggers — клиент ответил на все 4 вопроса ──────────────────────
    for (const file of paidTriggers) {
      const triggerPath = path.join(TRIGGERS_DIR, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(triggerPath, 'utf8'));
        fs.unlinkSync(triggerPath);
      } catch { continue; }

      const clientChatId = data.chatId;
      const answersText = (data.paidAnswers || [])
        .map(a => `${a.key}: ${a.answer}`)
        .join('\n');

      try {
        // Создаём brand в Metricool для клиента
        let metricoolBlogId = null;
        try {
          const brand = await createClientBrand(data.name || `Client_${clientChatId}`);
          if (brand?.id) {
            metricoolBlogId = brand.id;
            const session = loadClientSession(clientChatId);
            if (session) {
              session.metricoolBlogId  = metricoolBlogId;
              session.metricoolConnected = false;
              saveSession(clientChatId, session);
            }
            console.log(`[metricool] Brand создан для ${clientChatId}: blogId=${metricoolBlogId}`);

            // Уведомляем менеджера — нужно вручную отправить ссылку клиенту
            const managerChatId = process.env.BOT3_MANAGER_CHAT_ID;
            if (managerChatId) {
              await bot2.telegram.sendMessage(managerChatId,
                `📋 *Требуется действие — Metricool*\n\n` +
                `Клиент: *${data.name || clientChatId}*\n\n` +
                `*Что сделать (занимает 1 минуту):*\n` +
                `1. Зайдите на app.metricool.com\n` +
                `2. Переключитесь на brand "${data.name || `Client_${clientChatId}`}" (blogId: ${metricoolBlogId})\n` +
                `3. Settings → Connections → Connect Instagram → скопируйте ссылку\n` +
                `4. Отправьте клиенту вот этот текст с этой ссылкой:\n\n` +
                `———\n` +
                `Чтобы мы могли автоматически анализировать статистику вашего аккаунта — перейдите по ссылке ниже и подключите Instagram. Это займёт 1 минуту: нажмите "Продолжить как [ваше имя]" → разрешите доступ → готово.\n` +
                `[вставьте ссылку из Metricool]\n` +
                `———\n\n` +
                `После того как отправили — нажмите кнопку ниже.`,
                {
                  parse_mode: 'Markdown',
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: '✅ Ссылка отправлена клиенту', callback_data: `metricool_link_sent_${clientChatId}` }],
                    ]
                  }
                }
              ).catch(() => {});
            }
          }
        } catch (me) {
          console.error('[metricool] Ошибка создания brand:', me.message);
        }

        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `🎉 Клиент ответил на все вопросы — готов к генерации!\n\n` +
          `Имя: ${data.name || '—'}\nEmail: ${data.email || '—'}\nChatId: ${clientChatId}\nПакет: ${data.packageKey}\n` +
          `Metricool brand: ${metricoolBlogId ? `blogId=${metricoolBlogId}` : '❌ не создан'}\n\n` +
          `Ответы:\n${answersText}\n\n` +
          `Запусти генерацию: /client ${clientChatId}`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: `▶️ Запустить анализ (${clientChatId})`, callback_data: `run_client_${clientChatId}` }],
              ]
            }
          }
        );
        crmLog(clientChatId, 'paid_ready', { package: data.packageKey, metricoolBlogId });
      } catch (e) {
        console.error('paid trigger error for', clientChatId, e.message);
      }
    }

    // ── Бесплатные триггеры (анкета завершена — генерировать бесплатный пакет) ──
    const files = freeTriggers;
    for (const file of files) {
      const triggerPath = path.join(TRIGGERS_DIR, file);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(triggerPath, 'utf8'));
        fs.unlinkSync(triggerPath);
      } catch {
        continue;
      }

      console.log(`[checkTriggers] загружен trigger: chatId=${data?.chatId}, contentLanguage=${data?.contentLanguage}`);
      const clientChatId = data.chatId;
      const cLang = data.contentLanguage || 'ru';

      // Сохраняем данные клиента для возможности повтора
      const retryPath = path.join(TRIGGERS_DIR, `${clientChatId}.retry.json`);
      fs.writeFileSync(retryPath, JSON.stringify(data, null, 2));

      try {
        // ── Шаг 1: уведомляем клиента — анализ начался (~15-20 мин) ──────────
        await bot2.telegram.sendMessage(clientChatId,
          '⏳ Анализирую ваш бизнес, аудиторию и конкурентов...\n\nЭто займёт примерно 15–20 минут. Как только всё будет готово — пришлю результат.'
        ).catch(() => {});

        // ── Шаг 2: строим профили бизнеса + аудитории (блоки 1-2) ───────────
        deleteSession(ADMIN_CHAT_ID);
        resetSession(ADMIN_CHAT_ID);
        const session = getSession(ADMIN_CHAT_ID);
        session.targetClientId = clientChatId;
        session.isReturningClient = true;
        session.bot2Data = data;
        session.returningAnswers = [];
        session.contentLanguage = cLang;

        if (data.competitorNames && data.competitorNames.length > 0) {
          session.competitorNames = data.competitorNames;
          session.autoSearchCompetitors = false;
        } else {
          session.competitorNames = [];
          session.autoSearchCompetitors = true;
        }

        const fakeCtx = {
          chat: { id: ADMIN_CHAT_ID },
          reply: (text, opts) => bot.telegram.sendMessage(ADMIN_CHAT_ID, text, opts || {}),
          replyWithDocument: (doc, opts) => bot.telegram.sendDocument(ADMIN_CHAT_ID, doc, opts || {}),
        };

        await bot.telegram.sendMessage(ADMIN_CHAT_ID,
          `📋 Новый клиент: ${data.name || '—'} (chatId: ${clientChatId})\n⏳ Строю профили бизнеса и аудитории...`
        );
        await buildReturningProfiles(session);
        saveSession(ADMIN_CHAT_ID, session);

        await bot.telegram.sendMessage(ADMIN_CHAT_ID,
          `✅ Профили готовы — запускаю анализ конкурентов...`
        ).catch(() => {});

        // ── Шаг 3: анализ конкурентов (блок 3) ───────────────────────────────
        await runBlock3(fakeCtx, session);
        saveSession(ADMIN_CHAT_ID, session);

        await bot.telegram.sendMessage(ADMIN_CHAT_ID,
          `✅ Анализ конкурентов готов — генерирую контент-пакет (6 блоков)...`
        ).catch(() => {});

        // ── Шаг 4: генерируем бесплатный пакет на обогащённых данных ─────────
        console.log(`[FREE] Генерирую бесплатный пакет для ${clientChatId} на обогащённых данных`);
        const enrichedData = {
          businessProfile: session.businessProfile || '',
          audience: session.audience || '',
          competitorBrief: session.competitorBrief || '',
        };
        const { contentPlan, seoArticle, videoScript, carouselScript, coverExample, photoExample, isPersonalBrand } =
          await generateFreePackage(data, enrichedData);

        // ── Шаг 4.5: запускаем AI-генерацию изображений параллельно ──────────
        {
          const VISUAL_URL = process.env.VISUAL_SERVICE_URL || 'http://localhost:3002';
          import('node-fetch').then(({ default: fetch }) => {
            // Фото для поста
            const lines = (photoExample || '').split('\n');
            const promptLine = lines.find(l => /промпт.*генерац|prompt.*ai/i.test(l)) || '';
            const freePhotoPrompt = promptLine.replace(/^[^:]+:\s*/i, '').trim() || photoExample.slice(0, 300);
            if (freePhotoPrompt) {
              fetch(`${VISUAL_URL}/generate_free_photo`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ clientChatId, prompt: freePhotoPrompt }),
              }).catch(e => console.error('[free_photo] launch error:', e.message));
            }

            // Карусель (5 слайдов) + обложка
            fetch(`${VISUAL_URL}/generate_free_visuals`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ clientChatId, carouselScript, coverExample }),
            }).catch(e => console.error('[free_visuals] launch error:', e.message));
          });
        }

        // ── Шаг 5: HTML-страница для клиента (Netlify) ───────────────────────
        let siteUrl = null;
        try {
          const jsonData = buildFreePackJson(data, { contentPlan, seoArticle, videoScript, carouselScript, coverExample, photoExample, isPersonalBrand });
          const { url } = await buildAndDeploy(jsonData, 'free-pack-template.html', `free-${clientChatId}`);
          siteUrl = url;
        } catch (buildErr) {
          console.error('HTML build error for', clientChatId, buildErr.message);
        }

        // ── Шаг 6: сохраняем в pending (ждёт одобрения) ──────────────────────
        const PENDING_DIR = path.join(CLIENT_SESSIONS_DIR, 'pending');
        if (!fs.existsSync(PENDING_DIR)) fs.mkdirSync(PENDING_DIR, { recursive: true });
        fs.writeFileSync(
          path.join(PENDING_DIR, `${clientChatId}.json`),
          JSON.stringify({ contentPlan, seoArticle, videoScript, carouselScript, coverExample, photoExample, isPersonalBrand, siteUrl, clientData: data }, null, 2)
        );

        // ── Шаг 7: отправляем менеджеру на проверку через Bot3 ──────────────
        await sendFreeReviewToBot3(clientChatId, data, cLang, isPersonalBrand, siteUrl, {
          contentPlan, seoArticle, videoScript, carouselScript, coverExample, photoExample,
        });
      } catch (e) {
        console.error('Pipeline error for', clientChatId, e.message);
        await bot3Notify(
          `⚠️ Ошибка генерации бесплатного пакета — ${e.message}\n\nChatId: ${clientChatId}\nДанные клиента сохранены.`,
          { inline_keyboard: [[{ text: '🔄 Повторить генерацию', callback_data: `retry_free_${clientChatId}` }]] }
        );
      }
    }
  } catch (e) {
    console.error('checkTriggers error:', e.message);
  }
}

setInterval(checkTriggers, 10000);

// ─── ТАЙМЕР СКИДКИ — напоминания и истечение ──────────────────────────────────

async function checkDiscountTimers() {
  try {
    if (!fs.existsSync(CLIENT_SESSIONS_DIR)) return;
    const files = fs.readdirSync(CLIENT_SESSIONS_DIR).filter(f => f.endsWith('.json'));
    const now = Date.now();

    for (const file of files) {
      try {
        const filePath = path.join(CLIENT_SESSIONS_DIR, file);
        const session = JSON.parse(fs.readFileSync(filePath, 'utf8'));
        if (!session.discountSentAt || !session.discountExpiresAt) continue;
        if (session.discountUsed || session.discountExpired) continue;

        const chatId = session.chatId || file.replace('.json', '');
        const sentAt = session.discountSentAt;
        const expiresAt = session.discountExpiresAt;
        const reminders = session.discountReminders || [];
        const elapsed = now - sentAt;
        const remaining = expiresAt - now;

        // Напоминание 1 — через 24 часа (осталось 24 часа)
        if (elapsed >= 24 * 3600 * 1000 && !reminders.includes('24h')) {
          await bot2.telegram.sendMessage(chatId,
            '⏰ Напоминание: до истечения специального предложения осталось *24 часа*.\n\n' +
            'Тариф Старт — €120/мес\nТариф Стандарт — €200/мес\nТариф Профи — €280/мес',
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔥 Тариф Старт — €120/мес', callback_data: 'pkg_a_discount' }],
                  [{ text: '⭐ Тариф Стандарт — €200/мес', callback_data: 'pkg_standard_discount' }],
                  [{ text: '✨ Тариф Профи — €280/мес', callback_data: 'pkg_v_discount' }],
                ]
              }
            }
          ).catch(() => {});
          reminders.push('24h');
          updateClientSession(chatId, { discountReminders: reminders });
        }

        // Напоминание 2 — через 42 часа (осталось 6 часов)
        if (elapsed >= 42 * 3600 * 1000 && !reminders.includes('6h')) {
          await bot2.telegram.sendMessage(chatId,
            '⏰ До истечения специального предложения осталось *6 часов*.\n\n' +
            'После этого цена вернётся к стандартной.',
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔥 Тариф Старт — €120/мес', callback_data: 'pkg_a_discount' }],
                  [{ text: '⭐ Тариф Стандарт — €200/мес', callback_data: 'pkg_standard_discount' }],
                  [{ text: '✨ Тариф Профи — €280/мес', callback_data: 'pkg_v_discount' }],
                ]
              }
            }
          ).catch(() => {});
          reminders.push('6h');
          updateClientSession(chatId, { discountReminders: reminders });
        }

        // Напоминание 3 — через 47 часов (остался 1 час)
        if (elapsed >= 47 * 3600 * 1000 && !reminders.includes('1h')) {
          await bot2.telegram.sendMessage(chatId,
            '⏰ Остался *1 час* до истечения специального предложения!\n\n' +
            'Последний шанс получить первый месяц со скидкой 20%.',
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔥 Тариф Старт — €120/мес', callback_data: 'pkg_a_discount' }],
                  [{ text: '⭐ Тариф Стандарт — €200/мес', callback_data: 'pkg_standard_discount' }],
                  [{ text: '✨ Тариф Профи — €280/мес', callback_data: 'pkg_v_discount' }],
                ]
              }
            }
          ).catch(() => {});
          reminders.push('1h');
          updateClientSession(chatId, { discountReminders: reminders });
        }

        // Истечение — 48 часов прошло
        if (remaining <= 0 && !session.discountExpired) {
          await bot2.telegram.sendMessage(chatId,
            'Специальное предложение истекло.\n\n' +
            'Вы по-прежнему можете начать сотрудничество — по стандартной цене.',
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔥 Тариф Старт — €150/мес', callback_data: 'pkg_a' }],
                  [{ text: '⭐ Тариф Стандарт — €250/мес', callback_data: 'pkg_standard' }],
                  [{ text: '✨ Тариф Профи — €350/мес', callback_data: 'pkg_v' }],
                ]
              }
            }
          ).catch(() => {});
          updateClientSession(chatId, { discountExpired: true });
        }
      } catch { continue; }
    }
  } catch (e) {
    console.error('checkDiscountTimers error:', e.message);
  }
}

setInterval(checkDiscountTimers, 60000);

// ─── ДВУХНЕДЕЛЬНЫЙ ЦИКЛ АНАЛИТИКИ ────────────────────────────────────────────

const { getInstagramAnalytics, formatAnalyticsText, extractMetricsSummary, createClientBrand, isInstagramConnected } = require('./src/metricool');
const { buildAnalyticsPrompt, buildContentCorrectionPrompt } = require('./src/analytics_instruction');
const { ask, askSonnet, SONNET } = require('./src/claude');

async function checkAnalyticsCycle() {
  try {
    if (!fs.existsSync(CLIENT_SESSIONS_DIR)) return;
    const files = fs.readdirSync(CLIENT_SESSIONS_DIR).filter(f => f.endsWith('.json'));
    const now   = Date.now();
    const DAY   = 24 * 60 * 60 * 1000;

    for (const file of files) {
      const chatId = file.replace('.json', '');
      let session;
      try { session = JSON.parse(fs.readFileSync(path.join(CLIENT_SESSIONS_DIR, file), 'utf8')); }
      catch { continue; }

      if (!session.postingStartedAt) continue;

      const daysSince = Math.floor((now - session.postingStartedAt) / DAY);

      // Вариант В — напоминание подключить Metricool (дни 7, 21)
      if (!session.metricoolConnected && [7, 21].includes(daysSince) && !session[`metricoolNudge_${daysSince}`]) {
        session[`metricoolNudge_${daysSince}`] = true;
        saveSession(chatId, session);
        await bot2.telegram.sendMessage(chatId,
          '💡 *Маленькое напоминание*\n\n' +
          'Вы ещё не подключили аналитику. Если сделаете это — мы сами будем отслеживать ' +
          'статистику и через 15 дней пришлём готовые выводы.\n\n' +
          'Если не хотите — ничего страшного, просто пришлите скриншоты когда попросим.',
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }

      // День 13 — предупреждение что завтра нужны скриншоты (только если нет Metricool)
      if (!session.metricoolConnected && daysSince === 14 && !session.analyticsReminder14) {
        session.analyticsReminder14 = true;
        saveSession(chatId, session);
        await bot2.telegram.sendMessage(chatId,
          '📊 *Завтра нам понадобится статистика*\n\n' +
          'Чтобы скорректировать следующий контент под вашу аудиторию, нам нужны данные за эти 15 дней.\n\n' +
          '*Что сделать завтра:*\n' +
          '1. Откройте Instagram\n' +
          '2. Зайдите в Профессиональную панель\n' +
          '3. Нажмите "Статистика" → выберите период "последние 15 дней"\n' +
          '4. Сделайте скриншоты: общий охват, лучшие посты, статистика Reels\n' +
          '5. Пришлите скриншоты сюда\n\n' +
          '_Если подключите Metricool — мы сделаем это автоматически, без скриншотов._',
          { parse_mode: 'Markdown' }
        ).catch(() => {});
      }

      // День 15+ — запрос аналитики (каждые 15 дней)
      const cyclesDone  = session.analyticsCycles || 0;
      const nextCycleDay = (cyclesDone + 1) * 15;

      if (daysSince >= nextCycleDay && !session[`analyticsRunning_${cyclesDone + 1}`]) {
        session[`analyticsRunning_${cyclesDone + 1}`] = true;
        saveSession(chatId, session);

        if (session.metricoolConnected && session.metricoolBlogId) {
          // Вариант А — тянем из Metricool, полный автоцикл
          try {
            const data             = await getInstagramAnalytics(session.metricoolBlogId, 15);
            const analyticsText    = formatAnalyticsText(data);

            // Извлекаем числовые метрики и сохраняем в историю
            const { connected: _c, followers } = await isInstagramConnected(session.metricoolBlogId);
            if (followers) session.followersCount = followers;
            const summary = extractMetricsSummary(data, session.followersCount);
            if (!session.analyticsHistory) session.analyticsHistory = [];
            session.analyticsHistory.push({ cycle: cyclesDone + 1, date: Date.now(), ...summary });

            const publishedContent = session.lastContentSummary || 'данные недоступны';
            const analysisPrompt   = buildAnalyticsPrompt(session, analyticsText, publishedContent);
            const analysis         = await ask(analysisPrompt, { model: SONNET, maxTokens: 4000 });

            // Шаг 2: генерируем скорректированный контент на следующие 15 дней
            const correctionPrompt = buildContentCorrectionPrompt(session, analysis);
            const corrections      = await ask(correctionPrompt, { model: SONNET, maxTokens: 4000 });

            session.lastAnalysis     = { text: analysis,     date: Date.now(), cycle: cyclesDone + 1 };
            session.lastCorrections  = { text: corrections,  date: Date.now(), cycle: cyclesDone + 1 };
            session.analyticsCycles  = cyclesDone + 1;
            saveSession(chatId, session);

            const managerChatId = process.env.BOT3_MANAGER_CHAT_ID;
            if (managerChatId) {
              // Сначала отправляем анализ (для информации)
              await bot2.telegram.sendMessage(managerChatId,
                `📊 *Аналитика — ${session.clientName || chatId}* (цикл ${cyclesDone + 1})\n\n${analysis}`,
                { parse_mode: 'Markdown' }
              ).catch(() => {});

              // Затем скорректированный контент с кнопкой одобрения
              await bot2.telegram.sendMessage(managerChatId,
                `✏️ *Скорректированный контент — ${session.clientName || chatId}*\n\n` +
                `${corrections}\n\n_Проверьте и нажмите кнопку чтобы отправить клиенту._`,
                {
                  parse_mode: 'Markdown',
                  reply_markup: {
                    inline_keyboard: [[
                      { text: '✅ Отправить клиенту', callback_data: `send_corrections_${chatId}_${cyclesDone + 1}` },
                      { text: '✏️ Не отправлять', callback_data: `corrections_skip_${chatId}` },
                    ]],
                  },
                }
              ).catch(() => {});
            }
          } catch (e) {
            console.error('[analytics] Metricool error for', chatId, e.message);
          }

        } else {
          // Вариант В — просим скриншоты, менеджер запустит корректировки вручную
          session.analyticsIntake = true;
          saveSession(chatId, session);
          await bot2.telegram.sendMessage(chatId,
            '📊 *Время аналитики!*\n\n' +
            'Прошло 15 дней — пора посмотреть как реагирует ваша аудитория.\n\n' +
            '*Пришлите скриншоты статистики из Instagram:*\n' +
            '1. Откройте Instagram → Профессиональная панель\n' +
            '2. Нажмите "Статистика" → период "последние 15 дней"\n' +
            '3. Сделайте скриншоты: общий охват, лучшие посты, Reels\n' +
            '4. Пришлите всё сюда\n\n' +
            'Когда пришлёте всё — напишите *"готово"*.',
            { parse_mode: 'Markdown' }
          ).catch(() => {});
        }
      }
    }
  } catch (e) {
    console.error('checkAnalyticsCycle error:', e.message);
  }
}

// Проверяем раз в час
setInterval(checkAnalyticsCycle, 60 * 60 * 1000);

// ─── ПРОВЕРКА ПОДКЛЮЧЕНИЯ INSTAGRAM К METRICOOL ───────────────────────────────

async function checkMetricoolConnections() {
  try {
    if (!fs.existsSync(CLIENT_SESSIONS_DIR)) return;
    const files = fs.readdirSync(CLIENT_SESSIONS_DIR).filter(f => f.endsWith('.json'));

    for (const file of files) {
      const chatId = file.replace('.json', '');
      let session;
      try { session = JSON.parse(fs.readFileSync(path.join(CLIENT_SESSIONS_DIR, file), 'utf8')); }
      catch { continue; }

      // Только клиенты у которых есть brand но ещё не подключён Instagram
      if (!session.metricoolBlogId || session.metricoolConnected) continue;

      try {
        const { connected, followers } = await isInstagramConnected(session.metricoolBlogId);
        if (connected) {
          session.metricoolConnected = true;
          if (followers) session.followersCount = followers;
          saveSession(chatId, session);
          console.log(`[metricool] Instagram подключён для ${chatId}`);

          // Уведомляем менеджера
          const managerChatId = process.env.BOT3_MANAGER_CHAT_ID;
          if (managerChatId) {
            await bot2.telegram.sendMessage(managerChatId,
              `✅ Клиент ${session.clientName || chatId} подключил Instagram к Metricool.\n` +
              `Аналитика будет автоматической.`
            ).catch(() => {});
          }
        }
      } catch (e) {
        console.error('[metricool] Ошибка проверки подключения для', chatId, e.message);
      }
    }
  } catch (e) {
    console.error('checkMetricoolConnections error:', e.message);
  }
}

setInterval(checkMetricoolConnections, 60 * 60 * 1000);

// ─── ЗАПУСК ЭТАПА 2 ОПРОСНИКА САЙТА ──────────────────────────────────────────
// Использование: /site_details {chatId} vizitka   или   /site_details {chatId} expert

bot.command('site_details', async (ctx) => {
  if (String(ctx.chat.id) !== String(ADMIN_CHAT_ID)) return;
  const parts = ctx.message.text.trim().split(/\s+/);
  const clientChatId = parts[1];
  const template = parts[2]; // 'vizitka' или 'expert'

  if (!clientChatId || !['vizitka', 'expert'].includes(template)) {
    await ctx.reply('Использование:\n/site_details {chatId} vizitka\n/site_details {chatId} expert');
    return;
  }

  const questions = template === 'expert' ? EXPERT_QUESTIONS : VIZITKA_QUESTIONS;
  const templateRu = template === 'expert' ? 'Эксперт (€299)' : 'Визитка (€150)';

  // Обновляем сессию клиента
  updateClientSession(clientChatId, {
    step: 'website_details',
    websiteDetails: { template, questionIndex: 0, answers: {} },
  });

  // Отправляем клиенту вступление + первый вопрос
  await bot2.telegram.sendMessage(
    clientChatId,
    `Отлично! Оплата подтверждена — начинаем собирать данные для вашего сайта.\n\n` +
    `Шаблон: ${templateRu}\n` +
    `Всего вопросов: ${questions.length} — займёт 5-7 минут.\n\n` +
    `Отвечайте в удобном темпе — прогресс сохраняется.`
  );
  await new Promise(r => setTimeout(r, 800));
  await bot2.telegram.sendMessage(clientChatId, questions[0].text);

  await ctx.reply(`✅ Этап 2 запущен для клиента ${clientChatId} (${templateRu})`);
});

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
