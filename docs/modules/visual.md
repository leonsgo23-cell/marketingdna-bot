# visual.js — карта функций (Visual Service)

**Размер**: ~3200 строк  
**Роль**: Express-сервер (порт 3002), генерация изображений и видео  
**APIs**: Kie.ai (изображения + видео Veo3), sharp (наложение текста), ffmpeg (видео)

## Система самообучения (prompt_learning)

Подключена через `src/prompt_learning.js`. Работает автоматически:

- **Запись**: при каждой перегенерации с фидбеком (`regen_item`, `regen_video`, `regen_sample_slot`, `regen_sample_fragment`) — сохраняется пара `(промпт → комментарий менеджера)`
- **Анализ**: каждые 30 правок Claude Haiku извлекает общие паттерны и формирует уроки
- **Применение**: `startImage` и `startVideo` автоматически добавляют накопленные уроки в каждый промпт

Файлы хранятся в `~/.marketingdna-client-sessions/prompt_learning/`:
- `feedback_log.json` — история правок
- `global_lessons.json` — выработанные уроки

## Функции по категориям

### Надёжность генерации (июнь 2026)

- **Retry в genBatch**: после основного батча проверяются упавшие слайды (url=null). Если есть — один ретрай через 5 сек. Страховка на случай временных сбоев Kie.ai API.

### Задачи и очередь изображений

| Функция | Строка | Что делает |
|---------|--------|-----------|
| `saveImageTask(taskId, meta)` | 47 | Сохранить задачу в очередь |
| `removeImageTask(taskId)` | 54 | Удалить задачу из очереди |
| `pollAndSave(taskId, meta)` | 60 | Ждать завершения задачи и сохранить результат |
| `rebuildFreeVisuals(clientId)` | 87 | Пересобрать визуалы; отправляет карусель, обложку и сторис в Bot3 независимо |
| `notifyCarouselReady(clientId, urls, local)` | — | Карусель готова → отправить в Bot3 с кнопками |
| `notifyCoverReady(clientId, urls, local)` | — | Обложка готова → отправить в Bot3 с кнопками |
| `notifyStoryReady(clientId, urls, local)` | — | Сторис готова → отправить в Bot3 с кнопками |
| `notifySendButton(clientId)` | — | Карусель + обложка + сторис проверены → кнопка "📤 Отправить клиенту" |
| `notifyFreeVisualsReady(clientId, ...)` | — | Совместимость: вызывает три функции выше |
| `resumePendingTasks()` | 204 | Восстановить незавершённые задачи после перезапуска |
| `resumePendingVisualJobs()` | 219 | Восстановить незавершённые visual-джобы. При рестарте сервиса запускает `runVisualGeneration` без `maxVideos` — берёт правильное кол-во из пакета (Стандарт=2, Профи=4). `expectedCount` для проверки: Профи=4, Стандарт=2. |
| `bot3Send(chatId, text, replyMarkup)` | ~5384 | Отправить текст в Bot3. Проверяет ответ Telegram и логирует ошибку если не ok. Возвращает boolean. |
| `bot3SendVideo(chatId, filePath)` | ~5397 | Отправить видео в Bot3. При ошибке sendVideo → fallback на sendDocument. Логирует размер и причину. Возвращает boolean. |
| `sendSectionImages(...)` | ~4811 | Отправить раздел изображений в Bot3 (платный пакет). Если batch `sendMediaGroup` упал → retry по одному с логированием каждой ошибки. |

### Независимые уведомления бесплатного пакета (июнь 2026)

Каждый тип визуала отправляется в Bot3 **независимо** как только готов:
- **Карусель (7 слайдов)** → когда все 7 готовы ИЛИ ≥6 готово и прошло >15 мин (Kie.ai не ответил)
- **Авто-ретрай карусели** → после завершения `Promise.all` проверяются все слайды; пропущенные получают 1 повторную попытку; менеджер уведомляется о ретрае и его результате; если ретрай тоже не принёс — предлагается `/retry_free_slots {chatId}`
- **Обложка** → сразу как готова, не ждёт карусели
- **Сторис (9:16)** → сразу как готова, независимо
- **Фото** → независимо, отправляется сразу; скачивается локально в `{chatId}_free_photo.jpg`; Bot3 получает файл (не URL); HTML обновляется через публичный `/images/` URL; после фото Bot3 получает подпись поста из `free_prompts.json`
- **Кнопка "Отправить клиенту"** → появляется когда карусель, обложка И сторис уведомлены

**HTML-страница клиента** обновляется ПОСЛЕ наложения overlay-текста (`_ov.jpg`), не до. Это важно: раньше HTML обновлялся с сырыми файлами до overlay — изображения в странице показывались без текста или ссылки ломались.

Флаги: `{chatId}.carousel_notified`, `{chatId}.cover_notified`, `{chatId}.story_notified`, `{chatId}.free_visuals_notified`  
Сброс флагов при регенерации: `generateFreeVisuals` удаляет все 5 флагов (включая `visuals_6done`).

### Wave1 vs Wave2 — как попадают скрипты в visual.js

`runVisualGeneration` всегда читает `{chatId}.visual.json`. Поэтому:

| Момент | Кто пишет visual.json | Источник скриптов |
|--------|----------------------|-------------------|
| Wave1 | index.js (send_approved_package / run_visual) | session после блоков 1-9 |
| Wave2 | index.js (wave2_gen handler) — **перезапись перед /generate** | session после блоков 7-8 с аналитикой |

> ⚠️ Без перезаписи visual.json перед Wave2 `/generate` — visual.js читает Wave1 скрипты и генерирует те же картинки. Баг исправлен 20.06.2026.

### Локальное хранение всех изображений (21.06.2026)

**Все изображения** — бесплатный и платный пакет — скачиваются локально в `visual_results/`. Kie.ai URL не используется как постоянный источник (истекает 24-72ч).

#### Бесплатный пакет

| Тип | Функция | Локальный файл |
|-----|---------|---------------|
| Слайды (0-6) | `pollAndSave` | `{id}_free_carousel0..6.jpg` |
| Обложка | `pollAndSave` | `{id}_free_cover0.jpg` |
| Сторис | `pollAndSave` | `{id}_free_story0.jpg` |
| AI-фото (первичная) | `generateFreePhoto` | `{id}_free_photo.jpg` |
| Регенерация любого слота | `regenFreeImage` | те же имена файлов, обновляются |

**`updatePackPageCover` и `updatePackPagePhoto` (21.06.2026)**: оба теперь конвертируют локальный путь в публичный URL (`${VISUAL_BASE_URL}/images/{filename}`) внутри функции. До этого локальный путь шёл прямо в `<img src="">` — HTML показывал битые картинки.

**`previewTextEdit` (21.06.2026)**: при редактировании текста бесплатного пакета (кнопка ✏️) ищет raw-файл в трёх местах: 1) `results.json` (платный), 2) `{id}_free_carousel{N}.jpg` / `{id}_free_cover0.jpg`, 3) URL из `free_visuals.json`. Раньше падало с "исходный файл не найден" т.к. bot3 создавал пустой `results.json`.

**`regenFreeImage`**: после получения URL скачивает локально, обновляет `localPath` в `free_photo.json` / `free_visuals.json`, HTML через постоянный `/images/` URL. Также читает story промпт из `free_prompts.json` (раньше падало с "Промпт не найден").

#### Платный пакет

`applyAndSaveOverlays` — всегда скачивает изображение:
- **Есть текст** → накладывает, сохраняет `{id}_{section}_{i}_ov.jpg`
- **Нет текста** (Highlights, edge-кейсы) → сохраняет `{id}_{section}_{i}_raw.jpg`

Видео — всегда локально через ffmpeg.

`deliverPaidPackage` использует `bestPaidMedia(localPath, urlFallback)` — берёт локальный файл, URL только как запасной.

#### Статический сервер

`app.use('/images', express.static(RESULTS_DIR))` — все файлы из `visual_results/` по URL:  
`https://{VISUAL_BASE_URL}/images/{filename}`

⚠️ Требует `VISUAL_BASE_URL` в Railway env.

### Тестовые функции

| Функция | Строка | Что делает |
|---------|--------|-----------|
| `testOverlayOnCachedImages(clientChatId)` | 347 | Тест наложения текста на кешированные изображения |
| `testCarouselOverlay(clientChatId)` | 411 | Тест карусели с наложением |
| `testCarouselVariants(clientChatId)` | 473 | Тест 3 вариантов формата карусели |
| `testVideoOverlay(clientChatId)` | 559 | Тест видео с хук+тема+CTA |
| `testMini({...})` | 655 | Быстрый тест: генерация без полного запуска |
| `testFullClient({...})` | 836 | Полный тест клиентского пакета |

### Извлечение данных из скриптов

| Функция | Строка | Что делает |
|---------|--------|-----------|
| `extractFirstCarouselImagePrompts(scripts, maxSlides)` | 618 | Промпты изображений для каруселей |
| `extractFirstPhotoImagePrompt(photoScripts)` | 642 | Промпт для фото-поста |
| `extractFirstCoverImagePrompt(covers)` | 649 | Промпт для обложки |
| `extractSlideTexts(scripts, sectionType)` | 1584 | Тексты поверх слайдов (`КАДР N: / Текст поверх фото:`) |
| `extractSlideCaption(scripts, slideNum)` | 1790 | Подпись к слайду (`Подпись к посту:`) |
| `extractVideoTexts(videoScripts, ctaPreference, leadMagnet)` | 1745 | Хук+тема+CTA из видео-скриптов |
| `extractFirstPhotoCaption(photoScripts)` | 1782 | Подпись к фото-посту |
| `extractSubtitleFromScript(videoScript)` | 1934 | Субтитры из видео-скрипта |
| `extractTimedTexts(videoScript, ctaText)` | 1824 | Хук из "Эмоция зрителя:", CTA из скрипта или переданного ctaText |
| `splitVideoScripts(text)` | 4674 | Делит скрипты по "ВИДЕО N:" с сохранением заголовка в каждой части |

### Kie.ai API

| Функция | Строка | Что делает |
|---------|--------|-----------|
| `kiePost(endpoint, body)` | 1262 | POST запрос к Kie.ai |
| `kieGet(taskId, taskType)` | 1274 | GET статус задачи Kie.ai |
| `kieSize(ratio)` | 1289 | Маппинг соотношения → размер Kie.ai |
| `startImage(prompt, size)` | 1295 | Запустить генерацию изображения |
| `startVideo(prompt)` | 1300 | Запустить генерацию видео (Veo3) |
| `pollTask(taskId, maxMs, taskType)` | 1313 | Ждать завершения задачи (до 15 мин для видео) |

### Наложение текста на изображение

| Функция | Строка | Что делает |
|---------|--------|-----------|
| `getTextRenderer()` | 1482 | Инициализация text-to-svg рендерера |
| `escapeXml(str)` | 1499 | Экранирование спецсимволов для SVG |
| `wrapText(text, maxCharsPerLine)` | 1508 | Перенос строк |
| `overlayTextOnImage(imageBuffer, text, position)` | 1524 | Наложить текст на изображение (главная функция) |

### Обработка видео

| Функция | Строка | Что делает |
|---------|--------|-----------|
| `splitScriptToScenes(videoScript)` | 3015 | Primary: извлекает 4 "СЦЕНА N: EN:..." строки напрямую из ТЗ. Fallback: Claude Haiku (для старых скриптов без СЦЕНА-блоков) |
| `notifyBot3VideoScriptsPreview(clientChatId, clientName, videoScripts)` | ~5642 | Превью сценариев + pending-файл + кнопки [✅ Запустить] [✏️ Исправить]. Прямой fetch без Markdown (иначе Telegram отклоняет кнопки) |
| `waitForVideoApproval(clientChatId, fallbackScripts)` | ~5719 | Polling каждые 5 сек + пишет heartbeat в `{chatId}.veo_heartbeat.json`. В начале удаляет старый `approved`-файл. Ждёт `{chatId}.video_scripts_approved.json`. Возвращает сценарии из pending-файла (approved scripts, не оригинальные) |
| `applyLibraryVideo(libMatch, videoScript, videoIndex, clientChatId, ctaOverride)` | ~3493 | Берёт видео из библиотеки, накладывает субтитр из текущего сценария. Без Veo3 |
| `notifyBot3LibraryVideo(clientChatId, videoIndex, totalVideos, localPath, subtitleText, libMatch)` | ~5050 | Уведомление: видео из библиотеки с кнопками [✏️ Изменить текст] [🆕 Сгенерировать новое] |

## Endpoints visual_sample

| Endpoint | Что делает |
|----------|-----------|
| `POST /rewrite_video_scripts` | `{clientChatId, feedback}` — переписывает сценарии через Sonnet; fallback из done_snapshot если pending пуст; при ошибке показывает кнопки [✅ Текущие] [✏️ Снова] |
| `POST /generate_videos_from_pending` | `{clientChatId}` — генерирует все видео из pending-файла (или done_snapshot). Проверяет heartbeat: если `waitForVideoApproval` жива (<10 сек) — пропускает (предотвращает дублирование). Вызывается из `va_ok_` |
| `POST /resend_scripts` | `{clientChatId}` — повторно показывает сценарии с кнопками. Fallback из done_snapshot. Используется командой `/resend_scripts` |
| `POST /force_generate_video` | `{clientChatId, videoIndex}` — прямой Veo3 без библиотеки. Вызывается кнопкой 🆕 на библиотечном видео. Сохраняет в results.json |
| `POST /generate_visual_sample` | Генерирует полный тест: карусель+фото+обложка+сторис+видео с текстами и кнопками |
| `POST /regen_sample_slot` | Перегенерирует один слот (type: c/ph/co/st/v, index, feedback) |
| `POST /regen_sample_fragment` | Перегенерирует один фрагмент видео (fragIndex, feedback) → пересобирает итоговое |
| `POST /edit_sample_text` | Переналагает текст на существующий raw-файл, пересылает с кнопками |

**Файловая структура visual_sample:**
- `{chatId}_sample_car_raw_{i}.jpg` — raw картинка карусели (без текста)
- `{chatId}_sample_car_{i}.jpg` — с наложенным текстом (что отправляется)
- Аналогично для `photo`, `cover`, `story`
- `{chatId}_sample_video_raw.mp4` — видео без текста
- `{chatId}_sample_video.mp4` — с хук/тема/CTA

**Тексты хранятся в `free_prompts.json`:** `carouselTexts[]`, `coverTitle`, `photoTitle`, `videoHook`, `videoTheme`, `videoCta`
| `downloadFile(url, destPath)` | 1678 | Скачать файл по URL |
| `mergeVideoFragments(fragmentPaths, outputPath)` | 1685 | Склеить видео-фрагменты через ffmpeg |
| `wordSlice(text, maxWords)` | 1694 | Обрезать текст по словам (не посередине) |
| `getVideoDuration(videoPath)` | 1700 | Получить длительность видео |
| `srtTime(sec)` | 1713 | Секунды → SRT формат времени |
| `buildTimedSrt(hookText, ctaText, duration, themeText)` | 1721 | Построить SRT файл субтитров |
| `_splitLines(text, maxChars)` | 1834 | Разбить на строки по символам |
| `_buildDrawtextBlock(text, start, end, baseTmpPath)` | 1850 | Построить ffmpeg drawtext фильтр |
| `addSubtitles(videoPath, subtitleText, outputPath)` | 1893 | Добавить субтитры burn-in |
| `addTimedSubtitles(videoPath, srtContent, outputPath)` | 1902 | Добавить тайминговые субтитры |
| `generateOneVideo(videoScript, videoIndex, clientChatId, ctaOverride)` | 1943 | Сгенерировать одно видео полностью |
| `cleanupVideoFragments(clientChatId)` | 2035 | Удалить временные фрагменты |

### Библиотека контента

| Функция | Что делает |
|---------|-----------|
| `saveToLibrary(path, prompt, tags)` | Сохранить видео в `video_library/` |
| `saveToPhotoLibrary(path, prompt, tags, section)` | Сохранить фото в `photo_library/` |
| `searchVideoLibrary(tags, clientChatId, limit)` | Найти видео (исключает уже использованные клиентом) |
| `searchPhotoLibrary(tags, clientChatId, limit, section)` | Найти фото (исключает уже использованные клиентом) |
| `tryPhotoLibrary(prompt, clientChatId, section)` | Перед Kie.ai: проверить фото-библиотеку → localPath или null |
| `markContentUsed(clientChatId, photoIds, videoIds)` | Записать что клиент уже получил этот контент |
| `getClientHistory(clientChatId)` | История контента клиента |
| `libraryStats()` / `photoLibraryStats()` | Статистика библиотек |

**Триггер сохранения:** `/save_approved_content` вызывается из `deliverFreePackage` и `deliverVisualPackage` в index.js когда менеджер одобрил и контент идёт клиенту.

**Теги при сохранении:**
- Бесплатный пакет: промпты берутся из `free_prompts.json` → теги осмысленные ✅
- Платный пакет: промпты читаются из `{chatId}.visual.json` через `extractByPrefix` → теги осмысленные ✅ (исправлено 12.06.2026 — раньше передавался пустой промпт)

**Исключение использованного контента:** `searchPhotoLibrary` и `searchVideoLibrary` исключают из результатов фото/видео уже отправленные этому клиенту. Контент остаётся в библиотеке и доступен другим клиентам.

**Использование:** `generateFreeVisuals` проверяет фото-библиотеку через `tryPhotoLibrary` перед каждым обращением к Kie.ai (только бесплатный пакет).

### Highlights (обложки для Instagram Highlights)

Генерируются только в **Wave 1** для пакетов Стандарт (4 шт) и Профи (8 шт).

**Источник ТЗ**: `pkg.highlightCovers` (из `session.highlightCovers`, генерируется в `block8_covers.js`).  
**Формат**: 1:1 квадрат (круглая иконка Highlights).  
**Извлечение промптов**: `getPrompts(pkg.highlightCovers, 'Промпт для AI', maxHighlights)`.  
**Хранение результатов**: `results.highlights[]` + `results.highlightsLocalPaths[]`.  
**Секция в Bot3**: `hl` — кнопки Переделать (regen) без редактирования текста.  
**Доставка**: только при `!wave1Done` через `sendGroup(highlightMedias, '🔵 Обложки Highlights...')`.

### Регенерация

| Функция | Строка | Что делает |
|---------|--------|-----------|
| `previewTextEdit(clientChatId, section, index, text)` | 1079 | Предпросмотр редактирования текста |
| `regenVideoFromScript(clientChatId, videoScripts, feedback)` | 2124 | Перегенерировать все видео по скриптам |
| `regenVideo(clientChatId, videoIndex, feedback)` | 2203 | Перегенерировать одно видео |
| `regenSubtitle(clientChatId, videoIndex, newSubtitleText)` | 2309 | Только субтитры перегенерировать |
| `regenSection(clientChatId, section)` | 2358 | Перегенерировать целый раздел |

### Вспомогательные

| Функция | Строка | Что делает |
|---------|--------|-----------|
| `getCarouselGroups(carouselScripts, totalSlides)` | 1387 | Группировка слайдов по каруселям |
| `extractByPrefix(text, prefix)` | 1416 | Извлечь текст после префикса |
| `extractByContains(text, prefix)` | 1424 | Извлечь текст по частичному совпадению |
| `extractPromptsViaAI(text, type)` | 1436 | Claude Haiku извлекает промпты из текста |
| `getImagePrompts(text, type, maxCount)` | 1456 | Получить промпты для изображений |
| `sleep(ms)` | 1383 | Задержка (Promise) |
