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
  await ctx.reply(
    'Шаг 7 — Сценарии\n\n' +
    'Зачем: каждый сценарий написан под конкретный портрет аудитории, ' +
    'с конкретным страхом который снимает, по проверенному фреймворку (AIDA, PAS или BAB). ' +
    'Холодная аудитория получает один тип контента, тёплая — другой, горячая — третий. ' +
    'Так каждый ролик работает на результат.\n\n' +
    'Создаю: 8 видеосценариев + 5 каруселей + 5 фото-концепций. ~4 минуты.'
  );

  const biz = (session.businessProfile || '').slice(0, 1500);
  const aud = (session.audience || '').slice(0, 1500);
  const cast = (session.castdev || '').slice(0, 1500);
  const sem = (session.semanticCore || '').slice(0, 1000);
  const region = session.regionLabel;

  await ctx.reply('Пишу видеосценарии...');

  const langInstruction = getLangInstruction(session.contentLanguage);

  session.videoScripts = await askSonnet(`
Создай 8 видеосценариев для Reels / YouTube Shorts / TikTok.
Пиши БЕЗ markdown-форматирования (никаких **, *, #, _) — только чистый текст.
${langInstruction}

ФРЕЙМВОРКИ: AIDA (Внимание→Интерес→Желание→Действие), PAS (Боль→Агитация→Решение), BAB (До→После→Мост)
ТЕМПЕРАТУРЫ: Холодная (видят впервые), Тёплая (знают, выбирают), Горячая (готовы купить)

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
КАСТДЕВ: ${cast}
КЛЮЧЕВЫЕ СЛОВА: ${sem}
РЕГИОН: ${region}

Распредели: 3 сценария для холодной, 3 для тёплой, 2 для горячей аудитории.

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
  await ctx.reply('Пишу сценарии каруселей...');

  session.carouselScripts = await askSonnet(`
Создай 5 сценариев каруселей для Instagram/LinkedIn.
Пиши БЕЗ markdown-форматирования — только чистый текст.
${langInstruction}

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
КАСТДЕВ: ${cast}
РЕГИОН: ${region}

Распредели: 2 для холодной, 2 для тёплой, 1 для горячей.

Для каждой карусели:
КАРУСЕЛЬ [N]: [тема]
Температура: [холодная/тёплая/горячая]
Фреймворк: [AIDA/PAS/BAB]
Портрет: [имя]
Слайд 1 (обложка): [заголовок-стопкадр]
Слайд 2-6: [текст слайда]
Слайд 7 (финал+CTA): [текст + призыв]
Страх который снимает: [из кастдева]
───────────────
  `, 4000);

  await sendLong(ctx, session.carouselScripts);
  await ctx.reply('─────────────────────');
  await ctx.reply('Пишу фото-концепции...');

  session.photoScripts = await askSonnet(`
Создай 5 фото-концепций для постов в соцсетях.
Пиши БЕЗ markdown-форматирования — только чистый текст.
${langInstruction}

БИЗНЕС: ${biz}
АУДИТОРИЯ: ${aud}
РЕГИОН: ${region}

Для каждой концепции:
ФОТО [N]: [тема]
Температура: [холодная/тёплая/горячая]
Портрет: [имя]
Что на фото: [конкретная сцена]
Эмоция: [что чувствует зритель за 1 секунду]
Текст поверх фото: [короткая фраза или "без текста"]
Подпись к посту: [2-3 предложения]
CTA: [что делать дальше]
───────────────
  `, 2500);

  await sendLong(ctx, session.photoScripts);
  await ctx.reply('─────────────────────');

  session.step = STEPS.BLOCK8_SCRIPTS;
  await ctx.reply('✅ Все сценарии готовы! Начинаю ТЗ на обложки...');
  await runBlock8(ctx, session);
  return true;
}

module.exports = { runBlock7 };
