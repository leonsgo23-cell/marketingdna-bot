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

  // CTA-инструкция на основе ответа клиента про директ
  const ctaPref = session.bot2Data?.ctaPreference || session.ctaPreference || '';
  const leadMagnet = session.bot2Data?.leadMagnet || session.leadMagnet || '';
  const ctaInstruction = ctaPref === 'direct_magnet'
    ? `CTA: клиент готов общаться в директе. Лид-магнит: "${leadMagnet}". Используй призывы типа "напиши слово X в директ — пришлю [лид-магнит]". Минимум 2-3 поста с таким CTA.`
    : ctaPref === 'direct_only'
    ? `CTA: клиент готов отвечать в директе, но лид-магнита нет. Используй призывы "напиши в директ — расскажу подробнее / отвечу на вопрос". Не обещай подарок.`
    : `CTA: клиент НЕ ведёт директ — не используй призывы "напиши в директ". Используй только: комментарии под постом, ссылка в bio, запись через форму/мессенджер на сайте.`;

  // Количество видео-постов в зависимости от пакета
  const pkg = session.paidPackageKey || '';
  const videoCount = pkg.includes('pkg_v') ? 8 : pkg.includes('pkg_standard') ? 4 : 0;
  const videoInstruction = videoCount > 0
    ? `Видео (Reels/TikTok/Shorts): ровно ${videoCount} видео-постов за весь план. Не больше и не меньше.`
    : `Видео (Reels): НЕ включать видео-посты — в этом пакете видео нет.`;

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

ПРАВИЛА CTA: ${ctaInstruction}
ПРАВИЛО ВИДЕО: ${videoInstruction}

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

ПРАВИЛА CTA: ${ctaInstruction}
ПРАВИЛО ВИДЕО: ${videoInstruction}

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

  const ctaPref = session.bot2Data?.ctaPreference || session.ctaPreference || '';
  const leadMagnet = session.bot2Data?.leadMagnet || session.leadMagnet || '';
  const ctaInstruction = ctaPref === 'direct_magnet'
    ? `CTA: директ открыт, лид-магнит: "${leadMagnet}". Используй призывы с кодовым словом.`
    : ctaPref === 'direct_only'
    ? 'CTA: директ открыт, но лид-магнита нет. Призывы типа "напиши — расскажу подробнее".'
    : 'CTA: директ не ведётся. Только комментарии / ссылка в bio / форма на сайте.';
  const pkg = session.paidPackageKey || '';
  const videoCount = pkg.includes('pkg_v') ? 8 : pkg.includes('pkg_standard') ? 4 : 0;
  const videoInstruction = videoCount > 0
    ? `Видео (Reels/Shorts): ровно ${videoCount} в плане Б.`
    : 'Видео: не включать.';

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

ПРАВИЛА CTA: ${ctaInstruction}
ПРАВИЛО ВИДЕО: ${videoInstruction}

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
