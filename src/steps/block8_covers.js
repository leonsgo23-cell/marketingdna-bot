const { askSonnet } = require('../claude');
const { STEPS } = require('../state');
const { getLangInstruction } = require('../lang');
const { runBlock9, runBlock9PlanA, runBlock9PlanB } = require('./block9_calendar');

async function sendLong(ctx, text) {
  const LIMIT = 4000;
  if (text.length <= LIMIT) { await ctx.reply(text); return; }
  for (let i = 0; i < text.length; i += LIMIT) {
    await ctx.reply(text.slice(i, i + LIMIT));
  }
}

async function runBlock8(ctx, session) {
  await ctx.reply(
    'Шаг 8 — Обложки\n\n' +
    'Зачем: обложка — это первое что видит человек в ленте. ' +
    'У тебя есть 1 секунда чтобы он остановился, а не пролистал. ' +
    'Создаю точное ТЗ: что написать, что изобразить, какую эмоцию вызвать. ' +
    'Готово для Canva, Midjourney или любого AI-генератора.\n\n' +
    'Создаю ТЗ на обложки... ~3 минуты.'
  );

  const biz = (session.businessProfile || '').slice(0, 1000);
  const aud = (session.audience || '').slice(0, 800);
  const vid = (session.videoScripts || '').slice(0, 1500);
  const car = (session.carouselScripts || '').slice(0, 1200);
  const langInstruction = getLangInstruction(session.contentLanguage);

  const isProfi    = (session.paidPackageKey || '').includes('pkg_v');
  const isStandard = (session.paidPackageKey || '').includes('pkg_standard');
  const coverCount = isProfi ? 8 : isStandard ? 4 : 8;

  await ctx.reply(`Делаю ${coverCount} обложек для Reels...`);

  const videoCovers = await askSonnet(`
Ты — арт-директор. Создай ТЗ на обложки для ${coverCount} видеороликов (Reels/Shorts/TikTok).
Пиши БЕЗ markdown-форматирования (никаких **, *, #, _) — только чистый текст.
${langInstruction}

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
ВИДЕОСЦЕНАРИИ (темы): ${vid}
РЕГИОН: ${session.regionLabel}

Для каждой из ${coverCount} обложек:
ОБЛОЖКА РОЛИКА [N]: [тема]
Формат: 9:16 вертикаль
Главная фраза: "[максимум 5-7 слов]"
Что на изображении: [сцена/объект/человек — без людей крупным планом]
Цвет и настроение: [2-3 слова]
Стиль шрифта: [жирный/рукописный/минималистичный]
Эмоция зрителя: [одно слово]
Промпт для AI: [короткая фраза для Midjourney/DALL-E]
───────────────
  `, 3500);

  session.covers = videoCovers;
  await ctx.reply('✅ Блок 8 — ТЗ на обложки готово (сохранено в отчёт). Создаю контент-план...');
  await runBlock9PlanA(ctx, session);
  if (session.step === STEPS.BLOCK9_PLAN_B) {
    await runBlock9PlanB(ctx, session);
  }
  return true;
}

module.exports = { runBlock8 };
