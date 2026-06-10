# index.js — карта функций (Bot1, admin-бот)

**Размер**: ~2832 строк  
**Роль**: внутренний admin-бот, генерация всего контента, оркестрация  
**НЕ общается с клиентом напрямую**

## Ключевые функции

| Функция | Строка | Что делает |
|---------|--------|-----------|
| `regionFromLang(lang)` | 60 | Маппинг языка → регион для промптов |
| `processTextMessage(ctx, chatId, session, text)` | 843 | Обработка текстовых сообщений в admin-боте |
| `sendFinalSummary(ctx, session)` | 1034 | Отправка итогового саммари после генерации |
| `deliverVisualPackage(clientChatId)` | 1126 | Доставка платного пакета клиенту после одобрения Bot3 |
| `deliverFreePackage(clientChatId)` | 1461 | Доставка бесплатного пакета после одобрения Bot3 |
| `savePaidRetryCheckpoint(session)` | 1551 | Сохранение snapshot для retry |
| `retryPaidGeneration(clientChatId, ctx)` | 1576 | Восстановление из snapshot (используется /retry_paid) |
| `retryFreeGeneration(clientChatId, ctx)` | 1649 | Повтор бесплатной генерации |
| `sendToClient(clientChatId, text)` | 1666 | Отправка сообщения в Bot2 клиенту |
| `loadClientSession(clientChatId)` | 1674 | Загрузка сессии клиента |
| `deliverClientPackage(clientChatId, session)` | 1681 | Внутренняя доставка пакета |
| `bot3Notify(text, replyMarkup)` | 1726 | Уведомление менеджера в Bot3 |
| `sendFreeReviewToBot3(clientChatId, data, ...)` | 1738 | Отправка бесплатного пакета на проверку в Bot3 |
| `generateFreshSeoArticles(session, targetLang, langName)` | 1796 | Генерация SEO-статей для доп. языка заново |
| `runTranslationJob(clientChatId, targetLang, session)` | 1861 | Перевод пакета на доп. язык |
| `updateClientSession(clientChatId, updates)` | 1997 | Обновление данных сессии клиента |
| `startPaidOnboarding(clientChatId, packageKey)` | 2062 | Запуск дополнительных вопросов после оплаты |
| `checkTriggers()` | 2091 | Основной цикл: сканирует trigger-файлы, запускает генерацию |
| `checkDiscountTimers()` | 2520 | Проверяет истечение 48-часовой скидки |
| `checkAnalyticsCycle()` | 2632 | Цикл аналитики Metricool (в разработке) |
| `checkMetricoolConnections()` | 2769 | Проверка подключений Metricool (в разработке) |

## Блоки генерации (src/steps/)

| Файл | Строк | Что делает |
|------|-------|-----------|
| `block0_onboarding.js` | 120 | Онбординг нового клиента |
| `block0_returning.js` | 355 | Flow для вернувшегося клиента |
| `block1_unpacking.js` | 116 | Распаковка бизнеса + профиль аудитории |
| `block2_audience.js` | 91 | Расширенный портрет аудитории |
| `block3_competitors.js` | 194 | Анализ 5 конкурентов (Tavily API) |
| `block4_castdev.js` | 78 | Кастдев — живые фразы, страхи, возражения |
| `block5_semantics.js` | 76 | Семантическое ядро (обогащается после блока 3) |
| `block6_articles.js` | 84 | 3 SEO+GEO статьи |
| `block7_scripts.js` | 433 | Сценарии: карусели, фото, Stories, видео |
| `block8_covers.js` | 70 | ТЗ на обложки (Стандарт/Профи) |
| `block9_calendar.js` | 200 | Контент-план 30 дней |
| `block_free_package.js` | 267 | Бесплатный пакет (7 дней) |

## Порядок блоков генерации

```
1 → 2 → 4 → 5 → 3 (Tavily) → 5 обогащается → 6 → 7 → 8 → 9
```

## Команды admin-бота

```
/retry_paid {chatId}        — восстановить из snapshot (НЕ перегенерирует!)
/regen_scripts {chatId}     — перегенерировать скрипты (пропускает snapshot)
/debug_scripts {chatId}     — показать формат carouselScripts
/test_full_client {chatId}  — карусель + фото + видео с реальными данными
/test_carousel {chatId}     — 7 слайдов с жёсткими текстами RU/EN/LV
/test_video_overlay {chatId} — 1 видео с хук+тема+CTA
/test_carousel_variants {chatId} — 3 варианта формата карусели
```

## Доставка изображений — локальные файлы (июнь 2026)

**Правило:** и в `deliverFreePackage`, и в `deliverVisualPackage` — сначала проверяется локальный файл, URL Kie.ai только запасной вариант (истекает 24-72ч).

**Free пакет:** читает `carouselLocal[]`, `coverLocal[]`, `localPath` из JSON-файлов в `visual_results/`. Для каждого изображения ищет `_ov.jpg` (с оверлеем) → raw файл → URL.

**Paid пакет:** читает `results.photosLocalPaths`, `results.carouselSlidesLocalPaths`, `results.storiesLocalPaths`, `results.coversLocalPaths` из `{chatId}.results.json`. Видео всегда через `localPath` (было так изначально).

---

## deliverFreePackage — особенности (июнь 2026)

- После успешной доставки ставит флаг `session.freePackageDelivered = Date.now()` в сессию клиента.
- Этот флаг проверяется в bot2.js перед созданием нового trigger — повторная генерация заблокирована.

---

## deliverVisualPackage — 15+15 волны

- `wave1Done = !!session.wave1DeliveredAt` — определяет первая или вторая волна.
- `half(arr)` — первая волна: первая половина массива; вторая: вторая половина.
- Кнопка "Я опубликовал первый пост" (`posting_started`) показывается **только при wave1** (`!wave1Done`). При wave2 — не показывается.

---

## buildReturningProfiles — поля из платной анкеты (июнь 2026)

После получения всех 12 ответов, `buildReturningProfiles` в `block0_returning.js` явно извлекает:

```
session.brandVoice      ← 'brand_voice'
session.monthlyGoal     ← 'content_goal_monthly'
session.monthlyFocus    ← 'monthly_focus'
session.clientStories   ← 'client_stories'
session.priceRange      ← 'price_range'
session.decisionMaker   ← 'decision_maker'
```

Эти поля передаются явно в `block7_scripts.js` как `clientContext` блок во все промпты (видео, карусели, сценарии).

---

## Вспомогательные файлы

- `src/state.js` — STEPS, константы
- `src/persistence.js` — saveSession, loadSession
- `src/claude.js` — askSonnet, HAIKU
- `src/lang.js` — getLangInstruction(lang)
- `src/languages.js` — конфигурация языков
- `src/prompt_learning.js` — самообучение промптов из фидбека менеджера
