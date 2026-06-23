# Видео — техническая реализация

> Финальная реализация: 02.06.2026. Не менять без явного подтверждения.

## Кто получает видео

- **Старт** — AI-видео НЕ генерируется. Только 8 сценариев "человек в кадре" как подарок.
- **Стандарт** — 4 B-roll видео (Kie.ai Veo3)
- **Профи** — 8 B-roll видео + 8 обложек Highlights

## Формат ТЗ для видео (block7_scripts.js, обновлено 15.06.2026)

Block7 пишет для каждого видео 4 сцены в двух языках:

```
ВИДЕО N: [тема — макс 35 символов]
Настроение: [тип]
Эмоция зрителя: [хук — макс 35 символов]

СЦЕНЫ ДЛЯ ГЕНЕРАЦИИ:
СЦЕНА 1 (0-8 сек):
  EN: [конкретный EN prompt для Veo3 — детали этого бизнеса, vertical 9:16, no text]
  RU: [что видит зритель — для проверки менеджером]
СЦЕНА 2 (8-16 сек):
  EN: [...]
  RU: [...]
СЦЕНА 3 (16-24 сек):
  EN: [...]
  RU: [...]
СЦЕНА 4 (24-30 сек):
  EN: [...]
  RU: [...]
```

EN-строки → Veo3. RU-строки → менеджер видит в Bot3 до генерации.

## Пайплайн генерации (generateOneVideo в visual.js)

```
1. splitScriptToScenes(videoScript):
   — Primary: извлекает 4 "СЦЕНА N: EN: ..." строки напрямую (без Haiku)
   — Fallback: Claude Haiku генерирует сцены (для старых скриптов без СЦЕНА-блоков)
2. startVideo(prompt) → Kie.ai Veo3 API
3. pollTask() — ждём до 7 минут каждый фрагмент
4. Скачиваем .mp4 фрагменты → ffmpeg concat → merged.mp4
5. addSubtitles(merged, subtitle, final.mp4) — наложение текста burn-in
6. Сохраняем: rawPath (без текста) и localPath (с текстом)
```

## Превью сценариев для менеджера (15.06.2026)

Перед началом видео-генерации `notifyBot3VideoScriptsPreview` отправляет менеджеру в Bot3 карточку:
- Название каждого видео
- Хук (Эмоция зрителя)
- RU-описание каждой из 4 сцен

Менеджер видит ЧТО будет в кадре до того как $1.20 потрачено.

## Три блока текста поверх видео

| Блок | Тайминг | Источник текста |
|------|---------|----------------|
| **Хук** | 0–4 сек | Из "Эмоция зрителя:" (B-roll) или "А:" вариант (Старт) |
| **Тема** | 35%–65% видео | Из названия сценария, max 5 слов |
| **CTA** | Последние 8 сек | Из `ctaPreference` клиента |

## Техническая реализация текста

- Длина: всегда 30 сек (`ffmpeg -t 30`) — БЕЗ ffprobe (не работает в Railway)
- Одна тёмная полоса: `drawbox=...color=black@0.72:t=fill` + текст без боксов сверху
- Шрифт: `Inter-Bold.ttf` через `fontfile=` в ffmpeg drawtext
- Обрезка слов: `wordSlice(N)` — нет обрыва посередине слова
- Функция: `_buildDrawtextBlock(text, start, end, baseTmpPath)` в visual.js (стр. 1850)

## Что НЕЛЬЗЯ делать (проверено, не работает)

- `subtitles=` фильтр с SRT — требует fontconfig (нет в Railway nixpacks)
- `slice(0, N)` для обрезки текста — режет посередине слова
- ffprobe для получения длины видео — не работает в Railway

## Видео-библиотека

- Путь: `/root/.marketingdna-client-sessions/video_library/`
- `saveToLibrary(localPath, prompt, tags)` — сохраняет с тегами
- `searchLibrary(tags, limit)` — поиск по тегам
- `extractVideoTags(prompt)` — Claude Haiku извлекает теги из промпта
- `libraryStats()` — статистика библиотеки

## Регенерация видео

- `regenVideoFromScript(clientChatId, videoScripts, feedback)` — полная перегенерация
- `regenVideo(clientChatId, videoIndex, feedback)` — перегенерация одного видео (берёт `fragPaths` из results.json, не CDN-ссылки)
- `regenSubtitle(clientChatId, videoIndex, newSubtitleText)` — только субтитры

### regenSubtitle — логика (24.06.2026)

**Входные данные**: `newSubtitleText` = строка с форматом `"Хук: ...\nТема: ...\nСТА: ..."`

**Парсинг**: функция сама разбирает входной текст:
- `Хук:` → hookText (≤ 35 символов)
- `Тема:` → themeText (≤ 35 символов)
- `СТА:` / `CTA:` → ctaText (≤ 70 символов)

**Наложение**: использует `buildTimedSrt` + `addTimedSubtitles` (тайминговый хук/тема/CTA) — **не** `addSubtitles` (статичный). Так же как при первичной генерации.

**Важно**: использует `rawPath` из results.json (файл без субтитра) как базу → никакого двойного наложения.

**После**: вызывает `notifyBot3SingleVideo` с правильными кнопками (`et_video_`, `rscene_`), не `notifyBot3Regen`.

### Флоу "Изменить текст" в Bot3

1. Менеджер нажимает `et_video_` → Bot3 просит формат: `Хук: текст\nТема: текст\nСТА: текст`
2. Менеджер пишет → bot3.js парсит для подтверждения → показывает без меток → отправляет raw в `/regen_video?subtitleOverride=...`
3. visual.js → `regenSubtitle` → парсит → `addTimedSubtitles(rawPath, ...)` → `notifyBot3SingleVideo`

## Тест видео

```bash
/test_video_overlay 71950950  # 1 видео из библиотеки с хук+тема+CTA
/test_full_client 71950950    # полный тест включая видео
```
