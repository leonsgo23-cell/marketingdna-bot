// Инструкция для Bot1: двухнедельный анализ аналитики и корректировка контента

const ANALYTICS_BENCHMARKS = {
  // Нормативные показатели по нишам (базовые — для рынка ~10M+ чел.)
  niches: {
    restaurant:    { reelsViews: 2000, postSaves: 50,  engagementRate: 3.5, storyViews: 300 },
    coach:         { reelsViews: 1500, postSaves: 120, engagementRate: 4.0, storyViews: 200 },
    beauty:        { reelsViews: 3000, postSaves: 80,  engagementRate: 4.5, storyViews: 400 },
    fitness:       { reelsViews: 2500, postSaves: 100, engagementRate: 4.0, storyViews: 350 },
    retail:        { reelsViews: 1500, postSaves: 60,  engagementRate: 2.5, storyViews: 250 },
    services_b2b:  { reelsViews: 800,  postSaves: 40,  engagementRate: 2.0, storyViews: 150 },
    education:     { reelsViews: 2000, postSaves: 150, engagementRate: 5.0, storyViews: 200 },
    default:       { reelsViews: 1500, postSaves: 60,  engagementRate: 3.0, storyViews: 200 },
  },

  // Региональные коэффициенты (масштаб рынка и активность аудитории)
  // Базовые нормативы рассчитаны на рынок ~10M+ активных пользователей
  // Для малых рынков нормативы снижаются — вовлечённость (%) остаётся, охват (абс.) уменьшается
  regionMultipliers: {
    us:            { reach: 1.0,  engagement: 1.0 },  // США — базовый
    uk:            { reach: 0.5,  engagement: 1.0 },  // Великобритания
    de:            { reach: 0.5,  engagement: 0.9 },  // Германия
    western_eu:    { reach: 0.4,  engagement: 0.95 }, // Западная Европа (FR, NL, BE и др.)
    scandinavia:   { reach: 0.25, engagement: 1.1 },  // Скандинавия — меньше, но вовлечённее
    baltics:       { reach: 0.15, engagement: 1.2 },  // Прибалтика (LV, LT, EE) — малый рынок, высокая вовлечённость
    ru_cis:        { reach: 0.6,  engagement: 0.9 },  // Россия/СНГ
    default:       { reach: 0.5,  engagement: 1.0 },
  },

  // Что важно отслеживать по типу контента
  contentMetrics: {
    post:      ['reach', 'likes', 'saves', 'profile_visits', 'shares'],
    reel:      ['views', 'watch_time_pct', 'shares', 'saves', 'comments'],
    carousel:  ['slides_viewed', 'saves', 'shares', 'reach'],
    story:     ['views', 'replies', 'link_taps', 'exits'],
  },

  // Сигналы — что означают показатели
  signals: {
    high_saves:        'Аудитория считает контент полезным — делает на будущее. Больше таких тем.',
    high_shares:       'Контент находит сильный отклик. Похожие темы — в приоритет.',
    low_watch_time:    'Reels не удерживают внимание. Хук слабый или видео слишком медленное.',
    high_profile_visits: 'Пост вызвал интерес к автору. Тема работает на привлечение.',
    low_reach:         'Алгоритм не продвигает. Возможно — время публикации или слабый первый кадр.',
    high_story_exits:  'Stories неинтересны или слишком длинные. Сократить и добавить интерактив.',
    high_story_replies: 'Stories вызывают желание ответить. Больше вовлекающих форматов.',
  },
};

// Определяем регион по regionLabel из сессии
function detectRegionKey(regionLabel) {
  const text = (regionLabel || '').toLowerCase();
  if (/usa|us\b|united states|америк|сша/.test(text))                   return 'us';
  if (/uk|united kingdom|britain|великобритан/.test(text))              return 'uk';
  if (/germany|deutschland|германи/.test(text))                         return 'de';
  if (/sweden|norway|denmark|finland|швеци|норвег|дани|финлянд/.test(text)) return 'scandinavia';
  if (/latvia|литва|эстони|latv|litu|esto|прибалт/.test(text))          return 'baltics';
  if (/france|netherlands|belgium|austria|франц|нидерланд|бельг|австри/.test(text)) return 'western_eu';
  if (/russia|росси|казахст|украин|беларус|cis|снг/.test(text))         return 'ru_cis';
  return 'default';
}

// Применяем региональный коэффициент к базовым нормативам
function getAdjustedBenchmarks(nicheKey, regionKey) {
  const base = { ...(ANALYTICS_BENCHMARKS.niches[nicheKey] || ANALYTICS_BENCHMARKS.niches.default) };
  const mult = ANALYTICS_BENCHMARKS.regionMultipliers[regionKey] || ANALYTICS_BENCHMARKS.regionMultipliers.default;
  return {
    reelsViews:      Math.round(base.reelsViews  * mult.reach),
    postSaves:       Math.round(base.postSaves   * mult.reach),
    storyViews:      Math.round(base.storyViews  * mult.reach),
    engagementRate:  +(base.engagementRate * mult.engagement).toFixed(1),
  };
}

// Определяем нишу по профилю бизнеса
function detectNiche(businessProfile) {
  const text = (businessProfile || '').toLowerCase();
  if (/ресторан|кафе|еда|доставка|меню|повар|кухня/.test(text))  return 'restaurant';
  if (/коуч|тренер|наставник|консультант|менторинг/.test(text))  return 'coach';
  if (/красота|салон|маникюр|косметик|уход|spa|спа/.test(text))  return 'beauty';
  if (/фитнес|спорт|зал|тренировк|здоровье/.test(text))          return 'fitness';
  if (/магазин|розничн|товар|интернет-магазин|e-commerce/.test(text)) return 'retail';
  if (/b2b|корпорат|бизнес-услуг|аутсорс|it-услуг/.test(text))   return 'services_b2b';
  if (/курс|обучени|образован|школа|академия/.test(text))         return 'education';
  return 'default';
}

// Промпт для 15-дневного анализа аналитики
function buildAnalyticsPrompt(session, analyticsData, publishedContent) {
  const niche       = session.businessProfile?.slice(0, 200) || '';
  const goal        = session.contentGoal || 'привлечение новых клиентов';
  const lang        = session.contentLanguage || 'ru';
  const nicheKey    = detectNiche(session.businessProfile);
  const regionKey   = detectRegionKey(session.regionLabel);
  const benchmarks  = getAdjustedBenchmarks(nicheKey, regionKey);

  return `
Ты — аналитик контента. Проведи 15-дневный анализ эффективности контента для бизнеса.

ЦЕЛЬ КОНТЕНТА: ${goal}
БИЗНЕС: ${niche}
ЯЗЫК: ${lang}
НИША: ${nicheKey}
РЕГИОН: ${session.regionLabel || 'не указан'}

НОРМАТИВЫ ДЛЯ НИШИ И РЕГИОНА (скорректированы под масштаб рынка):
- Просмотры Reels: норма от ${benchmarks.reelsViews}
- Сохранения поста: норма от ${benchmarks.postSaves}
- Вовлечённость: норма от ${benchmarks.engagementRate}%
- Просмотры Stories: норма от ${benchmarks.storyViews}

Используй эти нормативы чтобы понять: показатели выше нормы → что повторить, ниже нормы → что изменить.

ОПУБЛИКОВАННЫЙ КОНТЕНТ (последние 15 дней):
${publishedContent}

ДАННЫЕ АНАЛИТИКИ:
${analyticsData}

ЗАДАЧА:
1. Сравни реальные показатели с нормативами по нише — что выше, что ниже
2. Выяви топ 3 материала и объясни почему они сработали
3. Выяви что не дотянуло до норматива — и предположи почему
4. Определи 2-3 конкретные корректировки для следующих 15 дней:
   - Какие темы усилить
   - Какие форматы изменить
   - Что убрать или заменить
5. Рекомендации по времени и частоте публикаций если видишь паттерн

ВАЖНО:
- Не говори что работа была плохой — говори что можно улучшить
- Опирайся только на данные — не додумывай
- Пиши кратко и по делу — менеджер проверит перед отправкой клиенту

Формат ответа:
ЧТО СРАБОТАЛО (выше нормы):
[список с цифрами]

ЧТО МОЖНО УЛУЧШИТЬ (ниже нормы):
[список с объяснением]

КОРРЕКТИРОВКИ НА СЛЕДУЮЩИЕ 15 ДНЕЙ:
[конкретные изменения в темах/форматах]

РЕКОМЕНДАЦИИ ПО ПУБЛИКАЦИИ:
[время, частота, если есть паттерн]
`;
}

// Текст для клиента — подключение аналитики (отправляется после Q5 в Bot2)
const ANALYTICS_ONBOARDING_TEXT = `
📊 *Последний шаг — подключить аналитику*

У нас теперь есть всё необходимое чтобы создать контент для ваших соцсетей.

Осталось подключить сервис с помощью которого вы будете видеть эффективность ваших материалов — постов, Reels, каруселей и других публикаций в ваших соцсетях.

Это позволит вам видеть как реально реагирует ваша аудитория на контент. А нам — оперативно реагировать на актуальные показатели и учитывать что сейчас интересует вашу аудиторию при подготовке следующего контента.

*Как подключить (2 минуты):*
1. Переключите Instagram в бизнес-аккаунт: Настройки → Аккаунт → Профессиональный аккаунт. Бесплатно, контент не удаляется.
2. Менеджер пришлёт вам ссылку для подключения отдельным сообщением — просто перейдите по ней и разрешите доступ.

Если у вас несколько платформ — мы подключим их на основе информации которую вы уже указали.

*Если не можете или не хотите переходить на бизнес-аккаунт* — это немного снизит оперативность нашей реакции на поведение вашей аудитории, но вы можете это компенсировать. Раз в 15 дней присылайте нам скриншоты статистики из приложения: охват за период, лучшие посты, статистику Reels. Мы сделаем анализ и учтём это при подготовке следующего контента.

Это добровольный шаг. Если пропустить — мы продолжаем работу в том же качестве. Просто не сможем так оперативно реагировать на изменения в поведении вашей аудитории и то что сейчас интересует ваших клиентов.
`;

// Промпт для генерации скорректированного контента на следующие 15 дней
function buildContentCorrectionPrompt(session, analyticsReport) {
  const niche      = session.businessProfile?.slice(0, 400) || '';
  const goal       = session.contentGoal || 'привлечение новых клиентов';
  const lang       = session.contentLanguage || 'ru';
  const current    = session.lastContentSummary || '';
  const hasData    = !!analyticsReport;
  const nicheKey   = detectNiche(session.businessProfile);
  const regionKey  = detectRegionKey(session.regionLabel);
  const benchmarks = getAdjustedBenchmarks(nicheKey, regionKey);

  return `
Ты — контент-стратег. Создай скорректированный контент для следующих 15 дней на основе${hasData ? ' данных аналитики' : ' профиля бизнеса и лучших практик для ниши'}.

ЦЕЛЬ КОНТЕНТА: ${goal}
БИЗНЕС: ${niche}
ЯЗЫК КОНТЕНТА: ${lang}
НИША: ${nicheKey}
РЕГИОН: ${session.regionLabel || 'не указан'}

НОРМАТИВЫ ДЛЯ НИШИ И РЕГИОНА:
- Просмотры Reels: от ${benchmarks.reelsViews} — контент набирающий меньше нуждается в более сильном хуке
- Сохранения поста: от ${benchmarks.postSaves} — если ниже, тема недостаточно полезная/практичная
- Вовлечённость: от ${benchmarks.engagementRate}% — ориентир для оценки текстов и CTA
- Просмотры Stories: от ${benchmarks.storyViews}

${hasData ? `АНАЛИЗ АНАЛИТИКИ (что сработало, что нет, рекомендации):
${analyticsReport}` : `ДАННЫХ АНАЛИТИКИ НЕТ — опирайся на нормативы ниши и профиль бизнеса.`}

${current ? `ТЕКУЩИЙ КОНТЕНТ (что уже было в плане):
${current.slice(0, 1000)}` : ''}

ЗАДАЧА: создай конкретный скорректированный контент для следующих 15 дней.

ОБЯЗАТЕЛЬНО:
${hasData ? '- Темы которые хорошо сработали — усиливай и развивай\n- Форматы с низкими показателями — заменяй или переделывай хук\n- Опирайся ТОЛЬКО на данные аналитики, не додумывай' : '- Фокус на темах которые лучше всего работают для привлечения аудитории в этой нише'}
- Пиши готовые формулировки — не общие советы
- Язык: ${lang}

Формат ответа (строго):

🎬 СЦЕНАРИИ REELS (4 штуки):
[для каждого: Тема / Хук (первые 3 секунды) / Структура (3-4 шага) / Призыв к действию]

📊 ТЕМЫ КАРУСЕЛЕЙ (3 штуки):
[для каждой: Заголовок обложки / 4-5 слайдов / Почему эта тема сработает]

📸 КОНЦЕПЦИИ ФОТО-ПОСТОВ (3 штуки):
[для каждой: Что снять / Текст поста (2-3 предложения) / Главная эмоция]

📱 ТЕМЫ STORIES (6 штук):
[тема + формат: опрос / вопрос / слайдер / факт / закулисье]

⏰ РЕКОМЕНДАЦИИ ПО ПУБЛИКАЦИЯМ:
[дни недели и время — ${hasData ? 'на основе данных аналитики' : 'лучшие практики для ниши'}]
`;
}

module.exports = { buildAnalyticsPrompt, buildContentCorrectionPrompt, ANALYTICS_BENCHMARKS, ANALYTICS_ONBOARDING_TEXT };
