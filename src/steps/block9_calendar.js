const { askSonnet } = require('../claude');
const { STEPS } = require('../state');
const { getLangInstruction } = require('../lang');

async function sendLong(ctx, text) {
  const LIMIT = 4000;
  for (let i = 0; i < text.length; i += LIMIT) {
    await ctx.reply(text.slice(i, i + LIMIT));
  }
}

// Шаг 1 — вводная, потом ждём любого слова
async function runBlock9(ctx, session) {
  const clientGoal = session.bot2Data?.contentPlanGoal;

  if (clientGoal) {
    await ctx.reply(
      'Шаг 9 — Контент-план\n\n' +
      `Клиент выбрал цель: ${clientGoal}.\n\n` +
      'Создам один контент-план на 30 дней — заточен под эту цель.\n\n' +
      'Напиши любое слово — начнём.'
    );
  } else {
    await ctx.reply(
      'Шаг 9 — Контент-план\n\n' +
      'Как работают компании с хорошими продажами: они никогда не делают один контент-план для всех. ' +
      'Они работают с тремя "температурами" аудитории одновременно.\n\n' +
      'Холодная — видят тебя впервые. Задача: зацепить, объяснить, вызвать интерес.\n' +
      'Тёплая — знают продукт, но не купили. Задача: почему именно ты, снять сомнения.\n' +
      'Горячая / своя база — подписчики и бывшие клиенты. Задача: напомнить, вернуть, продать снова.\n\n' +
      'Ты получишь два плана:\n' +
      'План А — Привлечение и прогрев (холодная + тёплая)\n' +
      'План Б — Активация и продажи (горячая + своя база)\n\n' +
      'Соотношение успешных брендов: 50% привлечение → 30% прогрев → 20% продажа.\n\n' +
      'Напиши любое слово — начнём с Плана А.'
    );
  }

  session.step = STEPS.BLOCK9_PLAN_A;
  return true;
}

// Шаг 2 — генерируем план. Если есть цель клиента — один план, иначе Plan A из двух.
async function runBlock9PlanA(ctx, session) {
  const clientGoal = session.bot2Data?.contentPlanGoal;
  const langInstruction = getLangInstruction(session.contentLanguage);
  const biz = (session.businessProfile || '').slice(0, 1500);
  const aud = (session.audience || '').slice(0, 1000);
  const cast = session.castdevPhrases || (session.castdev || '').slice(0, 800);
  const competitorGaps = session.competitorBrief || '';
  const headlinesList = session.headlines || '';

  if (clientGoal) {
    // Клиент выбрал цель — один план под неё
    await ctx.reply(`Создаю контент-план на 30 дней (цель: ${clientGoal})... ~2 минуты.`);

    const isWarm = clientGoal.includes('существующей') || clientGoal.includes('warm');
    const goalInstruction = isWarm
      ? `Цель: конверсия в покупку, повторные продажи, реактивация базы.\nЛогика по неделям:\nНеделя 1: Новое и актуальное — анонсы, обновления\nНеделя 2: Эмоция — истории клиентов, отзывы (используй живые фразы аудитории)\nНеделя 3: Эксклюзив для своих — спецпредложение или закрытый доступ\nНеделя 4: Реферальная активация — приведи друга, сарафан`
      : `Цель: рост подписчиков, доверие, первый контакт с холодной аудиторией.\nЛогика по неделям:\nНеделя 1: Знакомство — кто мы, что делаем\nНеделя 2: Доверие — кейсы, результаты, экспертность\nНеделя 3: Почему мы — УТП, отличие от конкурентов (используй незакрытые темы конкурентов)\nНеделя 4: Первый шаг — лёгкий вход, пробный формат`;

    const plan = await askSonnet(`
Составь контент-план на 30 дней.
Пиши БЕЗ markdown-форматирования (никаких **, *, #, _) — только чистый текст.
${langInstruction}

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
ЖИВЫЕ ФРАЗЫ И СТРАХИ АУДИТОРИИ (кастдев): ${cast}
НЕЗАКРЫТЫЕ ТЕМЫ КОНКУРЕНТОВ: ${competitorGaps}
ЗАГОЛОВКИ СТАТЕЙ ЭТОГО МЕСЯЦА: ${headlinesList}
РЕГИОН: ${session.regionLabel}
ЦЕЛЬ КЛИЕНТА: ${clientGoal}

${goalInstruction}

Дай таблицу 5-6 публикаций в неделю:
День | Платформа | Формат | Тема | CTA

Темы постов согласуй с заголовками статей этого месяца — контент должен работать как единая система.
После таблицы — 3 конкретных совета по продвижению для ${session.regionLabel}.
    `, 3500);

    session.calendar = session.calendar || {};
    session.calendar.plan = plan;
    session.step = STEPS.DONE;

    await sendLong(ctx, plan);
    await ctx.reply('─────────────────────');
    await ctx.reply('✅ Контент-план готов! Цель: ' + clientGoal);
  } else {
    // Стандартный режим — два плана
    await ctx.reply('Создаю План А — Привлечение и прогрев... ~2 минуты.');

    const planA = await askSonnet(`
Составь контент-план А на 30 дней для холодной и тёплой аудитории.
Пиши БЕЗ markdown-форматирования (никаких **, *, #, _) — только чистый текст.
${langInstruction}

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
ЖИВЫЕ ФРАЗЫ И СТРАХИ АУДИТОРИИ (кастдев): ${cast}
НЕЗАКРЫТЫЕ ТЕМЫ КОНКУРЕНТОВ: ${competitorGaps}
ЗАГОЛОВКИ СТАТЕЙ ЭТОГО МЕСЯЦА: ${headlinesList}
РЕГИОН: ${session.regionLabel}

Цель: рост подписчиков и доверие.
Логика по неделям:
Неделя 1: Знакомство — кто мы, что делаем
Неделя 2: Доверие — кейсы, результаты, экспертность
Неделя 3: Почему мы — УТП, отличие от конкурентов (используй незакрытые темы конкурентов)
Неделя 4: Первый шаг — лёгкий вход, пробный формат

Дай таблицу 5-6 публикаций в неделю:
День | Платформа | Формат | Тема | Температура | CTA

Темы постов и роликов согласуй с заголовками статей этого месяца — контент должен работать как единая система.
После таблицы — 3 конкретных совета по продвижению для ${session.regionLabel}.
    `, 3500);

    session.calendar = session.calendar || {};
    session.calendar.planA = planA;
    session.step = STEPS.BLOCK9_PLAN_B;

    await sendLong(ctx, planA);
    await ctx.reply('─────────────────────');
    await ctx.reply('✅ План А готов!\n\nНапиши любое слово — создам План Б (активация и продажи).');
  }

  return true;
}

// Шаг 3 — генерируем Plan Б (только без цели клиента)
async function runBlock9PlanB(ctx, session) {
  await ctx.reply('Создаю План Б — Активация и продажи... ~2 минуты.');

  const langInstruction = getLangInstruction(session.contentLanguage);
  const biz = (session.businessProfile || '').slice(0, 1500);
  const aud = (session.audience || '').slice(0, 1000);
  const cast = session.castdevPhrases || (session.castdev || '').slice(0, 800);
  const competitorGaps = session.competitorBrief || '';
  const headlinesList = session.headlines || '';

  const planB = await askSonnet(`
Составь контент-план Б на 30 дней для горячей аудитории и своей базы подписчиков.
Пиши БЕЗ markdown-форматирования (никаких **, *, #, _) — только чистый текст.
${langInstruction}

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
ЖИВЫЕ ФРАЗЫ И СТРАХИ АУДИТОРИИ (кастдев): ${cast}
НЕЗАКРЫТЫЕ ТЕМЫ КОНКУРЕНТОВ: ${competitorGaps}
ЗАГОЛОВКИ СТАТЕЙ ЭТОГО МЕСЯЦА: ${headlinesList}
РЕГИОН: ${session.regionLabel}

Цель: конверсия в покупку, повторные продажи, рекомендации.
Логика по неделям:
Неделя 1: Новое и актуальное — анонсы, обновления
Неделя 2: Эмоция — истории клиентов, community (используй живые фразы аудитории в темах постов)
Неделя 3: Эксклюзив для своих — спецпредложение
Неделя 4: Реферальная активация — приведи друга

Дай таблицу 4-5 публикаций в неделю:
День | Платформа | Формат | Тема | Температура | CTA

Темы постов согласуй с заголовками статей этого месяца — контент должен работать как единая система.
После таблицы — 3 конкретных совета как измерять конверсию из этого контента в ${session.regionLabel}.
  `, 3500);

  session.calendar = session.calendar || {};
  session.calendar.planB = planB;
  session.step = STEPS.DONE;

  await sendLong(ctx, planB);
  await ctx.reply('─────────────────────');
  return true;
}

module.exports = { runBlock9, runBlock9PlanA, runBlock9PlanB };
