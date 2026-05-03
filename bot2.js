require('dotenv').config();
const { Telegraf } = require('telegraf');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { askSonnet, ask } = require('./src/claude');
const { fetchPage } = require('./src/fetcher');

const BOT2_TOKEN = process.env.TELEGRAM_BOT2_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;

if (!BOT2_TOKEN) {
  console.error('TELEGRAM_BOT2_TOKEN не задан в .env');
  process.exit(1);
}

const bot = new Telegraf(BOT2_TOKEN, { handlerTimeout: 600000 });

const SESSIONS_DIR = path.join(os.homedir(), '.marketingdna-client-sessions');
const LEADS_FILE = path.join(SESSIONS_DIR, 'leads.csv');

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(LEADS_FILE)) {
  fs.writeFileSync(LEADS_FILE, 'date,name,whatsapp,email,chatId\n');
}

const STEPS = {
  WELCOME: 'welcome',
  COLLECTING_NAME: 'collecting_name',
  COLLECTING_WHATSAPP: 'collecting_whatsapp',
  COLLECTING_EMAIL: 'collecting_email',
  COLLECTING_LINKS: 'collecting_links',
  COLLECTING_DESCRIPTION: 'collecting_description',
  ANSWERING_QUESTIONS: 'answering_questions',
  GENERATING_RESULT: 'generating_result',
  DONE: 'done',
};

function loadSession(chatId) {
  const file = path.join(SESSIONS_DIR, `${chatId}.json`);
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { }
  }
  return { step: STEPS.WELCOME, chatId };
}

function saveSession(chatId, session) {
  const file = path.join(SESSIONS_DIR, `${chatId}.json`);
  fs.writeFileSync(file, JSON.stringify(session, null, 2));
}

function saveLead(session) {
  const date = new Date().toISOString().slice(0, 10);
  const name = (session.name || '').replace(/,/g, ' ');
  const whatsapp = (session.whatsapp || '').replace(/,/g, ' ');
  const email = (session.email || '').replace(/,/g, ' ');
  fs.appendFileSync(LEADS_FILE, `${date},${name},${whatsapp},${email},${session.chatId}\n`);
}

async function sendAdmin(text) {
  if (!ADMIN_CHAT_ID) return;
  try {
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, text);
  } catch (e) {
    console.error('Admin notify error:', e.message);
  }
}

async function sendLong(ctx, text) {
  const LIMIT = 4000;
  if (text.length <= LIMIT) { await ctx.reply(text); return; }
  for (let i = 0; i < text.length; i += LIMIT) {
    await ctx.reply(text.slice(i, i + LIMIT));
  }
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

// ─── HANDLERS ────────────────────────────────────────────────────────────────

async function handleStart(ctx) {
  const chatId = ctx.chat.id;
  const session = { step: STEPS.COLLECTING_NAME, chatId };
  saveSession(chatId, session);

  await ctx.reply(
    'Привет! Я помогу создать твой персональный контент-план на 7 дней и SEO-статью — бесплатно.\n\n' +
    'Для этого я изучу твой бизнес и задам несколько вопросов. Займёт 5-7 минут.\n\n' +
    'Как тебя зовут?'
  );
}

async function handleMessage(ctx) {
  const chatId = ctx.chat.id;
  const text = (ctx.message.text || '').trim();
  const session = loadSession(chatId);

  switch (session.step) {
    case STEPS.WELCOME:
    case undefined:
      await handleStart(ctx);
      return;

    case STEPS.COLLECTING_NAME: {
      if (text.length < 2) { await ctx.reply('Введи своё имя.'); return; }
      session.name = text;
      session.step = STEPS.COLLECTING_WHATSAPP;
      saveSession(chatId, session);
      await ctx.reply(`Приятно познакомиться, ${text}!\n\nНапиши свой номер WhatsApp (с кодом страны, например +371 20000000):`);
      break;
    }

    case STEPS.COLLECTING_WHATSAPP: {
      if (text.length < 7) { await ctx.reply('Введи номер телефона WhatsApp.'); return; }
      session.whatsapp = text;
      session.step = STEPS.COLLECTING_EMAIL;
      saveSession(chatId, session);
      await ctx.reply('Отлично! Теперь введи свой email — туда отправим контент-план в удобном формате:');
      break;
    }

    case STEPS.COLLECTING_EMAIL: {
      if (!isValidEmail(text)) { await ctx.reply('Введи корректный email, например: name@gmail.com'); return; }
      session.email = text;
      session.links = [];
      session.step = STEPS.COLLECTING_LINKS;
      saveSession(chatId, session);
      saveLead(session);
      await sendAdmin(
        `Новый лид!\nИмя: ${session.name}\nWhatsApp: ${session.whatsapp}\nEmail: ${session.email}\nTelegram ID: ${chatId}`
      );
      await ctx.reply(
        'Отлично! Теперь отправь ссылки на свой бизнес — сайт, Instagram, LinkedIn, TikTok, или любые другие страницы.\n\n' +
        'Каждую ссылку отправляй отдельным сообщением.\n' +
        'Когда добавишь все — напиши: готово\n\n' +
        'Если ссылок нет — тоже напиши: готово'
      );
      break;
    }

    case STEPS.COLLECTING_LINKS: {
      const lower = text.toLowerCase();
      if (lower === 'готово') {
        session.step = STEPS.COLLECTING_DESCRIPTION;
        saveSession(chatId, session);
        await ctx.reply(
          'Коротко опиши свой бизнес:\n\n' +
          'Что продаёшь, кому, и какая главная цель контента — продажи, узнаваемость или доверие?'
        );
      } else {
        const url = text.startsWith('http') ? text : 'https://' + text.replace(/^www\./, 'https://www.').replace('https://https://', 'https://');
        session.links.push(url);
        saveSession(chatId, session);
        await ctx.reply(`Добавлено: ${url}\n\nДобавь ещё ссылку или напиши: готово`);
      }
      break;
    }

    case STEPS.COLLECTING_DESCRIPTION: {
      if (text.length < 10) { await ctx.reply('Напиши чуть подробнее о своём бизнесе.'); return; }
      session.description = text;
      session.step = STEPS.ANSWERING_QUESTIONS;
      session.questions = [];
      session.answers = [];
      session.questionIndex = 0;
      saveSession(chatId, session);

      await ctx.reply('Читаю твои материалы и формирую вопросы... ~30 секунд.');

      try {
        const pagesContent = session.links.length > 0
          ? (await Promise.all(session.links.map(url => fetchPage(url)))).filter(Boolean).join('\n\n---\n\n').slice(0, 6000)
          : '';

        const questionsRaw = await ask(`
Ты — маркетолог. Изучи информацию о бизнесе и составь ровно 5 коротких вопросов для создания персонального контент-плана.

Описание бизнеса: ${session.description}
Материалы с сайта: ${pagesContent || 'нет данных'}

Вопросы должны выявить:
1. Главная целевая аудитория (кто ваш идеальный клиент)
2. Главная проблема/боль которую решает продукт
3. Что отличает от конкурентов (УТП)
4. Какой контент уже пробовали — что сработало, что нет
5. Какой результат хотят получить от контента

Пиши вопросы на русском. Каждый с новой строки. Только вопросы, без нумерации.
        `);

        session.questions = questionsRaw.trim()
          .split('\n')
          .map(q => q.replace(/^[\d]+[.)]\s*/, '').trim())
          .filter(q => q.length > 10 && q.endsWith('?'));

        if (session.questions.length === 0) {
          session.questions = [
            'Кто ваш идеальный клиент — опишите подробнее?',
            'Какую главную проблему решает ваш продукт или услуга?',
            'Чем вы отличаетесь от конкурентов?',
            'Какой контент вы уже пробовали — что сработало?',
            'Какой результат вы хотите получить от контента?',
          ];
        }

        session.scrapedContent = pagesContent;
        saveSession(chatId, session);

        await ctx.reply(`Изучил! Задам ${session.questions.length} вопросов.\n\nВопрос 1/${session.questions.length}:\n\n${session.questions[0]}`);
      } catch (e) {
        console.error('Questions generation error:', e);
        session.questions = [
          'Кто ваш идеальный клиент — опишите подробнее?',
          'Какую главную проблему решает ваш продукт или услуга?',
          'Чем вы отличаетесь от конкурентов?',
          'Какой контент вы уже пробовали — что сработало?',
          'Какой результат вы хотите получить от контента?',
        ];
        saveSession(chatId, session);
        await ctx.reply(`Вопрос 1/${session.questions.length}:\n\n${session.questions[0]}`);
      }
      break;
    }

    case STEPS.ANSWERING_QUESTIONS: {
      session.answers.push({
        question: session.questions[session.questionIndex],
        answer: text,
      });
      session.questionIndex++;
      saveSession(chatId, session);

      if (session.questionIndex < session.questions.length) {
        const num = session.questionIndex + 1;
        const total = session.questions.length;
        await ctx.reply(`Вопрос ${num}/${total}:\n\n${session.questions[session.questionIndex]}`);
      } else {
        session.step = STEPS.GENERATING_RESULT;
        saveSession(chatId, session);
        await generateResult(ctx, session);
      }
      break;
    }

    case STEPS.GENERATING_RESULT:
      await ctx.reply('Уже генерирую твой план, подожди немного...');
      break;

    case STEPS.DONE:
      await ctx.reply(
        'Твой контент-план уже готов — посмотри выше.\n\n' +
        'Хочешь полный пакет на 30 дней? Напиши: хочу пакет'
      );
      break;
  }
}

async function generateResult(ctx, session) {
  await ctx.reply('Отличные ответы! Создаю твой персональный контент-план... ~2 минуты.');

  const qa = session.answers.map(a => `Вопрос: ${a.question}\nОтвет: ${a.answer}`).join('\n\n');

  try {
    // Generate 7-day content plan
    const contentPlan = await askSonnet(`
Ты — контент-стратег. Создай персональный контент-план на 7 дней.
Пиши БЕЗ markdown-форматирования (никаких **, *, #, _) — только чистый текст.

Бизнес: ${session.description}
Материалы с сайта: ${(session.scrapedContent || '').slice(0, 2000)}

Ответы владельца:
${qa}

Создай план на 7 дней. Для каждого дня:

ДЕНЬ [N]:
Платформа: [Instagram / TikTok / LinkedIn]
Формат: [Reel / Карусель / Пост / Stories]
Тема: [конкретная тема]
Хук (первые слова): [цепляющее начало]
Суть контента: [2-3 предложения о чём пост]
CTA: [призыв к действию]

Используй разные форматы и платформы. Темы должны закрывать боли аудитории и показывать экспертизу.
    `, 2500);

    await ctx.reply('Твой контент-план на 7 дней:\n\n');
    await sendLong(ctx, contentPlan);
    await ctx.reply('─────────────────────');
    await ctx.reply('Создаю SEO-статью для сайта...');

    // Generate SEO article
    const seoArticle = await askSonnet(`
Ты — SEO-копирайтер. Напиши одну полноценную SEO-статью для сайта.
Пиши БЕЗ markdown-форматирования (никаких **, *, #, _) — только чистый текст.

Бизнес: ${session.description}
Ответы владельца:
${qa}

Напиши статью:
- Заголовок (SEO-оптимизированный)
- Введение (2-3 абзаца)
- 3-4 раздела с подзаголовками
- Заключение с призывом к действию

Статья должна отвечать на реальный вопрос целевой аудитории. Объём: 600-800 слов.
    `, 2000);

    await ctx.reply('SEO-статья для сайта:\n\n');
    await sendLong(ctx, seoArticle);

    session.step = STEPS.DONE;
    saveSession(ctx.chat.id, session);

    await sendAdmin(
      `Клиент завершил опрос!\nИмя: ${session.name}\nWhatsApp: ${session.whatsapp}\nEmail: ${session.email}`
    );

    // Special offer
    await ctx.reply('─────────────────────');
    await ctx.reply(
      'Это только начало.\n\n' +
      'Полный пакет на 30 дней включает:\n\n' +
      'Анализ конкурентов + 5 рекомендаций\n' +
      '16 готовых видеосценариев (Reels/TikTok)\n' +
      '8 готовых каруселей с текстами\n' +
      '6 концепций фото для ленты\n' +
      '15 шаблонов Stories\n' +
      '30 ТЗ на обложки (для Canva или ИИ)\n' +
      '5 SEO-статей для сайта\n' +
      'Контент-план на 30 дней\n\n' +
      'Стоимость первого месяца: 150 EUR\n' +
      'Далее: 197 EUR/мес\n\n' +
      'Хочешь начать? Напиши: хочу пакет\n\n' +
      'Или подпишись на наш Telegram-канал — там публикуем бесплатные советы по контент-маркетингу.'
    );

  } catch (e) {
    console.error('Generate result error:', e);
    session.step = STEPS.DONE;
    saveSession(ctx.chat.id, session);
    await ctx.reply('Произошла ошибка при генерации. Попробуй написать /start чтобы начать заново.');
  }
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

bot.start(handleStart);

bot.on('text', async (ctx) => {
  try {
    await handleMessage(ctx);
  } catch (e) {
    console.error('Handler error:', e);
    try { await ctx.reply('Что-то пошло не так. Попробуй ещё раз или напиши /start.'); } catch { }
  }
});

// ─── LAUNCH ──────────────────────────────────────────────────────────────────

bot.launch()
  .then(() => console.log('Bot #2 (client) запущен'))
  .catch(e => { console.error('Launch error:', e); process.exit(1); });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));
