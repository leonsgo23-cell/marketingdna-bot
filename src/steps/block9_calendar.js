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

// Шаг 1 — вводная, потом ждём любого слова
async function runBlock9(ctx, session) {
  const clientGoal = session.bot2Data?.contentPlanGoal;

  // runBlock9 теперь просто запускает PlanA напрямую — без ожидания ввода
  await runBlock9PlanA(ctx, session);
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

  // История предыдущих месяцев — не повторять темы
  const historyBlock = session.targetClientId
    ? loadHistoryInstruction(session.targetClientId)
    : '';

  if (clientGoal) {
    // Клиент выбрал цель — один план на 15 дней
    await ctx.reply(`Создаю контент-план на 15 дней (цель: ${clientGoal})... ~2 минуты.`);

    const isWarm = clientGoal.includes('существующей') || clientGoal.includes('warm');
    const goalInstruction = isWarm
      ? `Цель: конверсия в покупку, повторные продажи, реактивация базы.\nЛогика по неделям:\nНеделя 1: Новое и актуальное — анонсы, истории клиентов, отзывы\nНеделя 2: Активация — эксклюзив для своих, реферальная активация`
      : `Цель: рост подписчиков, доверие, первый контакт с холодной аудиторией.\nЛогика по неделям:\nНеделя 1: Знакомство и доверие — кто мы, кейсы, экспертность\nНеделя 2: Почему мы — УТП, отличие от конкурентов, лёгкий первый шаг`;

    const plan = await askSonnet(`
Составь контент-план на 15 дней.
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
${historyBlock}

Дай таблицу 5-6 публикаций в неделю (всего ~10-12 постов за 15 дней):
День | Платформа | Формат | Тема | CTA

Темы постов согласуй с заголовками статей этого месяца — контент должен работать как единая система.
После таблицы — 3 конкретных совета по продвижению для ${session.regionLabel}.
    `, 3500);

    session.calendar = session.calendar || {};
    session.calendar.plan = plan;
    session.step = STEPS.DONE;

    await sendLong(ctx, plan);
    await ctx.reply('─────────────────────');
    await ctx.reply('✅ Контент-план на 15 дней готов! Цель: ' + clientGoal);
  } else {
    // Стандартный режим — два плана по 15 дней
    await ctx.reply('Создаю План А — Привлечение и прогрев (15 дней)... ~2 минуты.');

    const planA = await askSonnet(`
Составь контент-план А на 15 дней для холодной и тёплой аудитории.
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
Неделя 1: Знакомство и доверие — кто мы, кейсы, экспертность
Неделя 2: Почему мы — УТП, отличие от конкурентов (используй незакрытые темы конкурентов), лёгкий первый шаг

ПРАВИЛА CTA: ${ctaInstruction}
ПРАВИЛО ВИДЕО: ${videoInstruction}

Дай таблицу 5-6 публикаций в неделю (всего ~10-12 постов за 15 дней):
День | Платформа | Формат | Тема | Температура | CTA

Темы постов и роликов согласуй с заголовками статей этого месяца — контент должен работать как единая система.
После таблицы — 3 конкретных совета по продвижению для ${session.regionLabel}.
    `, 3500);

    session.calendar = session.calendar || {};
    session.calendar.planA = planA;
    session.step = STEPS.BLOCK9_PLAN_B;

    await sendLong(ctx, planA);
    await ctx.reply('─────────────────────');
    await ctx.reply('✅ План А готов! Создаю План Б — Активация и продажи...');
    await runBlock9PlanB(ctx, session);
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
Составь контент-план Б на 15 дней для горячей аудитории и своей базы подписчиков.
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
Неделя 1: Новое и эмоция — анонсы, истории клиентов (используй живые фразы аудитории)
Неделя 2: Активация — эксклюзив для своих, реферальная активация, спецпредложение

ПРАВИЛА CTA: ${ctaInstruction}
ПРАВИЛО ВИДЕО: ${videoInstruction}

Дай таблицу 4-5 публикаций в неделю (всего ~8-10 постов за 15 дней):
День | Платформа | Формат | Тема | Температура | CTA

Темы постов согласуй с заголовками статей этого месяца — контент должен работать как единая система.
После таблицы — 3 конкретных совета как измерять конверсию из этого контента в ${session.regionLabel}.
  `, 3500);

  session.calendar = session.calendar || {};
  session.calendar.planB = planB;
  session.step = STEPS.DONE;

  await sendLong(ctx, planB);
  await ctx.reply('─────────────────────');
  await ctx.reply('✅ Контент-план готов! План А (привлечение) + План Б (продажи) — по 15 дней каждый.');
  return true;
}

module.exports = { runBlock9, runBlock9PlanA, runBlock9PlanB };
