const { askSonnet } = require('../claude');
const { STEPS } = require('../state');
const { getLangInstruction } = require('../lang');
const { loadHistoryInstruction } = require('../history');

async function sendLong(ctx, text) {
  const LIMIT = 4000;
  for (let i = 0; i < text.length; i += LIMIT) {
    await ctx.reply(text.slice(i, i + LIMIT));
  }
}

const LEGAL_RULES = `ПРАВОВЫЕ ОГРАНИЧЕНИЯ ЕС/ЛАТВИЯ (обязательно соблюдать):
1. БЕЗ гарантий результата — нельзя "удвоите продажи", "гарантированный рост X%". Можно: "помогает привлекать", "способствует росту".
2. БЕЗ искусственной срочности — "только сегодня/последний шанс" только при реальном ограничении.
3. Отзывы — обезличенно, без конкретных имён и цифр заработка без явного согласия реального человека.
4. БЕЗ сравнений с конкурентами по цифрам без доказательств.
5. Мотивация через возможности, не страх.`;

function buildSharedContext(session) {
  const langInstruction = getLangInstruction(session.contentLanguage);
  const biz = (session.businessProfile || '').slice(0, 1500);
  const aud = (session.audience || '').slice(0, 1000);
  const cast = session.castdevPhrases || (session.castdev || '').slice(0, 800);
  const competitorGaps = session.competitorBrief || '';
  const headlinesList = session.headlines || '';

  const ctaPref = session.bot2Data?.ctaPreference || session.ctaPreference || '';
  const leadMagnet = session.bot2Data?.leadMagnet || session.leadMagnet || '';
  const ctaInstruction = ctaPref === 'direct_magnet'
    ? `CTA: клиент готов общаться в директе. Лид-магнит: "${leadMagnet}". Используй призывы типа "напиши слово X в директ — пришлю [лид-магнит]". Минимум 2-3 поста с таким CTA.`
    : ctaPref === 'direct_only'
    ? `CTA: клиент готов отвечать в директе, но лид-магнита нет. Используй призывы "напиши в директ — расскажу подробнее / отвечу на вопрос". Не обещай подарок.`
    : `CTA: клиент НЕ ведёт директ — не используй призывы "напиши в директ". Используй только: комментарии под постом, ссылка в bio, запись через форму/мессенджер на сайте.`;

  const pkg = session.paidPackageKey || '';
  const isProfi    = pkg.includes('pkg_v');
  const isStandard = pkg.includes('pkg_standard');

  // Полный состав пакета за месяц (все типы контента)
  // Каждая волна = ровно половина от месячного объёма
  let waveContentInstruction;
  if (isProfi) {
    waveContentInstruction =
      'Каждая волна (15 дней) содержит ровно половину месячного пакета Профи:\n' +
      '— 4 карусели (8 за месяц)\n' +
      '— 4 поста-фото (8 за месяц)\n' +
      '— 4 видео B-roll Reels/TikTok (8 за месяц)\n' +
      '— 4 обложки для Reels (8 за месяц)\n' +
      '— 7–8 Stories (15 за месяц)\n' +
      'Итого ~10–12 публикаций за 15 дней с учётом всех форматов.';
  } else if (isStandard) {
    waveContentInstruction =
      'Каждая волна (15 дней) содержит ровно половину месячного пакета Стандарт:\n' +
      '— 4 карусели (8 за месяц)\n' +
      '— 4 поста-фото (8 за месяц)\n' +
      '— 2 видео B-roll Reels/TikTok (4 за месяц)\n' +
      '— 2 обложки для Reels (4 за месяц)\n' +
      '— 7–8 Stories (15 за месяц)\n' +
      'Итого ~10–12 публикаций за 15 дней с учётом всех форматов.';
  } else {
    waveContentInstruction =
      'Каждая волна (15 дней) содержит ровно половину месячного пакета Старт:\n' +
      '— 4 карусели (8 за месяц)\n' +
      '— 4 поста-фото (8 за месяц)\n' +
      '— 7–8 Stories (15 за месяц)\n' +
      '— Видео: нет в этом пакете\n' +
      'Итого ~10–12 публикаций за 15 дней.';
  }

  const historyBlock = session.targetClientId
    ? loadHistoryInstruction(session.targetClientId)
    : '';

  // Месячная цель из Q9 — влияет на стратегию обоих планов
  const monthlyGoal = session.monthlyGoal || session.bot2Data?.contentPlanGoal || '';
  const goalContext = monthlyGoal
    ? `МЕСЯЧНАЯ ЦЕЛЬ КЛИЕНТА (учитывай в обоих волнах): ${monthlyGoal}`
    : '';

  return { langInstruction, biz, aud, cast, competitorGaps, headlinesList, ctaInstruction, waveContentInstruction, historyBlock, goalContext };
}

// Волна 1 (дни 1-15): привлечение и доверие
async function runBlock9PlanA(ctx, session) {
  const { langInstruction, biz, aud, cast, competitorGaps, headlinesList, ctaInstruction, waveContentInstruction, historyBlock, goalContext } = buildSharedContext(session);

  await ctx.reply('Создаю контент-план — Волна 1 (дни 1–15): привлечение и доверие... ~2 минуты.');

  const planA = await askSonnet(`
Составь контент-план на первые 15 дней месяца (Волна 1 — привлечение и доверие).
Пиши БЕЗ markdown-форматирования (никаких **, *, #, _) — только чистый текст.
${langInstruction}

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
ЖИВЫЕ ФРАЗЫ И СТРАХИ АУДИТОРИИ (кастдев): ${cast}
НЕЗАКРЫТЫЕ ТЕМЫ КОНКУРЕНТОВ: ${competitorGaps}
ЗАГОЛОВКИ СТАТЕЙ ЭТОГО МЕСЯЦА: ${headlinesList}
РЕГИОН: ${session.regionLabel}
${goalContext}

Задача первой волны: познакомить холодную аудиторию с брендом, завоевать доверие тёплой.
Логика по неделям:
Неделя 1 (дни 1–7): Знакомство и экспертность — кто мы, кейсы, полезные материалы, живые фразы аудитории
Неделя 2 (дни 8–15): Почему мы — УТП, незакрытые темы конкурентов, лёгкий первый шаг

СОСТАВ ВОЛНЫ 1:
${waveContentInstruction}

ПРАВИЛА CTA: ${ctaInstruction}
${LEGAL_RULES}
${historyBlock}

Дай таблицу публикаций (все форматы из состава волны, 10–12 постов за 15 дней):
День | Платформа | Формат | Тема | Температура аудитории | CTA

Распредели все типы контента равномерно. Темы постов согласуй с заголовками статей этого месяца.
После таблицы — 2 совета по распределению контента для ${session.regionLabel}.
  `, 3500);

  session.calendar = session.calendar || {};
  session.calendar.planA = planA;
  session.step = STEPS.BLOCK9_PLAN_B;

  await ctx.reply('✅ Контент-план первых 15 дней готов. Создаю план второй волны...');
  await runBlock9PlanB(ctx, session);
  return true;
}

// Волна 2 (дни 16-30): активация и продажи
async function runBlock9PlanB(ctx, session) {
  const { langInstruction, biz, aud, cast, competitorGaps, headlinesList, ctaInstruction, waveContentInstruction, historyBlock, goalContext } = buildSharedContext(session);

  await ctx.reply('Создаю контент-план — Волна 2 (дни 16–30): активация и продажи... ~2 минуты.');

  const planB = await askSonnet(`
Составь контент-план на вторые 15 дней месяца (Волна 2 — активация и продажи).
Пиши БЕЗ markdown-форматирования (никаких **, *, #, _) — только чистый текст.
${langInstruction}

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
ЖИВЫЕ ФРАЗЫ И СТРАХИ АУДИТОРИИ (кастдев): ${cast}
НЕЗАКРЫТЫЕ ТЕМЫ КОНКУРЕНТОВ: ${competitorGaps}
ЗАГОЛОВКИ СТАТЕЙ ЭТОГО МЕСЯЦА: ${headlinesList}
РЕГИОН: ${session.regionLabel}
${goalContext}

Волна 1 уже прогрела аудиторию — теперь задача: конвертировать в покупку и активировать существующих клиентов.
Логика по неделям:
Неделя 3 (дни 16–22): Углубление и доверие — истории клиентов, отзывы (обезличенно), детали продукта, сравнение вариантов
Неделя 4 (дни 23–30): Активация — эксклюзив для своих, специальное предложение, реферальная активация, призыв к действию

СОСТАВ ВОЛНЫ 2:
${waveContentInstruction}

ПРАВИЛА CTA: ${ctaInstruction}
${LEGAL_RULES}
${historyBlock}

Дай таблицу публикаций (все форматы из состава волны, ~10–12 постов за 15 дней):
День | Платформа | Формат | Тема | Температура аудитории | CTA

Распредели все типы контента равномерно. Темы постов согласуй с заголовками статей этого месяца.
После таблицы — 2 совета как измерять результат второй волны в ${session.regionLabel}.
  `, 3500);

  session.calendar = session.calendar || {};
  session.calendar.planB = planB;
  session.step = STEPS.DONE;

  await ctx.reply('✅ Блок 9 — контент-план готов (сохранён в отчёт).\n\nДни 1–15: сейчас.\nДни 16–30: будут сгенерированы заново после аналитики Metricool.');
  return true;
}

async function runBlock9(ctx, session) {
  await runBlock9PlanA(ctx, session);
  return true;
}

module.exports = { runBlock9, runBlock9PlanA, runBlock9PlanB };
