// Инструкция для Bot1: двухнедельный анализ аналитики и корректировка контента

const ANALYTICS_BENCHMARKS = {
  // Нормативы по нишам — вовлечённость (%) универсальна, абсолютные цифры по размеру аккаунта
  niches: {
    restaurant:    { engagementRate: 3.5, reachRate: 0.25, saveRate: 0.025 },
    coach:         { engagementRate: 4.0, reachRate: 0.30, saveRate: 0.060 },
    beauty:        { engagementRate: 4.5, reachRate: 0.30, saveRate: 0.040 },
    fitness:       { engagementRate: 4.0, reachRate: 0.28, saveRate: 0.050 },
    retail:        { engagementRate: 2.5, reachRate: 0.20, saveRate: 0.030 },
    services_b2b:  { engagementRate: 2.0, reachRate: 0.18, saveRate: 0.020 },
    education:     { engagementRate: 5.0, reachRate: 0.32, saveRate: 0.075 },
    default:       { engagementRate: 3.0, reachRate: 0.25, saveRate: 0.030 },
  },

  // Категории по размеру аккаунта — влияют на ожидаемые абсолютные числа
  // engagementRate и reachRate одинаковы у всех; абсолютные цифры масштабируются
  accountSize: {
    micro:  { label: 'до 5 000 подписчиков',    reelsViewsBase: 300,  savesBase: 15,  storyViewsBase: 60  },
    small:  { label: '5 000 – 20 000',           reelsViewsBase: 1200, savesBase: 50,  storyViewsBase: 250 },
    medium: { label: '20 000 – 100 000',         reelsViewsBase: 4000, savesBase: 150, storyViewsBase: 800 },
    large:  { label: 'свыше 100 000',            reelsViewsBase: 15000,savesBase: 500, storyViewsBase: 3000},
  },

  // Качественный контекст по типу рынка (не числовой)
  regionContext: {
    local_small:  'Локальный малый рынок. Reels могут набирать просмотры глобально — не ограничивай геотегами. Фокус на engagement rate и saves как главные метрики качества.',
    local_medium: 'Региональный рынок. Хороший баланс локальной аудитории и потенциального глобального охвата через Reels.',
    global:       'Глобальный или крупный рынок. Абсолютные цифры выше, конкуренция за внимание сильнее — качество хука критично.',
    online_first: 'Онлайн-бизнес без привязки к локации. Reels работают глобально — ориентируйся на нишевую аудиторию, не на регион.',
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

// Определяем размер аккаунта по количеству подписчиков
// Если followers не известен — возвращаем 'micro' (самый консервативный ориентир)
function detectAccountSize(followers) {
  const n = parseInt(followers) || 0;
  if (n >= 100000) return 'large';
  if (n >= 20000)  return 'medium';
  if (n >= 5000)   return 'small';
  return 'micro';
}

// Если количество подписчиков неизвестно — добавляем пояснение в промпт
function accountSizeNote(followers) {
  if (!parseInt(followers)) {
    return 'Количество подписчиков неизвестно — нормативы взяты для аккаунта до 5 000 подписчиков. ' +
           'Если реальных подписчиков больше — скорректируй оценку абсолютных цифр пропорционально вверх.';
  }
  return '';
}

// Определяем тип рынка по regionLabel — качественно, без числовых коэффициентов
function detectMarketContext(regionLabel, businessProfile) {
  const region  = (regionLabel || '').toLowerCase();
  const profile = (businessProfile || '').toLowerCase();
  const isOnline = /онлайн|online|курс|coaching|digital|удалённ|remote/.test(profile);
  if (isOnline) return 'online_first';
  if (/usa|uk|germany|france|россия|deutschland/.test(region)) return 'global';
  if (/latvia|литва|эстони|latv|швеци|норвег|дания|финлянд|austria|бельг/.test(region)) return 'local_small';
  return 'local_medium';
}

// Формируем нормативы с учётом ниши и размера аккаунта
function getAdjustedBenchmarks(nicheKey, accountSizeKey) {
  const niche = ANALYTICS_BENCHMARKS.niches[nicheKey] || ANALYTICS_BENCHMARKS.niches.default;
  const size  = ANALYTICS_BENCHMARKS.accountSize[accountSizeKey] || ANALYTICS_BENCHMARKS.accountSize.micro;
  return {
    engagementRate: niche.engagementRate,
    reachRate:      niche.reachRate,
    saveRate:       niche.saveRate,
    reelsViews:     size.reelsViewsBase,
    postSaves:      size.savesBase,
    storyViews:     size.storyViewsBase,
    accountSizeLabel: size.label,
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
  const niche         = session.businessProfile?.slice(0, 200) || '';
  const goal          = session.contentGoal || 'привлечение новых клиентов';
  const lang          = session.contentLanguage || 'ru';
  const nicheKey      = detectNiche(session.businessProfile);
  const sizeKey       = detectAccountSize(session.followersCount);
  const marketCtx     = detectMarketContext(session.regionLabel, session.businessProfile);
  const benchmarks    = getAdjustedBenchmarks(nicheKey, sizeKey);
  const regionNote    = ANALYTICS_BENCHMARKS.regionContext[marketCtx] || '';
  const sizeNote      = accountSizeNote(session.followersCount);

  return `
Ты — аналитик контента. Проведи 15-дневный анализ эффективности контента для бизнеса.

ЦЕЛЬ КОНТЕНТА: ${goal}
БИЗНЕС: ${niche}
ЯЗЫК: ${lang}
НИША: ${nicheKey}
РЕГИОН: ${session.regionLabel || 'не указан'}
РАЗМЕР АККАУНТА: ${benchmarks.accountSizeLabel}${sizeNote ? `\n⚠️ ${sizeNote}` : ''}

КОНТЕКСТ РЫНКА: ${regionNote}

НОРМАТИВЫ (для аккаунта этого размера и ниши):
- Вовлечённость (engagement rate): норма от ${benchmarks.engagementRate}% — универсальный показатель, не зависит от региона
- Охват (reach rate): норма от ${Math.round(benchmarks.reachRate * 100)}% от числа подписчиков
- Просмотры Reels: ориентир от ${benchmarks.reelsViews} (Reels распределяются глобально — абсолютные цифры могут быть выше)
- Сохранения поста: ориентир от ${benchmarks.postSaves}
- Просмотры Stories: ориентир от ${benchmarks.storyViews}

ПРИОРИТЕТ МЕТРИК: engagement rate и saves rate — главные показатели качества контента. Абсолютные числа просмотров — вторичный контекст.

Используй нормативы чтобы понять: показатели выше нормы → что повторить, ниже нормы → что изменить.

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
  const sizeKey    = detectAccountSize(session.followersCount);
  const marketCtx  = detectMarketContext(session.regionLabel, session.businessProfile);
  const benchmarks = getAdjustedBenchmarks(nicheKey, sizeKey);
  const regionNote = ANALYTICS_BENCHMARKS.regionContext[marketCtx] || '';
  const sizeNote   = accountSizeNote(session.followersCount);

  return `
Ты — контент-стратег. Создай скорректированный контент для следующих 15 дней на основе${hasData ? ' данных аналитики' : ' профиля бизнеса и лучших практик для ниши'}.

ЦЕЛЬ КОНТЕНТА: ${goal}
БИЗНЕС: ${niche}
ЯЗЫК КОНТЕНТА: ${lang}
НИША: ${nicheKey}
РЕГИОН: ${session.regionLabel || 'не указан'}
РАЗМЕР АККАУНТА: ${benchmarks.accountSizeLabel}${sizeNote ? `\n⚠️ ${sizeNote}` : ''}

КОНТЕКСТ РЫНКА: ${regionNote}

НОРМАТИВЫ (ориентир для оценки):
- Вовлечённость: от ${benchmarks.engagementRate}% — универсальный показатель качества
- Просмотры Reels: ориентир от ${benchmarks.reelsViews}
- Сохранения поста: ориентир от ${benchmarks.postSaves}
- Просмотры Stories: ориентир от ${benchmarks.storyViews}

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
