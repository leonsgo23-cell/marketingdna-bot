const { STEPS } = require('../state');
const { Markup } = require('telegraf');

const REGIONS = {
  'Латвия / Прибалтика': 'latvia',
  'Россия / СНГ': 'russia',
  'Великобритания': 'uk',
  'США и Канада': 'usa',
  'Австралия': 'australia',
  'Германия / Австрия / Швейцария': 'dach',
  'Другой регион': 'other',
};

const WELCOME_MESSAGE =
`🧬 *Marketing DNA*

Я превращаю твой бизнес в готовый контент-пакет — от изучения продукта до сценариев для соцсетей.

*Что ты получишь на выходе:*

📊 *Семантическое ядро* — слова и фразы которыми твоя аудитория думает о продукте. Основа всего контента и SEO.

📝 *Статьи для сайта* (5 штук) — написаны под Google и AI-поиск (ChatGPT, Perplexity), чтобы тебя находили.

🎬 *Видеосценарии* (8 штук) — Reels, Shorts, TikTok с хуками под каждый сегмент аудитории.

🖼 *Карусели и фото* (10 штук) — сценарии для Instagram/LinkedIn каруселей и фото-постов.

🎯 *ТЗ на обложки* — что написать, что нарисовать, какую эмоцию вызвать.

📅 *ДВА контент-плана на 30 дней:*
• План А — рост новой аудитории и подписчиков
• План Б — продажи подписчикам и своей базе

*Как это работает:*
Мы пройдём 9 шагов. На каждом я объясню зачем он нужен и что делать. Чем точнее твои ответы — тем лучше получится контент. Всё займёт 15–20 минут.

*Поехали! Укажи регион бизнеса:*`;

async function startOnboarding(ctx, _session) {
  await ctx.reply(WELCOME_MESSAGE, {
    parse_mode: 'Markdown',
    ...Markup.keyboard(Object.keys(REGIONS).map(r => [r])).resize(),
  });
}

async function handleRegion(ctx, session, text) {
  const regionKey = Object.keys(REGIONS).find(
    k => k === text || k.toLowerCase().startsWith(text.toLowerCase().split('/')[0].trim())
  );
  if (!regionKey) {
    await ctx.reply('Выбери регион из списка ниже 👇', {
      ...Markup.keyboard(Object.keys(REGIONS).map(r => [r])).resize(),
    });
    return;
  }

  session.region = REGIONS[regionKey];
  session.regionLabel = regionKey;
  session.step = STEPS.COLLECTING_LINKS;

  await ctx.reply(
    `Регион: *${regionKey}* ✓\n\n` +
    '🔗 *Шаг 1 — Ссылки на ваш бизнес*\n\n' +
    'Зачем: изучу твой сайт и соцсети до того как задавать вопросы — контент получится точнее.\n\n' +
    'Отправляй по одной ссылке в каждом сообщении — сайт, TikTok, Telegram или любую другую страницу где есть информация о бизнесе.\n\n' +
    '⚠️ Instagram читать не могу — он закрыт для ботов. Если есть сайт или Telegram — добавь их.\n\n' +
    'Просто скопируй ссылку и вставь — принимаю в любом формате.\n\n' +
    'Когда добавишь все — напиши *готово*\n' +
    'Если ничего нет — напиши *нет сайта*',
    { parse_mode: 'Markdown', ...Markup.removeKeyboard() }
  );
}

async function handleLinks(ctx, session, text) {
  const lower = text.toLowerCase().trim();

  const noLink = lower === 'готово' || lower === 'не знаю' || lower === 'нет сайта' || lower === 'нет' || lower === 'пропустить';

  if (noLink) {
    if (session.links.length === 0 && !session.linksSkipWarned) {
      session.linksSkipWarned = true;
      await ctx.reply(
        'Без ссылок я буду задавать больше вопросов о бизнесе — это нормально.\n\n' +
        'Если всё же есть сайт или Instagram — добавь, это улучшит результат.\n' +
        'Если нет — напиши *готово* ещё раз и продолжим.',
        { parse_mode: 'Markdown' }
      );
      return false;
    }
    session.step = STEPS.BLOCK1_QUESTIONS;
    return true;
  }

  let url = null;

  if (text.startsWith('http') || text.startsWith('www.')) {
    url = text.startsWith('www.') ? 'https://' + text : text;
  } else if (text.startsWith('@')) {
    // Telegram handle: @username → https://t.me/username
    url = 'https://t.me/' + text.slice(1);
  } else if (/^[a-zA-Z0-9а-яё\-]+\.[a-zA-Zа-яё]{2,}/.test(text)) {
    // Domain without protocol: instagram.com/..., t.me/...
    url = 'https://' + text;
  }

  if (url) {
    session.links.push(url);
    await ctx.reply(
      `✓ Добавлено: ${url}\n\nДобавь ещё ссылку или напиши готово`
    );
  } else {
    await ctx.reply(
      'Не распознал ссылку — просто скопируй её из браузера или приложения и вставь.\n\nИли напиши готово чтобы продолжить без ссылок.'
    );
  }
  return false;
}

module.exports = { startOnboarding, handleRegion, handleLinks, REGIONS };
