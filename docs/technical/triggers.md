# Trigger-файлы — система оркестрации

**Путь**: `~/. marketingdna-client-sessions/triggers/` (Railway Volume)

## Таблица всех trigger-файлов

| Файл | Когда создаётся | Что запускает в index.js |
|------|----------------|--------------------------|
| `{id}.trigger` | Bot2 завершил анкету (бесплатный) | Генерация бесплатного пакета |
| `{id}.paid.trigger` | Stripe подтвердил оплату | Генерация платного пакета |
| `{id}.paid_init.trigger` | Stripe webhook получен | Инициализация платного flow |
| `{id}.code.trigger` | Клиент ввёл beta-код | Генерация по коду (как платный) |
| `{id}.approved.trigger` | Bot3 одобрил (платный) | `deliverVisualPackage()` |
| `{id}.free_approved.trigger` | Bot3 одобрил (бесплатный) | `deliverFreePackage()` |
| `{id}.addlang_{lang}.trigger` | Stripe: доп язык оплачен | `runTranslationJob()` |
| `{id}.done_snapshot.json` | Генерация завершена | Кэш для `/retry_paid` и `/run_visual` |
| `{id}.quality.marker` | `/test_quality` или качественный триггер | Ограничивает визуал до 1 штуки каждого типа |
| `{id}.bot4_review.trigger` | Bot3: менеджер нажал "Отправить" при активном Bot4 | Bot4 собирает финальный пакет и присылает менеджеру |

## Кто создаёт trigger-файлы

- **Bot2** (`bot2.js`): `.trigger`, `.paid.trigger`, `.paid_init.trigger`, `.code.trigger`, `.addlang_*.trigger`
  - Функции: `writeTrigger()`, `writePaidTrigger()`, `writePaidInitTrigger()`, `writeAddlangTrigger()`
- **Bot3** (`bot3.js`): `.approved.trigger`, `.free_approved.trigger`, `.bot4_review.trigger`
- **Bot4** (`bot4.js`): `.approved.trigger` (после финальной проверки менеджером)
- **Bot1** (`index.js`): `.done_snapshot.json`, `.quality.marker`

## Цикл проверки

`checkTriggers()` в index.js (стр. 2091) — периодически сканирует папку triggers/ и обрабатывает файлы.

## Важное про snapshot

⚠️ `/retry_paid` ВСЕГДА берёт данные из `{id}.done_snapshot.json`.
Для реальной перегенерации: `/regen_scripts {chatId}` (пропускает snapshot).

## Beta-коды

- Хранятся в `access_codes.json` в корне бота
- Клиент вводит код → Bot2 создаёт `.code.trigger` → Bot1 генерирует как платный
