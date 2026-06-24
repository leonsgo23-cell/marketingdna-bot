const { askSonnet } = require('../claude');
const { STEPS } = require('../state');
const { runBlock7 } = require('./block7_scripts');
const { getLangInstruction } = require('../lang');

const LEGAL_RULES = `ПРАВОВЫЕ ОГРАНИЧЕНИЯ ЕС/ЛАТВИЯ (обязательно соблюдать):
1. БЕЗ гарантий результата — нельзя "удвоите продажи", "гарантированный рост X%". Можно: "помогает привлекать", "способствует росту".
2. БЕЗ искусственной срочности — "только сегодня/последний шанс" только при реальном ограничении.
3. Отзывы — обезличенно, без конкретных имён и цифр заработка без явного согласия реального человека.
4. БЕЗ сравнений с конкурентами по цифрам без доказательств.
5. Мотивация через возможности, не страх.`;

async function runBlock6(ctx, session) {
  await ctx.reply(
    'Шаг 6 — Статьи для сайта\n\n' +
    'Зачем: статьи на сайте — это долгосрочный актив. ' +
    'Они работают 24/7: Google индексирует их и приводит людей которые ищут твой продукт. ' +
    'Плюс — AI-ассистенты (ChatGPT, Perplexity) будут цитировать твой сайт в своих ответах. ' +
    'Каждая статья написана на языке аудитории и отвечает на реальные вопросы которые они задают.\n\n' +
    'Пишу 3 статьи (1800–2500 знаков каждая)... ~2 минуты.'
  );

  const headlines = session.headlines || '';
  const castdevPhrases = session.castdevPhrases || '';
  const semanticKeywords = (session.semanticCore || '').slice(0, 2000);
  const competitorGaps = session.competitorBrief || '';
  const realNichePhrases = (session.realNichePhrases || '').slice(0, 600);

  const brandVoice    = session.brandVoice    || '';
  const monthlyGoal   = session.monthlyGoal   || '';
  const monthlyFocus  = session.monthlyFocus  || '';
  const clientStories = session.clientStories || '';
  const clientContext = [
    brandVoice    ? `ГОЛОС БРЕНДА (тон и стиль статьи должен соответствовать): ${brandVoice}` : '',
    monthlyGoal   ? `ЦЕЛЬ КОНТЕНТА В ЭТОМ МЕСЯЦЕ (статья тематически поддерживает её): ${monthlyGoal}` : '',
    monthlyFocus  ? `ЧТО ПРОИСХОДИТ В БИЗНЕСЕ СЕЙЧАС (можно упомянуть как актуальный контекст): ${monthlyFocus}` : '',
    clientStories ? `РЕАЛЬНЫЕ ИСТОРИИ КЛИЕНТОВ И РЕЗУЛЬТАТЫ (использовать как примеры в статье): ${clientStories}` : '',
  ].filter(Boolean).join('\n');

  const articles = [];

  // Определяем с какого заголовка начинать — чтобы не повторяться в следующие месяцы
  const usedCount = session.headlinesUsedCount || 0;
  const startFrom = usedCount + 1;

  for (let i = 0; i < 3; i++) {
    const headlineNum = startFrom + i;
    await ctx.reply(`Пишу статью ${i + 1}/3...`);

    const article = await askSonnet(`
Ты — опытный контент-маркетолог и SEO-копирайтер. Напиши статью для сайта бизнеса.

БИЗНЕС: ${session.businessProfile}
АУДИТОРИЯ: ${(session.audience || '').slice(0, 1200)}
РЕГИОН: ${session.regionLabel}
${clientContext ? clientContext + '\n' : ''}
ПОЛНЫЙ СПИСОК ЗАГОЛОВКОВ (база из семантики):
${headlines}

ЖИВЫЕ ФРАЗЫ И СТРАХИ АУДИТОРИИ (из кастдева):
${castdevPhrases}
${realNichePhrases ? `\nЖИВЫЕ ФРАЗЫ ИЗ НИШИ (реальные поисковые запросы и дискуссии):\n${realNichePhrases}\n` : ''}
КЛЮЧЕВЫЕ СЛОВА ИЗ СЕМАНТИЧЕСКОГО ЯДРА:
${semanticKeywords}

НЕЗАКРЫТЫЕ ТЕМЫ КОНКУРЕНТОВ:
${competitorGaps}

ЗАДАЧА: Напиши статью под заголовок НОМЕР ${headlineNum} из списка выше.
Используй именно этот заголовок как тему и фокус статьи.
Все остальные заголовки из списка — уже использованы или будут использованы в других статьях. Не смешивай темы.

ТРЕБОВАНИЯ:
- Объём: 1800-2500 знаков (считай символы, включая пробелы)
- Вступление начинай с боли или живой фразы из кастдева — так как говорит сама аудитория
- Тон статьи должен соответствовать голосу бренда (если задан выше)
- Если задана цель месяца — тематически свяжи статью с ней (без прямой рекламы)
- Если есть реальные истории клиентов — используй их как примеры (без имён, обезличенно)
- Используй ключевые слова из семантического ядра естественно внутри текста
- Если тема пересекается с незакрытыми темами конкурентов — раскрой её глубже чем они
- Структура: заголовок → вступление (боль читателя) → основная часть → вывод → CTA
- Оптимизирована под GEO: содержит чёткие факты и прямые ответы на вопросы аудитории
- В конце: мета-описание (150-160 знаков) для поисковиков
- Пиши БЕЗ markdown-форматирования (никаких **, *, #, _) — только чистый текст

${LEGAL_RULES}
${getLangInstruction(session.contentLanguage)}
    `, 3000);

    articles.push(article);
    await ctx.reply(`✅ Статья ${articles.length}/3 готова`);
  }

  session.articles = articles;
  // Обновляем счётчик использованных заголовков — следующий месяц начнёт с заголовка N+1
  session.headlinesUsedCount = startFrom - 1 + 3;
  session.step = STEPS.BLOCK7_ARTICLES;
  await ctx.reply('✅ Блок 6 — 3 статьи готовы (сохранены в отчёт). Пишу сценарии...');
  await runBlock7(ctx, session);
  return true;
}

module.exports = { runBlock6 };
