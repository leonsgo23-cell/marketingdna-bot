const { askSonnet } = require('../claude');
const { STEPS } = require('../state');
const { runBlock8 } = require('./block8_covers');
const { getLangInstruction } = require('../lang');
const { loadHistoryInstruction } = require('../history');

async function sendLong(ctx, text) {
  const LIMIT = 4000;
  for (let i = 0; i < text.length; i += LIMIT) {
    await ctx.reply(text.slice(i, i + LIMIT));
  }
}

async function runBlock7(ctx, session) {
  const isProfi    = (session.paidPackageKey || '').includes('pkg_v');
  const isStandard = (session.paidPackageKey || '').includes('pkg_standard');
  const langInstruction = getLangInstruction(session.contentLanguage);
  const biz = (session.businessProfile || '').slice(0, 1500);
  const aud = (session.audience || '').slice(0, 1500);
  const cast = (session.castdev || '').slice(0, 1500);
  const sem = (session.semanticCore || '').slice(0, 1000);
  const region = session.regionLabel;

  // Raw Q&A answers from client — preserves specific details lost in summaries
  const rawAnswers1 = (session.block1Answers || [])
    .map(a => `Q: ${a.question}\nA: ${a.answer}`).join('\n').slice(0, 1500);
  const rawAnswers2 = (session.block2Answers || [])
    .map(a => `Q: ${a.question}\nA: ${a.answer}`).join('\n').slice(0, 1000);
  const rawContext = [rawAnswers1, rawAnswers2].filter(Boolean).join('\n\n');
  const rawContextBlock = rawContext
    ? `ПРЯМЫЕ ОТВЕТЫ КЛИЕНТА НА ВОПРОСЫ АНКЕТЫ (используй для деталей — визуальный стиль, наличие людей в кадре, предпочтения):\n${rawContext}`
    : '';

  // История предыдущих месяцев — чтобы не повторять темы
  const historyBlock = session.targetClientId
    ? loadHistoryInstruction(session.targetClientId)
    : '';

  const ctaPref = session.bot2Data?.ctaPreference || session.ctaPreference || '';
  const leadMagnet = session.bot2Data?.leadMagnet || session.leadMagnet || '';
  const ctaInstruction = ctaPref === 'direct_magnet'
    ? `CTA: клиент готов общаться в директе. Лид-магнит: "${leadMagnet}". В каждом CTA используй призыв "напиши слово X в директ — пришлю [лид-магнит]".`
    : ctaPref === 'direct_only'
    ? `CTA: клиент готов отвечать в директе, но лид-магнита нет. Используй призывы "напиши в директ — отвечу на вопрос / расскажу подробнее". Не обещай подарок.`
    : `CTA: клиент НЕ ведёт директ. Используй только: комментарии под постом, ссылка в bio, запись через форму/мессенджер на сайте. НЕ использовать призывы "напиши в директ".`;

  if (isProfi || isStandard) {
    // ── ТАРИФЫ ПРОФИ (8 видео) и СТАНДАРТ (4 видео): B-roll ТЗ ──────────────
    const videoCount = isProfi ? 8 : 4;
    await ctx.reply(
      'Шаг 7 — AI-видео B-roll\n\n' +
      `Создаю ${videoCount} технических задания для генерации коротких AI-видео (B-roll).\n` +
      'Каждое ТЗ — атмосферный ролик 5-10 сек без человека в главной роли: ' +
      'детали, руки, пространство, продукт, движение. Генерируется через Kie.ai Veo3.\n\n' +
      '~3 минуты.'
    );

    await ctx.reply('Пишу ТЗ для AI-видео...');

    session.videoScripts = await askSonnet(`
Создай ${videoCount} технических задания (ТЗ) для генерации коротких AI B-roll видео (5-10 секунд каждое).
Это видео для Reels / TikTok / Shorts бизнеса.
Пиши БЕЗ markdown-форматирования — только чистый текст.
${langInstruction}

Тип видео: B-roll (атмосфера, детали, продукт, пространство).
Человек в кадре — только если это силуэт, спина, руки или мелькает на фоне. НЕ talking head, НЕ человек говорит в камеру.

ПРАВИЛО CTA: ${ctaInstruction}

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
КАСТДЕВ: ${cast}
РЕГИОН: ${region}
${rawContextBlock}
${historyBlock}

Для каждого ТЗ:
ВИДЕО [N]: [тема ролика]
Длительность: [5 / 7 / 10 секунд]
Настроение: [спокойное / динамичное / тёплое / профессиональное / атмосферное]
Что в кадре: [конкретная сцена — предметы, пространство, движение, детали]
Движение камеры: [медленный наезд / статика / плавное движение вправо / etc]
Освещение: [естественный свет / студийный / золотой час / etc]
Цвета: [тёплые / холодные / нейтральные / яркие]
Промпт для AI-видео: [готовый промпт на английском языке — 1-2 предложения]
Эмоция зрителя: [что чувствует за 5 секунд]

ЛИМИТЫ ТЕКСТА НА ЭКРАНЕ (строго):
Эмоция зрителя (хук) — максимум 35 символов. Это одна строка на экране.
Тема (заголовок ВИДЕО N) — максимум 35 символов. Одна строка.
CTA — максимум 70 символов (2 строки по 35). Мысль ОБЯЗАТЕЛЬНО законченная.
Считай символы. Не обрезай слова — умести мысль в лимит целиком.
───────────────
    `, 6000);

    await sendLong(ctx, session.videoScripts);
    await ctx.reply('─────────────────────');

  } else {
    // ── ТАРИФ СТАРТ: сценарии "человек в кадре" — подарок ────────────────────
    await ctx.reply(
      'Шаг 7 — Сценарии для видео\n\n' +
      '🎁 Подарок от нас: 8 сценариев для коротких видео где вы в кадре.\n' +
      'Это не часть тарифа — мы дарим их чтобы вы могли снять видео самостоятельно на телефон.\n' +
      'Каждый сценарий написан под конкретный портрет аудитории по фреймворку AIDA, PAS или BAB.\n\n' +
      '~4 минуты.'
    );

    await ctx.reply('Пишу сценарии...');

    session.videoScripts = await askSonnet(`
Создай 8 сценариев для коротких видео (Reels / YouTube Shorts / TikTok) где человек говорит в камеру.
Пиши БЕЗ markdown-форматирования (никаких **, *, #, _) — только чистый текст.
${langInstruction}

ФРЕЙМВОРКИ: AIDA (Внимание→Интерес→Желание→Действие), PAS (Боль→Агитация→Решение), BAB (До→После→Мост)
ТЕМПЕРАТУРЫ: Холодная (видят впервые), Тёплая (знают, выбирают), Горячая (готовы купить)

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
КАСТДЕВ: ${cast}
КЛЮЧЕВЫЕ СЛОВА: ${sem}
РЕГИОН: ${region}
${rawContextBlock}
${historyBlock}

Распредели: 3 сценария для холодной, 3 для тёплой, 2 для горячей аудитории.

ПРАВИЛО CTA: ${ctaInstruction}

Для каждого сценария:
СЦЕНАРИЙ [N]: [тема]
Температура: [холодная/тёплая/горячая]
Фреймворк: [AIDA/PAS/BAB]
Портрет: [имя из аудитории]

ХУК — 3 варианта первых 3 секунд:
А: [вариант]
Б: [вариант]
В: [вариант]

СЦЕНАРИЙ:
[00:00-00:03] Хук
[00:03-00:15] Развитие
[00:15-00:25] Решение/трансформация
[00:25-00:30] CTA

Страх который снимает ролик: [из кастдева]
───────────────
    `, 7000);

    await sendLong(ctx, session.videoScripts);
    await ctx.reply('─────────────────────');
  }

  // ── Карусели и фото-концепции — одинаково для обоих тарифов ─────────────────
  await ctx.reply('Пишу сценарии каруселей...');

  session.carouselScripts = await askSonnet(`
Создай 8 каруселей. Карусель = серия из 7 фото-постов об одной теме.
Пиши БЕЗ markdown-форматирования — только чистый текст.
${langInstruction}

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
КАСТДЕВ: ${cast}
РЕГИОН: ${region}
${rawContextBlock}
${historyBlock}

Распредели: 3 для холодной, 3 для тёплой, 2 для горячей.

ВАЖНО: Используй точное название бизнеса из профиля. НИКОГДА не пиши "AI-сервис", "наш сервис", "этот сервис" — только конкретное название.

ПРАВИЛО ТЕКСТА НА ФОТО: короткая фраза 3-6 слов. Именно такого формата:
"Контент без плана — убыток"
"Один пост = один клиент"
"Конкуренты уже это делают"

Для каждой карусели:
КАРУСЕЛЬ [N]: [тема]
Температура: [холодная/тёплая/горячая]
Фреймворк: [AIDA/PAS/BAB]
Портрет: [имя]
КАДР 1:
Текст поверх фото: [3-6 слов]
Подпись к посту: [1-2 предложения]
Промпт для изображения: [EN — NO text inside image, atmospheric scene, style, colors]
КАДР 2:
Текст поверх фото: [3-6 слов]
Подпись к посту: [1-2 предложения]
Промпт для изображения: [EN — NO text inside image, scene, style, colors]
КАДР 3:
Текст поверх фото: [3-6 слов]
Подпись к посту: [1-2 предложения]
Промпт для изображения: [EN — NO text inside image, scene, style, colors]
КАДР 4:
Текст поверх фото: [3-6 слов]
Подпись к посту: [1-2 предложения]
Промпт для изображения: [EN — NO text inside image, scene, style, colors]
КАДР 5:
Текст поверх фото: [3-6 слов]
Подпись к посту: [1-2 предложения]
Промпт для изображения: [EN — NO text inside image, scene, style, colors]
КАДР 6:
Текст поверх фото: [3-6 слов]
Подпись к посту: [1-2 предложения]
Промпт для изображения: [EN — NO text inside image, scene, style, colors]
КАДР 7:
Текст поверх фото: [3-6 слов — призыв к действию]
Подпись к посту: [1-2 предложения + CTA]
Промпт для изображения: [EN — NO text inside image, scene, style, colors]
Страх который снимает: [из кастдева]
───────────────
  `, 7000);

  await sendLong(ctx, session.carouselScripts);
  await ctx.reply('─────────────────────');
  await ctx.reply('Пишу фото-концепции для постов...');

  session.photoScripts = await askSonnet(`
Создай 8 фото-концепций для постов в соцсетях.
Пиши БЕЗ markdown-форматирования — только чистый текст.
${langInstruction}

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
РЕГИОН: ${region}
${rawContextBlock}
${historyBlock}

Для каждой концепции:
ФОТО [N]: [тема]
Температура: [холодная/тёплая/горячая]
Портрет: [имя]
Что на фото: [конкретная сцена]
Эмоция: [что чувствует зритель за 1 секунду]
Текст поверх фото: [короткая фраза или "без текста"]
Промпт для AI-генерации: [готовый промпт на английском — стиль, объекты, освещение, цвета, настроение]
Подпись к посту: [2-3 предложения]
CTA: [что делать дальше]
───────────────
  `, 4000);

  await sendLong(ctx, session.photoScripts);
  await ctx.reply('─────────────────────');
  await ctx.reply('Пишу концепции для Stories (часть 1 из 2)...');

  const storiesPromptBase = `
Пиши БЕЗ markdown-форматирования — только чистый текст.
${langInstruction}

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
КАСТДЕВ: ${cast}
РЕГИОН: ${region}
${rawContextBlock}

Формат всех изображений: 9:16 вертикаль.

Для каждой Stories:
STORIES [N]: [тема]
Тип: [прогревающая/продающая/вовлекающая/закулисная]
Температура: [холодная/тёплая/горячая]
Текст на экране: [короткий текст — максимум 7 слов]
Что на фоне: [конкретная сцена или объект]
Промпт для AI-генерации: [готовый промпт на английском — 9:16 vertical, atmospheric scene, style, colors, mood — NO text, no words, no letters, no watermarks inside the image]
Интерактив: [стикер опроса / ссылка / свайп-ап / нет]
CTA: [что делает зритель]
───────────────`;

  const storiesPart1 = await askSonnet(
    `Создай 8 концепций для Instagram/TikTok Stories (STORIES 1-8).\nРаспредели: 3 прогревающих, 2 продающих, 2 вовлекающих, 1 закулисная.${storiesPromptBase}`,
    3000
  );

  await ctx.reply('Пишу концепции для Stories (часть 2 из 2)...');

  const storiesPart2 = await askSonnet(
    `Создай 7 концепций для Instagram/TikTok Stories (STORIES 9-15).\nРаспредели: 2 прогревающих, 2 продающих, 1 вовлекающая, 2 закулисных.${storiesPromptBase}`,
    2500
  );

  session.storiesScripts = storiesPart1 + '\n\n' + storiesPart2;
  await sendLong(ctx, session.storiesScripts);
  await ctx.reply('─────────────────────');

  session.step = STEPS.BLOCK8_SCRIPTS;
  await ctx.reply('✅ Готово! Начинаю ТЗ на обложки...');
  await runBlock8(ctx, session);
  return true;
}

// ── Лёгкая версия для /test_mini — только 1 карусель + 1 фото + 1 видео ──────
async function runBlock7Mini(ctx, session) {
  const isProfi    = (session.paidPackageKey || '').includes('pkg_v');
  const isStandard = (session.paidPackageKey || '').includes('pkg_standard');
  const langInstruction = getLangInstruction(session.contentLanguage);
  const biz  = (session.businessProfile || '').slice(0, 1500);
  const aud  = (session.audience || '').slice(0, 1000);
  const cast = (session.castdev || '').slice(0, 800);
  const region = session.regionLabel || '';
  const ctaPref = session.bot2Data?.ctaPreference || session.ctaPreference || '';
  const leadMagnet = session.bot2Data?.leadMagnet || session.leadMagnet || '';
  const ctaInstruction = ctaPref === 'direct_magnet'
    ? `CTA: напиши слово X в директ — пришлю "${leadMagnet}".`
    : ctaPref === 'direct_only'
    ? `CTA: напиши в директ — расскажу подробнее.`
    : `CTA: комментарий / ссылка в bio / форма на сайте. Не директ.`;

  await ctx.reply('🧪 Мини-тест: генерирую 1 видео ТЗ...');

  if (isProfi || isStandard) {
    session.videoScripts = await askSonnet(`
Создай 1 техническое задание для AI B-roll видео (5-10 сек).
Пиши БЕЗ markdown. ${langInstruction}
БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
ПРАВИЛО CTA: ${ctaInstruction}

ВИДЕО 1: [тема]
Длительность: [5 / 7 / 10 секунд]
Настроение: [атмосфера]
Что в кадре: [конкретная сцена]
Движение камеры: [тип]
Освещение: [тип]
Цвета: [тип]
Промпт для AI-видео: [EN prompt — 1-2 sentences]
Эмоция зрителя: [макс 35 символов]
`, 800);
  } else {
    session.videoScripts = await askSonnet(`
Создай 1 сценарий видео "человек в кадре" (Reels/TikTok, 30-60 сек).
Пиши БЕЗ markdown. ${langInstruction}
БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
ПРАВИЛО CTA: ${ctaInstruction}

СЦЕНАРИЙ 1: [тема]
А (хук, 0-3 сек): [цепляющее начало]
Б (развитие): [суть контента]
В (CTA): [призыв]
`, 600);
  }

  await ctx.reply('🧪 Мини-тест: генерирую 1 карусель...');

  session.carouselScripts = await askSonnet(`
Создай 1 карусель из 7 фото-постов.
Пиши БЕЗ markdown. ${langInstruction}

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
КАСТДЕВ: ${cast}
РЕГИОН: ${region}

ПРАВИЛО ТЕКСТА НА ФОТО: 3-6 слов.

КАРУСЕЛЬ 1: [тема]
КАДР 1:
Текст поверх фото: [3-6 слов]
Подпись к посту: [1-2 предложения]
Промпт для изображения: [EN — NO text inside image, atmospheric scene]
КАДР 2:
Текст поверх фото: [3-6 слов]
Подпись к посту: [1-2 предложения]
Промпт для изображения: [EN — NO text inside image]
КАДР 3:
Текст поверх фото: [3-6 слов]
Подпись к посту: [1-2 предложения]
Промпт для изображения: [EN — NO text inside image]
КАДР 4:
Текст поверх фото: [3-6 слов]
Подпись к посту: [1-2 предложения]
Промпт для изображения: [EN — NO text inside image]
КАДР 5:
Текст поверх фото: [3-6 слов]
Подпись к посту: [1-2 предложения]
Промпт для изображения: [EN — NO text inside image]
КАДР 6:
Текст поверх фото: [3-6 слов]
Подпись к посту: [1-2 предложения]
Промпт для изображения: [EN — NO text inside image]
КАДР 7:
Текст поверх фото: [3-6 слов — CTA]
Подпись к посту: [1-2 предложения + CTA]
Промпт для изображения: [EN — NO text inside image]
───────────────
`, 2500);

  await ctx.reply('🧪 Мини-тест: генерирую 1 фото-пост...');

  session.photoScripts = await askSonnet(`
Создай 1 фото-концепцию для поста в соцсетях.
Пиши БЕЗ markdown. ${langInstruction}

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
РЕГИОН: ${region}

ФОТО 1: [тема]
Что на фото: [конкретная сцена]
Эмоция: [что чувствует зритель]
Текст поверх фото: [короткая фраза или "без текста"]
Промпт для AI-генерации: [EN prompt — style, objects, lighting, colors, mood]
Подпись к посту: [2-3 предложения]
CTA: [призыв к действию]
Почему это зайдёт аудитории: [1-2 предложения]
───────────────
`, 800);

  await ctx.reply('🧪 Мини-тест: генерирую 1 обложку...');

  session.covers = await askSonnet(`
Создай 1 ТЗ для обложки видео (Reels/Shorts thumbnail).
Пиши БЕЗ markdown. ${langInstruction}

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}

ОБЛОЖКА 1: [тема]
Заголовок на обложке: [3-5 слов — цепляющий текст]
Что на фоне: [конкретная сцена, визуал]
Промпт для AI-генерации: [EN prompt — 9:16 vertical, cinematic, NO text inside the image]
───────────────
`, 500);

  await ctx.reply('✅ Мини-сценарии готовы. Запускаю генерацию визуала...');
  return true;
}

module.exports = { runBlock7, runBlock7Mini };
