const { askSonnet } = require('../claude');
const { STEPS } = require('../state');
const { runBlock8 } = require('./block8_covers');
const { getLangInstruction } = require('../lang');

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
      'детали, руки, пространство, продукт, движение. Готово к загрузке в Kling AI.\n\n' +
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

Для каждого ТЗ:
ВИДЕО [N]: [тема ролика]
Длительность: [5 / 7 / 10 секунд]
Настроение: [спокойное / динамичное / тёплое / профессиональное / атмосферное]
Что в кадре: [конкретная сцена — предметы, пространство, движение, детали]
Движение камеры: [медленный наезд / статика / плавное движение вправо / etc]
Освещение: [естественный свет / студийный / золотой час / etc]
Цвета: [тёплые / холодные / нейтральные / яркие]
Промпт для Kling AI: [готовый промпт на английском языке — 1-2 предложения]
Эмоция зрителя: [что чувствует за 5 секунд]
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
Создай 8 сценариев каруселей для Instagram/LinkedIn.
Пиши БЕЗ markdown-форматирования — только чистый текст.
${langInstruction}

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
КАСТДЕВ: ${cast}
РЕГИОН: ${region}
${rawContextBlock}

Распредели: 3 для холодной, 3 для тёплой, 2 для горячей.

Каждый слайд карусели = мини фото-пост. Два отдельных поля:
Текст поверх фото = 3-6 слов, короткий удар. Примеры:
✅ "Контент без плана — убыток"
✅ "Один пост = один клиент"
✅ "Конкуренты уже это делают"
Подпись = 1-2 предложения, раскрывает текст на фото, идёт под изображением.

Для каждой карусели:
КАРУСЕЛЬ [N]: [тема]
Температура: [холодная/тёплая/горячая]
Фреймворк: [AIDA/PAS/BAB]
Портрет: [имя]
Слайд 1:
Текст поверх фото: [3-6 слов]
Подпись: [1-2 предложения]
Промпт изображения: [EN — NO text inside image, atmospheric scene, style, colors]
Слайд 2:
Текст поверх фото: [3-6 слов]
Подпись: [1-2 предложения]
Промпт изображения: [EN — NO text inside image, scene, style, colors]
Слайд 3:
Текст поверх фото: [3-6 слов]
Подпись: [1-2 предложения]
Промпт изображения: [EN — NO text inside image, scene, style, colors]
Слайд 4:
Текст поверх фото: [3-6 слов]
Подпись: [1-2 предложения]
Промпт изображения: [EN — NO text inside image, scene, style, colors]
Слайд 5:
Текст поверх фото: [3-6 слов]
Подпись: [1-2 предложения]
Промпт изображения: [EN — NO text inside image, scene, style, colors]
Слайд 6:
Текст поверх фото: [3-6 слов]
Подпись: [1-2 предложения]
Промпт изображения: [EN — NO text inside image, scene, style, colors]
Слайд 7 (CTA):
Текст поверх фото: [3-6 слов — призыв]
Подпись: [1-2 предложения + CTA]
Промпт изображения: [EN — NO text inside image, scene, style, colors]
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
  await ctx.reply('Пишу концепции для Stories...');

  session.storiesScripts = await askSonnet(`
Создай 15 концепций для Instagram/TikTok Stories.
Пиши БЕЗ markdown-форматирования — только чистый текст.
${langInstruction}

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
КАСТДЕВ: ${cast}
РЕГИОН: ${region}
${rawContextBlock}

Распредели по типам: 5 прогревающих, 4 продающих, 3 вовлекающих (опрос/вопрос), 3 закулисных.
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
───────────────
  `, 5000);

  await sendLong(ctx, session.storiesScripts);
  await ctx.reply('─────────────────────');

  session.step = STEPS.BLOCK8_SCRIPTS;
  await ctx.reply('✅ Готово! Начинаю ТЗ на обложки...');
  await runBlock8(ctx, session);
  return true;
}

module.exports = { runBlock7 };
