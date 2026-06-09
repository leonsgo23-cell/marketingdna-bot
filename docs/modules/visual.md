# visual.js — карта функций (Visual Service)

**Размер**: ~3167 строк  
**Роль**: Express-сервер (порт 3002), генерация изображений и видео  
**APIs**: Kie.ai (изображения + видео Veo3), sharp (наложение текста), ffmpeg (видео)

## Функции по категориям

### Задачи и очередь изображений

| Функция | Строка | Что делает |
|---------|--------|-----------|
| `saveImageTask(taskId, meta)` | 47 | Сохранить задачу в очередь |
| `removeImageTask(taskId)` | 54 | Удалить задачу из очереди |
| `pollAndSave(taskId, meta)` | 60 | Ждать завершения задачи и сохранить результат |
| `rebuildFreeVisuals(clientId)` | 87 | Пересобрать визуалы бесплатного пакета |
| `notifyFreeVisualsReady(clientId, ...)` | 115 | Уведомить Bot3 о готовности визуалов |
| `resumePendingTasks()` | 204 | Восстановить незавершённые задачи после перезапуска |
| `resumePendingVisualJobs()` | 219 | Восстановить незавершённые visual-джобы |

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
| `extractTimedTexts(videoScript, ctaText)` | 1824 | Тайминги текста для видео |

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
| `splitScriptToScenes(videoScript)` | 1645 | Claude Haiku делит ТЗ на ровно 4 сцены (минимум для 25-30 сек видео) |

## Endpoints visual_sample

| Endpoint | Что делает |
|----------|-----------|
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

### Видео-библиотека

| Функция | Строка | Что делает |
|---------|--------|-----------|
| `extractVideoTags(prompt)` | 2054 | Claude Haiku извлекает теги из промпта |
| `searchLibrary(tags, limit)` | 2072 | Поиск видео в библиотеке по тегам |
| `saveToLibrary(localPath, prompt, tags)` | 2088 | Сохранить видео в библиотеку |
| `libraryStats()` | 2112 | Статистика библиотеки |

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
