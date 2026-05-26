require('dotenv').config();
const dns = require('dns');
dns.setDefaultResultOrder('ipv4first');
const { Telegraf } = require('telegraf');
const { message: filterMessage } = require('telegraf/filters');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
const { transcribeVoice } = require('./src/voice');
const { validateCode, markCodeUsed, getCodeStats } = require('./src/access_codes');
const { crmLog, crmGet, crmList, formatClient, formatClientFull } = require('./src/crm');
const { VIZITKA_QUESTIONS, EXPERT_QUESTIONS, mapToVizitkaData, mapToExpertData } = require('./src/website_questions');
const { ask, HAIKU } = require('./src/claude');
const { ANALYTICS_ONBOARDING_TEXT } = require('./src/analytics_instruction');

const CLIENT_TEMPLATE_DIR = path.join(os.homedir(), 'client-site-template');

const TRIGGERS_DIR = path.join(os.homedir(), '.marketingdna-client-sessions', 'triggers');
const SESSIONS_DIR = path.join(os.homedir(), '.marketingdna-client-sessions');
const LEADS_FILE = path.join(SESSIONS_DIR, 'leads.csv');

const BOT2_TOKEN = process.env.TELEGRAM_BOT2_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID;
const PRIVACY_URL = process.env.PRIVACY_URL || 'https://marketing-dna.com/privacy';

if (!process.env.STRIPE_WEBHOOK_SECRET) {
  console.warn('[bot2] WARNING: STRIPE_WEBHOOK_SECRET не задан — webhook принимает запросы без верификации (небезопасно)');
}
if (!process.env.STRIPE_SECRET_KEY) {
  console.warn('[bot2] WARNING: STRIPE_SECRET_KEY не задан — Stripe SDK работает без аутентификации');
}

if (!BOT2_TOKEN) {
  console.error('TELEGRAM_BOT2_TOKEN не задан в .env');
  process.exit(1);
}

const bot = new Telegraf(BOT2_TOKEN, { handlerTimeout: 600000 });

if (!fs.existsSync(SESSIONS_DIR)) fs.mkdirSync(SESSIONS_DIR, { recursive: true });
if (!fs.existsSync(LEADS_FILE)) {
  fs.writeFileSync(LEADS_FILE, 'date,name,email,chatId\n');
}

// ─── ШАГИ ─────────────────────────────────────────────────────────────────────

const STEPS = {
  COLLECTING_NAME:        'collecting_name',
  COLLECTING_DESCRIPTION: 'collecting_description',
  ANSWERING_PART1:        'answering_part1',      // В1-В4
  COLLECTING_COMPETITORS: 'collecting_competitors', // В5 — multi-message
  ANSWERING_PART2:        'answering_part2',      // В6-В11
  COLLECTING_FORMAT:           'collecting_format',         // В12 — формат контента
  COLLECTING_CONTENT_GOAL:     'collecting_content_goal',  // В13 — цель контент-плана
  COLLECTING_LANG_DOCS:        'collecting_lang_docs',      // В14 — язык аналитики и документов
  COLLECTING_LANG_CONTENT:     'collecting_lang_content',   // В15 — язык контента для публикации

  COLLECTING_LINKS:            'collecting_links',
  COLLECTING_EMAIL:       'collecting_email',
  WAITING_FOR_RESULT:     'waiting_for_result',
  DONE:                   'done',
  CHOOSING_WEBSITE_PATH:  'choosing_website_path', // Выбор пути с сайта (?start=website)
  WEBSITE_QUESTIONNAIRE:  'website_questionnaire', // Опросник на сайт (этап 1, до оплаты)
  WEBSITE_PAYMENT:        'website_payment',        // Ожидание оплаты
  WEBSITE_DETAILS:        'website_details',        // Детальный опросник (этап 2, после оплаты)

  PAID_WAITING:           'paid_waiting',            // Ожидание вопросов от Bot #1
  PAID_Q1:                'paid_q1',                 // Платный вопрос 1: цель контента
  PAID_Q2:                'paid_q2',                 // Платный вопрос 2: фокус месяца
  PAID_Q3:                'paid_q3',                 // Платный вопрос 3: голос бренда
  PAID_Q4:                'paid_q4',                 // Платный вопрос 4: истории клиентов
  PAID_Q5:                'paid_q5',                 // Платный вопрос 5: платформы
  PAID_Q6:                'paid_q6',                 // Платный вопрос 6: подписчики (из Bot1)
};

// ─── ЧАСТЬ 1 — В1–В4 ──────────────────────────────────────────────────────────

const QUESTIONS_PART1 = [
  {
    key: 'region_language',
    text:
      'Вопрос 1 из 12\n\n' +
      'В каком регионе работаете и на каком языке ведёте контент?\n' +
      'Планируете ли в будущем выходить на другие рынки — понадобится ли другой язык?\n\n' +
      'Пример: работаю в Варшаве, контент на польском. Через год планирую выйти на немецкий рынок.',
    bridge: 'Понял — регион и язык зафиксированы.',
  },
  {
    key: 'ideal_client',
    text:
      'Вопрос 2 из 12\n\n' +
      'Кто ваш идеальный клиент?\n' +
      'Опишите: возраст, чем занимается, образ жизни, что для него важно.\n\n' +
      'Пример: предприниматели 35-50 лет, владеют малым бизнесом, хотят масштабироваться, но нет времени разбираться в маркетинге.',
    bridge: 'Хорошо — портрет аудитории принят.',
  },
  {
    key: 'pain',
    text:
      'Вопрос 3 из 12\n\n' +
      'Какую главную проблему или боль решает ваш продукт?\n' +
      'Что происходит с клиентом без вас — и что становится возможным благодаря вам?\n\n' +
      'Пример: владельцы кафе тратят часы на поиск поставщиков и переговоры — мы автоматизируем закупки за 15 минут в неделю.',
    bridge: 'Принял — именно боль делает контент цепляющим.',
  },
  {
    key: 'utp',
    text:
      'Вопрос 4 из 12\n\n' +
      'Чем вы отличаетесь от конкурентов?\n\n' +
      'Это называется УТП — уникальное торговое предложение: что у вас есть такого, чего нет у других?\n\n' +
      'Пример: мы единственная юридическая компания в регионе, которая специализируется только на стартапах и работает по фиксированной подписке без почасовой оплаты.',
    bridge: 'Отлично. Из уникальности строятся самые сильные хуки.',
  },
];

// ─── ЧАСТЬ 2 — В6–В11 ─────────────────────────────────────────────────────────

const QUESTIONS_PART2 = [
  {
    key: 'customer_journey',
    text:
      'Вопрос 6 из 12\n\n' +
      'Как клиент приходит к покупке?\n' +
      'Откуда узнаёт о вас, как долго думает, что помогает принять решение?\n\n' +
      'Пример: клиенты находят через рекомендации → смотрят сайт → записываются на бесплатный аудит → покупают пакет.',
    bridge: 'Учту — путь клиента поможет выстроить контент по воронке.',
  },
  {
    key: 'objections',
    text:
      'Вопрос 7 из 12\n\n' +
      'Какие возражения чаще всего слышите от клиентов до покупки?\n' +
      'Что их останавливает — цена, сомнения, конкуренты?\n\n' +
      'Пример: «Дорого», «Мне нужно посоветоваться», «Пробовал подобное — не сработало».',
    bridge: 'Хорошо — учтём это при создании контента.',
  },
  {
    key: 'content_history',
    text:
      'Вопрос 8 из 12\n\n' +
      'Что уже пробовали в контенте — какие платформы, форматы, темы?\n' +
      'Что сработало (хоть немного), а что не зашло совсем?\n\n' +
      'Пример: публиковал экспертные статьи в Telegram — хорошая реакция. YouTube пробовал — не пошло, сложно делать регулярно.',
    bridge: 'Понял — ваш опыт с контентом учтён.',
  },
  {
    key: 'content_goal',
    text:
      'Вопрос 9 из 12\n\n' +
      'Какой главный результат хотите получить от контента в ближайшие 3 месяца?\n\n' +
      'Пример: увеличить количество входящих заявок, вырасти с 300 до 1000 подписчиков, стать узнаваемым экспертом в своей нише.',
    bridge: 'Принято — под эту цель и выстроим всю структуру контент-плана.',
  },
  {
    key: 'price_range',
    text:
      'Вопрос 10 из 12\n\n' +
      'Укажите диапазон цен на ваши основные продукты или услуги.\n\n' +
      'Пример: разовая консультация — €80, пакет на месяц — €300-500, годовое сопровождение — от €3000.',
    bridge: 'Хорошо — ценовой диапазон зафиксирован.',
  },
  {
    key: 'decision_maker',
    text:
      'Вопрос 11 из 12\n\n' +
      'Кто обычно принимает решение о покупке?\n' +
      'Клиент решает сам или согласует с кем-то — партнёром, руководителем, командой?\n\n' +
      'Пример: частные клиенты решают лично. Корпоративные — всегда согласование с финансовым директором.',
    bridge: '',
  },
];

// ─── СЕССИИ ───────────────────────────────────────────────────────────────────

function loadSession(chatId) {
  const file = path.join(SESSIONS_DIR, `${chatId}.json`);
  if (fs.existsSync(file)) {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { }
  }
  return { step: STEPS.COLLECTING_NAME, chatId };
}

function saveSession(chatId, session) {
  const file = path.join(SESSIONS_DIR, `${chatId}.json`);
  fs.writeFileSync(file, JSON.stringify(session, null, 2));
}

function saveLead(session) {
  const date = new Date().toISOString().slice(0, 10);
  const name = (session.name || '').replace(/,/g, ' ');
  const email = (session.email || '').replace(/,/g, ' ');
  fs.appendFileSync(LEADS_FILE, `${date},${name},${email},${session.chatId}\n`);
}

function writeTrigger(chatId, session) {
  if (!fs.existsSync(TRIGGERS_DIR)) fs.mkdirSync(TRIGGERS_DIR, { recursive: true });

  // Собираем все ответы в единый массив для Bot #1
  const allAnswers = [
    ...(session.answersPart1 || []),
    { key: 'competitors', question: 'Конкуренты', answer: (session.competitorNames || []).join('\n') || 'не указаны' },
    ...(session.answersPart2 || []),
  ];

  const triggerData = {
    chatId: String(chatId),
    name: session.name,
    email: session.email,
    links: session.links || [],
    description: session.description,
    answers: allAnswers,
    competitorNames: session.competitorNames || [],
    contentFormat: session.contentFormat || 'fmt_unsure',
    contentPlanGoal: session.contentPlanGoal || 'привлечение новых клиентов',
    analyticsLanguage: session.analyticsLanguage || 'ru',
    contentLanguage: session.contentLanguage || 'ru',
    wantsWebsite: session.wantsWebsite || false,
    timestamp: Date.now(),
  };
  fs.writeFileSync(
    path.join(TRIGGERS_DIR, `${chatId}.trigger`),
    JSON.stringify(triggerData, null, 2)
  );
}

function writePaidInitTrigger(chatId, session, packageKey) {
  if (!fs.existsSync(TRIGGERS_DIR)) fs.mkdirSync(TRIGGERS_DIR, { recursive: true });
  const triggerData = {
    chatId: String(chatId),
    name: session.name,
    email: session.email,
    packageKey,
    timestamp: Date.now(),
  };
  fs.writeFileSync(
    path.join(TRIGGERS_DIR, `${chatId}.paid_init.trigger`),
    JSON.stringify(triggerData, null, 2)
  );
}

function writePaidTrigger(chatId, session) {
  if (!fs.existsSync(TRIGGERS_DIR)) fs.mkdirSync(TRIGGERS_DIR, { recursive: true });
  const triggerData = {
    chatId: String(chatId),
    name: session.name,
    email: session.email,
    packageKey: session.paidPackageKey,
    paidAnswers: session.paidAnswers || [],
    timestamp: Date.now(),
  };
  fs.writeFileSync(
    path.join(TRIGGERS_DIR, `${chatId}.paid.trigger`),
    JSON.stringify(triggerData, null, 2)
  );
}

// ─── УТИЛИТЫ ──────────────────────────────────────────────────────────────────

async function sendAdmin(text) {
  if (!ADMIN_CHAT_ID) return;
  try {
    await bot.telegram.sendMessage(ADMIN_CHAT_ID, text);
  } catch (e) {
    console.error('Admin notify error:', e.message);
  }
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

function isInstagram(text) {
  return text.includes('instagram.com') || text.includes('instagr.am');
}


const LANG_LABELS = { ru: 'русском 🇷🇺', lv: 'латышском 🇱🇻', en: 'английском 🇬🇧' };
const LANG_NAMES  = { ru: 'Русский 🇷🇺', lv: 'Латышский 🇱🇻', en: 'Английский 🇬🇧' };

// ─── МИКРО-РЕАКЦИЯ НА ОТВЕТ КЛИЕНТА ──────────────────────────────────────────

async function getMicroReaction(question, answer) {
  try {
    return await ask(
      `Ты — дружелюбный ассистент маркетингового сервиса. Клиент ответил на вопрос анкеты.
Вопрос: ${question}
Ответ клиента: ${answer}

Напиши короткую живую реакцию — 1-2 предложения. Правила:
- Отреагируй конкретно на то что написал клиент — не обобщай
- Тон: тёплый, профессиональный, без восклицаний и дежурных фраз
- Никаких "Отлично!", "Прекрасно!", "Замечательно!" — это шаблонно
- Никаких обещаний и выводов — только отклик на сказанное
- Пиши на том же языке на котором ответил клиент
- Максимум 2 предложения`,
      { model: HAIKU, maxTokens: 100, timeoutMs: 8000 }
    );
  } catch {
    return null;
  }
}

// ─── TYPING HELPER ────────────────────────────────────────────────────────────

async function typing(ctx, ms = 900) {
  await ctx.sendChatAction('typing');
  await new Promise(r => setTimeout(r, ms));
}

// ─── СТАРТ ────────────────────────────────────────────────────────────────────

async function resumeSession(ctx, session) {
  const step = session.step;

  if (step === STEPS.ANSWERING_PART1) {
    const idx = session.questionIndexPart1 || 0;
    const q = QUESTIONS_PART1[idx];
    if (q) { await ctx.reply(`📍 Продолжаем.\n\n${q.text}`); return; }
  }
  if (step === STEPS.COLLECTING_COMPETITORS) {
    await ctx.reply('📍 Продолжаем.\n\nВопрос 5 из 12 — Конкуренты.\n\nДобавьте конкурента или напишите: готово');
    return;
  }
  if (step === STEPS.ANSWERING_PART2) {
    const idx = session.questionIndexPart2 || 0;
    const q = QUESTIONS_PART2[idx];
    if (q) { await ctx.reply(`📍 Продолжаем.\n\n${q.text}`); return; }
  }
  if (step === STEPS.CHOOSING_WEBSITE_PATH) {
    await ctx.reply('Что вас интересует?', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🌐 Только сайт', callback_data: 'ws_path_site' }],
          [{ text: '📱 Только контент-план', callback_data: 'ws_path_content' }],
          [{ text: '🔥 И сайт, и контент-план', callback_data: 'ws_path_both' }],
        ]
      }
    });
    return;
  }

  if (step === STEPS.COLLECTING_FORMAT) {
    await ctx.reply(
      '📍 Продолжаем.\n\nВопрос 12 из 12 — как вы видите свой контент?',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎬 С человеком в кадре — я сам, сотрудник или мастер', callback_data: 'fmt_person' }],
            [{ text: '📦 Без человека — продукт, процесс, пространство', callback_data: 'fmt_product' }],
            [{ text: '🤷 Пока не знаю — помогите определиться', callback_data: 'fmt_unsure' }],
          ]
        }
      }
    );
    return;
  }
  if (step === STEPS.COLLECTING_CONTENT_GOAL) {
    await ctx.reply(
      '📍 Продолжаем.\n\nКакая главная цель вашего контента в этом месяце?',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎯 Привлечь новых клиентов', callback_data: 'cgoal_new' }],
            [{ text: '🔥 Продавать тем кто уже знает меня', callback_data: 'cgoal_warm' }],
          ]
        }
      }
    );
    return;
  }
  if (step === STEPS.COLLECTING_LANG_DOCS) {
    await ctx.reply(
      '📍 Продолжаем.\n\nНа каком языке подготовить аналитику и рабочие документы?',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🇷🇺 Русский', callback_data: 'lang_docs_ru' }],
            [{ text: '🇱🇻 Латышский', callback_data: 'lang_docs_lv' }],
            [{ text: '🇬🇧 Английский', callback_data: 'lang_docs_en' }],
          ]
        }
      }
    );
    return;
  }
  if (step === STEPS.COLLECTING_LANG_CONTENT) {
    await ctx.reply(
      '📍 Продолжаем.\n\nНа каком языке подготовить контент для публикации?',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🇷🇺 Русский', callback_data: 'lang_content_ru' }],
            [{ text: '🇱🇻 Латышский', callback_data: 'lang_content_lv' }],
            [{ text: '🇬🇧 Английский', callback_data: 'lang_content_en' }],
          ]
        }
      }
    );
    return;
  }
  if (step === STEPS.COLLECTING_LINKS) {
    await ctx.reply('📍 Продолжаем.\n\nПришлите ссылки на соцсети или сайт (каждую отдельно), или напишите: готово');
    return;
  }
  if (step === STEPS.COLLECTING_EMAIL) {
    await ctx.reply('📍 Продолжаем.\n\nНапишите email — куда прислать контент-план?');
    return;
  }
  if (step === STEPS.WAITING_FOR_RESULT) {
    await ctx.reply('Контент-план ещё готовится — следите за этим чатом.');
    return;
  }
  if (step === STEPS.PAID_WAITING) {
    await ctx.reply('Ожидаем подтверждение — сейчас пришлю первый вопрос.');
    return;
  }
  if (step === STEPS.PAID_Q6) {
    const q6 = (session.paidQuestions || [])[5];
    if (q6) await ctx.reply(`📍 Продолжаем.\n\n${q6.text}`);
    return;
  }
  if ([STEPS.PAID_Q1, STEPS.PAID_Q2, STEPS.PAID_Q3, STEPS.PAID_Q4, STEPS.PAID_Q5].includes(step)) {
    const idx = { [STEPS.PAID_Q1]: 0, [STEPS.PAID_Q2]: 1, [STEPS.PAID_Q3]: 2, [STEPS.PAID_Q4]: 3, [STEPS.PAID_Q5]: 4 }[step];
    const q = (session.paidQuestions || [])[idx];
    if (q) {
      await ctx.reply(`📍 Продолжаем.\n\n${q.text}`);
      if (step === STEPS.PAID_Q1 && q.buttons) {
        await ctx.reply('Нажмите кнопку:', { reply_markup: { inline_keyboard: q.buttons } });
      }
      if (step === STEPS.PAID_Q5) {
        await ctx.reply('Нажмите кнопку или напишите:', {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📸 Всё в Instagram', callback_data: 'plat_instagram' }],
              [{ text: '4+4: Instagram + TikTok', callback_data: 'plat_split' }],
              [{ text: '✏️ Другое — напишу сам', callback_data: 'plat_custom' }],
            ]
          }
        });
      }
    }
    return;
  }
  await ctx.reply('📍 Напишите /start чтобы начать.');
}

async function handleStart(ctx) {
  const chatId = ctx.chat.id;

  // Если уже проходил опрос — спросить что делать
  const existing = loadSession(chatId);
  if (existing.step === STEPS.DONE && existing.name) {
    await ctx.reply(
      `С возвращением, ${existing.name}!\n\n` +
      'Вы уже получили бесплатный контент-план. Хотите пройти заново?\n\n' +
      'Напишите да — начнём с чистого листа.\n' +
      'Или просто задайте вопрос.'
    );
    return;
  }

  const source = ctx.startPayload || 'direct';

  if (source === 'addlang') {
    await showAddLang(ctx);
    return;
  }

  if (source === 'website') {
    const session = { step: STEPS.CHOOSING_WEBSITE_PATH, chatId, links: [], source };
    saveSession(chatId, session);
    await ctx.reply(
      'Привет! Что вас интересует?',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🌐 Только сайт', callback_data: 'ws_path_site' }],
            [{ text: '📱 Только контент-план', callback_data: 'ws_path_content' }],
            [{ text: '🔥 И сайт, и контент-план', callback_data: 'ws_path_both' }],
          ]
        }
      }
    );
    return;
  }

  const session = { step: STEPS.COLLECTING_NAME, chatId, links: [], source };
  saveSession(chatId, session);

  await ctx.reply(
    'Приветствую!\n\n' +
    'Я — Marketing DNA.\n\n' +
    'Задам вам несколько вопросов — система проанализирует ваш бизнес и подготовит персональный контент-пакет. Бесплатно.\n\n' +
    'Что вы получите:\n\n' +
    '🎠 Карусель — 5 готовых слайдов для публикации\n' +
    '📸 Готовый пост: изображение + текст\n' +
    '🎨 Пример обложки для видео\n' +
    '🎬 Сценарий ролика (Reels / TikTok)\n' +
    '📝 SEO-статья для сайта\n' +
    '📅 Контент-план на 7 дней\n\n' +
    'Откройте материалы, ознакомьтесь, оцените — и сами решите хотите ли получать такой контент для публикации в ваших соцсетях.\n\n' +
    'А чтобы положительное решение было легче принять — в конце вас ждёт кое-что приятное 😉\n\n' +
    'Давайте начнём со знакомства. Как вас зовут?'
  );
}

// ─── ОСНОВНОЙ ОБРАБОТЧИК ──────────────────────────────────────────────────────

async function handleMessage(ctx) {
  const chatId = ctx.chat.id;
  const text = (ctx.message.text || '').trim();
  const session = loadSession(chatId);

  // Команды обрабатываются отдельными bot.command() хендлерами — не перехватываем
  if (text.startsWith('/')) return;

  // Клиент прислал своё имя+email для ручного добавления языка
  if (session?.step === 'addlang_identify') {
    const adminId = (process.env.ADMIN_CHAT_ID || '').trim();
    session.step = null;
    saveSession(chatId, session);
    if (adminId) {
      await bot.telegram.sendMessage(
        adminId,
        `🌐 Запрос на добавление языка\n\n` +
        `ChatId клиента: ${chatId}\n` +
        `Данные от клиента:\n${text}\n\n` +
        `Найди в CRM по имени/email и вручную установи paidPackageKey + contentLanguage.`
      ).catch(() => {});
    }
    await ctx.reply(
      '✅ Данные получены — передали менеджеру.\n\n' +
      'Мы проверим вашу подписку и добавим язык вручную. Это займёт не более 24 часов.'
    );
    return;
  }

  // Приём скриншотов аналитики — клиент написал "готово"
  if (session?.analyticsIntake && text.toLowerCase() === 'готово') {
    const screenshots = session.analyticsScreenshots || [];
    if (!screenshots.length) {
      await ctx.reply('Скриншоты не получены. Пришлите фото статистики из Instagram, потом напишите "готово".');
      return;
    }
    session.analyticsIntake = false;
    session.analyticsCycles = (session.analyticsCycles || 0) + 1;
    session.analyticsScreenshots = [];
    saveSession(chatId, session);
    crmLog(chatId, 'analytics_screenshots_received', { count: screenshots.length, cycle: session.analyticsCycles });
    await ctx.reply(
      '✅ Спасибо! Получили все скриншоты.\n\n' +
      'Анализируем данные и скорректируем следующий контент — пришлём выводы в ближайшее время.'
    );

    // Уведомляем менеджера что пришли скриншоты + кнопка для генерации корректировок
    const managerChatId = process.env.BOT3_MANAGER_CHAT_ID;
    if (managerChatId) {
      await bot.telegram.sendMessage(managerChatId,
        `📊 *${session.clientName || chatId}* прислал скриншоты аналитики (${screenshots.length} шт, цикл ${session.analyticsCycles}).\n\n` +
        `Изучите скриншоты выше и нажмите кнопку — бот сгенерирует скорректированный контент на следующие 15 дней.`,
        {
          parse_mode: 'Markdown',
          reply_markup: {
            inline_keyboard: [[
              { text: '✏️ Сгенерировать корректировки', callback_data: `gen_corrections_${chatId}` },
            ]],
          },
        }
      ).catch(() => {});
    }
    return;
  }

  // Автовосстановление после ошибки — любое сообщение запускает resume
  if (session._resumeAfterError) {
    delete session._resumeAfterError;
    saveSession(chatId, session);
    await resumeSession(ctx, session);
    return;
  }

  // Опросник на сайт — обработка текстовых sub-steps
  if (session.step === STEPS.WEBSITE_QUESTIONNAIRE) {
    const ws = session.websiteAnswers || {};

    // Sub-step: имя (только для пути ?start=website → "Только сайт")
    if (ws.waitingName) {
      if (text.length < 2) { await ctx.reply('Напишите своё имя.'); return; }
      ws.name = text;
      ws.waitingName = false;
      ws.waitingEmail = true;
      session.websiteAnswers = ws;
      saveSession(chatId, session);
      await ctx.reply('Ваш email — куда прислать подтверждение?');
      return;
    }

    // Sub-step: email
    if (ws.waitingEmail) {
      ws.email = text;
      ws.waitingEmail = false;
      session.websiteAnswers = ws;
      saveSession(chatId, session);
      await ctx.reply('Что будет на сайте?', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏢 Визитка компании', callback_data: 'ws_type_card' }],
            [{ text: '🛍 Услуги или продукты', callback_data: 'ws_type_services' }],
          ]
        }
      });
      return;
    }

    // Sub-step: примеры сайтов (последний вопрос этапа 1) → рекомендация + оплата
    if (ws.waitingExamples) {
      ws.examples = text;
      ws.waitingExamples = false;

      // Определяем шаблон по количеству услуг
      const bigCounts = ['6–10', '11–20', 'Больше 20'];
      const template  = bigCounts.includes(ws.serviceCount) ? 'expert' : 'vizitka';
      ws.recommendedTemplate = template;
      session.websiteAnswers = ws;
      session.step = STEPS.WEBSITE_PAYMENT;
      saveSession(chatId, session);

      const isExpert      = template === 'expert';
      const templateName  = isExpert ? 'Сайт-эксперт' : 'Сайт-визитка';
      const price         = isExpert ? '€299' : '€150';
      const stripeLink    = isExpert
        ? (process.env.STRIPE_SITE_EXPERT || 'https://buy.stripe.com/9B65kxgsdaNe49g2ln5Rm0j')
        : (process.env.STRIPE_SITE_VIZITKA || 'https://buy.stripe.com/3cI7sFcbX1cE5dk6BD5Rm0i');

      const featuresList  = isExpert
        ? '9 экранов: о вас, услуги с фото, кейсы, отзывы, FAQ, форма заявки'
        : '3 экрана: услуги, отзывы, форма заявки';

      const keyboard = stripeLink
        ? { inline_keyboard: [
            [{ text: `💳 Оплатить ${price}`, url: stripeLink }],
            [{ text: '✅ Я оплатил — продолжить', callback_data: `ws_paid_${template}` }],
          ]}
        : { inline_keyboard: [
            [{ text: '✅ Я оплатил — продолжить', callback_data: `ws_paid_${template}` }],
          ]};

      await ctx.reply(
        `Отлично! На основе ваших ответов подбираю оптимальный вариант.\n\n` +
        `─────────────────────\n` +
        `📄 *${templateName}* — ${price}\n\n` +
        `${featuresList}\n\n` +
        `Персональный дизайн под ваш бренд.\n` +
        `Домен подключаем сами (~€10–15/год докупаете отдельно).\n` +
        `─────────────────────\n\n` +
        (stripeLink ? `Нажмите кнопку оплаты ниже. После оплаты нажмите «Я оплатил».` : `Нажмите кнопку ниже чтобы продолжить.`),
        { parse_mode: 'Markdown', reply_markup: keyboard }
      );

      const name  = ws.name  || session.name  || '—';
      const email = ws.email || session.email || '—';
      await sendAdmin(
        `🌐 Клиент на шаге оплаты сайта!\n\n` +
        `Имя: ${name}\nEmail: ${email}\nChatId: ${chatId}\n\n` +
        `Рекомендован: ${templateName} ${price}\n` +
        `Услуг: ${ws.serviceCount || '—'} | Домен: ${ws.domain || '—'} | Логотип: ${ws.logo || '—'}`
      );
      return;
    }
  }

  // Этап 2 детального опросника сайта (после оплаты)
  if (session.step === STEPS.WEBSITE_DETAILS) {
    const handled = await handleWebsiteDetails(ctx, chatId, text, session);
    if (handled) return;
  }

  // Проверяем код доступа на любом шаге, кроме ввода имени
  if (session.step !== STEPS.COLLECTING_NAME && /^[A-Z0-9]{4,20}$/.test(text.trim())) {
    const codeResult = validateCode(text.trim(), chatId);
    if (!codeResult) {
      await ctx.reply('Код не найден или уже использован. Проверьте правильность и попробуйте ещё раз.');
      return;
    }
    if (codeResult) {
      markCodeUsed(codeResult.code, chatId);
      session.accessCode = codeResult.code;
      crmLog(chatId, 'code_used', { code: codeResult.code, label: codeResult.label });

      if (codeResult.autoSend) {
        session.autoSendApproved = true;
        saveSession(chatId, session);

        await sendAdmin(
          `🤖 Авто-доставка активирована!\n` +
          `Код: ${codeResult.code} (${codeResult.label})\n` +
          `Имя: ${session.name || '—'}\nEmail: ${session.email || '—'}\nChatId: ${chatId}\n\n` +
          `Полный пакет отправится клиенту АВТОМАТИЧЕСКИ.`
        );

        await ctx.reply(
          '✅ Код принят!\n\n' +
          'Полный контент-пакет готовится и придёт сюда автоматически.\n' +
          'Следите за этим чатом — обычно занимает несколько часов.'
        );
      } else {
        saveSession(chatId, session);

        // Пишем code.trigger — Bot #1 подхватит и отправит кнопку для выбора тарифа
        try {
          if (!fs.existsSync(TRIGGERS_DIR)) fs.mkdirSync(TRIGGERS_DIR, { recursive: true });
          fs.writeFileSync(
            path.join(TRIGGERS_DIR, `${chatId}.code.trigger`),
            JSON.stringify({
              chatId: String(chatId),
              name: session.name || '—',
              email: session.email || '—',
              code: codeResult.code,
              label: codeResult.label,
              packageKey: codeResult.packageKey || null,
              timestamp: Date.now(),
            }, null, 2)
          );
        } catch (e) {
          console.error('code.trigger write error:', e.message);
        }

        await ctx.reply(
          '✅ Код принят!\n\n' +
          'Ваш пакет уже готовится — пришлю сюда когда будет готово.\n' +
          'Обычно занимает несколько часов.'
        );
      }
      return;
    }
  }

  switch (session.step) {

    // ── Имя ───────────────────────────────────────────────────────────────────
    case STEPS.COLLECTING_NAME: {
      if (text.length < 2) { await ctx.reply('Напишите своё имя.'); return; }
      session.name = text;
      session.step = STEPS.COLLECTING_DESCRIPTION;
      saveSession(chatId, session);
      await typing(ctx, 700);
      await ctx.reply(
        `Рад познакомиться, ${text}!\n\n` +
        'Расскажите в 2-3 предложениях: чем занимаетесь, что продаёте и кому?\n\n' +
        'Пример: провожу онлайн-курсы по финансовой грамотности для наёмных сотрудников, которые хотят начать инвестировать.'
      );
      break;
    }

    // ── Описание бизнеса ──────────────────────────────────────────────────────
    case STEPS.COLLECTING_DESCRIPTION: {
      if (text.length < 10) { await ctx.reply('Напишите чуть подробнее — 2-3 предложения о вашем деле.'); return; }
      session.description = text;
      session.answersPart1 = [];
      session.questionIndexPart1 = 0;
      session.step = STEPS.ANSWERING_PART1;
      saveSession(chatId, session);
      await typing(ctx, 1200);
      await ctx.reply(
        'Хорошо, картина понятна!\n\n' +
        '💡 Подсказка: на мои вопросы можно отвечать голосовыми сообщениями — я транскрибирую и зафиксирую ответ. Удобно когда мысли проще рассказать, чем написать.\n\n' +
        'Теперь 12 вопросов — каждый помогает точнее настроить контент под вашу аудиторию и цели.\n\n' +
        'Отвечайте как удобно.\n\n' +
        QUESTIONS_PART1[0].text
      );
      break;
    }

    // ── Часть 1: В1–В4 ────────────────────────────────────────────────────────
    case STEPS.ANSWERING_PART1: {
      const idx = session.questionIndexPart1;
      const q = QUESTIONS_PART1[idx];
      session.answersPart1.push({ key: q.key, question: q.text, answer: text });
      session.questionIndexPart1++;
      saveSession(chatId, session);
      await typing(ctx, 800);

      // Микро-реакция на ответ
      const reaction1 = await getMicroReaction(q.text, text);
      if (reaction1) await ctx.reply(reaction1);
      await typing(ctx, 600);

      if (session.questionIndexPart1 < QUESTIONS_PART1.length) {
        const next = QUESTIONS_PART1[session.questionIndexPart1];
        await ctx.reply(next.text);
      } else {
        // Переходим к сбору конкурентов
        session.step = STEPS.COLLECTING_COMPETITORS;
        session.competitorNames = [];
        session.awaitingInstagramDesc = false;
        session.pendingInstagramHandle = null;
        saveSession(chatId, session);
        await ctx.reply(
          `${q.bridge}\n\n` +
          'Вопрос 5 из 12\n\n' +
          'Назовите 2-3 конкурентов — отправляйте по одному: название + ссылка на сайт или Telegram.\n\n' +
          'Пример:\n' +
          'Агентство «Рост» — rost-agency.com\n' +
          'Студия Marketo — t.me/marketo_studio\n\n' +
          'Если конкурент только в Instagram — напишите его название, я попрошу описание.\n\n' +
          'Когда добавите всех — напишите: готово\n' +
          'Если не знаете конкурентов — напишите: не знаю'
        );
      }
      break;
    }

    // ── Конкуренты — мультисообщение ─────────────────────────────────────────
    case STEPS.COLLECTING_COMPETITORS: {
      const lower = text.toLowerCase().trim();

      // Ждём описание Instagram-конкурента
      if (session.awaitingInstagramDesc) {
        const handle = session.pendingInstagramHandle;
        session.competitorNames.push(`${handle} (Instagram) — описание: ${text}`);
        session.awaitingInstagramDesc = false;
        session.pendingInstagramHandle = null;
        saveSession(chatId, session);
        await ctx.reply('Добавлен. Добавьте ещё конкурента или напишите: готово');
        return;
      }

      if (lower === 'готово') {
        if (session.competitorNames.length === 0) {
          await ctx.reply('Добавьте хотя бы одного конкурента, или напишите: не знаю — тогда поищу сам.');
          return;
        }
        await startPart2(ctx, session);
        return;
      }

      if (lower === 'не знаю' || lower === 'нет конкурентов') {
        session.competitorNames = [];
        session.autoSearchCompetitors = true;
        saveSession(chatId, session);
        await ctx.reply('Понял — поищу конкурентов сам по нише и региону.');
        await startPart2(ctx, session);
        return;
      }

      if (isInstagram(text)) {
        session.pendingInstagramHandle = text;
        session.awaitingInstagramDesc = true;
        saveSession(chatId, session);
        await ctx.reply(
          'Instagram нельзя прочитать автоматически — требует авторизации.\n\n' +
          'Расскажите об этом конкуренте: что продают, какой контент делают, кто их аудитория?\n\n' +
          'Напишите 2-3 предложения.'
        );
        return;
      }

      session.competitorNames.push(text);
      saveSession(chatId, session);
      await ctx.reply(`Добавлен: ${text}\n\nДобавьте ещё или напишите: готово`);
      break;
    }

    // ── Часть 2: В6–В11 ───────────────────────────────────────────────────────
    case STEPS.ANSWERING_PART2: {
      const idx = session.questionIndexPart2;
      const q = QUESTIONS_PART2[idx];
      session.answersPart2.push({ key: q.key, question: q.text, answer: text });
      session.questionIndexPart2++;
      saveSession(chatId, session);
      await typing(ctx, 800);

      // Микро-реакция на ответ
      const reaction2 = await getMicroReaction(q.text, text);
      if (reaction2) await ctx.reply(reaction2);
      await typing(ctx, 600);

      if (session.questionIndexPart2 < QUESTIONS_PART2.length) {
        const next = QUESTIONS_PART2[session.questionIndexPart2];
        await ctx.reply(next.text);
      } else {
        // Все вопросы В6-В11 собраны — задаём В12
        session.step = STEPS.COLLECTING_FORMAT;
        saveSession(chatId, session);
        await typing(ctx, 800);
        await ctx.reply(
          'Вопрос 12 из 12\n\n' +
          'Как вы видите свой контент — какой формат вам ближе?',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '🎬 С человеком в кадре — я сам, сотрудник или мастер', callback_data: 'fmt_person' }],
                [{ text: '📦 Без человека — продукт, процесс, пространство', callback_data: 'fmt_product' }],
                [{ text: '🤷 Пока не знаю — помогите определиться', callback_data: 'fmt_unsure' }],
              ]
            }
          }
        );
      }
      break;
    }

    // ── Ссылки ────────────────────────────────────────────────────────────────
    case STEPS.COLLECTING_LINKS: {
      if (text.toLowerCase() === 'готово') {
        session.step = STEPS.COLLECTING_EMAIL;
        saveSession(chatId, session);
        await ctx.reply(
          'Почти готово!\n\n' +
          'Куда прислать готовый контент-план? Напишите email.\n\n' +
          'Используем только для отправки материалов — без спама.\n' +
          `Политика конфиденциальности: ${PRIVACY_URL}`
        );
      } else {
        const url = text.startsWith('http') ? text : 'https://' + text;
        if (!session.links) session.links = [];
        session.links.push(url);
        saveSession(chatId, session);
        await ctx.reply(`Добавил: ${url}\n\nДобавьте ещё или напишите: готово`);
      }
      break;
    }

    // ── Email ─────────────────────────────────────────────────────────────────
    case STEPS.COLLECTING_EMAIL: {
      if (!isValidEmail(text)) {
        await ctx.reply('Напишите корректный email, например: name@gmail.com');
        return;
      }
      session.email = text;
      session.step = STEPS.WAITING_FOR_RESULT;
      saveSession(chatId, session);
      saveLead(session);

      await sendAdmin(
        `🔔 Новый лид завершил опрос!\nИмя: ${session.name}\nEmail: ${session.email}\nChatId: ${chatId}`
      );

      writeTrigger(chatId, session);

      await ctx.reply(
        'Всё. Запускаю анализ.\n\n' +
        'Сейчас система изучит вашу нишу, посмотрит на конкурентов и начнёт строить контент под вашу аудиторию.\n\n' +
        'Это займёт несколько минут — результат будет персональным, не шаблонным.\n\n' +
        `Пришлю сюда и продублирую на ${session.email} — чтобы всегда был под рукой.`
      );
      break;
    }

    // ── Ожидание результата ───────────────────────────────────────────────────
    case STEPS.WAITING_FOR_RESULT: {
      await ctx.reply(
        'Контент-план ещё готовится.\n\n' +
        'Пришлю как только будет готово — следите за этим чатом.'
      );
      break;
    }

    // ── Готово — клиент получил бесплатный пакет ─────────────────────────────
    case STEPS.DONE: {
      // (код доступа перехватывается выше до switch)

      // Если написал "да" когда уже done — предлагаем начать заново
      if (text.toLowerCase() === 'да') {
        const session2 = { step: STEPS.COLLECTING_NAME, chatId, links: [] };
        saveSession(chatId, session2);
        await ctx.reply(
          'Начинаем заново!\n\n' +
          'Как вас зовут?'
        );
        return;
      }

      crmLog(chatId, 'question_asked', { text: text.slice(0, 100) });
      await ctx.reply('Есть вопрос? Напишите — отвечу.\n\nИли выберите пакет кнопкой выше.');
      break;
    }

    // ── Платные вопросы (после оплаты) ────────────────────────────────────────

    case STEPS.PAID_WAITING: {
      await ctx.reply('Готовлю первый вопрос — подождите немного.');
      break;
    }

    case STEPS.PAID_Q1: {
      // Текстовый фолбэк для Q1 (цель контента) — если не нажал кнопку
      const paidQ1 = (session.paidQuestions || [])[0];
      session.paidAnswers = session.paidAnswers || [];
      session.paidAnswers.push({ key: 'content_goal', question: paidQ1?.text || '', answer: text });
      session.step = STEPS.PAID_Q2;
      saveSession(chatId, session);
      const q2 = (session.paidQuestions || [])[1];
      if (q2) await ctx.reply(q2.text);
      break;
    }

    case STEPS.PAID_Q2: {
      const paidQ2 = (session.paidQuestions || [])[1];
      session.paidAnswers = session.paidAnswers || [];
      session.paidAnswers.push({ key: 'monthly_focus', question: paidQ2?.text || '', answer: text });
      session.step = STEPS.PAID_Q3;
      saveSession(chatId, session);
      const q3 = (session.paidQuestions || [])[2];
      if (q3) await ctx.reply(q3.text);
      break;
    }

    case STEPS.PAID_Q3: {
      const paidQ3 = (session.paidQuestions || [])[2];
      session.paidAnswers = session.paidAnswers || [];
      session.paidAnswers.push({ key: 'brand_voice', question: paidQ3?.text || '', answer: text });
      session.step = STEPS.PAID_Q4;
      saveSession(chatId, session);
      const q4 = (session.paidQuestions || [])[3];
      if (q4) await ctx.reply(q4.text);
      break;
    }

    case STEPS.PAID_Q4: {
      const paidQ4 = (session.paidQuestions || [])[3];
      session.paidAnswers = session.paidAnswers || [];
      session.paidAnswers.push({ key: 'client_stories', question: paidQ4?.text || '', answer: text });
      session.step = STEPS.PAID_Q5;
      saveSession(chatId, session);
      const q5 = (session.paidQuestions || [])[4];
      if (q5) {
        await ctx.reply(q5.text, {
          reply_markup: {
            inline_keyboard: [
              [{ text: '📸 Всё в Instagram', callback_data: 'plat_instagram' }],
              [{ text: '4+4: Instagram + TikTok', callback_data: 'plat_split' }],
              [{ text: '✏️ Другое — напишу сам', callback_data: 'plat_custom' }],
            ]
          }
        });
      }
      break;
    }

    case STEPS.PAID_Q5: {
      // Текстовый ответ на вопрос про платформы (если не нажал кнопку)
      const paidQ5 = (session.paidQuestions || [])[4];
      session.paidAnswers = session.paidAnswers || [];
      session.paidAnswers.push({ key: 'platforms', question: paidQ5?.text || '', answer: text });
      session.step = STEPS.PAID_Q6;
      saveSession(chatId, session);
      const q6 = (session.paidQuestions || [])[5];
      if (q6) await ctx.reply(q6.text);
      break;
    }

    case STEPS.PAID_Q6: {
      const paidQ6 = (session.paidQuestions || [])[5];
      const followers = parseInt(text.replace(/[^0-9]/g, '')) || 0;
      session.paidAnswers = session.paidAnswers || [];
      session.paidAnswers.push({ key: 'followers_count', question: paidQ6?.text || '', answer: text });
      session.followersCount = followers;
      writePaidTrigger(chatId, session);
      session.step = STEPS.PAID_WAITING;
      saveSession(chatId, session);
      crmLog(chatId, 'paid_questions_done', { followersCount: followers });
      await ctx.reply(
        '✅ Спасибо! Все данные получены.\n\n' +
        'Команда готовит ваш полный контент-пакет — это занимает 30–60 минут.\n\n' +
        'Пришлю результат сюда как только будет готово.'
      );
      await new Promise(r => setTimeout(r, 1200));
      await sendLangUpsell(ctx, chatId, session.paidPackageKey);
      break;
    }

    default: {
      await handleStart(ctx);
      break;
    }
  }
}

// ─── ВСПОМОГАТЕЛЬНАЯ: переход к части 2 ──────────────────────────────────────

async function startPart2(ctx, session) {
  session.step = STEPS.ANSWERING_PART2;
  session.answersPart2 = [];
  session.questionIndexPart2 = 0;
  saveSession(session.chatId, session);
  await ctx.reply(`Принял.\n\n${QUESTIONS_PART2[0].text}`);
}

async function proceedToContentGoal(ctx, chatId, session) {
  session.step = STEPS.COLLECTING_CONTENT_GOAL;
  saveSession(chatId, session);
  await typing(ctx, 600);
  await ctx.reply(
    'Последний вопрос перед тем как запустить генерацию.\n\n' +
    '*Какая главная цель вашего контента в этом месяце?*\n\n' +
    'От ответа зависит как будет выстроен контент-план — темы, порядок, призывы к действию.',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🎯 Привлечь новых клиентов', callback_data: 'cgoal_new' }],
          [{ text: '🔥 Продавать тем кто уже знает меня', callback_data: 'cgoal_warm' }],
        ]
      }
    }
  );
}

async function proceedToLangDocs(ctx, chatId, session) {
  session.step = STEPS.COLLECTING_LANG_DOCS;
  saveSession(chatId, session);
  await typing(ctx, 600);
  await ctx.reply(
    'Почти готово!\n\n' +
    '*На каком языке подготовить аналитику и рабочие документы?*\n\n' +
    'Контент-план, анализ конкурентов, рекомендации — то что читаете вы.',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🇷🇺 Русский', callback_data: 'lang_docs_ru' }],
          [{ text: '🇱🇻 Латышский', callback_data: 'lang_docs_lv' }],
          [{ text: '🇬🇧 Английский', callback_data: 'lang_docs_en' }],
        ]
      }
    }
  );
}

async function proceedToLangContent(ctx, chatId, session) {
  session.step = STEPS.COLLECTING_LANG_CONTENT;
  saveSession(chatId, session);
  await typing(ctx, 600);
  await ctx.reply(
    '*На каком языке подготовить контент для публикации?*\n\n' +
    'Посты, статьи, карусели, видео, обложки — то что увидят ваши клиенты.',
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: '🇷🇺 Русский', callback_data: 'lang_content_ru' }],
          [{ text: '🇱🇻 Латышский', callback_data: 'lang_content_lv' }],
          [{ text: '🇬🇧 Английский', callback_data: 'lang_content_en' }],
        ]
      }
    }
  );
}

async function proceedToLinks(ctx, chatId, session) {
  session.step = STEPS.COLLECTING_LINKS;
  session.links = [];
  saveSession(chatId, session);
  await typing(ctx, 600);
  await ctx.reply(
    'Отлично! Все ответы получены.\n\n' +
    'Последняя просьба — пришлите ссылки на ваши соцсети или сайт.\n\n' +
    'Instagram, TikTok, LinkedIn, сайт — что есть. Это поможет понять как вы выглядите онлайн.\n\n' +
    'Каждую ссылку отдельным сообщением.\n' +
    'Когда добавите всё — напишите: готово\n\n' +
    'Если ссылок пока нет — тоже напишите: готово'
  );
}

// ─── РОУТЫ ────────────────────────────────────────────────────────────────────

bot.start(handleStart);

bot.command('restart', async (ctx) => {
  const session = { step: STEPS.COLLECTING_NAME, chatId: ctx.chat.id, links: [] };
  saveSession(ctx.chat.id, session);
  await ctx.reply(
    'Начинаем заново!\n\n' +
    'Как вас зовут?'
  );
});

// ─── В12: ВЫБОР ФОРМАТА КОНТЕНТА ─────────────────────────────────────────────

const FORMAT_LABELS = {
  fmt_person_lead:    'Главный герой — говорит, объясняет, ведёт',
  fmt_person_support: 'Второй план — показывает процесс или мастерство',
  fmt_product:        'Без человека — продукт, процесс, пространство',
  fmt_unsure:         'Пока не знаю — помогите определиться',
};

// Шаг 1 — первичный выбор
bot.action(/^fmt_(person|product|unsure)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const choice = ctx.match[1]; // person / product / unsure
  const session = loadSession(chatId);

  if (session.step !== STEPS.COLLECTING_FORMAT) return;

  if (choice === 'person') {
    // Уточняем роль человека
    await ctx.editMessageText(
      'Вопрос 12 из 12\n\nКакую роль играет человек в вашем контенте?',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎤 Главный герой — говорит, объясняет, ведёт блог', callback_data: 'fmt_person_lead' }],
            [{ text: '🤝 Второй план — показывает процесс или мастерство', callback_data: 'fmt_person_support' }],
          ]
        }
      }
    );
    return;
  }

  // product или unsure — сразу к ссылкам
  const fullKey = choice === 'product' ? 'fmt_product' : 'fmt_unsure';
  session.contentFormat = fullKey;
  await ctx.editMessageText(`Вопрос 12 из 12\n\nФормат: ${FORMAT_LABELS[fullKey]}`);
  await proceedToContentGoal(ctx, chatId, session);
});

// ─── В13: ЦЕЛЬ КОНТЕНТ-ПЛАНА ──────────────────────────────────────────────────

bot.action(/^cgoal_(new|warm)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const session = loadSession(chatId);

  if (session.step !== STEPS.COLLECTING_CONTENT_GOAL) return;

  const choice = ctx.match[1]; // 'new' or 'warm'
  session.contentPlanGoal = choice === 'new'
    ? 'привлечение новых клиентов'
    : 'продажи существующей аудитории';

  await ctx.editMessageText(`Цель контента: ${session.contentPlanGoal} ✓`);
  await proceedToLangDocs(ctx, chatId, session);
});

// ─── В14: ЯЗЫК АНАЛИТИКИ ─────────────────────────────────────────────────────

bot.action(/^lang_docs_(ru|lv|en)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const session = loadSession(chatId);

  if (session.step !== STEPS.COLLECTING_LANG_DOCS) return;

  session.analyticsLanguage = ctx.match[1];
  await ctx.editMessageText(`Язык аналитики: ${LANG_LABELS[ctx.match[1]]} ✓`);
  await proceedToLangContent(ctx, chatId, session);
});

// ─── В15: ЯЗЫК КОНТЕНТА ───────────────────────────────────────────────────────

bot.action(/^lang_content_(ru|lv|en)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const session = loadSession(chatId);

  if (session.step !== STEPS.COLLECTING_LANG_CONTENT) return;

  session.contentLanguage = ctx.match[1];
  await ctx.editMessageText(`Язык контента: ${LANG_LABELS[ctx.match[1]]} ✓`);
  await proceedToLinks(ctx, chatId, session);
});

// Шаг 2 — уточнение роли человека (только если выбрал "с человеком")
bot.action(/^fmt_person_(lead|support)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const fullKey = ctx.match[0]; // fmt_person_lead / fmt_person_support
  const session = loadSession(chatId);

  if (session.step !== STEPS.COLLECTING_FORMAT) return;

  session.contentFormat = fullKey;
  await ctx.editMessageText(`Вопрос 12 из 12\n\nФормат: ${FORMAT_LABELS[fullKey]}`);
  await proceedToContentGoal(ctx, chatId, session);
});

bot.command('codes', async (ctx) => {
  if (String(ctx.chat.id) !== String(ADMIN_CHAT_ID)) return;
  await ctx.reply('📊 Коды доступа:\n\n' + getCodeStats());
});

bot.command('resume', async (ctx) => {
  const chatId = ctx.chat.id;
  const session = loadSession(chatId);

  const stepMessages = {
    [STEPS.COLLECTING_NAME]:        'Как вас зовут?',
    [STEPS.COLLECTING_DESCRIPTION]: 'Расскажите о своём бизнесе: что продаёте, кому?',
    [STEPS.COLLECTING_LINKS]:       'Пришлите ссылки на соцсети или сайт (каждую отдельно), или напишите: готово',
    [STEPS.COLLECTING_EMAIL]:       'Напишите email — куда прислать контент-план?',
    [STEPS.WAITING_FOR_RESULT]:     'Контент-план готовится. Пришлю когда будет готово — следите за этим чатом.',
    [STEPS.DONE]:                   'Ваш контент готов — посмотрите выше.',
    [STEPS.WEBSITE_PAYMENT]:        'Ожидаем подтверждение оплаты — нажмите «Я оплатил» в сообщении выше.',
  };

  if (session.step === STEPS.ANSWERING_PART1) {
    const idx = session.questionIndexPart1 || 0;
    const q = QUESTIONS_PART1[idx];
    if (q) { await ctx.reply(`📍 Продолжаем.\n\n${q.text}`); return; }
  }

  if (session.step === STEPS.COLLECTING_COMPETITORS) {
    await ctx.reply(
      '📍 Продолжаем.\n\n' +
      'Вопрос 5 из 12 — Конкуренты\n\n' +
      'Назовите конкурентов по одному (название + ссылка), или напишите: не знаю\n' +
      'Когда закончите — напишите: готово'
    );
    return;
  }

  if (session.step === STEPS.ANSWERING_PART2) {
    const idx = session.questionIndexPart2 || 0;
    const q = QUESTIONS_PART2[idx];
    if (q) { await ctx.reply(`📍 Продолжаем.\n\n${q.text}`); return; }
  }



  if (session.step === STEPS.COLLECTING_CONTENT_GOAL) {
    await ctx.reply(
      '📍 Продолжаем.\n\nКакая главная цель вашего контента в этом месяце?',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🎯 Привлечь новых клиентов', callback_data: 'cgoal_new' }],
            [{ text: '🔥 Продавать тем кто уже знает меня', callback_data: 'cgoal_warm' }],
          ]
        }
      }
    );
    return;
  }

  if (session.step === STEPS.COLLECTING_LANG_DOCS) {
    await ctx.reply(
      '📍 Продолжаем.\n\nНа каком языке подготовить аналитику и рабочие документы?',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🇷🇺 Русский', callback_data: 'lang_docs_ru' }],
            [{ text: '🇱🇻 Латышский', callback_data: 'lang_docs_lv' }],
            [{ text: '🇬🇧 Английский', callback_data: 'lang_docs_en' }],
          ]
        }
      }
    );
    return;
  }

  if (session.step === STEPS.COLLECTING_LANG_CONTENT) {
    await ctx.reply(
      '📍 Продолжаем.\n\nНа каком языке подготовить контент для публикации?',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🇷🇺 Русский', callback_data: 'lang_content_ru' }],
            [{ text: '🇱🇻 Латышский', callback_data: 'lang_content_lv' }],
            [{ text: '🇬🇧 Английский', callback_data: 'lang_content_en' }],
          ]
        }
      }
    );
    return;
  }

  if (session.step === STEPS.WEBSITE_DETAILS) {
    const questions = getWebsiteQuestions(session.websiteDetails?.template);
    const idx = session.websiteDetails?.questionIndex || 0;
    const q = questions[idx];
    if (q) { await ctx.reply(`📍 Продолжаем.\n\n${q.text}`); return; }
  }

  const msg = stepMessages[session.step];
  if (msg) {
    await ctx.reply(`📍 Продолжаем с того места.\n\n${msg}`);
  } else {
    await ctx.reply('Напишите /start чтобы начать заново.');
  }
});

// ─── ВЫБОР ПАКЕТА (inline-кнопки) ────────────────────────────────────────────

const STRIPE_LINKS = {
  pkg_a:               'https://buy.stripe.com/9B6aERa3P1cEdJQ9NP5Rm0a',
  pkg_standard:        'https://buy.stripe.com/00waER0tf4oQeNU4tv5Rm0n',
  pkg_v:               'https://buy.stripe.com/00waER4Jv2gI5dk2ln5Rm0k',
  pkg_a_discount:      'https://buy.stripe.com/4gMbIVcbXcVm5dke455Rm0g',
  pkg_standard_discount: 'https://buy.stripe.com/9B67sFa3P3kM35c7FH5Rm0o',
  pkg_v_discount:      'https://buy.stripe.com/cNi14h7VH6wYdJQ4tv5Rm0l',
  pkg_a_lang:          'https://buy.stripe.com/fZu4gt5Nz7B2cFM2ln5Rm0e',
  pkg_standard_lang:   'https://buy.stripe.com/8x2fZb4Jv5sUbBI8JL5Rm0p',
  pkg_v_lang:          'https://buy.stripe.com/5kQ14hek58F69tA6BD5Rm0m',
};

const PKG_LABELS = {
  pkg_a:               'Тариф Старт — €150/мес',
  pkg_standard:        'Тариф Стандарт — €250/мес',
  pkg_v:               'Тариф Профи — €350/мес',
  pkg_a_discount:      'Тариф Старт — €120/мес (скидка 20%)',
  pkg_standard_discount: 'Тариф Стандарт — €200/мес (скидка 20%)',
  pkg_v_discount:      'Тариф Профи — €280/мес (скидка 20%)',
  pkg_a_lang:          'Доп. язык — Старт €30/мес',
  pkg_standard_lang:   'Доп. язык — Стандарт €60/мес',
  pkg_v_lang:          'Доп. язык — Профи €90/мес',
};

async function handlePackageSelection(ctx, pkgKey) {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const session = loadSession(chatId);
  const label = PKG_LABELS[pkgKey];
  const link = STRIPE_LINKS[pkgKey];
  const isDiscount = pkgKey.includes('_discount');

  // Если скидочная кнопка — проверяем не истёк ли таймер
  if (isDiscount) {
    const clientFile = path.join(SESSIONS_DIR, `${chatId}.json`);
    let clientSession = {};
    try { clientSession = JSON.parse(fs.readFileSync(clientFile, 'utf8')); } catch { }
    if (clientSession.discountExpired) {
      await ctx.reply('Срок специального предложения истёк. Актуальные тарифы ниже.', {
        reply_markup: {
          inline_keyboard: [
            [{ text: '🔥 Тариф Старт — €150/мес', callback_data: 'pkg_a' }],
            [{ text: '⭐ Тариф Стандарт — €250/мес', callback_data: 'pkg_standard' }],
            [{ text: '✨ Тариф Профи — €350/мес', callback_data: 'pkg_v' }],
          ]
        }
      });
      return;
    }
    // Фиксируем что скидка использована
    const file = path.join(SESSIONS_DIR, `${chatId}.json`);
    try {
      const s = JSON.parse(fs.readFileSync(file, 'utf8'));
      s.discountUsed = true;
      fs.writeFileSync(file, JSON.stringify(s, null, 2));
    } catch { }
  }

  crmLog(chatId, 'pkg_selected', { package: label });
  crmLog(chatId, 'payment_initiated', { package: label, discount: isDiscount });

  // Добавляем chatId в ссылку — Stripe вернёт его в вебхуке
  const payLink = `${link}?client_reference_id=${chatId}--${pkgKey}`;

  await ctx.reply(
    `Отлично! Вы выбрали: ${label}\n\n` +
    `Нажмите кнопку ниже для оплаты — после подтверждения платежа всё запустится автоматически.`,
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: `💳 Оплатить ${label}`, url: payLink }],
          [{ text: '✅ Я уже оплатил', callback_data: `paid_confirm_${pkgKey}` }],
        ]
      }
    }
  );

  await sendAdmin(
    `👀 Клиент смотрит на оплату\n` +
    `Пакет: ${label}\n` +
    `Скидка: ${isDiscount ? 'да 20%' : 'нет'}\n` +
    `Имя: ${session.name || '—'}\n` +
    `Email: ${session.email || '—'}\n` +
    `ChatId: ${chatId}\n\n` +
    `(ссылка на оплату отправлена — ждём подтверждения)`
  );
}

bot.action('pkg_a', (ctx) => handlePackageSelection(ctx, 'pkg_a'));
bot.action('pkg_standard', (ctx) => handlePackageSelection(ctx, 'pkg_standard'));
bot.action('pkg_v', (ctx) => handlePackageSelection(ctx, 'pkg_v'));
bot.action('pkg_a_discount', (ctx) => handlePackageSelection(ctx, 'pkg_a_discount'));
bot.action('pkg_standard_discount', (ctx) => handlePackageSelection(ctx, 'pkg_standard_discount'));
bot.action('pkg_v_discount', (ctx) => handlePackageSelection(ctx, 'pkg_v_discount'));

// ─── ПОДТВЕРЖДЕНИЕ ОПЛАТЫ ─────────────────────────────────────────────────────

bot.action(/^paid_confirm_(pkg_a|pkg_standard|pkg_v|pkg_a_discount|pkg_standard_discount|pkg_v_discount)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const pkgKey = ctx.match[1];
  const session = loadSession(chatId);

  writePaidInitTrigger(chatId, session, pkgKey);

  session.step = STEPS.PAID_WAITING;
  session.paidPackageKey = pkgKey;
  session.paidAnswers = [];
  saveSession(chatId, session);

  crmLog(chatId, 'payment_confirmed', { package: pkgKey });

  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply(
    '✅ Отлично! Оплата подтверждена.\n\n' +
    'Сейчас задам несколько уточняющих вопросов — займёт 2 минуты.\n' +
    'Это поможет подготовить контент максимально точно под ваш бизнес.'
  );
});

// ─── ПЛАТФОРМЫ (вопрос 5) ─────────────────────────────────────────────────────

async function completePaidQ5(ctx, platformAnswer) {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const session = loadSession(chatId);
  if (session.step !== STEPS.PAID_Q5) return;

  const paidQ5 = (session.paidQuestions || [])[4];
  session.paidAnswers = session.paidAnswers || [];
  session.paidAnswers.push({ key: 'platforms', question: paidQ5?.text || 'Платформы?', answer: platformAnswer });
  session.step = STEPS.PAID_Q6;
  saveSession(chatId, session);

  await ctx.editMessageText(`Платформа: ${platformAnswer} ✓`).catch(() => {});
  const q6 = (session.paidQuestions || [])[5];
  if (q6) await ctx.reply(q6.text);
}

// ─── ЯЗЫК UPSELL ─────────────────────────────────────────────────────────────

async function sendLangUpsell(_ctx, chatId, packageKey) {
  const isProfi    = (packageKey || '').includes('pkg_v');
  const isStandard = (packageKey || '').includes('pkg_standard');
  const langPrice  = isProfi ? '€90' : isStandard ? '€60' : '€30';
  const langLink   = isProfi
    ? 'https://buy.stripe.com/5kQ14hek58F69tA6BD5Rm0m'
    : isStandard
      ? 'https://buy.stripe.com/8x2fZb4Jv5sUbBI8JL5Rm0p'
      : 'https://buy.stripe.com/fZu4gt5Nz7B2cFM2ln5Rm0e';

  await bot.telegram.sendMessage(
    chatId,
    '💡 *Дополнение — второй язык контента*\n\n' +
    'Хотите получать тот же контент на двух языках?\n' +
    'Например: латышский + английский, или латышский + русский.\n\n' +
    `Стоимость: *+${langPrice}/мес* — отдельная подписка.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: `➕ Добавить второй язык — ${langPrice}/мес`, url: `${langLink}?client_reference_id=${chatId}--lang` }],
          [{ text: '✅ Уже оплатил второй язык', callback_data: 'lang_paid_confirm' }],
          [{ text: 'Нет, одного языка достаточно', callback_data: 'lang_skip' }],
        ]
      }
    }
  );
}

// ─── ADD LANGUAGE FLOW ────────────────────────────────────────────────────────

async function showAddLang(ctx) {
  const chatId = ctx.chat.id;
  const session = loadSession(chatId) || {};
  const pkg = session.paidPackageKey;

  if (!pkg) {
    const s = loadSession(chatId) || {};
    s.step = 'addlang_identify';
    saveSession(chatId, s);
    await ctx.reply(
      '❓ Не нашёл вашу подписку в этом аккаунте.\n\n' +
      'Возможно, вы оплачивали или заполняли анкету с другого Telegram-аккаунта.\n\n' +
      'Напишите здесь ваше *имя* и *email* — мы найдём вашу подписку и добавим язык вручную в течение 24 часов.',
      { parse_mode: 'Markdown' }
    );
    return;
  }

  const currentLang = session.contentLanguage || 'ru';
  const allLangs = ['lv', 'ru', 'en'];
  const available = allLangs.filter(l => l !== currentLang);

  const isProfi    = pkg.includes('pkg_v');
  const isStandard = pkg.includes('pkg_standard');
  const price = isProfi ? '€90' : isStandard ? '€60' : '€30';

  await ctx.reply(
    `Вы получаете контент на *${LANG_LABELS[currentLang]}*.\n\n` +
    `Какой язык хотите добавить? Стоимость: *+${price}/мес*`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          ...available.map(l => [{ text: LANG_NAMES[l], callback_data: `addlang_${l}` }]),
          [{ text: 'Отмена', callback_data: 'addlang_cancel' }],
        ]
      }
    }
  );
}

bot.command('addlang', async (ctx) => { await showAddLang(ctx); });

bot.action(/^addlang_([a-z]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const lang = ctx.match[1];
  if (lang === 'cancel') {
    await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
    await ctx.reply('Хорошо, второй язык не добавлен. Напишите /addlang когда будете готовы.');
    return;
  }
  const chatId = ctx.chat.id;
  const session = loadSession(chatId);
  const pkg = session.paidPackageKey;
  const isProfi    = (pkg || '').includes('pkg_v');
  const isStandard = (pkg || '').includes('pkg_standard');
  const price    = isProfi ? '€90' : isStandard ? '€60' : '€30';
  const langLink = isProfi
    ? 'https://buy.stripe.com/5kQ14hek58F69tA6BD5Rm0m'
    : isStandard
      ? 'https://buy.stripe.com/8x2fZb4Jv5sUbBI8JL5Rm0p'
      : 'https://buy.stripe.com/fZu4gt5Nz7B2cFM2ln5Rm0e';

  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply(
    `Отлично! Добавляем *${LANG_NAMES[lang]}* к вашему контенту.\n\n` +
    `Стоимость: *+${price}/мес*\n\n` +
    `После оплаты нажмите «Я оплатил» — подготовим контент на втором языке.`,
    {
      parse_mode: 'Markdown',
      reply_markup: {
        inline_keyboard: [
          [{ text: `💳 Оплатить ${price}`, url: `${langLink}?client_reference_id=${chatId}--addlang-${lang}` }],
          [{ text: '✅ Я оплатил', callback_data: `addlang_paid_${lang}` }],
        ]
      }
    }
  );
});

bot.action(/^addlang_paid_([a-z]+)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const lang = ctx.match[1];
  const chatId = ctx.chat.id;
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});

  // Обновляем сессию — добавляем новый язык
  const session = loadSession(chatId) || {};
  session.additionalLanguage = lang;
  saveSession(chatId, session);

  // Пишем триггер для Bot1
  if (!fs.existsSync(TRIGGERS_DIR)) fs.mkdirSync(TRIGGERS_DIR, { recursive: true });
  fs.writeFileSync(
    path.join(TRIGGERS_DIR, `${chatId}.addlang.trigger`),
    JSON.stringify({ chatId: String(chatId), lang, packageKey: session.paidPackageKey, name: session.name, timestamp: Date.now() }, null, 2)
  );

  crmLog(chatId, 'addlang_purchased', { lang });
  await ctx.reply(
    `✅ Оплата принята!\n\nГотовим ваш контент-пакет на *${LANG_NAMES[lang]}*.\nПришлём как только будет готово — обычно в течение 24 часов.`,
    { parse_mode: 'Markdown' }
  );
});

bot.action('lang_skip', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply('Хорошо! Контент будет на одном языке. Пришлю пакет как только будет готово.');
  await new Promise(r => setTimeout(r, 1000));
  await ctx.reply(ANALYTICS_ONBOARDING_TEXT, { parse_mode: 'Markdown' });
});

bot.action('lang_paid_confirm', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  await ctx.reply('✅ Отлично! Второй язык добавлен. Подготовим контент на двух языках.');
  const chatId = ctx.chat.id;
  crmLog(chatId, 'lang_addon_purchased', {});
  await new Promise(r => setTimeout(r, 1000));
  await ctx.reply(ANALYTICS_ONBOARDING_TEXT, { parse_mode: 'Markdown' });
});

bot.action('plat_instagram', (ctx) => completePaidQ5(ctx, 'Instagram'));
bot.action('plat_split', (ctx) => completePaidQ5(ctx, 'Instagram + TikTok (4+4)'));
bot.action('plat_custom', async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const session = loadSession(chatId);
  if (session.step !== STEPS.PAID_Q5) return;
  await ctx.editMessageText('Напишите платформы в следующем сообщении:').catch(() => {});
});

// ─── ЦЕЛЬ КОНТЕНТА paid (вопрос 1) ───────────────────────────────────────────

bot.action(/^paid_cgoal_(new|warm)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const session = loadSession(chatId);
  if (session.step !== STEPS.PAID_Q1) return;

  const goalLabel = ctx.match[1] === 'new' ? 'Привлечь новых клиентов' : 'Продавать тем кто уже знает меня';
  const paidQ1 = (session.paidQuestions || [])[0];
  session.paidAnswers = session.paidAnswers || [];
  session.paidAnswers.push({ key: 'content_goal', question: paidQ1?.text || '', answer: goalLabel });
  session.step = STEPS.PAID_Q2;
  saveSession(chatId, session);

  await ctx.editMessageText(`Цель: ${goalLabel} ✓`).catch(() => {});
  const q2 = (session.paidQuestions || [])[1];
  if (q2) await ctx.reply(q2.text);
});

// ─── ОПРОСНИК НА САЙТ ────────────────────────────────────────────────────────

bot.action('website_upsell', async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const session = loadSession(chatId);
  session.step = STEPS.WEBSITE_QUESTIONNAIRE;
  session.websiteAnswers = {};
  saveSession(chatId, session);

  await ctx.reply(
    'Отлично! Пара вопросов — займёт 1 минуту.\n\nЧто будет на сайте?',
    {
      reply_markup: {
        inline_keyboard: [
          [{ text: '🏢 Визитка компании', callback_data: 'ws_type_card' }],
          [{ text: '🛍 Услуги или продукты', callback_data: 'ws_type_services' }],
        ]
      }
    }
  );
});

bot.action('website_no', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageText('Понял — если понадобится, обращайтесь.');
});

// Подтверждение оплаты сайта — запуск этапа 2
bot.action(/^ws_paid_(vizitka|expert)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId   = ctx.chat.id;
  const template = ctx.match[1];
  const session  = loadSession(chatId);
  const questions = getWebsiteQuestions(template);

  session.step           = STEPS.WEBSITE_DETAILS;
  session.websiteDetails = { template, questionIndex: 0, answers: {} };
  saveSession(chatId, session);

  crmLog(chatId, 'site_payment_confirmed', { template });

  const templateRu = template === 'expert' ? 'Эксперт (€299)' : 'Визитка (€150)';
  await sendAdmin(
    `💳 Клиент подтвердил оплату сайта!\n\n` +
    `Шаблон: ${templateRu}\nChatId: ${chatId}\nИмя: ${session.name || '—'}\n\n` +
    `Этап 2 запущен автоматически.`
  );

  await ctx.editMessageText('✅ Отлично! Оплата принята.\n\nНачинаем собирать данные для вашего сайта — займёт 5-7 минут.');
  await new Promise(r => setTimeout(r, 600));
  await ctx.reply(
    `Всего ${questions.length} вопросов — отвечайте в удобном темпе, прогресс сохраняется.\n\n` +
    questions[0].text
  );
});

bot.action(/^ws_path_(site|content|both)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const choice = ctx.match[1];
  const session = loadSession(chatId);

  if (choice === 'site') {
    session.step = STEPS.WEBSITE_QUESTIONNAIRE;
    session.websiteAnswers = { waitingName: true };
    saveSession(chatId, session);
    await ctx.editMessageText('Хорошо! Пара вопросов — займёт 1 минуту.\n\nКак вас зовут?');
  } else if (choice === 'content') {
    session.step = STEPS.COLLECTING_NAME;
    saveSession(chatId, session);
    await ctx.editMessageText(
      'Хорошо!\n\nМы бесплатно создадим для вас:\n\n' +
      '📅 Контент-план на 7 дней\n' +
      '📝 SEO-статья для сайта\n' +
      '🎨 Пример обложки для видео\n' +
      '📸 Пример готового поста: AI-изображение + текст\n' +
      '🎬 Сценарий ролика (Reels / TikTok)\n' +
      '🎠 Карусель — 5 готовых слайдов\n\n' +
      'Как вас зовут?'
    );
  } else { // both
    session.step = STEPS.COLLECTING_NAME;
    session.wantsWebsite = true;
    saveSession(chatId, session);
    await ctx.editMessageText(
      'Отлично! Начнём с контент-плана — это займёт 7–10 минут.\n' +
      'После получите бесплатный пакет, а затем перейдём к вопросам про сайт.\n\n' +
      'Как вас зовут?'
    );
  }
});

bot.action(/^ws_type_(card|services)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const choice = ctx.match[1];
  const session = loadSession(chatId);

  session.websiteAnswers.siteType = choice === 'card' ? 'Визитка компании' : 'Услуги/продукты';

  if (choice === 'services') {
    saveSession(chatId, session);
    await ctx.editMessageText('Сколько услуг или продуктов хотите разместить?', {
      reply_markup: {
        inline_keyboard: [
          [{ text: '1–5', callback_data: 'ws_count_1_5' }],
          [{ text: '6–10', callback_data: 'ws_count_6_10' }],
          [{ text: '11–20', callback_data: 'ws_count_11_20' }],
          [{ text: 'Больше 20', callback_data: 'ws_count_20plus' }],
        ]
      }
    });
  } else {
    saveSession(chatId, session);
    await ctx.editMessageText('Тип: Визитка компании');
    await askWsDomain(ctx);
  }
});

bot.action(/^ws_count_(1_5|6_10|11_20|20plus)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const session = loadSession(chatId);
  const countMap = { '1_5': '1–5', '6_10': '6–10', '11_20': '11–20', '20plus': 'Больше 20' };
  session.websiteAnswers.serviceCount = countMap[ctx.match[1]];
  saveSession(chatId, session);
  await ctx.editMessageText(`Количество: ${session.websiteAnswers.serviceCount}`);
  await askWsDomain(ctx);
});

async function askWsDomain(ctx) {
  await ctx.reply('Домен (адрес сайта) уже есть?', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Есть', callback_data: 'ws_domain_yes' }],
        [{ text: '❌ Нет', callback_data: 'ws_domain_no' }],
        [{ text: '🤔 Нужна помощь с выбором', callback_data: 'ws_domain_help' }],
      ]
    }
  });
}

bot.action(/^ws_domain_(yes|no|help)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const session = loadSession(chatId);
  const domainMap = { yes: 'Есть', no: 'Нет', help: 'Нужна помощь с выбором' };
  session.websiteAnswers.domain = domainMap[ctx.match[1]];
  saveSession(chatId, session);
  await ctx.editMessageText(`Домен: ${domainMap[ctx.match[1]]}`);
  await ctx.reply('Логотип и фирменные цвета есть?', {
    reply_markup: {
      inline_keyboard: [
        [{ text: '✅ Есть', callback_data: 'ws_logo_yes' }],
        [{ text: '❌ Нет', callback_data: 'ws_logo_no' }],
        [{ text: '🔄 Частично', callback_data: 'ws_logo_partial' }],
      ]
    }
  });
});

bot.action(/^ws_logo_(yes|no|partial)$/, async (ctx) => {
  await ctx.answerCbQuery();
  const chatId = ctx.chat.id;
  const session = loadSession(chatId);
  const logoMap = { yes: 'Есть', no: 'Нет', partial: 'Частично' };
  session.websiteAnswers.logo = logoMap[ctx.match[1]];
  session.websiteAnswers.waitingExamples = true;
  saveSession(chatId, session);
  await ctx.editMessageText(`Логотип: ${logoMap[ctx.match[1]]}`);
  await ctx.reply(
    'Последнее — есть примеры сайтов которые вам нравятся визуально?\n\n' +
    'Отправьте ссылку или несколько. Если нет — напишите: нет'
  );
});

// ─── WEBSITE DETAILS: ЭТАП 2 ОПРОСНИКА ───────────────────────────────────────

function getWebsiteQuestions(template) {
  return template === 'expert' ? EXPERT_QUESTIONS : VIZITKA_QUESTIONS;
}


async function buildAndDeploySite(chatId, session) {
  const template = session.websiteDetails.template;
  const answers  = session.websiteDetails.answers || {};

  const dataObj  = template === 'expert' ? mapToExpertData(answers) : mapToVizitkaData(answers);
  const tmplFile = template === 'expert' ? 'expert-template.html' : 'vizitka-template.html';
  const outDir   = `dist-client-${chatId}`;
  const dataFile = `data-client-${chatId}.json`;

  fs.writeFileSync(
    path.join(CLIENT_TEMPLATE_DIR, dataFile),
    JSON.stringify(dataObj, null, 2)
  );

  let previewUrl = null;
  try {
    const output = execSync(
      `node build.js "${dataFile}" "${tmplFile}" "${outDir}" --deploy`,
      { cwd: CLIENT_TEMPLATE_DIR, encoding: 'utf8', timeout: 120000 }
    );
    const match = output.match(/https:\/\/[^\s]+netlify\.app/);
    previewUrl = match ? match[0] : null;
  } catch (err) {
    console.error('Site build error:', err.message);
  }

  return { previewUrl, dataFile, outDir };
}

// Обработчик текстовых сообщений в шаге WEBSITE_DETAILS
// Вызывается из handleMessage до основного switch
async function handleWebsiteDetails(ctx, chatId, text, session) {
  const questions = getWebsiteQuestions(session.websiteDetails.template);
  const idx       = session.websiteDetails.questionIndex;

  if (idx >= questions.length) return false; // уже завершён

  // Сохраняем ответ на текущий вопрос
  const key = questions[idx].key;
  session.websiteDetails.answers[key] = text;
  session.websiteDetails.questionIndex = idx + 1;
  saveSession(chatId, session);

  if (session.websiteDetails.questionIndex < questions.length) {
    // Следующий вопрос
    await ctx.reply(questions[session.websiteDetails.questionIndex].text);
  } else {
    // Все вопросы собраны — строим сайт
    await ctx.reply('Отлично! Все данные получены.\n\nСобираю ваш сайт — займёт около минуты...');

    const { previewUrl, dataFile } = await buildAndDeploySite(chatId, session);

    session.step = STEPS.DONE;
    saveSession(chatId, session);

    const template   = session.websiteDetails.template;
    const answers    = session.websiteDetails.answers;
    const name       = answers.fullName || session.name || '—';
    const email      = answers.email   || session.email  || '—';
    const templateRu = template === 'expert' ? 'Эксперт (€299)' : 'Визитка (€150)';

    if (previewUrl) {
      await ctx.reply(
        `✅ Сайт собран!\n\n` +
        `Александр проверит его и пришлёт ссылку когда всё будет готово.`
      );
      await sendAdmin(
        `🌐 Сайт клиента собран!\n\n` +
        `Имя: ${name}\nEmail: ${email}\nChatId: ${chatId}\n` +
        `Шаблон: ${templateRu}\n\n` +
        `📎 Preview: ${previewUrl}\n\n` +
        `Проверь сайт и при необходимости отредактируй файл:\n` +
        `~/client-site-template/${dataFile}\n\n` +
        `⚠️ Hero и about фото — заглушки. Замените на фото клиента.`
      );
    } else {
      await ctx.reply(
        `✅ Данные получены!\n\n` +
        `Александр подготовит сайт и пришлёт ссылку в ближайшее время.`
      );
      await sendAdmin(
        `🌐 Данные для сайта клиента собраны!\n\n` +
        `Имя: ${name}\nEmail: ${email}\nChatId: ${chatId}\n` +
        `Шаблон: ${templateRu}\n\n` +
        `Файл данных: ~/client-site-template/${dataFile}\n` +
        `Собрать вручную:\ncd ~/client-site-template && node build.js ${dataFile} ${template}-template.html dist-client-${chatId} --deploy`
      );
    }
  }
  return true;
}

// ─── CRM КОМАНДЫ ─────────────────────────────────────────────────────────────

bot.command('clients', async (ctx) => {
  if (String(ctx.chat.id) !== String(ADMIN_CHAT_ID)) return;
  const list = crmList();
  if (!list.length) { await ctx.reply('Клиентов пока нет.'); return; }
  const chunks = [];
  let chunk = '';
  for (const record of list) {
    const line = formatClient(record) + '\n\n─────\n\n';
    if (chunk.length + line.length > 3800) { chunks.push(chunk); chunk = ''; }
    chunk += line;
  }
  if (chunk) chunks.push(chunk);
  for (const c of chunks) await ctx.reply(c);
});

bot.command('crm', async (ctx) => {
  if (String(ctx.chat.id) !== String(ADMIN_CHAT_ID)) return;
  const parts = ctx.message.text.trim().split(/\s+/);
  const targetId = parts[1];
  if (!targetId) { await ctx.reply('Укажи chatId:\n/crm 123456789'); return; }
  const record = crmGet(targetId);
  await ctx.reply(formatClientFull(record));
});

// ─── ГОЛОСОВЫЕ СООБЩЕНИЯ ──────────────────────────────────────────────────────

bot.on(filterMessage('voice'), async (ctx) => {
  if (!process.env.GROQ_API_KEY) {
    await ctx.reply('🎤 Голосовые сообщения пока не поддерживаются.\n\nНапишите текстом или /resume чтобы повторить вопрос.');
    return;
  }

  await ctx.reply('🎤 Распознаю голос...');

  try {
    const fileId = ctx.message.voice.file_id;
    const text = await transcribeVoice(bot, fileId);
    if (!text || text.length < 2) {
      await ctx.reply('Не удалось распознать. Попробуйте ещё раз или напишите текстом.');
      return;
    }
    await ctx.reply(`📝 Распознано:\n"${text}"`);
    await handleMessage({ ...ctx, message: { ...ctx.message, text } });
  } catch (err) {
    console.error('Transcription error:', err.message);
    await ctx.reply('Не удалось распознать голос. Напишите текстом.');
  }
});

bot.on(filterMessage('text'), async (ctx) => {
  try {
    await handleMessage(ctx);
  } catch (e) {
    console.error('Handler error:', e);
    try {
      // Сохраняем флаг — следующее сообщение запустит автовосстановление
      const chatId = ctx.chat.id;
      const session = loadSession(chatId);
      session._resumeAfterError = true;
      saveSession(chatId, session);
      await ctx.reply(
        '⚠️ Что-то пошло не так — но прогресс сохранён.\n\n' +
        'Напишите *продолжить* — и я вернусь к тому месту где остановились.',
        { parse_mode: 'Markdown' }
      );
    } catch { }
  }
});

// ─── STRIPE WEBHOOK SERVER ────────────────────────────────────────────────────

const express = require('express');
const app = express();

app.post('/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;

  let event;
  try {
    if (webhookSecret) {
      const Stripe = require('stripe');
      const stripe = Stripe(process.env.STRIPE_SECRET_KEY || '');
      event = stripe.webhooks.constructEvent(req.body, sig, webhookSecret);
    } else {
      event = JSON.parse(req.body.toString());
    }
  } catch (err) {
    console.error('Stripe webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const ref = session.client_reference_id || '';
    const [chatId, pkgKey] = ref.split('--');

    if (chatId && pkgKey) {
      try {
        const email = session.customer_details?.email || '—';
        const name  = session.customer_details?.name  || '—';

        // Уведомляем клиента
        await bot.telegram.sendMessage(
          chatId,
          '✅ Оплата подтверждена — спасибо!\n\n' +
          'Сейчас задам несколько уточняющих вопросов чтобы подготовить пакет максимально точно под ваш бизнес.\n\n' +
          'Займёт 2 минуты 👇'
        );

        // Обновляем сессию и пишем триггер для Bot #1
        const clientSession = loadSession(Number(chatId));
        clientSession.email = clientSession.email || email;
        clientSession.paidPackageKey = pkgKey;
        saveSession(Number(chatId), clientSession);

        writePaidInitTrigger(chatId, { name, email, packageKey: pkgKey }, pkgKey);

        console.log(`[stripe] paid: chatId=${chatId} pkg=${pkgKey} email=${email}`);
      } catch (e) {
        console.error('[stripe] webhook handler error:', e.message);
      }
    }
  }

  res.json({ received: true });
});

app.get('/health', (_, res) => res.send('ok'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Webhook server on port ${PORT}`));

// ─── АНАЛИТИКА: кнопка "начал постить" + приём скриншотов ────────────────────

bot.action('posting_started', async (ctx) => {
  await ctx.answerCbQuery();
  await ctx.editMessageReplyMarkup({ inline_keyboard: [] }).catch(() => {});
  const chatId = ctx.chat.id;
  const session = loadSession(chatId);
  if (!session) return;

  session.postingStartedAt = Date.now();
  saveSession(chatId, session);
  crmLog(chatId, 'posting_started', { date: new Date().toISOString() });

  await ctx.reply(
    '✅ Отлично! Запомнили — отсчёт пошёл.\n\n' +
    'Через 15 дней мы проанализируем реакцию вашей аудитории и скорректируем следующий контент.'
  );
});

// Приём скриншотов статистики от клиента (Вариант В — без Metricool)
bot.on(filterMessage('photo'), async (ctx) => {
  const chatId = ctx.chat.id;
  const session = loadSession(chatId);
  if (!session?.analyticsIntake) return;

  // Сохраняем file_id скриншота в сессию
  const fileId = ctx.message.photo[ctx.message.photo.length - 1].file_id;
  session.analyticsScreenshots = session.analyticsScreenshots || [];
  session.analyticsScreenshots.push(fileId);
  saveSession(chatId, session);

  await ctx.reply(
    `📎 Скриншот ${session.analyticsScreenshots.length} получен.\n\n` +
    'Пришлите ещё если нужно, или напишите *"готово"* когда отправили всё.',
    { parse_mode: 'Markdown' }
  );
});

// ─── ЗАПУСК ───────────────────────────────────────────────────────────────────

bot.telegram.deleteWebhook({ drop_pending_updates: true })
  .then(() => bot.launch({ dropPendingUpdates: true }))
  .then(() => console.log('✅ Bot #2 (client) запущен'))
  .catch(e => { console.error('Launch error:', e); process.exit(1); });

process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err.message);
});

process.on('unhandledRejection', (err) => {
  console.error('Unhandled rejection:', err?.message || err);
});
