const { askSonnet } = require('../claude');
const { fetchPage } = require('../fetcher');
const { STEPS } = require('../state');

async function runBlock1(ctx, session) {
  const hasLinks = session.links && session.links.length > 0;

  if (hasLinks) {
    await ctx.reply(
      'Шаг 1 — Распаковка бизнеса\n\n' +
      'Зачем: чем лучше я понимаю твой продукт, команду и УТП — тем точнее будут все сценарии и статьи. ' +
      'Пропустить этот шаг нельзя: без него контент будет общим, а не твоим.\n\n' +
      'Читаю твои ссылки... Это займёт ~30 секунд.'
    );
  } else {
    await ctx.reply(
      'Шаг 1 — Распаковка бизнеса\n\n' +
      'Зачем: чем лучше я понимаю твой продукт, команду и УТП — тем точнее будут все сценарии и статьи. ' +
      'Пропустить этот шаг нельзя: без него контент будет общим, а не твоим.\n\n' +
      'Ссылок нет — задам вопросы чтобы разобраться в бизнесе самостоятельно.'
    );
  }

  const pagesContent = hasLinks
    ? await Promise.all(session.links.map(url => fetchPage(url)))
    : [];
  const combinedContent = pagesContent.filter(Boolean).join('\n\n---\n\n').slice(0, 8000);

  session.scrapedContent = combinedContent;

  const questionsRaw = await askSonnet(`
Ты — профессиональный бизнес-аналитик. Тебе нужно глубоко изучить бизнес клиента.

Регион: ${session.regionLabel}

Вот информация с сайта и соцсетей бизнеса:
${combinedContent || 'Информация не получена — задай вопросы на основе общих данных о бизнесе'}

Сформулируй ровно 7 уточняющих вопросов которые помогут понять:
1. Что конкретно продаёт бизнес (продукты/услуги, цены, форматы)
2. Чем отличается от конкурентов (УТП)
3. Кто лица бренда / команда
4. История и опыт компании
5. Голос бренда (тон коммуникации)
6. Что уже работает в маркетинге
7. Какая главная цель контента — продажи / узнаваемость / доверие

Пиши вопросы на русском. Каждый вопрос на новой строке. Только вопросы, без нумерации и пояснений.
  `);

  session.block1Questions = questionsRaw.trim()
    .split('\n')
    .map(q => q.replace(/^[\d]+[.)]\s*/, '').trim())
    .filter(q => q.length > 15 && !q.startsWith('#') && q.endsWith('?'));
  session.block1Answers = [];
  session.questionIndex = 0;
  session.step = STEPS.BLOCK1_ANSWERS;

  if (hasLinks && combinedContent) {
    await ctx.reply('✅ Изучил! Теперь задам несколько вопросов о бизнесе.');
  }

  await askNextQuestion(ctx, session);
}

async function askNextQuestion(ctx, session) {
  const q = session.block1Questions[session.questionIndex];
  const total = session.block1Questions.length;
  const num = session.questionIndex + 1;
  await ctx.reply(`Вопрос ${num}/${total}:\n\n${q}`);
}

async function handleBlock1Answer(ctx, session, text) {
  session.block1Answers.push({
    question: session.block1Questions[session.questionIndex],
    answer: text,
  });
  session.questionIndex++;

  if (session.questionIndex < session.block1Questions.length) {
    await askNextQuestion(ctx, session);
  } else {
    session.step = STEPS.BLOCK2_QUESTIONS;
    await ctx.reply('✅ Отлично! Распаковка завершена.\n\nПереходим к следующему блоку...');
    return true;
  }
  return false;
}

async function buildBusinessProfile(session) {
  const qa = session.block1Answers.map(a => `Q: ${a.question}\nA: ${a.answer}`).join('\n\n');

  session.businessProfile = await askSonnet(`
Составь структурированный профиль бизнеса на основе данных.

Регион: ${session.regionLabel}
Сайт/соцсети (краткое содержание): ${(session.scrapedContent || '').slice(0, 3000)}

Ответы владельца:
${qa}

Составь профиль в формате:
НАЗВАНИЕ И ТИП БИЗНЕСА: ...
ПРОДУКТЫ/УСЛУГИ: ...
ЦЕНЫ/ФОРМАТЫ: ...
УТП (чем отличается): ...
КОМАНДА/ЛИЦА БРЕНДА: ...
ГОЛОС БРЕНДА: ...
ЦЕЛЬ КОНТЕНТА: ...
ТЕКУЩИЙ МАРКЕТИНГ: ...
  `);

  return session.businessProfile;
}

module.exports = { runBlock1, askNextQuestion, handleBlock1Answer, buildBusinessProfile };
