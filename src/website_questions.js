// Вопросы для Stage 2 сбора данных о сайте
// Вызываются после оплаты командой /site_details {chatId} vizitka|expert

const TOTAL_VIZITKA = 10;
const TOTAL_EXPERT  = 12;

const VIZITKA_QUESTIONS = [
  {
    key: 'fullName',
    text: `Шаг 1 из ${TOTAL_VIZITKA} — Ваши имя и фамилия?\n\nПример: Анна Берзиня`,
  },
  {
    key: 'profession',
    text: `Шаг 2 из ${TOTAL_VIZITKA} — Ваша профессия или специализация (3-5 слов).\n\nПример: Визажист и стилист`,
  },
  {
    key: 'tagline',
    text: `Шаг 3 из ${TOTAL_VIZITKA} — Напишите 1-2 фразы: чем вы помогаете клиентам?\n\nПример: Создаю образы для женщин которые хотят выглядеть уверенно на свадьбе, фотосессии или важной встрече.`,
  },
  {
    key: 'about',
    text: `Шаг 4 из ${TOTAL_VIZITKA} — О себе: кто вы, ваш опыт, почему клиенты выбирают вас.\n\n2-3 предложения.`,
  },
  {
    key: 'stats',
    text: `Шаг 5 из ${TOTAL_VIZITKA} — Ваша статистика.\n\nНапишите: X лет, Y клиентов\n\nПример: 5 лет, 300 клиентов`,
  },
  {
    key: 'telegram',
    text: `Шаг 6 из ${TOTAL_VIZITKA} — Ваш Telegram для связи с клиентами.\n\nПример: @username`,
  },
  {
    key: 'whatsapp',
    text: `Шаг 7 из ${TOTAL_VIZITKA} — Ваш WhatsApp (номер с кодом страны).\n\nПример: 37120000000\n\nЕсли нет — напишите: нет`,
  },
  {
    key: 'instagram',
    text: `Шаг 8 из ${TOTAL_VIZITKA} — Ваш Instagram.\n\nПример: @username\n\nЕсли нет — напишите: нет`,
  },
  {
    key: 'services',
    text:
      `Шаг 9 из ${TOTAL_VIZITKA} — Напишите 3 ваши услуги, каждую с новой строки:\n` +
      `Название — €цена\n\n` +
      `Пример:\n` +
      `Свадебный макияж — €120\n` +
      `Вечерний образ — €60\n` +
      `Макияж для фотосессии — €80`,
  },
  {
    key: 'reviews',
    text:
      `Шаг 10 из ${TOTAL_VIZITKA} — Напишите 3 отзыва клиентов, каждый с новой строки:\n` +
      `Имя | текст отзыва | кто клиент\n\n` +
      `Пример:\n` +
      `Анна С. | Лена создала образ мечты на мою свадьбу! | Невеста, Рига\n` +
      `Кристина Б. | Профессиональный результат для LinkedIn | Маркетолог, Рига\n` +
      `Лаура О. | Первый профмакияж — влюбилась! | Предприниматель, Юрмала`,
  },
];

const EXPERT_QUESTIONS = [
  {
    key: 'fullName',
    text: `Шаг 1 из ${TOTAL_EXPERT} — Ваши имя и фамилия?\n\nПример: Анна Берзиня`,
  },
  {
    key: 'profession',
    text: `Шаг 2 из ${TOTAL_EXPERT} — Ваша профессия или специализация (3-5 слов).\n\nПример: Визажист и стилист`,
  },
  {
    key: 'tagline',
    text: `Шаг 3 из ${TOTAL_EXPERT} — Напишите 1-2 фразы: чем вы помогаете клиентам?\n\nПример: Создаю образы для женщин которые хотят выглядеть уверенно на свадьбе, фотосессии или важной встрече.`,
  },
  {
    key: 'about',
    text: `Шаг 4 из ${TOTAL_EXPERT} — О себе: кто вы, ваш опыт, почему клиенты выбирают вас.\n\n2-3 предложения.`,
  },
  {
    key: 'stats',
    text: `Шаг 5 из ${TOTAL_EXPERT} — Ваша статистика.\n\nНапишите: X лет, Y клиентов\n\nПример: 5 лет, 300 клиентов`,
  },
  {
    key: 'telegram',
    text: `Шаг 6 из ${TOTAL_EXPERT} — Ваш Telegram для связи с клиентами.\n\nПример: @username`,
  },
  {
    key: 'whatsapp',
    text: `Шаг 7 из ${TOTAL_EXPERT} — Ваш WhatsApp (номер с кодом страны).\n\nПример: 37120000000\n\nЕсли нет — напишите: нет`,
  },
  {
    key: 'instagram',
    text: `Шаг 8 из ${TOTAL_EXPERT} — Ваш Instagram.\n\nПример: @username\n\nЕсли нет — напишите: нет`,
  },
  {
    key: 'services_1_3',
    text:
      `Шаг 9 из ${TOTAL_EXPERT} — Первые 3 услуги, каждую с новой строки:\n` +
      `Название | описание (1 фраза) | €цена\n\n` +
      `Пример:\n` +
      `Свадебный макияж | Образ для самого важного дня, фиксация на весь день | €120\n` +
      `Вечерний образ | Для ресторана и выхода в свет, держится 8+ часов | €60\n` +
      `Макияж для фотосессии | Красиво смотрится на камере в любом освещении | €80`,
  },
  {
    key: 'services_4_6',
    text:
      `Шаг 10 из ${TOTAL_EXPERT} — Ещё 3 услуги:\n` +
      `Название | описание (1 фраза) | €цена\n\n` +
      `Пример:\n` +
      `Деловой образ | Для встреч и конференций, натуральный и профессиональный | €55\n` +
      `Выпускной и торжества | Яркий образ для праздника, работаю с молодыми | €50\n` +
      `Обучение макияжу | Индивидуальный урок, техника под ваш тип лица | €80`,
  },
  {
    key: 'hero_desc',
    text:
      `Шаг 11 из ${TOTAL_EXPERT} — Напишите 2-3 предложения для главного экрана сайта.\n` +
      `Это первое что увидит посетитель — почему к вам стоит обратиться?\n\n` +
      `Пример: Создаю образы для женщин которые хотят выглядеть уверенно и красиво — на свадьбе, фотосессии или важной встрече. Не просто макияж — полное преображение.`,
  },
  {
    key: 'reviews',
    text:
      `Шаг 12 из ${TOTAL_EXPERT} — Напишите 3 отзыва клиентов, каждый с новой строки:\n` +
      `Имя | текст отзыва | кто клиент\n\n` +
      `Пример:\n` +
      `Анна С. | Лена создала образ мечты на мою свадьбу! | Невеста, Рига\n` +
      `Кристина Б. | Профессиональный результат для LinkedIn | Маркетолог, Рига\n` +
      `Лаура О. | Первый профмакияж — влюбилась! | Предприниматель, Юрмала`,
  },
];

// Иконки услуг по ключевым словам в названии
function pickServiceIcon(name) {
  const n = (name || '').toLowerCase();
  if (n.includes('свад'))    return '💍';
  if (n.includes('фотосес')) return '📸';
  if (n.includes('выпускн')) return '🎓';
  if (n.includes('вечерн'))  return '✨';
  if (n.includes('делов'))   return '💼';
  if (n.includes('обучен') || n.includes('урок')) return '🏫';
  if (n.includes('дет'))     return '👶';
  if (n.includes('мужск'))   return '👔';
  return '⭐';
}

// Парсинг строки услуги визитки "Название — €цена"
function parseVizitkaService(line) {
  const parts = line.split(/\s*—\s*/);
  return {
    name:  (parts[0] || '').trim(),
    price: (parts[1] || '').trim(),
    desc:  '',
  };
}

// Парсинг строки услуги эксперта "Название | описание | €цена"
function parseExpertService(line) {
  const parts = line.split(/\s*\|\s*/);
  return {
    name:  (parts[0] || '').trim(),
    desc:  (parts[1] || '').trim(),
    price: (parts[2] || '').trim(),
  };
}

// Парсинг отзыва "Имя | текст | роль"
function parseReview(line) {
  const parts = line.split(/\s*\|\s*/);
  return {
    name: (parts[0] || '').trim(),
    text: (parts[1] || '').trim(),
    role: (parts[2] || '').trim(),
  };
}

// Парсинг статистики "5 лет, 300 клиентов"
function parseStats(text) {
  const yearsMatch   = text.match(/(\d+)\s*лет/i);
  const clientsMatch = text.match(/(\d[\d\s+]*)\s*клиент/i);
  return {
    years:   yearsMatch   ? yearsMatch[1].trim()   : '5',
    clients: clientsMatch ? clientsMatch[1].replace(/\s/g, '').trim() : '100',
  };
}

// Нормализация Telegram handle → без @
function normTelegram(s) {
  return (s || '').replace(/^@/, '').trim();
}

// Нормализация Instagram → без @, или '' если 'нет'
function normInstagram(s) {
  const v = (s || '').trim().toLowerCase();
  if (v === 'нет' || v === 'no' || v === '-') return '';
  return v.replace(/^@/, '');
}

// Нормализация WhatsApp → только цифры, или '' если 'нет'
function normWhatsapp(s) {
  const v = (s || '').trim().toLowerCase();
  if (v === 'нет' || v === 'no' || v === '-') return '';
  return v.replace(/[^\d]/g, '');
}

// Дефолтное фото-заглушка (нейтральный профессиональный портрет)
const DEFAULT_PHOTO = 'https://images.unsplash.com/photo-1584347922562-5d9542ec02ba?w=600&q=80';
const DEFAULT_ABOUT_PHOTO = 'https://images.unsplash.com/photo-1551803091-e20673f15770?w=600&q=80';

// Преобразование ответов в data.json для визитки
function mapToVizitkaData(answers) {
  const nameParts   = (answers.fullName || '').trim().split(/\s+/);
  const firstName   = nameParts[0] || '';
  const lastName    = nameParts.slice(1).join(' ') || '';
  const stats       = parseStats(answers.stats || '');

  const serviceLines = (answers.services || '').split('\n').filter(Boolean);
  const svcs = [0, 1, 2].map(i => parseVizitkaService(serviceLines[i] || ''));

  const reviewLines = (answers.reviews || '').split('\n').filter(Boolean);
  const revs = [0, 1, 2].map(i => parseReview(reviewLines[i] || ''));

  const yearsLabel   = `${stats.years} ${Number(stats.years) === 1 ? 'год' : 'лет'}`;
  const clientsLabel = `${stats.clients}+`;

  return {
    lang: 'ru',
    color: 'teal',

    name:             answers.fullName || '',
    name_first:       firstName,
    name_last:        lastName,
    profession:       answers.profession || '',
    tagline:          answers.tagline || '',
    meta_description: `${answers.fullName || ''} — ${answers.profession || ''}. ${answers.tagline || ''}`.slice(0, 160),

    badge_text:       'Принимаю клиентов',
    chip_icon:        '⭐',
    chip_text:        `${clientsLabel} клиентов\nза ${yearsLabel}`,

    cta_primary_text:   'Записаться →',
    cta_primary_link:   `https://t.me/${normTelegram(answers.telegram)}`,
    cta_secondary_text: 'Посмотреть услуги',

    stat1_num:   yearsLabel,
    stat1_label: 'опыта',
    stat2_num:   clientsLabel,
    stat2_label: 'клиентов',
    stat3_num:   '98%',
    stat3_label: 'рекомендуют',

    photo_url: DEFAULT_PHOTO,

    services_tag:   'Что я делаю',
    services_title: 'Мои услуги',
    services_sub:   'Выберите подходящий формат — или спросите про индивидуальный.',

    s1_icon:  pickServiceIcon(svcs[0].name), s1_name: svcs[0].name, s1_desc: svcs[0].desc, s1_price: svcs[0].price,
    s1_p1: '', s1_p2: '', s1_p3: '', s1_placeholder: '📷',
    s2_icon:  pickServiceIcon(svcs[1].name), s2_name: svcs[1].name, s2_desc: svcs[1].desc, s2_price: svcs[1].price,
    s2_p1: '', s2_p2: '', s2_p3: '', s2_placeholder: '📷',
    s3_icon:  pickServiceIcon(svcs[2].name), s3_name: svcs[2].name, s3_desc: svcs[2].desc, s3_price: svcs[2].price,
    s3_p1: '', s3_p2: '', s3_p3: '', s3_placeholder: '📷',

    reviews_title: 'Что говорят клиенты',

    r1_text: revs[0].text, r1_avatar: '👤', r1_name: revs[0].name, r1_role: revs[0].role,
    r2_text: revs[1].text, r2_avatar: '👤', r2_name: revs[1].name, r2_role: revs[1].role,
    r3_text: revs[2].text, r3_avatar: '👤', r3_name: revs[2].name, r3_role: revs[2].role,

    contact_tag:   'Записаться',
    contact_title: `Давайте создадим ваш образ`,
    contact_sub:   'Оставьте заявку — отвечу в течение 2 часов и подберём удобное время.',

    form_name_placeholder:    'Ваше имя',
    form_phone_placeholder:   'Телефон или Telegram',
    form_message_placeholder: 'Расскажите про мероприятие — дата, формат, пожелания',
    form_btn_text:             'Отправить заявку →',
    form_note:                 'Нажимая кнопку, вы соглашаетесь на обработку персональных данных',

    formspree_id: 'ВСТАВЬТЕ_ID_ОТ_FORMSPREE',

    social_telegram:  normTelegram(answers.telegram),
    social_whatsapp:  normWhatsapp(answers.whatsapp),
    social_instagram: normInstagram(answers.instagram),
    social_linkedin:  '',

    footer_year: String(new Date().getFullYear()),
  };
}

// Преобразование ответов в data.json для эксперта
function mapToExpertData(answers) {
  const nameParts = (answers.fullName || '').trim().split(/\s+/);
  const firstName = nameParts[0] || '';
  const lastName  = nameParts.slice(1).join(' ') || '';
  const stats     = parseStats(answers.stats || '');

  const svcLines1 = (answers.services_1_3 || '').split('\n').filter(Boolean);
  const svcLines2 = (answers.services_4_6 || '').split('\n').filter(Boolean);
  const svcs = [
    ...svcLines1.map(l => parseExpertService(l)),
    ...svcLines2.map(l => parseExpertService(l)),
  ];
  while (svcs.length < 6) svcs.push({ name: '', desc: '', price: '' });

  const reviewLines = (answers.reviews || '').split('\n').filter(Boolean);
  const revs = [0, 1, 2].map(i => parseReview(reviewLines[i] || ''));

  const yearsNum    = stats.years;
  const clientsNum  = stats.clients;

  // Разбиваем about на title + text
  const aboutSentences = (answers.about || '').split(/(?<=[.!?])\s+/);
  const aboutTitle = aboutSentences[0] || answers.about || '';
  const aboutText1 = aboutSentences.slice(1, 3).join(' ');
  const aboutText2 = aboutSentences.slice(3).join(' ');

  return {
    lang: 'ru',
    color: 'pink',

    name:             answers.fullName || '',
    profession:       answers.profession || '',
    meta_description: `${answers.fullName || ''} — ${answers.profession || ''}. ${answers.tagline || ''}`.slice(0, 160),

    nav_logo:        firstName,
    nav_logo_accent: lastName,
    nav_link1: 'Обо мне', nav_link2: 'Услуги', nav_link3: 'Работы', nav_link4: 'Отзывы', nav_cta: 'Записаться',

    badge_text: 'Принимаю клиентов',

    hero_title_1: answers.profession || '',
    hero_title_2: answers.tagline ? answers.tagline.split(' ').slice(0, 4).join(' ') : '',
    hero_desc:    answers.hero_desc || answers.tagline || '',

    cta_primary:   'Записаться на консультацию →',
    cta_secondary: 'Посмотреть работы',

    trust1: '', trust2: '', trust3: '',

    photo_url:  DEFAULT_PHOTO,
    chip_icon:  '⭐',
    chip_text:  `${clientsNum}+ клиентов\nза ${yearsNum} лет`,

    stat1_num: yearsNum,   stat1_label: 'лет опыта',
    stat2_num: clientsNum + '+', stat2_label: 'довольных клиентов',
    stat3_num: '98%',      stat3_label: 'рекомендуют друзьям',
    stat4_num: '',         stat4_label: '',

    about_tag:    'Обо мне',
    about_title:  aboutTitle,
    about_text1:  aboutText1 || answers.about || '',
    about_text2:  aboutText2 || '',
    about_photo:  DEFAULT_ABOUT_PHOTO,

    v1_icon: '🎓', v1_title: 'Профессиональное образование', v1_desc: '',
    v2_icon: '✨', v2_title: 'Только профессиональные материалы', v2_desc: '',
    v3_icon: '📸', v3_title: 'Опыт работы с профессионалами', v3_desc: '',

    services_tag:   'Что я делаю',
    services_title: 'Мои услуги',
    services_sub:   'Выберите подходящий формат — или напишите мне, подберём вместе.',

    s1_icon: pickServiceIcon(svcs[0].name), s1_name: svcs[0].name, s1_desc: svcs[0].desc, s1_price: svcs[0].price,
    s1_p1: '', s1_p2: '', s1_p3: '', s1_placeholder: '📷',
    s2_icon: pickServiceIcon(svcs[1].name), s2_name: svcs[1].name, s2_desc: svcs[1].desc, s2_price: svcs[1].price,
    s2_p1: '', s2_p2: '', s2_p3: '', s2_placeholder: '📷',
    s3_icon: pickServiceIcon(svcs[2].name), s3_name: svcs[2].name, s3_desc: svcs[2].desc, s3_price: svcs[2].price,
    s3_p1: '', s3_p2: '', s3_p3: '', s3_placeholder: '📷',
    s4_icon: pickServiceIcon(svcs[3].name), s4_name: svcs[3].name, s4_desc: svcs[3].desc, s4_price: svcs[3].price,
    s4_p1: '', s4_p2: '', s4_p3: '', s4_placeholder: '📷',
    s5_icon: pickServiceIcon(svcs[4].name), s5_name: svcs[4].name, s5_desc: svcs[4].desc, s5_price: svcs[4].price,
    s5_p1: '', s5_p2: '', s5_p3: '', s5_placeholder: '📷',
    s6_icon: pickServiceIcon(svcs[5].name), s6_name: svcs[5].name, s6_desc: svcs[5].desc, s6_price: svcs[5].price,
    s6_p1: '', s6_p2: '', s6_p3: '', s6_placeholder: '📷',

    p1_icon: '', p1_name: '', p1_desc: '', p1_i1: '', p1_i2: '', p1_i3: '', p1_i4: '', p1_price: '', p1_p1: '', p1_p2: '', p1_p3: '', p1_placeholder: '',
    p2_badge: '', p2_icon: '', p2_name: '', p2_desc: '', p2_i1: '', p2_i2: '', p2_i3: '', p2_i4: '', p2_i5: '', p2_price: '', p2_p1: '', p2_p2: '', p2_p3: '', p2_placeholder: '',
    p3_icon: '', p3_name: '', p3_desc: '', p3_i1: '', p3_i2: '', p3_i3: '', p3_i4: '', p3_price: '', p3_p1: '', p3_p2: '', p3_p3: '', p3_placeholder: '',

    process_tag:   'Как мы работаем',
    process_title: 'От записи до результата',
    process_sub:   'Всё продумано чтобы вы чувствовали себя комфортно на каждом этапе.',

    step1_title: 'Запись и консультация', step1_desc: 'Обсуждаем повод и пожелания. Бесплатно в мессенджере.',
    step2_title: 'Подготовка',           step2_desc: 'Для важных мероприятий делаем пробник заранее.',
    step3_title: 'День события',         step3_desc: 'Работаю у вас или в студии. Спокойно, без спешки.',
    step4_title: 'Результат',            step4_desc: 'Вы смотрите в зеркало и улыбаетесь.',

    cases_tag:   'Работы',
    cases_title: 'Истории клиентов',
    cases_sub:   'Каждый образ — отдельная история.',
    c1_emoji: '⭐', c1_tag: '', c1_title: '', c1_desc: '', c1_result: '',
    c2_emoji: '⭐', c2_tag: '', c2_title: '', c2_desc: '', c2_result: '',
    c3_emoji: '⭐', c3_tag: '', c3_title: '', c3_desc: '', c3_result: '',

    reviews_tag:   'Отзывы',
    reviews_title: 'Что говорят клиенты',

    r1_text: revs[0].text, r1_avatar: '👤', r1_name: revs[0].name, r1_role: revs[0].role,
    r2_text: revs[1].text, r2_avatar: '👤', r2_name: revs[1].name, r2_role: revs[1].role,
    r3_text: revs[2].text, r3_avatar: '👤', r3_name: revs[2].name, r3_role: revs[2].role,

    faq_tag: 'Вопросы и ответы', faq_title: 'Часто спрашивают',
    q1_q: '', q1_a: '', q2_q: '', q2_a: '', q3_q: '', q3_a: '', q4_q: '', q4_a: '', q5_q: '', q5_a: '',

    contact_tag:   'Записаться',
    contact_title: 'Давайте начнём',
    contact_sub:   'Оставьте заявку — отвечу в течение 2 часов.',

    form_name:    'Ваше имя',
    form_phone:   'Телефон или Telegram',
    form_email:   'Email (необязательно)',
    form_message: 'Расскажите про повод — дата, формат, пожелания',
    form_btn:     'Отправить заявку →',
    form_note:    'Нажимая кнопку, вы соглашаетесь на обработку персональных данных',

    formspree_id: 'ВСТАВЬТЕ_ID_ОТ_FORMSPREE',

    social_telegram:  normTelegram(answers.telegram),
    social_whatsapp:  normWhatsapp(answers.whatsapp),
    social_instagram: normInstagram(answers.instagram),
    social_linkedin:  '',

    footer_year: String(new Date().getFullYear()),
  };
}

module.exports = {
  VIZITKA_QUESTIONS,
  EXPERT_QUESTIONS,
  mapToVizitkaData,
  mapToExpertData,
};
