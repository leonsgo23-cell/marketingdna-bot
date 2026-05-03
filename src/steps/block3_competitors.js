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

  await ctx.reply(
    'Шаг 3 — Анализ конкурентов\n\n' +
    'Зачем: конкуренты показывают дыры в рынке — темы которые они не закрывают. Это твои возможности для контента который выделит тебя.\n\n' +
    'Для каждого конкурента отправь одним сообщением название и ссылку.\n\n' +
    'Пример:\n' +
    'Студия Иванова — instagram.com/ivanova\n' +
    'Арт-пространство Рига — artriga.lv\n\n' +
    'Когда добавишь всех — напиши готово\n' +
    'Если не знаешь конкурентов — напиши не знаю'
  );
}

async function handleCompetitorInput(ctx, session, text) {
  const lower = text.toLowerCase().trim();

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

  session.competitorNames.push(text);
  await ctx.reply(`✓ Добавлен: ${text}\n\nДобавь ещё или напиши готово`);
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
        competitorData.push(`КОНКУРЕНТ: ${entry}\n⚠️ Не удалось получить данные — анализирую по названию.`);
      } else {
        competitorData.push(`КОНКУРЕНТ: ${entry}\n(ссылка не указана — анализирую по названию)`);
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
