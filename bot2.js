require('dotenv').config();
const { Telegraf, Markup } = require('telegraf');
const { message } = require('telegraf/filters');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { askSonnet } = require('./src/claude');
const { fetchPage } = require('./src/fetcher');
const { transcribeVoice } = require('./src/voice');

const TRIGGERS_DIR = path.join(os.homedir(), '.marketingdna-client-sessions', 'triggers');

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
    'Привет! Я бесплатно создам для тебя:\n\n' +
    '📅 Контент-план на 7 дней\n' +
    '🎬 Готовый сценарий ролика (Reels / TikTok)\n' +
    '🖼 Сценарий карусели — слайд за слайдом\n' +
    '🎯 ТЗ на обложку — для Canva, Figma или ИИ\n' +
    '📝 SEO-статья под Google и AI-поиск\n\n' +
    'Всё — под твой бизнес, не шаблон.\n\n' +
    'Для этого задам несколько вопросов о твоём деле. Займёт 5–7 минут.\n\n' +
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
          ? (await Promise.all(session.links.map(url => fetchPage(url)))).filter(Boolean).join('\n\n---\n\n').slice(0, 8000)
          : '';

        const questionsRaw = await askSonnet(`
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
          .filter(q => q.length > 15 && !q.startsWith('#') && q.endsWith('?'));

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

    default:
      await ctx.reply('Напиши /start чтобы начать заново.');
      break;

    case STEPS.DONE: {
      const lower = text.toLowerCase().trim();
      if (lower === 'беру всё' || lower === 'беру все' || lower === 'хочу всё' || lower === 'хочу все' || lower === 'беру') {
        await ctx.reply(
          '🔥 Marketing DNA — тексты + готовый визуал, €250/мес.\n\n' +
          'Нажми кнопку ниже — оплата через защищённую страницу Stripe. Займёт 2 минуты.\n' +
          'После оплаты получишь ссылку на бот и мы начнём.',
          Markup.inlineKeyboard([
            [Markup.button.url('💳 Оплатить €250/мес', 'https://buy.stripe.com/PLACEHOLDER_250')],
          ])
        );
        await sendAdmin(
          `🛒 ЗАЯВКА: Marketing DNA €250/мес\nИмя: ${session.name}\nWhatsApp: ${session.whatsapp}\nEmail: ${session.email}`
        );
      } else {
        await ctx.reply(
          'Твой контент готов — посмотри выше.\n\n' +
          'Готов начать? Напиши: беру\n\n' +
          'Есть вопрос? Просто напиши.'
        );
      }
      break;
    }
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
Материалы с сайта: ${(session.scrapedContent || '').slice(0, 3000)}

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

    await ctx.reply(
      'SEO-статья для сайта:\n\n' +
      'Эта статья написана под реальные запросы твоей аудитории — как они ищут решение в Google и в AI-поиске (ChatGPT, Perplexity). ' +
      'Структура: заголовок под ключевой запрос, введение с болью читателя, разделы с ответами на возражения, CTA в конце.\n\n'
    );
    await sendLong(ctx, seoArticle);
    await ctx.reply('─────────────────────');
    await ctx.reply('Создаю сценарий ролика...');

    // Generate 1 video script sample
    const videoScript = await askSonnet(`
Ты — сценарист Reels и TikTok. Напиши один готовый сценарий короткого ролика (60–90 сек).
Пиши БЕЗ markdown-форматирования — только чистый текст.

Бизнес: ${session.description}
Ответы владельца:
${qa}

Выбери самую острую боль аудитории и сделай ролик под неё.

СЦЕНАРИЙ РОЛИКА:
Платформа: [Instagram Reels / TikTok]
Тема: [одна фраза]
Хук (первые 3 секунды — текст на экране + что говоришь):
Основная часть (что говоришь, по шагам):
Шаг 1:
Шаг 2:
Шаг 3:
Концовка + CTA:
Текст на обложке: [5–7 слов]

Пиши конкретно — не "расскажи о себе", а точные фразы которые произносит человек в кадре.
    `, 1200);

    await ctx.reply('Пример сценария ролика — как выглядит готовый:\n\n');
    await sendLong(ctx, videoScript);
    await ctx.reply('─────────────────────');
    await ctx.reply('Создаю сценарий карусели...');

    // Generate 1 carousel script sample
    const carouselScript = await askSonnet(`
Ты — контент-маркетолог. Напиши сценарий одной карусели для Instagram или LinkedIn — слайд за слайдом.
Пиши БЕЗ markdown-форматирования — только чистый текст.

Бизнес: ${session.description}
Ответы владельца:
${qa}

Выбери тему которая закрывает возражение или учит чему-то полезному за 5–7 слайдов.

СЦЕНАРИЙ КАРУСЕЛИ:
Тема:
Платформа: [Instagram / LinkedIn]

Слайд 1 (обложка): [заголовок который останавливает, 5–8 слов]
Слайд 2: [подзаголовок или боль]
Слайд 3: [шаг 1 / факт 1]
Слайд 4: [шаг 2 / факт 2]
Слайд 5: [шаг 3 / факт 3]
Слайд 6 (если нужен): [итог или неожиданный вывод]
Последний слайд: [CTA — что сделать дальше]

Для каждого слайда: заголовок (крупный текст на слайде) + 1–2 предложения пояснения под ним.
    `, 1200);

    await ctx.reply('Пример карусели — слайд за слайдом:\n\n');
    await sendLong(ctx, carouselScript);
    await ctx.reply('─────────────────────');
    await ctx.reply('Создаю ТЗ на обложку...');

    // Generate 1 cover brief sample
    const coverBrief = await askSonnet(`
Ты — арт-директор. Создай ТЗ на одну обложку для ролика.
Пиши БЕЗ markdown-форматирования — только чистый текст.

Бизнес: ${session.description}
Ответы владельца:
${qa}

Возьми самую сильную тему из контента и сделай ТЗ.

ТЗ НА ОБЛОЖКУ:
Формат: 9:16 вертикаль
Главная фраза: [максимум 5–7 слов — то что читается за 1 секунду]
Что на изображении: [сцена, объект или человек — конкретно]
Цвет и настроение: [2–3 слова]
Стиль шрифта: [жирный / рукописный / минималистичный]
Эмоция зрителя: [одно слово]
Промпт для AI-генератора: [короткая фраза на английском для генерации изображения]
    `, 600);

    await ctx.reply('Пример ТЗ на обложку — что передать дизайнеру, или открыть в Canva / Figma / любом ИИ-генераторе:\n\n');
    await sendLong(ctx, coverBrief);

    session.step = STEPS.DONE;
    saveSession(ctx.chat.id, session);

    await sendAdmin(
      `Клиент завершил опрос!\nИмя: ${session.name}\nWhatsApp: ${session.whatsapp}\nEmail: ${session.email}`
    );

    await sendSalesOffer(ctx, session);

    // Записываем триггер для авто-запуска Bot #1
    try {
      if (!fs.existsSync(TRIGGERS_DIR)) fs.mkdirSync(TRIGGERS_DIR, { recursive: true });
      fs.writeFileSync(
        path.join(TRIGGERS_DIR, `${chatId}.trigger`),
        JSON.stringify({ chatId: String(chatId), name: session.name, timestamp: Date.now() })
      );
    } catch (triggerErr) {
      console.error('Ошибка записи триггера:', triggerErr.message);
    }

  } catch (e) {
    console.error('Generate result error:', e);
    session.step = STEPS.DONE;
    saveSession(ctx.chat.id, session);
    await ctx.reply('Произошла ошибка при генерации. Попробуй написать /start чтобы начать заново.');
  }
}

// ─── SALES OFFER ─────────────────────────────────────────────────────────────

async function sendSalesOffer(ctx, session) {
  await ctx.reply('─────────────────────');

  // Сообщение 1 — Bridge: признаём ценность, но сразу показываем что это только начало
  await ctx.reply(
    '✅ Готово. У тебя есть план на 7 дней и SEO-статья — под твой бизнес, не шаблон.\n\n' +
    'Если опубликуешь по плану — увидишь первые результаты уже через неделю.\n\n' +
    'И вот в чём честность:'
  );

  await new Promise(r => setTimeout(r, 1500));

  // Сообщение 2 — Scale: ты получил вкус, платный = глубже + больше
  await ctx.reply(
    '👆 Ты только что получил образец каждого формата:\n\n' +
    '📅 Контент-план — на 7 дней\n' +
    '🎬 Сценарий ролика — 1 штука\n' +
    '🖼 Сценарий карусели — 1 штука\n' +
    '🎯 ТЗ на обложку — 1 штука\n' +
    '📝 SEO-статья — 1 штука\n\n' +
    'Это не шаблоны — написано под твой бизнес, твою аудиторию, твои цели.\n\n' +
    'Теперь важное: платный пакет — это не просто "то же самое, но больше".\n\n' +
    'В платном режиме система дополнительно:\n' +
    '— читает сайты конкурентов и находит темы которые они не закрывают\n' +
    '— строит семантическую карту ниши — как твои клиенты думают и говорят о продукте\n' +
    '— встраивает эти данные в каждый сценарий, каждую карусель, каждую статью\n\n' +
    'Бесплатно ты получил вкус. Платно — контент который бьёт точно в аудиторию.'
  );

  await new Promise(r => setTimeout(r, 1500));

  // Сообщение 3 — Pain: цена "сделать самому"
  await ctx.reply(
    '⏱ Посчитай что значит сделать это самому:\n\n' +
    '30 постов + 8 роликов + 5 каруселей в месяц\n' +
    '= 40–60 часов твоего времени\n\n' +
    'Фрилансер-копирайтер: от €350/мес\n' +
    'Видеопродакшн отдельно: от €400/мес\n' +
    'SMM-агентство под ключ: от €700/мес\n\n' +
    'И никто из них не читал сайты твоих конкурентов, не строил семантику ниши и не знает психологию твоей аудитории.\n\n' +
    'Система это сделала. Вот что ты получаешь:'
  );

  await new Promise(r => setTimeout(r, 1000));

  // Сообщение 4 — Что входит в пакет (единственный оффер)
  await ctx.reply(
    '🔥 Marketing DNA — тексты + готовый визуал: €250/мес\n\n' +
    '📊 Анализ конкурентов — что делают хорошо, что не закрывают\n' +
    '📅 Контент-план на 30 дней × 2 варианта (рост / продажи)\n' +
    '🎬 8 сценариев для роликов с хуком, структурой и точным текстом\n' +
    '🖼 8 сценариев каруселей — каждый слайд с текстом\n' +
    '📝 5 SEO-статей — под Google и AI-поиск\n' +
    '🎯 30 ТЗ на обложки\n\n' +
    'Плюс готовое производство:\n' +
    '▶️ 8 готовых видео (Reels / TikTok / Shorts)\n' +
    '🖼 8 готовых каруселей с дизайном\n' +
    '📸 6 готовых фото для ленты\n' +
    '📱 15 готовых Stories\n' +
    '🎨 30 готовых обложек\n\n' +
    'Остаётся одно действие — нажать «Опубликовать».\n\n' +
    'Каждый текст и каждый визуал написан под психологию твоей аудитории:\n' +
    'не просто красиво — а так, чтобы человек остановился и захотел купить.'
  );

  await new Promise(r => setTimeout(r, 1500));

  // Сообщение 5 — Сравнение с рынком
  await ctx.reply(
    '💡 Посчитай альтернативы:\n\n' +
    'Копирайтер: от €350/мес (только тексты, без анализа)\n' +
    'Видеопродакшн: от €400/мес\n' +
    'SMM-агентство: от €700/мес\n\n' +
    'Marketing DNA — всё вместе: €250/мес\n\n' +
    '📌 При этом каждый сценарий построен на реальных данных:\n' +
    'анализ конкурентов + семантика ниши + психология аудитории.\n' +
    'Никакой склейки фрилансеров, одна стратегия от начала до конца.'
  );

  await new Promise(r => setTimeout(r, 1500));

  // Сообщение 6 — Финальный CTA с кнопкой оплаты
  await ctx.reply(
    '🎯 Сейчас — лучший момент.\n\n' +
    'Система уже изучила твой бизнес. Ты видел как выглядит результат.\n\n' +
    'Оплата через защищённую страницу Stripe — 2 минуты.\n' +
    'После оплаты сразу получишь доступ к боту и начнём.\n\n' +
    'Напиши: беру — и я отправлю ссылку на оплату.',
    Markup.inlineKeyboard([
      [Markup.button.url('💳 Оплатить €250/мес', 'https://buy.stripe.com/PLACEHOLDER_250')],
    ])
  );

  await sendAdmin(
    `💰 Клиент увидел оффер!\nИмя: ${session.name}\nWhatsApp: ${session.whatsapp}\nEmail: ${session.email}`
  );
}

// ─── ROUTES ──────────────────────────────────────────────────────────────────

bot.start(handleStart);

bot.command('restart', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = { step: STEPS.COLLECTING_NAME, chatId };
  saveSession(chatId, session);
  await ctx.reply('🔄 Начинаем заново!\n\nКак тебя зовут?');
});

bot.command('resume', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = loadSession(chatId);

  const stepMessages = {
    [STEPS.COLLECTING_NAME]: 'Как тебя зовут?',
    [STEPS.COLLECTING_WHATSAPP]: 'Напиши свой номер WhatsApp (с кодом страны, например +371 20000000):',
    [STEPS.COLLECTING_EMAIL]: 'Напиши свой email:',
    [STEPS.COLLECTING_LINKS]: 'Отправляй ссылки на свой бизнес по одной, или напиши: готово',
    [STEPS.COLLECTING_DESCRIPTION]: 'Коротко опиши свой бизнес: что продаёшь, кому, и какая главная цель контента?',
    [STEPS.GENERATING_RESULT]: 'Генерация в процессе — подожди немного. Если прошло больше 5 минут, напиши /restart.',
    [STEPS.DONE]: 'Твой контент готов — посмотри выше.\n\nГотов начать? Напиши: беру',
  };

  if (session.step === STEPS.ANSWERING_QUESTIONS && session.questions && session.questions[session.questionIndex]) {
    const num = session.questionIndex + 1;
    const total = session.questions.length;
    await ctx.reply(`📍 Продолжаем.\n\nВопрос ${num}/${total}:\n\n${session.questions[session.questionIndex]}`);
    return;
  }

  const msg = stepMessages[session.step];
  if (msg) {
    await ctx.reply(`📍 Продолжаем с того места.\n\n${msg}`);
  } else {
    await ctx.reply('Напиши /start чтобы начать заново.');
  }
});

bot.on(message('voice'), async (ctx) => {
  const chatId = ctx.chat.id;
  const session = loadSession(chatId);

  if (!process.env.GROQ_API_KEY) {
    await ctx.reply('🎤 Голосовые сообщения пока не поддерживаются.\n\nНапиши ответ текстом или используй /resume чтобы повторить вопрос.');
    return;
  }

  await ctx.reply('🎤 Слушаю... распознаю голос.');

  try {
    const fileId = ctx.message.voice.file_id;
    const text = await transcribeVoice(bot, fileId);

    if (!text || text.length < 2) {
      await ctx.reply('Не удалось распознать голос. Попробуй ещё раз или напиши текстом.');
      return;
    }

    await ctx.reply(`📝 Распознано:\n"${text}"`);
    await handleMessage({ ...ctx, message: { ...ctx.message, text } });
  } catch (err) {
    console.error('Ошибка транскрипции:', err.message);
    await ctx.reply('Не удалось распознать голос. Попробуй ещё раз или напиши текстом.');
  }
});

bot.on(message('text'), async (ctx) => {
  const chatId = ctx.chat.id;
  try {
    await handleMessage(ctx);
  } catch (e) {
    console.error('Handler error:', e);
    try {
      const session = loadSession(chatId);
      saveSession(chatId, session);
      await ctx.reply(
        '⚠️ Что-то пошло не так.\n\n' +
        '✅ Твой прогресс сохранён — ничего не потеряно.\n\n' +
        'Напиши что-нибудь чтобы продолжить, или /start чтобы начать заново.'
      );
    } catch { }
  }
});

// ─── LAUNCH ──────────────────────────────────────────────────────────────────

bot.telegram.deleteWebhook({ drop_pending_updates: true })
  .then(() => bot.launch({ dropPendingUpdates: true }))
  .then(() => console.log('Bot #2 (client) запущен'))
  .catch(e => { console.error('Launch error:', e); process.exit(1); });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception (бот продолжает работу):', err.message);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection (бот продолжает работу):', err?.message || err);
});
