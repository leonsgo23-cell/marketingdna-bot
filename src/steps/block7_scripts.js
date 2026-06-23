const { askSonnet, askVision } = require('../claude');
const { STEPS } = require('../state');
const { runBlock8 } = require('./block8_covers');
const { getLangInstruction } = require('../lang');
const { loadHistoryInstruction } = require('../history');

// Анализ существующего стиля клиента через Claude Vision
async function analyzeExistingStyle(screenshotPaths, businessDescription) {
  const fs = require('fs');
  const validPaths = (screenshotPaths || []).filter(p => fs.existsSync(p));
  if (validPaths.length === 0) return '';

  try {
    const prompt = `Ты анализируешь скриншоты существующего контента клиента в соцсетях для маркетингового агентства.

Бизнес клиента: ${businessDescription.slice(0, 300)}

Проанализируй скриншоты и опиши кратко (200-250 слов):
1. ВИЗУАЛЬНЫЙ СТИЛЬ — цвета, тип фото (профессиональные/любительские), оформление, текст на фото
2. ТОН ПОДАЧИ — серьёзный / дружелюбный / экспертный / личный / продающий
3. ТИП КОНТЕНТА — что преобладает (продающие / обучение / личное / кейсы / анонсы)
4. ЧТО СТОИТ СОХРАНИТЬ — что в текущем стиле работает хорошо
5. СЛОВАРЬ — как клиент общается с аудиторией, какие слова и обращения использует

Отвечай структурированно. Этот анализ используется для генерации нового контента.`;

    return await askVision(prompt, validPaths, 800);
  } catch (e) {
    console.error('[block7] Vision analysis error:', e.message);
    return '';
  }
}

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

  // Специфические поля из платной анкеты — используются явно для точности контента
  const brandVoice    = session.brandVoice    || '';
  const monthlyGoal   = session.monthlyGoal   || '';
  const monthlyFocus  = session.monthlyFocus  || '';
  const clientStories = session.clientStories || '';
  const priceRange    = session.priceRange    || '';
  const clientContext = [
    brandVoice    ? `ГОЛОС БРЕНДА (тон, стиль общения с аудиторией): ${brandVoice}` : '',
    monthlyGoal   ? `ЦЕЛЬ КОНТЕНТА В ЭТОМ МЕСЯЦЕ: ${monthlyGoal}` : '',
    monthlyFocus  ? `ЧТО ПРОИСХОДИТ В БИЗНЕСЕ В ЭТОМ МЕСЯЦЕ (акции, запуски, события): ${monthlyFocus}` : '',
    priceRange    ? `ЦЕНОВОЙ ДИАПАЗОН УСЛУГ/ПРОДУКТОВ: ${priceRange}` : '',
    clientStories ? `РЕАЛЬНЫЕ ИСТОРИИ КЛИЕНТОВ И РЕЗУЛЬТАТЫ (использовать в контенте): ${clientStories}` : '',
  ].filter(Boolean).join('\n');

  // Технические поля всегда на русском — чтобы парсер находил промпты независимо от языка контента
  const fieldNamesRule = `КРИТИЧЕСКИ ВАЖНО — ТЕХНИЧЕСКИЕ МАРКЕРЫ: все названия полей (ВИДЕО, СЦЕНА, КАРУСЕЛЬ, КАДР, СЦЕНАРИЙ, ФОТО, STORIES, Промпт для изображения, Промпт для AI-видео, Текст поверх фото, Подпись к посту, Эмоция зрителя, Настроение, Температура и т.д.) пиши ВСЕГДА на русском языке. Только содержимое полей переводи на язык клиента. Это технические маркеры — их нельзя переводить.`;

  // Реальные фразы аудитории из Tavily — собраны в Block4, используются для хуков
  const realPhrasesBlock = session.realNichePhrases
    ? `${session.realNichePhrases}\n\nИСПОЛЬЗУЙ ЭТИ ФРАЗЫ: хуки, подписи, тексты поверх видео и фото должны звучать как реальные люди из этой ниши — не как нейросеть.`
    : '';

  // Голос клиента из реальных отзывов — цитаты, боли, словарь покупателя (Block4 review search)
  const reviewPhrasesBlock = session.reviewSitePhrases
    ? `${session.reviewSitePhrases}\n\nЯЗЫК РЕАЛЬНЫХ ПОКУПАТЕЛЕЙ: вставляй их слова и цитаты в хуки и первые строки постов — аудитория должна узнавать себя с первых секунд.`
    : '';

  // Компактная выжимка живых фраз + ключевых слов + страхов (Block4 castdevPhrases — создавался для Block7)
  const castdevPhrasesBlock = session.castdevPhrases
    ? `ЖИВЫЕ ФРАЗЫ И КЛЮЧЕВЫЕ СЛОВА АУДИТОРИИ:\n${session.castdevPhrases}`
    : '';

  // Семантическое ядро — как аудитория ищет этот бизнес (Block5)
  const semBlock = sem
    ? `СЕМАНТИЧЕСКОЕ ЯДРО (реальные запросы по которым ищут этот бизнес — используй их логику при формулировке сцен и хуков):\n${sem}`
    : '';

  // Стратегия стиля изменений — выбор клиента при онбординге
  const evolutionStyleMap = {
    A: 'СТРАТЕГИЯ СТИЛЯ — СОХРАНЕНИЕ: клиент хочет продолжить в своём стиле. Контент должен органично продолжить его существующую подачу — голос, тон, визуальный стиль, подача. Улучшай исполнение и регулярность. Никаких резких изменений — эволюция, не революция.',
    B: 'СТРАТЕГИЯ СТИЛЯ — ПОСТЕПЕННЫЕ ИЗМЕНЕНИЯ: клиент готов меняться, ориентируясь на статистику. Сохраняй фирменные визуальные элементы (цвета, лого, узнаваемый стиль). Постепенно улучшай форматы, хуки, качество подачи. Первая волна — ближе к привычному, вторая — смелее.',
    C: 'СТРАТЕГИЯ СТИЛЯ — КОМПЛЕКСНОЕ ОБНОВЛЕНИЕ: клиент дал согласие на серьёзные изменения — прошлое не давало нужных результатов. Он готов менять не только стратегию и содержание, но и визуальный стиль, тон и голос бренда. Применяй лучшие практики ниши без строгих ограничений существующим стилем. Лого и конкретные фирменные знаки — сохраняй. Цветовая гамма, визуальный стиль, тон, подача — могут меняться: используй существующие элементы как отправную точку и источник деталей, но не как обязательный стандарт. Цель: контент который реально работает — не контент похожий на прошлое.',
  };
  const existingStyleBlock = evolutionStyleMap[session.contentEvolutionStyle] || '';

  // Claude Vision: анализ скриншотов существующего контента (если клиент прислал)
  // Кешируем в session.existingStyleAnalysis — при повторном запуске не анализируем заново
  if (!session.existingStyleAnalysis && session.existingScreenshotPaths?.length > 0) {
    session.existingStyleAnalysis = await analyzeExistingStyle(session.existingScreenshotPaths, biz);
  }
  const visionStyleBlock = session.existingStyleAnalysis
    ? `СУЩЕСТВУЮЩИЙ СТИЛЬ КЛИЕНТА (анализ его текущего контента в соцсетях):\n${session.existingStyleAnalysis}`
    : '';

  // Аналитика Wave1 + нишевые тренды (только для Wave2)
  const wave2Label = session.isWave2 ? ' (WAVE 2 — дни 16–30, активация и продажи)' : ' (Wave 1 — дни 1–15, привлечение и доверие)';
  const analyticsBlock = session.analyticsInsights
    ? `\nАНАЛИТИКА WAVE 1 + ТРЕНДЫ НИШИ В ДРУГИХ РЕГИОНАХ (обязательно учти при создании Wave 2):\n${session.analyticsInsights.slice(0, 2000)}`
    : '';

  // Правовые ограничения (EU 2005/29/EC, Reklāmas likums, EU AI Act)
  const legalRules = `ОБЯЗАТЕЛЬНЫЕ ПРАВОВЫЕ ОГРАНИЧЕНИЯ ЕС/ЛАТВИЯ (строго соблюдать во всех текстах):
1. БЕЗ гарантий результата — запрещено "удвоите продажи", "гарантированный рост X%", "100% результат". Разрешено: "помогает привлекать", "способствует росту", "строит доверие аудитории".
2. БЕЗ искусственной срочности — "только сегодня" и "последний шанс" только если есть реальное ограничение. Не выдумывать дефицит или дедлайны.
3. Отзывы — только обезличенно — "клиенты отмечают...", "предприниматели из этой ниши замечают..." — без конкретных имён, фамилий и точных цифр заработка.
4. БЕЗ сравнений с конкурентами по цифрам — нельзя "лучше чем X" или "дешевле чем Y" без подтверждённых данных.
5. Мотивация через возможности, не страх — нельзя "если не сделаешь это — потеряешь бизнес". Можно: "рынок меняется — время выстраивать присутствие".`;

  const ctaPref = session.bot2Data?.ctaPreference || session.ctaPreference || '';
  const leadMagnet = session.bot2Data?.leadMagnet || session.leadMagnet || '';
  const ctaInstruction = ctaPref === 'direct_magnet'
    ? `CTA: клиент готов общаться в директе. Лид-магнит: "${leadMagnet}". В каждом CTA используй призыв "напиши слово X в директ — пришлю [лид-магнит]".`
    : ctaPref === 'direct_only'
    ? `CTA: клиент готов отвечать в директе, но лид-магнита нет. Используй призывы "напиши в директ — отвечу на вопрос / расскажу подробнее". Не обещай подарок.`
    : `CTA: клиент НЕ ведёт директ. Используй только: комментарии под постом, ссылка в bio, запись через форму/мессенджер на сайте. НЕ использовать призывы "напиши в директ".`;

  if (isProfi || isStandard) {
    // ── ТАРИФЫ ПРОФИ (8 видео) и СТАНДАРТ (4 видео): B-roll ТЗ ──────────────
    const videoCount = isProfi ? 4 : 2;
    await ctx.reply(
      `Шаг 7 — AI-видео (нарративные)${wave2Label}\n\n` +
      `Создаю ${videoCount} нарративных видео-сценария.\n` +
      'Каждое видео — мини-история из 4 клипов по 8 сек: Было→Стало, Проблема→Решение и др.\n' +
      'Каждый клип получает отдельный сценарий под свою роль в истории → Veo3.\n\n' +
      '~3 минуты.'
    );

    await ctx.reply('Пишу ТЗ для AI-видео...');

    session.videoScripts = await askSonnet(`
Создай ${videoCount} коротких AI-видео (30 сек каждое = 4 клипа по 8 сек) для Reels / TikTok / Shorts.
Пиши БЕЗ markdown-форматирования — только чистый текст.
${langInstruction}
${fieldNamesRule}

ГЛАВНЫЙ ПРИНЦИП — НАРРАТИВНОЕ ВИДЕО:
Каждое видео — это мини-история из 4 клипов. Каждый клип несёт свою роль в истории.
НЕ просто 4 случайных B-roll кадра — а 4 акта единой истории которая цепляет зрителя.

ШАГ 1: Выбери нарратив для каждого видео исходя из бизнеса, аудитории и целей месяца:
  - Было → Стало: боль до / поворот / трансформация / счастливый результат
  - Проблема → Решение: проблема клиента / нарастание / появление решения / облегчение
  - День из жизни: утренняя рутина / рабочий момент / использование продукта / удовлетворение вечером
  - Сомнение → Уверенность: колебание / вопрос / открытие / действие с уверенностью
  - Как это работает: задача / шаг 1 / шаг 2 / готовый результат

ШАГ 2: Для каждого из 4 клипов пиши ОТДЕЛЬНЫЙ сценарий под его роль в истории.
Каждый клип должен работать и отдельно, и как часть целого.

ПРАВИЛА ВИЗУАЛА:
- Конкретика ниши: НЕ "laptop on desk" — ДА "tired small business owner staring blankly at screen in a small Riga shop, late evening, phone notifications ignored".
- Человек в кадре: силуэт, спина, руки, мелькает на фоне. НЕ лицо крупным планом, НЕ говорит в камеру.
- Формат: вертикальный 9:16. Стиль: фотореалистичная съёмка, как настоящая камера.
- Зритель за 5 секунд понимает: ЧТО за бизнес, ДЛЯ КОГО, и ЧТО происходит в истории.

ПРАВИЛО CTA: ${ctaInstruction}

${legalRules}

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
КАСТДЕВ: ${cast}
РЕГИОН: ${region}
${clientContext ? clientContext + '\n' : ''}${realPhrasesBlock ? realPhrasesBlock + '\n' : ''}${reviewPhrasesBlock ? reviewPhrasesBlock + '\n' : ''}${castdevPhrasesBlock ? castdevPhrasesBlock + '\n' : ''}${semBlock ? semBlock + '\n' : ''}${visionStyleBlock ? visionStyleBlock + '\n' : ''}${existingStyleBlock ? existingStyleBlock + '\n' : ''}${rawContextBlock}
${analyticsBlock}
${historyBlock}

Для каждого видео используй СТРОГО этот формат:
ВИДЕО [N]: [тема ролика — максимум 35 символов]
Нарратив: [Было → Стало / Проблема → Решение / День из жизни / Сомнение → Уверенность / Как это работает]
Эмоция зрителя: [что чувствует за первые 5 секунд — максимум 35 символов, это хук на экране]

СЦЕНА 1 (0-8 сек):
Роль: [ПРОБЛЕМА / БОЛЬ / НАЧАЛО / УТРО — что эта сцена делает в истории]
Нарратив сцены: [1-2 предложения — что конкретно происходит с персонажем и почему это важно для истории]
  EN: [English prompt: конкретная визуальная сцена отражающая роль в нарративе, vertical 9:16, photorealistic cinematic, no text, no words, no face close-ups]
  RU: [что видит зритель — 1 предложение по-русски, для проверки менеджером]
СЦЕНА 2 (8-16 сек):
Роль: [ПОВОРОТ / ПОЯВЛЕНИЕ РЕШЕНИЯ / СЕРЕДИНА ДНЯ — роль в истории]
Нарратив сцены: [что конкретно происходит]
  EN: [English prompt: visual сцена отражающая поворот истории, vertical 9:16, photorealistic, no text]
  RU: [что видит зритель]
СЦЕНА 3 (16-24 сек):
Роль: [ТРАНСФОРМАЦИЯ / ПРОЦЕСС / ОТКРЫТИЕ — роль в истории]
Нарратив сцены: [что конкретно происходит]
  EN: [English prompt: visual трансформации или процесса, vertical 9:16, photorealistic, no text]
  RU: [что видит зритель]
СЦЕНА 4 (24-30 сек):
Роль: [РЕЗУЛЬТАТ / ПОСЛЕ / УДОВЛЕТВОРЕНИЕ — эмоциональная точка истории]
Нарратив сцены: [что конкретно происходит, почему зритель хочет так же]
  EN: [English prompt: визуальный финал — результат эмоциональная точка, vertical 9:16, photorealistic, no text]
  RU: [что видит зритель]
───────────────
    `, 8000);

    await ctx.reply('✅ ТЗ для AI-видео готовы (сохранены в отчёт)');

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
${fieldNamesRule}

ФРЕЙМВОРКИ: AIDA (Внимание→Интерес→Желание→Действие), PAS (Боль→Агитация→Решение), BAB (До→После→Мост)
ТЕМПЕРАТУРЫ: Холодная (видят впервые), Тёплая (знают, выбирают), Горячая (готовы купить)

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
КАСТДЕВ: ${cast}
КЛЮЧЕВЫЕ СЛОВА: ${sem}
РЕГИОН: ${region}
${clientContext ? clientContext + '\n' : ''}${realPhrasesBlock ? realPhrasesBlock + '\n' : ''}${reviewPhrasesBlock ? reviewPhrasesBlock + '\n' : ''}${visionStyleBlock ? visionStyleBlock + '\n' : ''}${existingStyleBlock ? existingStyleBlock + '\n' : ''}${rawContextBlock}
${historyBlock}

Распредели: 3 сценария для холодной, 3 для тёплой, 2 для горячей аудитории.

ПРАВИЛО CTA: ${ctaInstruction}

${legalRules}

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

    await ctx.reply('✅ Сценарии видео готовы (сохранены в отчёт)');
  }

  // ── Карусели и фото-концепции — одинаково для обоих тарифов ─────────────────
  await ctx.reply('Пишу сценарии каруселей...');

  session.carouselScripts = await askSonnet(`
Создай 4 карусели${wave2Label}. Карусель = серия из 7 фото-постов об одной теме.
Пиши БЕЗ markdown-форматирования — только чистый текст.
${langInstruction}
${fieldNamesRule}

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
КАСТДЕВ: ${cast}
РЕГИОН: ${region}
${clientContext ? clientContext + '\n' : ''}${realPhrasesBlock ? realPhrasesBlock + '\n' : ''}${reviewPhrasesBlock ? reviewPhrasesBlock + '\n' : ''}${visionStyleBlock ? visionStyleBlock + '\n' : ''}${existingStyleBlock ? existingStyleBlock + '\n' : ''}${rawContextBlock}
${analyticsBlock}
${historyBlock}

Распредели: ${session.isWave2 ? '1 для холодной, 2 для тёплой, 1 для горячей' : '2 для холодной аудитории, 1 для тёплой, 1 для горячей'}.

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
Промпт для изображения: [EN — photorealistic photo, real camera shot, NO illustration, NO painting, NO text inside image, atmospheric scene, style, colors]
КАДР 2:
Текст поверх фото: [3-6 слов]
Подпись к посту: [1-2 предложения]
Промпт для изображения: [EN — photorealistic photo, real camera shot, NO illustration, NO painting, NO text inside image, scene, style, colors]
КАДР 3:
Текст поверх фото: [3-6 слов]
Подпись к посту: [1-2 предложения]
Промпт для изображения: [EN — photorealistic photo, real camera shot, NO illustration, NO painting, NO text inside image, scene, style, colors]
КАДР 4:
Текст поверх фото: [3-6 слов]
Подпись к посту: [1-2 предложения]
Промпт для изображения: [EN — photorealistic photo, real camera shot, NO illustration, NO painting, NO text inside image, scene, style, colors]
КАДР 5:
Текст поверх фото: [3-6 слов]
Подпись к посту: [1-2 предложения]
Промпт для изображения: [EN — photorealistic photo, real camera shot, NO illustration, NO painting, NO text inside image, scene, style, colors]
КАДР 6:
Текст поверх фото: [3-6 слов]
Подпись к посту: [1-2 предложения]
Промпт для изображения: [EN — photorealistic photo, real camera shot, NO illustration, NO painting, NO text inside image, scene, style, colors]
КАДР 7:
Текст поверх фото: [3-6 слов — призыв к действию]
Подпись к посту: [1-2 предложения + CTA]
Промпт для изображения: [EN — photorealistic photo, real camera shot, NO illustration, NO painting, NO text inside image, scene, style, colors]
Страх который снимает: [из кастдева]
───────────────
  `, 7000);

  await ctx.reply('✅ 4 карусели готовы. Пишу фото-концепции...');

  session.photoScripts = await askSonnet(`
Создай 4 фото-концепции для постов в соцсетях${wave2Label}.
Пиши БЕЗ markdown-форматирования — только чистый текст.
${langInstruction}
${fieldNamesRule}

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
РЕГИОН: ${region}
${rawContextBlock}
${analyticsBlock}
${historyBlock}

Для каждой концепции:
ФОТО [N]: [тема]
Температура: [холодная/тёплая/горячая]
Портрет: [имя]
Что на фото: [конкретная сцена]
Эмоция: [что чувствует зритель за 1 секунду]
Текст поверх фото: [короткая фраза или "без текста"]
Промпт для AI-генерации: [готовый промпт на английском — photorealistic photo style, real camera, NO illustration, NO painting, объекты, освещение, цвета, настроение]
Подпись к посту: [2-3 предложения]
CTA: [что делать дальше]
───────────────
  `, 4000);

  await ctx.reply('✅ 4 фото-концепции готовы. Пишу Stories...');

  const storiesPromptBase = `
Пиши БЕЗ markdown-форматирования — только чистый текст.
${langInstruction}
${fieldNamesRule}

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
Промпт для AI-генерации: [готовый промпт на английском — 9:16 vertical, photorealistic photo, real camera, NO illustration, NO painting, atmospheric scene, colors, mood — NO text, no words inside the image]
Интерактив: [стикер опроса / ссылка / свайп-ап / нет]
CTA: [что делает зритель]
───────────────`;

  const storiesCount = session.isWave2 ? 8 : 7;
  session.storiesScripts = await askSonnet(
    `Создай ${storiesCount} концепций для Instagram/TikTok Stories${wave2Label} (STORIES 1-${storiesCount}).\n` +
    (session.isWave2
      ? 'Распредели: 2 прогревающих, 3 продающих, 2 вовлекающих, 1 закулисная.'
      : 'Распредели: 3 прогревающих, 2 продающих, 1 вовлекающая, 1 закулисная.'
    ) + storiesPromptBase + (analyticsBlock ? `\n${analyticsBlock}` : ''),
    session.isWave2 ? 3500 : 3000
  );

  session.step = STEPS.BLOCK8_SCRIPTS;
  await ctx.reply(`✅ Блок 7 — ${storiesCount} Stories готовы. Начинаю ТЗ на обложки...`);
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
${legalRules}

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
${legalRules}

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
Промпт для изображения: [EN — photorealistic photo, real camera shot, NO illustration, NO painting, NO text inside image, atmospheric scene]
КАДР 2:
Текст поверх фото: [3-6 слов]
Подпись к посту: [1-2 предложения]
Промпт для изображения: [EN — photorealistic photo, real camera shot, NO illustration, NO painting, NO text inside image]
КАДР 3:
Текст поверх фото: [3-6 слов]
Подпись к посту: [1-2 предложения]
Промпт для изображения: [EN — photorealistic photo, real camera shot, NO illustration, NO painting, NO text inside image]
КАДР 4:
Текст поверх фото: [3-6 слов]
Подпись к посту: [1-2 предложения]
Промпт для изображения: [EN — photorealistic photo, real camera shot, NO illustration, NO painting, NO text inside image]
КАДР 5:
Текст поверх фото: [3-6 слов]
Подпись к посту: [1-2 предложения]
Промпт для изображения: [EN — photorealistic photo, real camera shot, NO illustration, NO painting, NO text inside image]
КАДР 6:
Текст поверх фото: [3-6 слов]
Подпись к посту: [1-2 предложения]
Промпт для изображения: [EN — photorealistic photo, real camera shot, NO illustration, NO painting, NO text inside image]
КАДР 7:
Текст поверх фото: [3-6 слов — CTA]
Подпись к посту: [1-2 предложения + CTA]
Промпт для изображения: [EN — photorealistic photo, real camera shot, NO illustration, NO painting, NO text inside image]
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
Промпт для AI-генерации: [EN prompt — photorealistic photo, real camera shot, NO illustration, NO painting, objects, lighting, colors, mood]
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
Промпт для AI-генерации: [EN prompt — 9:16 vertical, photorealistic photo, real camera, cinematic, NO illustration, NO text inside the image]
───────────────
`, 500);

  await ctx.reply('✅ Мини-сценарии готовы. Запускаю генерацию визуала...');
  return true;
}

module.exports = { runBlock7, runBlock7Mini };
