const { ask, askSonnet } = require('../claude');
const { STEPS } = require('../state');

async function runBlock2(ctx, session) {
  await ctx.reply(
    'Шаг 2 — Целевая аудитория\n\n' +
    'Зачем: один и тот же продукт продаётся по-разному разным людям. ' +
    'Мы создадим 3 портрета твоих покупателей — и каждый сценарий будет написан под конкретного человека, а не "для всех".\n\n' +
    'Формирую вопросы...'
  );

  const questionsRaw = await ask(`
Ты — маркетолог-аналитик. Изучи профиль бизнеса и составь 6 вопросов для выявления целевой аудитории.

Профиль бизнеса:
${session.businessProfile}

Регион: ${session.regionLabel}

Вопросы должны помочь понять:
- Кто покупает (возраст, пол, образ жизни, доход)
- Почему покупают (боли, потребности, желания)
- Где находятся (какие соцсети, форумы, сообщества)
- Как принимают решение о покупке
- Кто НЕ является целевой аудиторией

Пиши вопросы на русском. Каждый на новой строке. Только вопросы.
  `);

  session.block2Questions = questionsRaw.trim()
    .split('\n')
    .map(q => q.replace(/^[\d]+[.)]\s*/, '').trim())
    .filter(q => q.length > 15 && !q.startsWith('#') && q.endsWith('?'));
  session.block2Answers = [];
  session.questionIndex = 0;
  session.step = STEPS.BLOCK2_ANSWERS;

  await askNextBlock2Question(ctx, session);
}

async function askNextBlock2Question(ctx, session) {
  const q = session.block2Questions[session.questionIndex];
  const total = session.block2Questions.length;
  const num = session.questionIndex + 1;
  await ctx.reply(`Вопрос ${num}/${total}:\n\n${q}`);
}

async function handleBlock2Answer(ctx, session, text) {
  session.block2Answers.push({
    question: session.block2Questions[session.questionIndex],
    answer: text,
  });
  session.questionIndex++;

  if (session.questionIndex < session.block2Questions.length) {
    await askNextBlock2Question(ctx, session);
  } else {
    session.step = STEPS.BLOCK3_COMPETITORS;
    return true;
  }
  return false;
}

async function buildAudienceProfile(session) {
  const qa = session.block2Answers.map(a => `Q: ${a.question}\nA: ${a.answer}`).join('\n\n');

  session.audience = await askSonnet(`
На основе профиля бизнеса и ответов владельца создай 3 детальных портрета целевой аудитории.

Профиль бизнеса: ${session.businessProfile}
Регион: ${session.regionLabel}

Ответы о целевой аудитории:
${qa}

Для каждого портрета укажи:
- Имя и краткое описание (например: "Мария, 34, мама двух детей")
- Возраст, пол, образ жизни
- Главная боль/проблема которую решает продукт
- Главное желание/мечта
- Где проводит время онлайн
- Как принимает решение о покупке
- Что может остановить от покупки (возражения)

Учти региональные особенности: ${session.regionLabel}
  `);

  return session.audience;
}

module.exports = { runBlock2, askNextBlock2Question, handleBlock2Answer, buildAudienceProfile };
