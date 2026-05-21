require('dotenv').config();
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
              [{ text: '✨ Тариф Профи (€250)', callback_data: `tariff_v_${targetId}` }],
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
    const clientSession = loadClientSession(session.targetClientId);
    if (clientSession && clientSession.autoSendApproved) {
      // Клиент активировал авто-код — отправляем без подтверждения
      await deliverClientPackage(session.targetClientId, session);
      await ctx.reply(`🤖 Пакет отправлен клиенту автоматически (chatId: ${session.targetClientId}) — активирован авто-код.`);
    } else {
      // Обычный клиент — показываем кнопку
      await ctx.reply(
        `✅ Проверьте документ выше.\n\nОтправить результат клиенту (chatId: ${session.targetClientId})?`,
        Markup.inlineKeyboard([
          [Markup.button.callback('📤 Отправить клиенту', `send_client_${session.targetClientId}`)],
          [Markup.button.callback('⏸ Не отправлять', 'send_cancel')],
        ])
      );
    }
  }
}

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

bot.action(/^tariff_([av])_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const pkg = ctx.match[1] === 'v' ? 'pkg_v' : 'pkg_a';
  const targetId = ctx.match[2];
  const chatId = ctx.chat.id;

  deleteSession(chatId);
  resetSession(chatId);
  const session = getSession(chatId);
  session.targetClientId = targetId;
  session.paidPackageKey = pkg;

  const bot2Data = getBot2Data(targetId);
  if (bot2Data) {
    const tariffLabel = pkg === 'pkg_v' ? 'Профи' : 'Старт';
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

// ─── ОДОБРЕНИЕ БЕСПЛАТНОГО ПАКЕТА ────────────────────────────────────────────

bot.action(/^send_free_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const clientChatId = ctx.match[1];
  const PENDING_DIR = path.join(CLIENT_SESSIONS_DIR, 'pending');
  const pendingFile = path.join(PENDING_DIR, `${clientChatId}.json`);

  if (!fs.existsSync(pendingFile)) {
    await ctx.reply(`⚠️ Pending-файл не найден для chatId ${clientChatId}. Возможно уже был отправлен.`);
    return;
  }

  let pkg;
  try {
    pkg = JSON.parse(fs.readFileSync(pendingFile, 'utf8'));
  } catch (e) {
    await ctx.reply(`⚠️ Ошибка чтения pending-файла: ${e.message}`);
    return;
  }

  try {
    const { contentPlan, seoArticle, videoScript, carouselScript, coverExample, photoExample, isPersonalBrand, siteUrl, clientData } = pkg;

    if (siteUrl) {
      // Отправляем красивую страницу
      await sendToClient(clientChatId, `Ваш бесплатный пакет готов! Смотрите все материалы здесь:\n\n${siteUrl}`);
    } else {
      // Fallback: текст если HTML не был сгенерирован
      await sendToClient(clientChatId, 'Контент-план на 7 дней:\n\n' + contentPlan);
      await sendToClient(clientChatId, '─────────────────────\nSEO-статья для сайта:\n\n' + seoArticle);
      await sendToClient(clientChatId, '─────────────────────\nСценарий ролика:\n\n' + videoScript);
      await sendToClient(clientChatId, '─────────────────────\nСценарий карусели:\n\n' + carouselScript);
      await sendToClient(clientChatId, '─────────────────────\nПример обложки для видео:\n\n' + coverExample);
      await sendToClient(clientChatId, '─────────────────────\nПример готового поста (AI-изображение + текст):\n\n' + photoExample);
    }
    // Скидочный оффер 50% — только если клиент ещё не получал скидку
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
        'Первый месяц со скидкой 50%:\n\n' +
        'Тариф Старт: ~€150~ → *€75/мес*\n' +
        'Тариф Профи: ~€250~ → *€125/мес*\n\n' +
        'За этот месяц вы убедитесь насколько качественный контент мы готовим, увидите как легко с ним работать — и сколько времени высвобождается у вас и вашей команды. Оценив это на практике, платить полную цену со второго месяца будет уже совсем просто.\n\n' +
        '⏳ Предложение действует 48 часов — после истекает.\n\n' +
        'Выберите тариф:',
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔥 Тариф Старт — €75/мес', callback_data: 'pkg_a_discount' }],
              [{ text: '✨ Тариф Профи — €125/мес', callback_data: 'pkg_v_discount' }],
            ]
          }
        }
      );
      crmLog(clientChatId, 'discount_offer_shown', { expiresAt: discountExpiresAt });
    } else {
      // Повторное прохождение — полная цена
      await sendToClient(clientChatId, buildSalesOffer(isPersonalBrand));
      if (isPersonalBrand) {
        await bot2.telegram.sendMessage(clientChatId, 'Выберите тариф:', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '🔥 Тариф Старт — €150/мес', callback_data: 'pkg_a' }],
            ]
          }
        });
      } else {
        await bot2.telegram.sendMessage(clientChatId, 'Выберите тариф:', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '✨ Тариф Профи — €250/мес', callback_data: 'pkg_v' }],
            ]
          }
        });
      }
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
    await ctx.reply(`✅ Бесплатный пакет отправлен клиенту (chatId: ${clientChatId})`);
  } catch (e) {
    console.error('Ошибка отправки free пакета:', e.message);
    await ctx.reply(`⚠️ Ошибка отправки клиенту: ${e.message}`);
  }
});

bot.action(/^reject_free_(.+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const clientChatId = ctx.match[1];
  await ctx.reply(
    `⏸ Пакет клиенту ${clientChatId} не отправлен.\n\n` +
    `Файл сохранён в pending — отредактируйте вручную и запустите:\n` +
    `/send_pending ${clientChatId}`
  );
});

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
  const tariff = session.isPersonalBrand ? 'pkg_a' : 'pkg_v';

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
}

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
      'Вопрос 1 из 5\n\n' +
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
      'Вопрос 2 из 5\n\n' +
      'Что особенного в вашем бизнесе этот месяц?\n\n' +
      'Акции, запуски новых продуктов, сезонные предложения, события — что важно упомянуть в контенте?\n\n' +
      'Пример: запускаем новый курс 15 мая, делаем скидку 20% на все услуги до конца месяца.',
  },
  {
    key: 'brand_voice',
    text:
      'Вопрос 3 из 5\n\n' +
      'Как звучит ваш бренд — какой тон и стиль?\n\n' +
      'Пример: экспертный и строгий / дружелюбный и простой / вдохновляющий и мотивирующий.',
  },
  {
    key: 'client_stories',
    text:
      'Вопрос 4 из 5\n\n' +
      'Есть ли живые истории клиентов, отзывы или результаты которые можно использовать в контенте?\n\n' +
      'Даже один конкретный пример — очень ценно.\n\n' +
      'Пример: клиент Анна за 3 месяца вышла на €2000 в месяц с нуля.',
  },
  {
    key: 'platforms',
    text:
      'Вопрос 5 из 5\n\n' +
      'На каких платформах хотите публиковать контент?\n\n' +
      '(Нажмите кнопку или напишите сами)',
  },
];

async function startPaidOnboarding(clientChatId, packageKey) {
  const isStart = packageKey.includes('pkg_a');
  const packageLabel = isStart ? 'Пакет Старт' : 'Пакет Профи';

  await bot2.telegram.sendMessage(
    clientChatId,
    `Оплата получена — спасибо! Вы приобрели ${packageLabel}.\n\n` +
    `Чтобы подготовить пакет максимально точно под ваш бизнес, задам вам 5 уточняющих вопросов. ` +
    `Это займёт 2 минуты и даст нам всю необходимую информацию для глубокого исследования.`
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
    const freeTriggers    = allFiles.filter(f => /^\d+\.trigger$/.test(f));
    const paidInitTriggers = allFiles.filter(f => /^\d+\.paid_init\.trigger$/.test(f));
    const paidTriggers    = allFiles.filter(f => /^\d+\.paid\.trigger$/.test(f));
    const codeTriggers    = allFiles.filter(f => /^\d+\.code\.trigger$/.test(f));
    const totalFound = freeTriggers.length + paidInitTriggers.length + paidTriggers.length + codeTriggers.length;
    if (totalFound > 0) console.log(`[checkTriggers v2] найдено файлов: ${totalFound} (free:${freeTriggers.length} paid_init:${paidInitTriggers.length} paid:${paidTriggers.length} code:${codeTriggers.length})`);

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
                [{ text: '✨ Тариф Профи (€250)', callback_data: `tariff_v_${clientChatId}` }],
              ]
            }
          }
        );
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
        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `🎉 Клиент ответил на все вопросы — готов к генерации!\n\n` +
          `Имя: ${data.name || '—'}\nEmail: ${data.email || '—'}\nChatId: ${clientChatId}\nПакет: ${data.packageKey}\n\n` +
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
        crmLog(clientChatId, 'paid_ready', { package: data.packageKey });
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

        // ── Шаг 3: анализ конкурентов (блок 3) ───────────────────────────────
        await runBlock3(fakeCtx, session);
        saveSession(ADMIN_CHAT_ID, session);

        // ── Шаг 4: генерируем бесплатный пакет на обогащённых данных ─────────
        console.log(`[FREE] Генерирую бесплатный пакет для ${clientChatId} на обогащённых данных`);
        const enrichedData = {
          businessProfile: session.businessProfile || '',
          audience: session.audience || '',
          competitorBrief: session.competitorBrief || '',
        };
        const { contentPlan, seoArticle, videoScript, carouselScript, coverExample, photoExample, isPersonalBrand } =
          await generateFreePackage(data, enrichedData);

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

        // ── Шаг 7: отправляем Александру на проверку ─────────────────────────
        const langNote = isNonRussian(cLang) ? ` · Язык клиента: ${cLang.toUpperCase()} (перевод ниже каждого блока)` : '';
        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `🔔 Бесплатный пакет готов!\n\nИмя: ${data.name || '—'}\nEmail: ${data.email || '—'}\nChatId: ${clientChatId}\nТип: ${isPersonalBrand ? 'Личный бренд → А/Б' : 'Бизнес → В'}${langNote}\n\nПроверьте материалы ниже:`
        );

        const adminSend = async (label, text) => {
          const LIMIT = 2000;
          const block = await adminBlock(label, text, cLang);
          console.log(`[adminSend] ${label} длина=${block.length}`);
          for (let i = 0; i < block.length; i += LIMIT) {
            const chunk = block.slice(i, i + LIMIT);
            await bot.telegram.sendMessage(ADMIN_CHAT_ID, chunk);
          }
        };
        await adminSend('📅 КОНТЕНТ-ПЛАН 7 ДНЕЙ:', contentPlan);
        await adminSend('📝 SEO-СТАТЬЯ:', seoArticle);
        await adminSend('🎬 СЦЕНАРИЙ РОЛИКА:', videoScript);
        await adminSend('🎠 СЦЕНАРИЙ КАРУСЕЛИ:', carouselScript);
        await adminSend('🖼 ПРИМЕР ОБЛОЖКИ:', coverExample);
        await adminSend('📸 ПРИМЕР ФОТО:', photoExample);

        if (siteUrl) {
          await bot.telegram.sendMessage(ADMIN_CHAT_ID, `🌐 Страница для клиента:\n${siteUrl}`);
        }

        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `✅ Проверьте материалы выше${siteUrl ? ' и страницу по ссылке' : ''}.\n\nОтправить клиенту ${data.name || clientChatId}?`,
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '📤 Отправить клиенту', callback_data: `send_free_${clientChatId}` }],
                [{ text: '✏️ Не отправлять (разобраться вручную)', callback_data: `reject_free_${clientChatId}` }],
              ]
            }
          }
        );
      } catch (e) {
        console.error('Pipeline error for', clientChatId, e.message);
        await bot.telegram.sendMessage(
          ADMIN_CHAT_ID,
          `⚠️ Ошибка генерации пакета для chatId ${clientChatId}: ${e.message}`
        ).catch(() => {});
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
            'Тариф Старт — €75/мес\nТариф Профи — €125/мес',
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔥 Тариф Старт — €75/мес', callback_data: 'pkg_a_discount' }],
                  [{ text: '✨ Тариф Профи — €125/мес', callback_data: 'pkg_v_discount' }],
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
                  [{ text: '🔥 Тариф Старт — €75/мес', callback_data: 'pkg_a_discount' }],
                  [{ text: '✨ Тариф Профи — €125/мес', callback_data: 'pkg_v_discount' }],
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
            'Последний шанс получить первый месяц за полцены.',
            {
              parse_mode: 'Markdown',
              reply_markup: {
                inline_keyboard: [
                  [{ text: '🔥 Тариф Старт — €75/мес', callback_data: 'pkg_a_discount' }],
                  [{ text: '✨ Тариф Профи — €125/мес', callback_data: 'pkg_v_discount' }],
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
                  [{ text: '✨ Тариф Профи — €250/мес', callback_data: 'pkg_v' }],
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
