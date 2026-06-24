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

  const biz  = (session.businessProfile || '').slice(0, 1000);
  const aud  = (session.audience || '').slice(0, 800);
  const cast = (session.castdev || '').slice(0, 800);
  const vid  = (session.videoScripts || '').slice(0, 1500);
  const car  = (session.carouselScripts || '').slice(0, 1200);
  const langInstruction = getLangInstruction(session.contentLanguage);

  // Контекст месяца и голос бренда
  const brandVoice   = session.brandVoice   || '';
  const monthlyGoal  = session.monthlyGoal  || '';
  const monthlyFocus = session.monthlyFocus || '';
  const clientContext = [
    brandVoice   ? `ГОЛОС БРЕНДА (тон и стиль): ${brandVoice}` : '',
    monthlyGoal  ? `ЦЕЛЬ КОНТЕНТА В ЭТОМ МЕСЯЦЕ: ${monthlyGoal}` : '',
    monthlyFocus ? `ЧТО ПРОИСХОДИТ В БИЗНЕСЕ СЕЙЧАС: ${monthlyFocus}` : '',
  ].filter(Boolean).join('\n');

  // Реальный язык аудитории — для фраз на обложке
  const realPhrasesBlock = session.realNichePhrases
    ? `ЖИВЫЕ ФРАЗЫ АУДИТОРИИ (Tavily): ${session.realNichePhrases.slice(0, 600)}`
    : '';
  const castdevPhrasesBlock = session.castdevPhrases
    ? `КЛЮЧЕВЫЕ СЛОВА И СТРАХИ АУДИТОРИИ: ${session.castdevPhrases.slice(0, 400)}`
    : '';

  const isProfi    = (session.paidPackageKey || '').includes('pkg_v');
  const isStandard = (session.paidPackageKey || '').includes('pkg_standard');
  const coverCount = isProfi ? 4 : isStandard ? 2 : 4;
  const highlightCount = session.highlightsBonus ? (isProfi ? 8 : isStandard ? 4 : 0) : 0;

  await ctx.reply(`Делаю ${coverCount} обложек для Reels${highlightCount ? ` + ${highlightCount} обложек Highlights` : ''}...`);

  const videoCoversPromise = askSonnet(`
Ты — арт-директор. Создай ТЗ на обложки для ${coverCount} видеороликов (Reels/Shorts/TikTok).
Пиши БЕЗ markdown-форматирования (никаких **, *, #, _) — только чистый текст.
${langInstruction}

ИНСТРУКЦИЯ — СОЗДАВАТЬ ОБЛОЖКИ СТРОГО В ЭТОМ ПОРЯДКЕ:

ШАГ 1: Изучи бизнес и аудиторию
→ Прочитай: БИЗНЕС, АУДИТОРИЯ, РЕГИОН
→ Запомни: для кого обложка, что продаёт бизнес

ШАГ 2: Пойми язык аудитории
→ Прочитай: ЖИВЫЕ ФРАЗЫ, КЛЮЧЕВЫЕ СЛОВА И СТРАХИ
→ Запомни: какими словами говорит аудитория — именно ими пиши главную фразу

ШАГ 3: Учти контекст месяца и голос бренда
→ Прочитай: ГОЛОС БРЕНДА, ЦЕЛЬ МЕСЯЦА, ЧТО ПРОИСХОДИТ В БИЗНЕСЕ
→ Главная фраза должна поддерживать цель этого месяца и звучать в тоне бренда

ШАГ 4: Привяжи к теме видео
→ Прочитай: ВИДЕОСЦЕНАРИИ
→ Каждая обложка — для конкретного видео, фраза раскрывает его тему

ШАГ 5: Напиши обложку
→ Главная фраза: 5-7 слов языком аудитории из шага 2, поддерживает цель из шага 3
→ НЕ пиши: "Узнайте как", "Мы предлагаем", "Лучший выбор" — это generic
→ ДА: фраза которую сама аудитория могла бы сказать о своей боли или желании

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
КАСТДЕВ: ${cast}
РЕГИОН: ${session.regionLabel}
${clientContext ? clientContext + '\n' : ''}${realPhrasesBlock ? realPhrasesBlock + '\n' : ''}${castdevPhrasesBlock ? castdevPhrasesBlock + '\n' : ''}
ВИДЕОСЦЕНАРИИ (темы): ${vid}

Для каждой из ${coverCount} обложек:
ОБЛОЖКА РОЛИКА [N]: [тема]
Формат: 9:16 вертикаль
Главная фраза: "[максимум 5-7 слов — языком аудитории]"
Что на изображении: [сцена/объект/человек — без людей крупным планом]
Цвет и настроение: [2-3 слова]
Стиль шрифта: [жирный/рукописный/минималистичный]
Эмоция зрителя: [одно слово]
Промпт для AI: [короткая фраза для Midjourney/DALL-E]
───────────────
  `, 3500);

  const highlightCoversPromise = highlightCount > 0 ? askSonnet(`
Ты — дизайнер. Создай ТЗ на ${highlightCount} обложек для Instagram Highlights.
Пиши БЕЗ markdown-форматирования — только чистый текст.
${langInstruction}

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}

Highlights — это круглые иконки-разделы в профиле Instagram (формат 1:1).
Придумай ${highlightCount} смысловых разделов для этого бизнеса (например: Услуги, До/После, Отзывы, Команда, Акции, FAQ и т.д.)

Для каждой обложки:
HIGHLIGHT [N]: [название раздела]
Иконка или символ: [что изображено — минималистично]
Фоновый цвет: [конкретный цвет в соответствии с брендом]
Текст на обложке: [1-2 слова, название раздела]
Промпт для AI: [промпт на английском — 1:1 квадрат, минималистичный дизайн, иконка + цвет + название раздела как текст]
───────────────
  `, 2000) : Promise.resolve('');

  const [videoCovers, highlightCovers] = await Promise.all([videoCoversPromise, highlightCoversPromise]);

  session.covers = videoCovers;
  if (highlightCount > 0) session.highlightCovers = highlightCovers;
  await ctx.reply('✅ Блок 8 — ТЗ на обложки готово (сохранено в отчёт). Создаю контент-план...');
  await runBlock9PlanA(ctx, session);
  if (session.step === STEPS.BLOCK9_PLAN_B) {
    await runBlock9PlanB(ctx, session);
  }
  return true;
}

module.exports = { runBlock8 };
