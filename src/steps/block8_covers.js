const { askSonnet } = require('../claude');
const { STEPS } = require('../state');

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

  await ctx.reply('Делаю обложки для роликов...');

  const videoCovers = await askSonnet(`
Ты — арт-директор. Создай ТЗ на обложки для 8 видеороликов (Reels/Shorts/TikTok).
Пиши БЕЗ markdown-форматирования (никаких **, *, #, _) — только чистый текст.

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
ВИДЕОСЦЕНАРИИ (темы): ${vid}
РЕГИОН: ${session.regionLabel}

Для каждой из 8 обложек:
ОБЛОЖКА РОЛИКА [N]: [тема]
Формат: 9:16 вертикаль
Главная фраза: "[максимум 5-7 слов]"
Что на изображении: [сцена/объект/человек]
Цвет и настроение: [2-3 слова]
Стиль шрифта: [жирный/рукописный/минималистичный]
Эмоция зрителя: [одно слово]
Промпт для AI: [короткая фраза для Midjourney/DALL-E]
───────────────
  `, 3500);

  await sendLong(ctx, videoCovers);
  await ctx.reply('─────────────────────');
  await ctx.reply('Делаю обложки для каруселей...');

  const carouselCovers = await askSonnet(`
Ты — арт-директор. Создай ТЗ на обложки для 5 каруселей (Instagram/LinkedIn).
Пиши БЕЗ markdown-форматирования (никаких **, *, #, _) — только чистый текст.

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
КАРУСЕЛИ (темы): ${car}
РЕГИОН: ${session.regionLabel}

Для каждой из 5 обложек:
ОБЛОЖКА КАРУСЕЛИ [N]: [тема]
Формат: 1:1 квадрат
Главная фраза: "[максимум 5-7 слов]"
Что на изображении: [сцена/объект/человек]
Цвет и настроение: [2-3 слова]
Стиль шрифта: [жирный/рукописный/минималистичный]
Эмоция зрителя: [одно слово]
Промпт для AI: [короткая фраза для Midjourney/DALL-E]
───────────────
  `, 2500);

  await sendLong(ctx, carouselCovers);
  await ctx.reply('─────────────────────');

  session.covers = videoCovers + '\n\n' + carouselCovers;
  session.step = STEPS.BLOCK9_CALENDAR;
  await ctx.reply('✅ ТЗ на обложки готово!\n\nОстался последний шаг — контент-план на 60 дней.\n\nНапиши: контент-план');
  return true;
}

module.exports = { runBlock8 };
