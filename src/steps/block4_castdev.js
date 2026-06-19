const { askSonnet, ask, HAIKU } = require('../claude');
const { STEPS } = require('../state');
const { search } = require('../tavily');

// Ищет реальные фразы аудитории в нише через Tavily — best-effort, не ломает генерацию
async function searchRealNichePhrases(businessProfile, region, contentLanguage) {
  try {
    // Haiku генерирует 2 поисковых запроса под конкретный бизнес
    const queryRaw = await ask(
      `Business: "${businessProfile.slice(0, 400)}", region: "${region}".
Generate 2 short search queries in Russian to find real customer reviews and comments about this type of business.
Return ONLY a JSON array of 2 strings, no markdown.
Example: ["кофейня Рига отзывы клиентов", "пекарня что говорят покупатели"]`,
      { model: HAIKU, maxTokens: 120 }
    );

    let queries = [];
    try {
      const m = queryRaw.match(/\[[\s\S]*?\]/);
      if (m) queries = JSON.parse(m[0]);
    } catch {}
    if (!queries.length) return '';

    // Поиск параллельно по двум запросам
    const results = await Promise.all(queries.slice(0, 2).map(q => search(q, 4)));
    const combined = results.filter(Boolean).join('\n\n').slice(0, 3000);
    if (!combined.trim()) return '';

    // Haiku извлекает живые фразы из результатов
    const phrases = await ask(
      `From these search results, extract 8-10 real phrases that actual customers use when talking about this type of business.
Focus on: how they describe the problem, what they want, how they feel, what language they use.
Write ONLY the phrases, one per line starting with "—". No analysis, no comments.

RESULTS:
${combined}`,
      { model: HAIKU, maxTokens: 400 }
    );

    if (!phrases.trim()) return '';
    return `РЕАЛЬНЫЕ ФРАЗЫ аудитории из интернет-отзывов в этой нише:\n${phrases.trim()}`;
  } catch {
    return ''; // если Tavily недоступен — продолжаем без реальных фраз
  }
}

// Ищет реальные отзывы клиентов на сайтах отзывов — извлекает живой голос покупателя
async function searchReviewSitePhrases(businessProfile, region) {
  try {
    const queryRaw = await ask(
      `Business: "${businessProfile.slice(0, 400)}", region: "${region}".
Generate 3 short search queries in Russian to find real customer reviews and testimonials about this type of business (review sites, forums, complaints, praise).
Return ONLY a JSON array of 3 strings, no markdown.
Example: ["отзывы клиентов кофейня Рига", "форум покупатели о пекарне плюсы минусы", "что говорят клиенты о стоматологии"]`,
      { model: HAIKU, maxTokens: 150 }
    );

    let queries = [];
    try {
      const m = queryRaw.match(/\[[\s\S]*?\]/);
      if (m) queries = JSON.parse(m[0]);
    } catch {}
    if (!queries.length) return '';

    const results = await Promise.all(queries.slice(0, 3).map(q => search(q, 5)));
    const combined = results.filter(Boolean).join('\n\n').slice(0, 4000);
    if (!combined.trim()) return '';

    const analysis = await ask(
      `Analyze these search results (reviews, forums, testimonials) and extract the authentic voice of real customers in this niche.

1. РЕАЛЬНЫЕ БОЛИ (3-5 самых частых жалоб/проблем из отзывов):
— [фраза]

2. РЕАЛЬНЫЕ ПОХВАЛЫ (3-5 самых частых плюсов из отзывов):
— [фраза]

3. ЖИВЫЕ ЦИТАТЫ (8-10 точных фраз которыми клиент описывает проблему или результат):
— "[цитата]"

4. СЛОВАРЬ ПОКУПАТЕЛЯ (конкретные слова и выражения реальных клиентов — НЕ маркетинговые термины):
— [слово/выражение]

Write ONLY in Russian. Real language only — no marketing copy.

SEARCH RESULTS:
${combined}`,
      { model: HAIKU, maxTokens: 700 }
    );

    if (!analysis.trim()) return '';
    return `ГОЛОС КЛИЕНТА ИЗ РЕАЛЬНЫХ ОТЗЫВОВ В НИШЕ (${region}):\n${analysis.trim()}`;
  } catch {
    return '';
  }
}

async function runBlock4(ctx, session) {
  await ctx.reply(
    '🧠 Шаг 4 — Кастдев\n\n' +
    'Провожу виртуальные интервью с каждым портретом аудитории — выясняю мотивы, страхи и живые слова которыми они думают о продукте. Параллельно собираю реальные фразы из отзывов в нише.\n\n~3 минуты.'
  );

  const businessSummary = (session.businessProfile || '').slice(0, 1500);
  const audienceSummary = (session.audience || '').slice(0, 2500);

  // Оба поиска параллельно: общие фразы ниши + отзывы с сайтов отзывов
  const [realPhrases, reviewPhrases] = await Promise.all([
    searchRealNichePhrases(businessSummary, session.regionLabel || '', session.contentLanguage || 'ru'),
    searchReviewSitePhrases(businessSummary, session.regionLabel || ''),
  ]);

  if (realPhrases) session.realNichePhrases = realPhrases;
  if (reviewPhrases) session.reviewSitePhrases = reviewPhrases;

  session.castdev = await askSonnet(`
Ты — эксперт по кастдеву. Проведи виртуальные глубинные интервью с покупателями.

ЛЕСТНИЦА ОСОЗНАННОСТИ (Бен Хант, 1-5):
1 — не знает о проблеме, 2 — знает проблему, 3 — ищет решение, 4 — сравнивает варианты, 5 — готов купить

БИЗНЕС: ${businessSummary}
АУДИТОРИЯ (3 портрета): ${audienceSummary}
РЕГИОН: ${session.regionLabel}
${realPhrases ? `\n${realPhrases}\n\nВАЖНО: Живые фразы выше — это как реально говорит аудитория в этой нише. Используй их стиль и лексику при составлении цитат портретов.\n` : ''}${reviewPhrases ? `\n${reviewPhrases}\n\nЦИТАТЫ ИЗ ОТЗЫВОВ: живые слова реальных покупателей выше — вставляй их стиль и лексику в цитаты портретов. Это не маркетинг — это как клиенты реально думают и говорят.\n` : ''}
Для каждого из 3 портретов:

ПОРТРЕТ [N] — [имя]
Ступень осознанности (1-5): [ступень + одна фраза почему]
Главные мотивы: (3 пункта)
Страхи и как снять в контенте: (3 пункта — страх → способ снятия)
Триггеры покупки: (2-3 пункта)
Живые фразы которыми говорит о проблеме: (3 цитаты в кавычках — на языке как говорит реальная аудитория)
Что заставит подписаться: (2 пункта)
Что заставит купить: (2 пункта)

---
СВОДНЫЙ ВЫВОД:
Топ-3 инсайта для всего контента:
Главные страхи для снятия в роликах:
Ключевые слова и фразы для хуков и заголовков:
  `, 5000);

  // Компактное поле с живыми фразами — для Block6, Block7, Block9
  session.castdevPhrases = await askSonnet(`
Из кастдева ниже выпиши ТОЛЬКО живые фразы и ключевые слова аудитории.
Пиши БЕЗ markdown-форматирования — только чистый текст.

КАСТДЕВ:
${session.castdev}

Выведи в формате:

ЖИВЫЕ ФРАЗЫ (цитаты как говорит аудитория о проблеме):
— [фраза]
— [фраза]
(все фразы из всех портретов)

КЛЮЧЕВЫЕ СЛОВА И ВЫРАЖЕНИЯ ДЛЯ ХУКОВ:
— [слово/фраза]
— [слово/фраза]
(все ключевые слова из сводного вывода)

ГЛАВНЫЕ СТРАХИ:
— [страх]
— [страх]
(все страхи из всех портретов)
  `, 1200);

  session.step = STEPS.BLOCK5_SEMANTICS;
  await ctx.reply('✅ Блок 4 — кастдев готов (сохранён в отчёт). Строю семантическое ядро...');
  return true;
}

module.exports = { runBlock4 };
