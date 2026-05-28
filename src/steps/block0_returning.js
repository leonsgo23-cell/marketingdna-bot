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
  session.step = STEPS.RETURNING_CHOICE;

  await ctx.reply(
    'Привет! Вижу что ты уже получал бесплатный контент-план через нашего бота.\n\n' +
    'Вот что у меня есть о твоём бизнесе:\n' +
    '✓ Чем занимаешься и что продаёшь\n' +
    '✓ Кто твоя аудитория и какую проблему решаешь\n' +
    '✓ Чем отличаешься от конкурентов\n' +
    '✓ Какой результат хочешь получить от контента\n\n' +
    'Хочешь — продолжим на основе этих данных, без повтора базовых вопросов.\n\n' +
    'Или выбери «Начать заново» — и я начну с чистого листа. Чем точнее данные — тем точнее получится контент-пакет.',
    Markup.keyboard([
      ['✅ Продолжить'],
      ['🔄 Начать заново'],
    ]).resize()
  );
}

async function handleReturningChoice(ctx, session, text) {
  const lower = text.toLowerCase().trim();

  if (lower === '✅ продолжить' || lower === 'продолжить') {
    session.step = STEPS.RETURNING_COMPETITORS;
    session.competitorNames = [];
    session.awaitingInstagramDesc = false;
    session.pendingInstagramHandle = null;

    await ctx.reply(
      'Отлично! Идём глубже — задам 6 вопросов.\n\n' +
      'Вопрос 1 — Конкуренты\n\n' +
      'Назови 2-3 конкурентов — отправляй по одному: название + ссылка на сайт или Telegram.\n\n' +
      'Пример:\n' +
      'Студия Иванова — artriga.lv\n' +
      'Мастерская Петровой — t.me/petrova_art\n\n' +
      '⚠️ Instagram читать не могу — он требует авторизации. Если конкурент только в Instagram — просто напиши его название, я попрошу описание.\n\n' +
      'Я изучу сайты конкурентов и найду:\n' +
      '— что они делают хорошо и что даёт результат\n' +
      '— какие темы они не закрывают — это твои свободные возможности\n\n' +
      'Когда добавишь всех — напиши: готово\n' +
      'Если не знаешь конкурентов — напиши: не знаю',
      Markup.removeKeyboard()
    );
    return 'competitors';
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

function isInstagram(text) {
  return text.includes('instagram.com') || text.includes('instagr.am');
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
    session.step = STEPS.RETURNING_QUESTIONS;
    session.questionIndex = 0;
    session.returningAnswers = [];
    await askReturningQuestion(ctx, session);
    return true;
  }

  if (lower === 'не знаю' || lower === 'нет конкурентов') {
    session.competitorNames = [];
    session.autoSearchCompetitors = true;
    session.step = STEPS.RETURNING_QUESTIONS;
    session.questionIndex = 0;
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

  session.competitorNames.push(text);
  await ctx.reply(
    `✓ Добавлен: ${text}\n\nДобавь ещё или напиши *готово*`,
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

  const bot2QA = (bot2.answers || [])
    .map(a => `Вопрос: ${a.question}\nОтвет: ${a.answer}`)
    .join('\n\n');

  const deepQA = session.returningAnswers
    .map(a => `Тема: ${a.key}\nОтвет: ${a.answer}`)
    .join('\n\n');

  const scrapedSnippet = (bot2.scrapedContent || '').slice(0, 3000);

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

Составь структурированный профиль бизнеса:
— Что продаёт, как работает, сколько стоит
— Главная ценность для клиента
— УТП и отличие от конкурентов
— Путь клиента к покупке и типичные возражения
— Текущий контент: что пробовали, что работает
— Цели на ближайшие 3 месяца
— Язык контента и планы по регионам
  `);

  session.audience = await askSonnet(`
Ты — маркетолог. Составь профиль целевой аудитории бизнеса.

ОПИСАНИЕ БИЗНЕСА:
${bot2.description || ''}

ОТВЕТЫ ВЛАДЕЛЬЦА:
${bot2QA}

УГЛУБЛЁННЫЕ ОТВЕТЫ:
${deepQA}

Составь профиль аудитории:
— Кто идеальный клиент (демография, профессия, ситуация)
— Главная боль и проблема которую решает продукт
— Что мотивирует к покупке
— Что останавливает (страхи и возражения)
— Как принимает решение о покупке
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
