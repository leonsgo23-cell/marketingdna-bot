# Деплой и инфраструктура

## Деплой бота

```bash
cd ~/marketingdna-bot
git add .
git commit -m "описание изменения"
git push
# → GitHub → Railway → автодеплой за 2-3 мин
```

## Деплой сайта

```bash
cd ~/marketingdna-site
git add index.html   # (или нужные файлы)
git commit -m "описание"
git push
# → GitHub → Railway → marketing-dna.com за 1-2 мин
```

⚠️ **НЕ использовать `netlify deploy`** — деплоит на netlify.app, а не на marketing-dna.com.

## Локальный запуск — ЗАПРЕЩЁН

`start.sh` содержит защиту: если нет переменной `RAILWAY_PROJECT_ID` (т.е. запуск не с Railway) — скрипт сразу завершается с ошибкой.

**Причина:** локальный запуск вызывает ошибку `409 Conflict` — Telegram не позволяет двум копиям одного бота работать одновременно. Это "убивает" работающий бот на Railway.

**Правило:** боты запускаются ТОЛЬКО через Railway. Для деплоя изменений — `git push`.

## Railway — структура сервисов

Все боты запускаются в **одном контейнере** через `start.sh`:
- **Bot1** — `index.js` (admin-бот, генерация)
- **Bot2** — `bot2.js` (клиентский бот)
- **Bot3** — `bot3.js` (менеджерский бот)
- **Visual** — `visual.js` (порт 3002, Express)
- **Bot4** — `bot4.js` (финальная проверка) — запускается только если `TELEGRAM_BOT4_TOKEN` задан

Bot4 стартует с задержкой 35 сек (избегает 409 Conflict при редеплое).

## Переменные Railway (добавлены 15.06.2026)

| Переменная | Назначение |
|-----------|-----------|
| `TELEGRAM_BOT4_TOKEN` | Токен Bot4 (создать через @BotFather) |
| `BOT4_MANAGER_CHAT_ID` | chatId менеджера для Bot4 (опционально) |
| `LEARNING_THRESHOLD` | Порог для цикла самообучения (по умолчанию 30, рекомендуется 10) |
| `TELEGRAM_BOT5_TOKEN` | Токен Bot5 «Продюсер» (02.07.2026); без него Bot5 не стартует |
| `PRODUCER_HOUR_UTC` | Час автогенерации сценария дня Bot5 (по умолчанию 5 = 08:00 Рига летом) |

## Railway — Volume (постоянное хранилище)

**Путь**: `/root/.marketingdna-client-sessions/`

Что хранится:
- Сессии клиентов (JSON файлы)
- Trigger-файлы (`.trigger`, `.paid.trigger`, `.approved.trigger`, ...)
- Готовые медиафайлы (фото, видео)
- Видео-библиотека: `/root/.marketingdna-client-sessions/video_library/`

## Домен и DNS

- Домен: marketing-dna.com
- DNS: nano.lv → Railway
- НЕ Netlify

## Переменные окружения (Railway)

Хранятся в Railway Dashboard → Service → Variables.
Не хранить в коде, не коммитить в git.
Ключевые: Telegram токены, OpenAI API key, Kie.ai API key, Stripe ключи, Tavily API key.
