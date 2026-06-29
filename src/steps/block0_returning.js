const fs = require('fs');
const path = require('path');
const os = require('os');
const { Markup } = require('telegraf');
const { askSonnet } = require('../claude');
const { STEPS } = require('../state');

const BOT2_SESSIONS_DIR = path.join(os.homedir(), '.marketingdna-client-sessions');

function loadBot2Session(chatId) {
  try {
    const filePath = path.join(BOT2_SESSIONS_DIR, `${chatId}.json`);
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    }
  } catch (e) {
    console.error('Не удалось прочитать сессию Bot #2:', e.message);
  }
  return null;
}

// Возвращает сессию клиента если она существует и содержит хоть какие-то данные
function getBot2Data(chatId) {
  const s = loadBot2Session(chatId);
  if (!s) return null;
  // Принимаем сессию если есть ЛЮБЫЕ данные — свободный опрос ИЛИ платный ИЛИ базовые поля
  const hasData =
    (s.answersPart1 && s.answersPart1.length > 0) ||
    (s.answers && s.answers.length > 0) ||
    (s.paidAnswers && s.paidAnswers.length > 0) ||
    s.name || s.description;
  if (!hasData) return null;
  return s;
}

async function startReturningClientFlow(ctx, session, bot2Data) {
  session.isReturningClient = true;
  session.bot2Data = bot2Data;

  // Если клиент уже ответил на 12 вопросов — пропускаем диалог выбора,
  // сразу переходим к генерации на основе paidAnswers
  if (bot2Data?.paidAnswers?.length > 0) {
    session.step = STEPS.DONE;
    // Копируем язык и пакет из bot2Data если нужно
    if (!session.contentLanguage && bot2Data.contentLanguage) session.contentLanguage = bot2Data.contentLanguage;
    if (!session.paidPackageKey && bot2Data.paidPackageKey) session.paidPackageKey = bot2Data.paidPackageKey;
    await ctx.reply('⚡ Данные получены — запускаю генерацию...');
    return;
  }

  // Иначе (только бесплатные данные) — показываем диалог
  session.step = STEPS.RETURNING_CHOICE;
  await ctx.reply(
    'Вижу что у нас есть базовые данные о вашем бизнесе.\n\n' +
    'Продолжим на их основе или начнём с чистого листа?',
    Markup.keyboard([
      ['✅ Продолжить'],
      ['🔄 Начать заново'],
    ]).resize()
  );
}

function extractCompetitorsFromQ3(paidAnswers) {
  const q3 = (paidAnswers || []).find(a => a.key === 'competitors');
  if (!q3 || !q3.answer) return null;
  const ans = q3.answer.trim().toLowerCase();
  if (ans === 'не знаю' || ans === 'нет конкурентов' || ans === 'нет' || ans.length < 5) return null;
  // Делим по строкам и запятым — каждый конкурент отдельно
  const lines = q3.answer.split(/[\n,]+/).map(l => l.trim()).filter(l => l.length > 3);
  return lines.length > 0 ? lines : null;
}

async function handleReturningChoice(ctx, session, text) {
  const lower = text.toLowerCase().trim();

  if (lower === '✅ продолжить' || lower === 'продолжить') {
    session.awaitingInstagramDesc = false;
    session.pendingInstagramHandle = null;

    // Если клиент уже указал конкурентов в Q3 — берём их автоматически
    const paidCompetitors = extractCompetitorsFromQ3(session.bot2Data?.paidAnswers);
    if (paidCompetitors) {
      session.competitorNames = paidCompetitors;
      session.autoSearchCompetitors = false;
      await ctx.reply(
        `✅ Конкуренты из анкеты клиента:\n${paidCompetitors.map(c => `— ${c}`).join('\n')}\n\nИспользую их для анализа. Перехожу к построению профилей...`,
        Markup.removeKeyboard()
      );
      return await finishCompetitors(ctx, session);
    }

    // Конкуренты не указаны — включаем автопоиск
    session.competitorNames = [];
    session.autoSearchCompetitors = true;
    await ctx.reply(
      '✅ Клиент не указал конкурентов — система найдёт типичных игроков в нише самостоятельно.\n\nПерехожу к построению профилей...',
      Markup.removeKeyboard()
    );
    return await finishCompetitors(ctx, session);
  }

  if (lower === '🔄 начать заново' || lower === 'начать заново') {
    session.isReturningClient = false;
    session.bot2Data = null;
    session.step = STEPS.ONBOARDING;
    return 'restart';
  }

  // Если нажали что-то другое — повторяем кнопки
  await ctx.reply(
    'Выбери один из вариантов:',
    Markup.keyboard([
      ['✅ Продолжить'],
      ['🔄 Начать заново'],
    ]).resize()
  );
  return null;
}

// Проверяет достаточно ли данных из Bot2 чтобы пропустить RETURNING_QUESTIONS
function hasEnoughBot2Data(bot2Data) {
  if (!bot2Data) return false;
  const answers = [
    ...(bot2Data.answers || []),
    ...(bot2Data.answersPart1 || []),
    ...(bot2Data.answersPart2 || []),
    ...(bot2Data.paidAnswers || []),
  ];
  return answers.length >= 3;
}

// Решает: задавать вопросы или пропустить если данные уже есть
async function finishCompetitors(ctx, session) {
  const bot2 = session.bot2Data;
  if (hasEnoughBot2Data(bot2)) {
    // Данные из Bot2 уже есть — пропускаем повторные вопросы
    session.returningAnswers = [];
    session.step = STEPS.DONE; // buildReturningProfiles вызовет вызывающий код
    await ctx.reply('✅ Данные о бизнесе уже есть — вопросы пропускаем, перехожу к анализу.');
    return true;
  }
  // Данных нет — задаём вопросы как обычно
  session.step = STEPS.RETURNING_QUESTIONS;
  session.questionIndex = 0;
  session.returningAnswers = [];
  await askReturningQuestion(ctx, session);
  return true;
}

function isInstagram(text) {
  return text.includes('instagram.com') || text.includes('instagr.am');
}

// Обрезает UTM-параметры и прочий мусор из URL, оставляя только домен + путь
function cleanUrl(text) {
  try {
    const match = text.match(/https?:\/\/[^\s]+/);
    if (!match) return text;
    const url = new URL(match[0]);
    const clean = url.origin + url.pathname.replace(/\/$/, '');
    if (clean !== match[0].replace(/\/$/, '')) {
      return text.replace(match[0], clean);
    }
  } catch {}
  return text;
}

// Сбор конкурентов (аналогично block3_competitors, но внутри returning flow)
async function handleReturningCompetitors(ctx, session, text) {
  const lower = text.toLowerCase().trim();

  if (session.awaitingInstagramDesc) {
    const handle = session.pendingInstagramHandle;
    session.competitorNames.push(`${handle} (Instagram) — описание от клиента: ${text}`);
    session.awaitingInstagramDesc = false;
    session.pendingInstagramHandle = null;
    await ctx.reply(
      '✓ Конкурент добавлен.\n\nДобавь ещё конкурента или напиши *готово*',
      { parse_mode: 'Markdown' }
    );
    return false;
  }

  if (lower === 'готово') {
    if (session.competitorNames.length === 0) {
      await ctx.reply(
        'Добавь хотя бы одного конкурента, или напиши *не знаю* — тогда я поищу сам.',
        { parse_mode: 'Markdown' }
      );
      return false;
    }
    return await finishCompetitors(ctx, session);
  }

  if (lower === 'не знаю' || lower === 'нет конкурентов') {
    session.competitorNames = [];
    session.autoSearchCompetitors = true;
    return await finishCompetitors(ctx, session);
    session.returningAnswers = [];
    await ctx.reply('Понял. Поищу конкурентов сам на основе профиля бизнеса.');
    await askReturningQuestion(ctx, session);
    return true;
  }

  if (isInstagram(text)) {
    session.pendingInstagramHandle = text;
    session.awaitingInstagramDesc = true;
    await ctx.reply(
      'Instagram я не могу прочитать автоматически — он требует авторизации.\n\n' +
      'Расскажи об этом конкуренте: что продают, какой контент делают, кто их аудитория?\n\n' +
      'Напиши 2-3 предложения:'
    );
    return false;
  }

  const cleaned = cleanUrl(text);
  session.competitorNames.push(cleaned);
  const note = cleaned !== text ? '\n_(длинная ссылка сокращена до домена)_' : '';
  await ctx.reply(
    `✓ Добавлен: ${cleaned}${note}\n\nДобавь ещё или напиши *готово*`,
    { parse_mode: 'Markdown' }
  );
  return false;
}

const RETURNING_QUESTIONS = [
  {
    key: 'language',
    text:
      '*Вопрос 2 — Язык контента*\n\n' +
      'На каком языке ведёшь контент сейчас?\n' +
      'И планируешь ли выходить на другие регионы — потребуется ли другой язык в будущем?',
  },
  {
    key: 'product',
    text:
      '*Вопрос 3 — Продукт и цена*\n\n' +
      'Опиши свой главный продукт или услугу — что именно покупает клиент, как это работает, сколько стоит?\n' +
      'Если есть несколько продуктов — опиши основной.',
  },
  {
    key: 'customerJourney',
    text:
      '*Вопрос 4 — Путь клиента*\n\n' +
      'Как клиент приходит к покупке? Откуда узнаёт, как принимает решение, что его останавливает?\n' +
      'Если есть типичные возражения — напиши их тоже.',
  },
  {
    key: 'contentHistory',
    text:
      '*Вопрос 5 — Контент сейчас*\n\n' +
      'Что уже пробовал в контенте — какие платформы, форматы, темы?\n' +
      'Что сработало (хоть немного), а что не зашло совсем?',
  },
  {
    key: 'goals',
    text:
      '*Вопрос 6 — Цели*\n\n' +
      'Какой главный результат хочешь получить от контента в ближайшие 3 месяца?\n' +
      'Например: больше заявок, подписчики, узнаваемость, доверие аудитории.',
  },
];

async function askReturningQuestion(ctx, session) {
  const q = RETURNING_QUESTIONS[session.questionIndex];
  if (!q) return;

  // Если это addlang-режим — язык уже известен, пропускаем вопрос автоматически
  if (session.addlangLang && q.key === 'language') {
    session.returningAnswers.push({ key: 'language', question: q.text.replace(/\*[^\*]+\*\n\n/, ''), answer: session.addlangLang });
    session.contentLanguage = session.addlangLang;
    session.questionIndex++;
    const next = RETURNING_QUESTIONS[session.questionIndex];
    if (next) await ctx.reply(next.text, { parse_mode: 'Markdown' });
    return;
  }

  await ctx.reply(q.text, { parse_mode: 'Markdown' });
}

async function handleReturningAnswer(ctx, session, text) {
  const q = RETURNING_QUESTIONS[session.questionIndex];
  session.returningAnswers.push({ key: q.key, question: q.text.replace(/\*[^\*]+\*\n\n/, ''), answer: text });

  if (q.key === 'language') {
    session.contentLanguage = text;
  }

  session.questionIndex++;

  if (session.questionIndex < RETURNING_QUESTIONS.length) {
    await askReturningQuestion(ctx, session);
    return false;
  }

  // Все 6 вопросов собраны
  return true;
}

async function buildReturningProfiles(session) {
  const bot2 = session.bot2Data;

  const allBot2Answers = [
    ...(bot2.answers || []),
    ...(bot2.answersPart1 || []),
    ...(bot2.answersPart2 || []),
    ...(bot2.paidAnswers || []),
  ];
  const bot2QA = allBot2Answers
    .map(a => `Вопрос: ${a.question || a.key}\nОтвет: ${a.answer}`)
    .join('\n\n');

  const deepQA = (session.returningAnswers || [])
    .map(a => `Тема: ${a.key}\nОтвет: ${a.answer}`)
    .join('\n\n');

  const scrapedSnippet = (bot2.scrapedContent || '').slice(0, 3000);

  // Извлекаем специфические поля из платных ответов для явного использования в блоках
  const findPaidAnswer = (...keys) => {
    const ans = allBot2Answers.find(a => keys.includes(a.key));
    return ans ? ans.answer : '';
  };
  // Сохраняем в сессию — block7 и другие блоки берут отсюда напрямую
  session.brandVoice      = findPaidAnswer('brand_voice')          || bot2.brandVoice      || '';
  session.monthlyGoal     = findPaidAnswer('content_goal_monthly') || bot2.monthlyGoal     || '';
  session.monthlyFocus    = findPaidAnswer('monthly_focus')         || bot2.monthlyFocus    || '';
  session.clientStories   = findPaidAnswer('client_stories')        || bot2.clientStories   || '';
  session.priceRange      = findPaidAnswer('price_range')           || bot2.priceRange      || '';
  session.decisionMaker   = findPaidAnswer('decision_maker')        || bot2.decisionMaker   || '';
  session.objections      = findPaidAnswer('objections')            || bot2.objections      || '';

  // Данные об существующем бизнесе клиента (собраны в бесплатном флоу, 20.06.2026)
  session.promotionChannels      = bot2.promotionChannels      || [];
  session.contentEvolutionStyle  = bot2.contentEvolutionStyle  || '';
  session.existingScreenshotPaths = bot2.existingScreenshotPaths || [];
  // existingStyleAnalysis кешируется — если уже есть в bot2 сессии, используем
  if (bot2.existingStyleAnalysis) session.existingStyleAnalysis = bot2.existingStyleAnalysis;
  // businessSiteContent из бесплатного флоу (если клиент дал URL на сайт)
  if (bot2.businessSiteContent && !session.businessSiteContent) {
    session.businessSiteContent = bot2.businessSiteContent;
  }

  // Блок дополнительного контекста для промптов
  const extraContext = [
    session.priceRange    ? `Ценовой диапазон: ${session.priceRange}` : '',
    session.decisionMaker ? `Кто принимает решение о покупке: ${session.decisionMaker}` : '',
    session.monthlyGoal   ? `Цель контента в этом месяце: ${session.monthlyGoal}` : '',
    session.monthlyFocus  ? `Что происходит в бизнесе в этом месяце: ${session.monthlyFocus}` : '',
    session.brandVoice    ? `Голос и тон бренда: ${session.brandVoice}` : '',
    session.clientStories ? `Истории клиентов и результаты: ${session.clientStories}` : '',
  ].filter(Boolean).join('\n');

  session.businessProfile = await askSonnet(`
Ты — маркетолог. Составь детальный профиль бизнеса на основе данных из двух источников.

ОПИСАНИЕ БИЗНЕСА (от владельца):
${bot2.description || ''}

МАТЕРИАЛЫ С САЙТА:
${scrapedSnippet || 'нет данных'}

ОТВЕТЫ НА БАЗОВЫЕ ВОПРОСЫ:
${bot2QA}

УГЛУБЛЁННЫЕ ОТВЕТЫ:
${deepQA}

${extraContext ? `ДОПОЛНИТЕЛЬНЫЙ КОНТЕКСТ:\n${extraContext}` : ''}

Составь структурированный профиль бизнеса:
— Что продаёт, как работает, сколько стоит (ценовой диапазон)
— Главная ценность для клиента и УТП
— Отличие от конкурентов
— Путь клиента к покупке и кто принимает решение о покупке
— Типичные возражения клиентов
— Текущий контент: что пробовали, что работало
— Голос и тон бренда
— Истории клиентов и реальные результаты (если есть)
— Цель контента в текущем месяце
— Актуальные события в бизнесе этого месяца (акции, запуски, события)
  `);

  session.audience = await askSonnet(`
Ты — маркетолог. Составь профиль целевой аудитории бизнеса.

ОПИСАНИЕ БИЗНЕСА:
${bot2.description || ''}

ОТВЕТЫ ВЛАДЕЛЬЦА:
${bot2QA}

УГЛУБЛЁННЫЕ ОТВЕТЫ:
${deepQA}

${extraContext ? `ДОПОЛНИТЕЛЬНЫЙ КОНТЕКСТ:\n${extraContext}` : ''}

Составь профиль аудитории:
— Кто идеальный клиент (демография, профессия, ситуация)
— Главная боль и проблема которую решает продукт
— Что мотивирует к покупке
— Что останавливает (страхи и возражения)
— Как принимает решение о покупке и кто участвует
— Где проводит время онлайн
  `);
}

module.exports = {
  getBot2Data,
  startReturningClientFlow,
  handleReturningChoice,
  handleReturningCompetitors,
  handleReturningAnswer,
  buildReturningProfiles,
};
