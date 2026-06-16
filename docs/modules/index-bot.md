# index.js — карта функций (Bot1, admin-бот)

**Размер**: ~3200 строк  
**Роль**: внутренний admin-бот, генерация всего контента, оркестрация  
**НЕ общается с клиентом напрямую**

## Ключевые функции

| Функция | Строка | Что делает |
|---------|--------|-----------|
| `regionFromLang(lang)` | 83 | Маппинг языка → регион (fallback) |
| `regionFromCity(cityText, fallbackLang)` | 94 | Определяет регион из ответа клиента о городе/рынке (приоритет над языком) |
| `processTextMessage(ctx, chatId, session, text)` | 843 | Обработка текстовых сообщений в admin-боте |
| `sendFinalSummary(ctx, session)` | 1034 | Отправка итогового саммари после генерации (HTML-страница → Bot1) |
| `deliverVisualPackage(clientChatId)` | 1126 | Доставка платного пакета клиенту после одобрения Bot3 |
| `deliverFreePackage(clientChatId)` | 1461 | Доставка бесплатного пакета после одобрения Bot3 |
| `savePaidRetryCheckpoint(session)` | 1551 | Сохранение snapshot для retry |
| `retryPaidGeneration(clientChatId, ctx)` | 1576 | Восстановление из snapshot (используется /retry_paid) |
| `retryFreeGeneration(clientChatId, ctx)` | 1649 | Повтор бесплатной генерации |
| `sendToClient(clientChatId, text)` | 1666 | Отправка сообщения в Bot2 клиенту |

## run_client_ — запуск генерации (fix 13.06.2026)

`bot.action(/^run_client_(.+)$/)` — кнопка "▶️ Запустить" из уведомления Bot1.

После нажатия:
1. Вызывает `startReturningClientFlow(ctx, session, bot2Data)`
2. Если `paidAnswers.length > 0` — `startReturningClientFlow` ставит `STEPS.DONE` и возвращается (fix #6)
3. **run_client_ проверяет `session.step === STEPS.DONE`** → запускает полную цепочку:  
   `buildReturningProfiles` → `runBlock4` → `runBlock5` → `runBlock3` → `runBlock6` (block6 внутри вызывает 7→8→9)
4. Если `paidAnswers` нет — `startReturningClientFlow` показывает диалог выбора (обычный флоу)
| `loadClientSession(clientChatId)` | 1674 | Загрузка сессии клиента |
| `deliverClientPackage(clientChatId, session)` | 1681 | Внутренняя доставка пакета |
| `bot3Notify(text, replyMarkup)` | 1726 | Уведомление менеджера в Bot3 |
| `sendFreeReviewToBot3(clientChatId, data, ...)` | 1738 | Отправка бесплатного пакета на проверку в Bot3 |
| `generateFreshSeoArticles(session, targetLang, langName)` | 1796 | Генерация SEO-статей для доп. языка заново |
| `runTranslationJob(clientChatId, targetLang, session)` | 1861 | Перевод пакета на доп. язык |
| `updateClientSession(clientChatId, updates)` | 1997 | Обновление данных сессии клиента |
| `startPaidOnboarding(clientChatId, packageKey)` | 2062 | Запуск вопросов после оплаты. Читает `interfaceLang` клиента → выбирает `PAID_ONBOARDING_QUESTIONS` (RU) или `PAID_ONBOARDING_QUESTIONS_LV` (LV). Приветствие тоже на языке клиента. |
| `notifyBot3Error(clientChatId, name, step, errorMsg)` | ~2390 | Алерт в Bot3 при падении генерации с указанием шага и команды восстановления |
| `checkTriggers()` | 2335 | Основной цикл: сканирует trigger-файлы, запускает генерацию |
| `processFreeTriggerAsync(data)` | ~2335 | Изолированная параллельная генерация бесплатного пакета (сессия `gen_free_{chatId}`) |
| `saveQueueStatus()` | ~65 | Записывает `queue_status.json` — текущие активные генерации для /queue в Bot3 |
| `checkDiscountTimers()` | 2520 | Проверяет истечение 48-часовой скидки |
| `checkAnalyticsCycle()` | ~3000 | Полный жизненный цикл клиента: Metricool-напоминания, Wave2-генерация, продление |
| `checkMetricoolConnections()` | ~3200 | Проверка подключений Metricool |

## Блоки генерации (src/steps/)

| Файл | Строк | Что делает |
|------|-------|-----------|
| `block0_onboarding.js` | 120 | Онбординг нового клиента |
| `block0_returning.js` | 355 | Flow для вернувшегося клиента |
| `block1_unpacking.js` | 116 | Распаковка бизнеса + профиль аудитории |
| `block2_audience.js` | 91 | Расширенный портрет аудитории |
| `block3_competitors.js` | 194 | Анализ 5 конкурентов (Tavily API) |
| `block4_castdev.js` | 73 | Кастдев — Tavily поиск реальных фраз ниши + виртуальные интервью Claude. Сохраняет `session.realNichePhrases` для Block7 |
| `block5_semantics.js` | 76 | Семантическое ядро (обогащается после блока 3) |
| `block6_articles.js` | 84 | 3 SEO+GEO статьи |
| `block7_scripts.js` | 433 | Сценарии: карусели, фото, Stories, видео |
| `block8_covers.js` | 70 | ТЗ на обложки (Стандарт/Профи) |
| `block9_calendar.js` | 200 | Контент-план 15 дней (Wave1 или Wave2 через isWave2 флаг) |
| `block_free_package.js` | 267 | Бесплатный пакет (7 дней) |

## Порядок блоков генерации

**Платный пакет:**
```
buildReturningProfiles (все 12 ответов → бизнес + аудитория)
→ block4 кастдев (виртуальные интервью, живые фразы)
→ block5 семантика (ключевые слова, заголовки из кастдева)
→ block3 конкуренты (Tavily — реальные сайты из Q3)
→ block6 статьи (заголовки из семантики + кастдев фразы)
→ block7 сценарии (кастдев + семантика + бизнес-контекст)
→ block8 обложки (Стандарт/Профи)
→ block9 контент-план 15 дней
```

Конкуренты (block3): берутся **автоматически из Q3** клиента (Tavily скрейпит реальные сайты). Если Q3 пустой/«не знаю» — `autoSearchCompetitors=true` → Claude описывает типичных игроков ниши без Tavily.

**Объёмы Wave1 (14.06.2026):**

| Тип | Старт | Стандарт | Профи |
|-----|-------|----------|-------|
| Карусели | 4 | 4 | 4 |
| Фото | 4 | 4 | 4 |
| Stories | 7 | 7 | 7 |
| Видео | — | 2 | 4 |
| Обложки | — | 2 | 4 |

Block9: генерирует **только Wave1** (дни 1–15). Wave2 генерируется заново через `wave2_gen.trigger` после аналитики. Блоки 3-9 отправляют в Bot1 только краткий статус.

`sendFinalSummary`: показывает сводку только Wave1 + "Wave2 генерируется после аналитики на день 15".

**Admin HTML-отчёт (14.06.2026):** `sendSummaryDocument` теперь строит HTML-страницу из `assets/admin-summary-template.html` (через `src/summary.js → buildAndDeployAdminSummary`) и отправляет ссылку `{VISUAL_BASE_URL}/pack/admin_{chatId}` в Bot1. Fallback: .txt файл если VISUAL_BASE_URL не задан.

**Бесплатный пакет (с 12.06.2026):**
```
buildReturningProfiles
→ Claude-анализ конкурентов ниши (без Tavily, ~30 сек) → enrichedData.competitorBrief
→ block_free_package (использует businessProfile + audience + competitorBrief)
```
Block3/Tavily не используется. Claude анализирует типичных конкурентов ниши из своих знаний — это обогащает контент-план, статью и карусель без лишних затрат.

## Параллельная обработка клиентов (июнь 2026)

**Проблема решена:** бесплатные пакеты обрабатываются параллельно, не в очередь.

| Константа | Значение | Смысл |
|-----------|---------|-------|
| `GEN_LIMITS.free` | 15 | Максимум одновременных бесплатных генераций |
| `GEN_LIMITS.paid` | 5 | Максимум одновременных платных генераций |
| `activeGenerations.free` | Set(chatId) | Текущие активные бесплатные |
| `activeGenerations.paid` | Set(chatId) | Текущие активные платные |

**Изоляция сессий:** каждый клиент получает сессию с ключом `gen_free_{chatId}` — физически отдельный файл. Данные клиента А не могут попасть к клиенту Б. Двойная защита: ассерт `session.targetClientId === clientChatId` в начале генерации.

**Если лимит достигнут:** триггер-файл остаётся в папке, подбирается на следующем цикле checkTriggers (каждые 10 сек).

**Статус очереди:** пишется в `queue_status.json` → Bot3 `/queue` показывает живую картину.

**Сообщение клиенту:** "Анализируем ваш бизнес и готовим персональный пакет. Ориентировочное время: 15–20 минут. Пришлём сразу как будет готово."

## CRM — Google Sheets (июнь 2026)

При каждой доставке (бесплатный, Wave 1, Wave 2) автоматически обновляются два листа:

| Лист | Что хранит | Как обновляется |
|------|-----------|----------------|
| **История** | Одна строка на каждое событие доставки: кто, что получил, ссылка на пакет, следующее действие | Только append — строки не удаляются |
| **Дашборд** | Одна строка на клиента — текущий статус, даты Wave 1/Wave 2, ссылки, следующее действие | Upsert — обновляется при каждом изменении |

Функции в `src/sheets.js`: `appendClientHistory(...)`, `upsertDashboard(...)`.

**Команда `/clients` в Bot1** — быстрая сводка без открытия браузера: кто генерируется, кто на каком Wave, когда следующее действие.

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

## deliverVisualPackage — Wave1 / Wave2 (обновлено 14.06.2026)

- `wave1Done = !!clientSess.wave1DeliveredAt` — определяет первая или вторая волна.
- **`half()` удалён** — каждая волна генерируется отдельно, доставляется полностью.
- При Wave1: клиент получает краткую инструкцию по публикации (карусель/фото/stories/видео) + совет отвечать на комментарии в первые 60 минут.
- Кнопка "Я опубликовал первый пост" (`posting_started`) показывается **только при wave1**.

---

## checkAnalyticsCycle — полный жизненный цикл (14.06.2026)

Запускается раз в час. Проверяет каждого клиента у кого есть `wave1DeliveredAt`:

| День от Wave1 | Действие |
|--------------|---------|
| 3 | Напоминание подключить Metricool (польза + кнопки) |
| 7 | Напоминание: «неделя прошла, данных нет» |
| 12 | Финальное: «3 дня до Wave2, последний шанс» |
| 15+ | Аналитика Metricool (если подключён) + `buildNicheResearchPrompt` → `wave2_gen.trigger` |
| 25 | Предложение продления с кнопками всех пакетов |
| 27 | Напоминание: 3 дня до конца + кнопки |
| 30+ | Полное предложение продления |
| При renewalScheduledStart | Запуск отложенного продления (если оплачено на д.25/27) |

**Правило Metricool:** если не подключён — не задаём вопросов клиенту. Только убеждаем подключить.

**Wave2 auto-generation (`wave2_gen.trigger`):**
1. `checkAnalyticsCycle` записывает триггер с `analyticsInsights`
2. `checkTriggers` подхватывает → загружает `done_snapshot.json`
3. Запускает `block7` (с аналитикой в промптах) → `block8` → `block9` (дни 16–30)
4. Генерирует визуалы → Bot3 на проверку → менеджер одобряет → клиент получает Wave2

**Поля сессии клиента для цикла:**
```
wave1DeliveredAt    — дата доставки Wave1
wave2DeliveredAt    — дата доставки Wave2
metricoolConnected  — подключён ли Metricool
metricoolNudge_3/7/12 — флаги напоминаний
analyticsInsights   — результат анализа (Claude + ниша)
analyticsHistory[]  — история всех аналитических циклов
renewalPaidAt       — дата оплаты продления
renewalScheduled    — { name, email, packageKey } для отложенного старта
renewalScheduledStart — timestamp когда запускать (wave1 + 30 дней)
renewalLaunched     — флаг что отложенное продление запущено
monthNumber         — номер текущего месяца (1, 2, 3...)
```

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
