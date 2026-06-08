# Видео — техническая реализация

> Финальная реализация: 02.06.2026. Не менять без явного подтверждения.

## Кто получает видео

- **Старт** — AI-видео НЕ генерируется. Только 8 сценариев "человек в кадре" как подарок.
- **Стандарт** — 4 B-roll видео (Kie.ai Veo3)
- **Профи** — 8 B-roll видео + 8 обложек Highlights

## Пайплайн генерации (generateOneVideo в visual.js)

```
1. splitScriptToScenes(videoScript) — Claude Haiku делит ТЗ на ровно 4 сцены (4 × 8 сек = 32 сек → обрезается до 30)
2. startVideo(prompt) → Kie.ai Veo3 API
3. pollTask() — ждём до 7 минут каждый фрагмент
4. Скачиваем .mp4 фрагменты → ffmpeg concat → merged.mp4
5. addSubtitles(merged, subtitle, final.mp4) — наложение текста burn-in
6. Сохраняем: rawPath (без текста) и localPath (с текстом)
```

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
- `regenVideo(clientChatId, videoIndex, feedback)` — перегенерация одного видео
- `regenSubtitle(clientChatId, videoIndex, newSubtitleText)` — только субтитры

## Тест видео

```bash
/test_video_overlay 71950950  # 1 видео из библиотеки с хук+тема+CTA
/test_full_client 71950950    # полный тест включая видео
```
