const { askSonnet } = require('../claude');
const { STEPS } = require('../state');
const { runBlock7 } = require('./block7_scripts');

async function runBlock6(ctx, session) {
  await ctx.reply(
    'Шаг 6 — Статьи для сайта\n\n' +
    'Зачем: статьи на сайте — это долгосрочный актив. ' +
    'Они работают 24/7: Google индексирует их и приводит людей которые ищут твой продукт. ' +
    'Плюс — AI-ассистенты (ChatGPT, Perplexity) будут цитировать твой сайт в своих ответах. ' +
    'Каждая статья написана на языке аудитории и отвечает на реальные вопросы которые они задают.\n\n' +
    'Пишу 5 статей (1800–2500 знаков каждая)... ~3 минуты.'
  );

  const semanticSummary = (session.semanticCore || '').slice(0, 3000);
  const articles = [];

  for (let i = 1; i <= 5; i++) {
    await ctx.reply(`Пишу статью ${i}/5...`);

    const article = await askSonnet(`
Ты — опытный контент-маркетолог. Напиши статью для сайта бизнеса.

БИЗНЕС: ${session.businessProfile}
АУДИТОРИЯ: ${(session.audience || '').slice(0, 1500)}
СЕМАНТИЧЕСКОЕ ЯДРО (ключевые слова и фразы): ${semanticSummary}
РЕГИОН: ${session.regionLabel}

Статья номер ${i} из 5. Каждая статья на РАЗНУЮ тему из семантического ядра.

ТРЕБОВАНИЯ:
- Объём: 1800-2500 знаков (считай символы, включая пробелы)
- Написана языком целевой аудитории, не сухим корпоративным
- Использует ключевые слова из семантического ядра естественно, не роботизированно
- Структура: цепляющий заголовок → вступление (боль) → основная часть → вывод → CTA
- Оптимизирована под GEO: содержит чёткие факты и ответы на реальные вопросы аудитории
- В конце укажи: мета-описание (150-160 знаков) для поисковиков
- Пиши БЕЗ markdown-форматирования (никаких **, *, #, _) — только чистый текст

Пиши на русском языке.
    `, 3000);

    articles.push(article);

    const LIMIT = 4000;
    for (let j = 0; j < article.length; j += LIMIT) {
      await ctx.reply(article.slice(j, j + LIMIT));
    }
    await ctx.reply('─────────────────────');
  }

  session.articles = articles;
  session.step = STEPS.BLOCK7_ARTICLES;
  await ctx.reply('✅ 5 статей готовы! Начинаю сценарии...');
  await runBlock7(ctx, session);
  return true;
}

module.exports = { runBlock6 };
