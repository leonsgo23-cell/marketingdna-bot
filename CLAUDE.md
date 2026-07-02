# Marketing DNA — навигатор

## ⚡ ПЕРВОЕ ЧТО НУЖНО СДЕЛАТЬ В НОВОМ ЧАТЕ

1. Прочитай этот файл до конца
2. Для любой задачи — найди нужный раздел в таблице ниже и читай ТОЛЬКО тот docs/ файл
3. **НЕ читай index.js, bot2.js, bot3.js, visual.js целиком** — они по 2500-3000 строк и переполнят контекст
4. Вся нужная информация уже есть в docs/ — используй её

> Актуально: июнь 2026. Обновлять при каждом системном изменении.

## Архитектура (кратко)

```
Bot2 (клиент, bot2.js) → .trigger файл → Bot1 (admin, index.js) → Bot3 (менеджер, bot3.js) → Bot2
                                                    ↕
                                           visual.js (порт 3002)
```

Деплой: `git push` → GitHub → Railway (1-3 мин). НЕ netlify.

---

## Что читать для какой задачи

### Бизнес-вопросы (пакеты, цены, что получает клиент, себестоимость, маржа)
→ [docs/core/business-rules.md](docs/core/business-rules.md)

### Путь клиента (анкета, оплата, доставка)
→ [docs/core/client-journey.md](docs/core/client-journey.md)

### Что нельзя менять (договорённости, запреты)
→ [docs/core/agreements.md](docs/core/agreements.md) ← **читать ПЕРЕД любой правкой кода**

### Деплой, Railway, инфраструктура
→ [docs/core/deployment.md](docs/core/deployment.md)

### Работа с index.js (Bot1, генерация)
→ [docs/modules/index-bot.md](docs/modules/index-bot.md)

### Работа с bot2.js (клиентский бот, анкета)
→ [docs/modules/bot2-client.md](docs/modules/bot2-client.md)

### Работа с bot3.js (менеджерский бот)
→ [docs/modules/bot3-manager.md](docs/modules/bot3-manager.md)

### Работа с visual.js (изображения, видео)
→ [docs/modules/visual.md](docs/modules/visual.md)

### Работа с producer.js (Bot5 — соцсети самой Marketing DNA)
→ [docs/modules/producer.md](docs/modules/producer.md)

### Карусели — техника наложения текста, формат скриптов
→ [docs/technical/carousel.md](docs/technical/carousel.md)

### Видео — пайплайн, субтитры, burn-in текст
→ [docs/technical/video.md](docs/technical/video.md)

### Trigger-файлы — что и когда создаётся
→ [docs/technical/triggers.md](docs/technical/triggers.md)

### Мультиязычность — два языка, доп. язык
→ [docs/technical/multilingual.md](docs/technical/multilingual.md)

### Тестовые команды
→ [docs/ops/test-commands.md](docs/ops/test-commands.md)

### Что в разработке (roadmap)
→ [docs/ops/roadmap.md](docs/ops/roadmap.md)

---

## Правило обновления документации

**После любого изменения кода — обновить соответствующий docs/ файл в той же задаче.**

| Изменил | Обнови |
|---------|--------|
| index.js | docs/modules/index-bot.md |
| bot2.js | docs/modules/bot2-client.md |
| bot3.js | docs/modules/bot3-manager.md |
| visual.js | docs/modules/visual.md |
| src/steps/block*.js | docs/modules/index-bot.md (раздел "Блоки генерации") |
| Новая договорённость | docs/core/agreements.md |
| Новый trigger-тип | docs/technical/triggers.md |
| Новые тест-команды | docs/ops/test-commands.md |
| Изменения в roadmap | docs/ops/roadmap.md |
