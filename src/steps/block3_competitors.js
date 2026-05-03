const { askSonnet } = require('../claude');
const { fetchPage } = require('../fetcher');
const { STEPS } = require('../state');

async function sendLong(ctx, text) {
  const LIMIT = 4000;
  if (text.length <= LIMIT) {
    await ctx.reply(text);
    return;
  }
  for (let i = 0; i < text.length; i += LIMIT) {
    await ctx.reply(text.slice(i, i + LIMIT));
  }
}

async function askForCompetitors(ctx, session) {
  session.step = STEPS.BLOCK3_INPUT;
  session.competitorNames = [];
  session.awaitingInstagramDesc = false;
  session.pendingInstagramHandle = null;

  await ctx.reply(
    'Шаг 3 — Анализ конкурентов\n\n' +
    'Зачем: конкуренты показывают дыры в рынке — темы которые они не закрывают. Это твои возможности для контента который выделит тебя.\n\n' +
    'Для каждого конкурента отправь одним сообщением название и ссылку на сайт или Telegram.\n\n' +
    'Пример:\n' +
    'Студия Иванова — artriga.lv\n' +
    'Мастерская Петровой — t.me/petrova_art\n\n' +
    '⚠️ Instagram читать не могу — он требует авторизации. Если конкурент только в Instagram — просто напиши его название, я попрошу описание.\n\n' +
    'Когда добавишь всех — напиши *готово*\n' +
    'Если не знаешь конкурентов — напиши *не знаю*',
    { parse_mode: 'Markdown' }
  );
}

function isInstagram(text) {
  return text.includes('instagram.com') || text.includes('instagr.am');
}

async function handleCompetitorInput(ctx, session, text) {
  const lower = text.toLowerCase().trim();

  // Ждём описание Instagram-конкурента от клиента
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
    session.step = STEPS.BLOCK3_COMPETITORS;
    return true;
  }

  if (lower === 'не знаю' || lower === 'нет конкурентов' || lower === 'не знаю конкурентов') {
    session.competitorNames = [];
    session.autoSearchCompetitors = true;
    session.step = STEPS.BLOCK3_COMPETITORS;
    await ctx.reply('Понял. Поищу конкурентов сам на основе профиля бизнеса — отмечу что найдено автоматически.');
    return true;
  }

  // Если клиент прислал Instagram-ссылку
  if (isInstagram(text)) {
    session.pendingInstagramHandle = text;
    session.awaitingInstagramDesc = true;
    await ctx.reply(
      'Instagram я не могу прочитать автоматически — он требует авторизации.\n\n' +
      'Ты знаешь этого конкурента — расскажи о нём:\n' +
      'что продают, какой контент делают, кто их аудитория?\n\n' +
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

async function runBlock3(ctx, session) {
  await ctx.reply('⏳ Читаю сайты конкурентов...');

  const competitorData = [];
  const failedLinks = [];

  for (const entry of session.competitorNames) {
    const urlMatch = entry.match(/https?:\/\/[^\s]+|www\.[^\s]+|[a-zA-Z0-9-]+\.[a-zA-Z]{2,}(\/[^\s]*)?/g);
    const urls = urlMatch
      ? urlMatch.map(u => u.startsWith('http') ? u : 'https://' + u)
      : [];

    let fetched = false;
    for (const url of urls) {
      const content = await fetchPage(url);
      if (content && content.length > 100) {
        competitorData.push(`КОНКУРЕНТ: ${entry}\nДанные с сайта:\n${content.slice(0, 2500)}`);
        fetched = true;
        break;
      }
    }

    if (!fetched) {
      if (urls.length > 0) {
        failedLinks.push(entry);
        competitorData.push(`КОНКУРЕНТ: ${entry}\nДАННЫЕ НЕДОСТУПНЫ — сайт не открылся.`);
      } else {
        competitorData.push(`КОНКУРЕНТ: ${entry}\nДАННЫЕ НЕДОСТУПНЫ — ссылка не указана.`);
      }
    }
  }

  if (failedLinks.length > 0) {
    await ctx.reply(
      '⚠️ Не удалось прочитать следующие ссылки:\n\n' +
      failedLinks.map(f => `• ${f}`).join('\n') +
      '\n\nАнализирую по названию — результат может быть менее точным.\n' +
      'Проверь правильность ссылок если хочешь повторить анализ позже.'
    );
  }

  const autoNote = session.autoSearchCompetitors
    ? 'Конкуренты не были указаны клиентом — найди и опиши 3-4 типичных конкурента в этой нише самостоятельно, отметь что это автоматический поиск.'
    : '';

  session.competitors = await askSonnet(`
Ты — аналитик контент-маркетинга. Проведи анализ конкурентов.

БИЗНЕС: ${session.businessProfile}
ЦЕЛЕВАЯ АУДИТОРИЯ: ${session.audience}
РЕГИОН: ${session.regionLabel}
${autoNote}

ДАННЫЕ ПО КОНКУРЕНТАМ:
${competitorData.length > 0 ? competitorData.join('\n\n') : 'Конкуренты не указаны'}

ВАЖНО: Если для конкурента написано "ДАННЫЕ НЕДОСТУПНЫ" — не придумывай ничего о нём, не строй предположений по названию. Напиши только его название и фразу "данные недоступны для анализа". Используй только факты из предоставленных данных или описания от клиента.

Составь отчёт:

## КОНКУРЕНТЫ
Описание каждого: тип бизнеса, позиционирование, каналы продвижения

## ЧТО КОНКУРЕНТЫ ДЕЛАЮТ В КОНТЕНТЕ
- Темы и форматы которые используют
- Тон коммуникации
- Что работает у их аудитории

## НЕЗАКРЫТЫЕ ТЕМЫ — НАШИ ВОЗМОЖНОСТИ
- Темы которые конкуренты игнорируют
- Боли аудитории которые никто не закрывает
- Форматы которые никто не использует
  `);

  session.step = STEPS.BLOCK4_CASTDEV;
  await sendLong(ctx, session.competitors);
  await ctx.reply('✅ Анализ конкурентов готов! Перехожу к кастдеву...');
  return true;
}

module.exports = { askForCompetitors, handleCompetitorInput, runBlock3 };
