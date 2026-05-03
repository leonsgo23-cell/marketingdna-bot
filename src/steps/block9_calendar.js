const { askSonnet } = require('../claude');
const { STEPS } = require('../state');

async function sendLong(ctx, text) {
  const LIMIT = 4000;
  for (let i = 0; i < text.length; i += LIMIT) {
    await ctx.reply(text.slice(i, i + LIMIT));
  }
}

// Шаг 1 — объяснение температур, потом ждём любого слова
async function runBlock9(ctx, session) {
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
  session.step = STEPS.BLOCK9_PLAN_A;
  return true;
}

// Шаг 2 — генерируем План А, потом ждём любого слова
async function runBlock9PlanA(ctx, session) {
  await ctx.reply('Создаю План А — Привлечение и прогрев... ~2 минуты.');

  const biz = (session.businessProfile || '').slice(0, 1500);
  const aud = (session.audience || '').slice(0, 1000);
  const cast = (session.castdev || '').slice(0, 800);

  const planA = await askSonnet(`
Составь контент-план А на 30 дней для холодной и тёплой аудитории.
Пиши БЕЗ markdown-форматирования (никаких **, *, #, _) — только чистый текст.

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
КАСТДЕВ: ${cast}
РЕГИОН: ${session.regionLabel}

Цель: рост подписчиков и доверие.
Логика по неделям:
Неделя 1: Знакомство — кто мы, что делаем
Неделя 2: Доверие — кейсы, результаты, экспертность
Неделя 3: Почему мы — УТП, отличие от конкурентов
Неделя 4: Первый шаг — лёгкий вход, пробный формат

Дай таблицу 5-6 публикаций в неделю:
День | Платформа | Формат | Тема | Температура | CTA

После таблицы — 3 конкретных совета по продвижению для ${session.regionLabel}.
  `, 3500);

  session.calendar = session.calendar || {};
  session.calendar.planA = planA;
  session.step = STEPS.BLOCK9_PLAN_B;

  await sendLong(ctx, planA);
  await ctx.reply('─────────────────────');
  await ctx.reply('✅ План А готов!\n\nНапиши любое слово — создам План Б (активация и продажи).');
  return true;
}

// Шаг 3 — генерируем План Б, финал
async function runBlock9PlanB(ctx, session) {
  await ctx.reply('Создаю План Б — Активация и продажи... ~2 минуты.');

  const biz = (session.businessProfile || '').slice(0, 1500);
  const aud = (session.audience || '').slice(0, 1000);
  const cast = (session.castdev || '').slice(0, 800);

  const planB = await askSonnet(`
Составь контент-план Б на 30 дней для горячей аудитории и своей базы подписчиков.
Пиши БЕЗ markdown-форматирования (никаких **, *, #, _) — только чистый текст.

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
КАСТДЕВ: ${cast}
РЕГИОН: ${session.regionLabel}

Цель: конверсия в покупку, повторные продажи, рекомендации.
Логика по неделям:
Неделя 1: Новое и актуальное — анонсы, обновления
Неделя 2: Эмоция — истории клиентов, community
Неделя 3: Эксклюзив для своих — спецпредложение
Неделя 4: Реферальная активация — приведи друга

Дай таблицу 4-5 публикаций в неделю:
День | Платформа | Формат | Тема | Температура | CTA

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
