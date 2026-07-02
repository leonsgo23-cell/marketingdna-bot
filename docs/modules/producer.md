# producer.js — Bot5 «Бот-Продюсер»

> Создан 02.07.2026. Ведение СОБСТВЕННЫХ соцсетей Marketing DNA (не клиентских).
> Спецификация и план: `~/Documents/claudeProject/specs/2026-07-02-bot-producer-*.md`

## Назначение

Ежедневный контент для двух Instagram-аккаунтов бренда:
- **@marketingdnateam** — EN (европейский малый бизнес)
- **@marketingdnaru** — RU (русскоязычные предприниматели в Европе)

Этап 1 (текущий): сценарий дня → одобрение менеджером → 7 картинок +
2 видео Story Reel (EN и RU) → ручная публикация.
Дальше по плану: мониторинг конкурентов (Этап 2), лид-магнит (Этап 3),
автопубликация Metricool + аналитика (Этап 4).

## Запуск

- `start.sh`: запускается только если задан `TELEGRAM_BOT5_TOKEN`
- Polling стартует с задержкой **45 сек** (Bot4 — 35 сек; разводим 409 Conflict)
- Env: `TELEGRAM_BOT5_TOKEN` (обязателен), `PRODUCER_HOUR_UTC`
  (час автогенерации, по умолчанию 5 = 08:00 Рига летом), `VISUAL_SERVICE_URL`

## Данные (Railway volume)

```
~/.marketingdna-client-sessions/producer/
├── users.json            — chatId зарегистрированных (владелец, Александр)
├── state.json            — lastAutoDate (защита от двойного автозапуска)
├── drafts/{id}.json      — черновики дня со статусами
└── {id}.visual_done.json — сигнал готовности визуала от visual.js (удаляется после чтения)
```

Статусы черновика: `pending_script` → `generating_visual` → `visual_ready` → `approved_publish`

## Бренд-конфиг

`producer/brands/mdna.json` (в git) — аудитория, голос, запреты, рубрики,
CTA, визуальный стиль, аккаунты, время публикаций.
Рубрика дня выбирается по дню недели (`rubricByWeekday`, индекс = getUTCDay).
Мультибренд: новый бренд = новый JSON (пока захардкожен mdna).

## Флоу

1. Утром (или `/today`) → `generateDailySet()` → Sonnet генерирует сценарий:
   7 кадров (RU/EN текст + IMG-промпт), подписи RU/EN, 3 сторис
2. Карточка сценария всем пользователям: ✅ Одобрить (`pr_ok_`) /
   🔄 Переделать (`pr_re_`) / ✏️ С комментарием (`pr_cm_` → текст → реген с фидбеком)
3. Одобрение → POST `{VISUAL_URL}/producer_story_reel` (jobId=draft.id)
4. visual.js: 7 картинок Kie.ai 9:16 (общие для обоих языков!) → 2 рендера
   Creatomate (текст EN и текст RU отдельными слоями) → пишет `{id}.visual_done.json`
5. producer.js опрашивает каждые 10 сек → медиагруппа картинок + 2 видео +
   подписи + кнопки: ✅ Беру в публикацию / 🔄 Пересобрать видео
6. Этап 1: публикация вручную. Метка времени из `brand.publishTimes`

## Endpoint в visual.js

`POST /producer_story_reel { jobId, imagePrompts[], textsEn[], textsRu[], textPosition? }`
— отвечает сразу `{ok:true}`, работает асинхронно. Переиспользует
`startImage`, `pollTask`, `downloadFile`, `buildCarouselVideoSource` (2.5с/слайд).
Результат/ошибка — всегда в `producer/{jobId}.visual_done.json`.
Файлы: `RESULTS_DIR/producer_{jobId}_slide{i}_raw.jpg`, `producer_{jobId}_{en|ru}.mp4`
(в RESULTS_DIR — чтобы раздавались через `/images/` для Creatomate).

## Команды

| Команда | Что делает |
|---------|-----------|
| `/start` | Регистрация получателя (пишется в users.json) |
| `/today` | Сгенерировать сценарий дня сейчас |
| `/idea {тема}` | Сценарий на заданную тему |
| `/status` | Последние 5 черновиков со статусами |

## Себестоимость дня

7 картинок × $0.03 = $0.21 + 2 рендера Creatomate (подписка) + ~$0.03 Sonnet
≈ **$0.25/день** на оба аккаунта.
