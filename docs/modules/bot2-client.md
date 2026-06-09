# bot2.js — карта функций (клиентский бот)

**Размер**: ~2535 строк  
**Роль**: единственная точка общения с клиентом в Telegram  
**НЕ генерирует контент** — только собирает данные и пишет trigger-файлы

## Ключевые функции

| Функция | Строка | Что делает |
|---------|--------|-----------|
| `loadSession(chatId)` | 179 | Загрузка сессии клиента из файла |
| `saveSession(chatId, session)` | 187 | Сохранение сессии клиента |
| `saveLead(session)` | 192 | Сохранение лида (email и данные) |
| `writeTrigger(chatId, session)` | 199 | Создаёт `{id}.trigger` (бесплатный пакет) |
| `writePaidInitTrigger(chatId, session, packageKey)` | 232 | Создаёт `{id}.paid_init.trigger` |
| `writePaidTrigger(chatId, session)` | 247 | Создаёт `{id}.paid.trigger` после оплаты |
| `sendAdmin(text)` | 265 | Уведомление администратору |
| `isValidEmail(email)` | 281 | Валидация email |
| `isInstagram(text)` | 285 | Проверка ссылки на Instagram |
| `getMicroReaction(question, answer)` | 294 | Claude генерирует живую реакцию на ответ анкеты |
| `typing(ctx, ms)` | 320 | Имитация набора текста (задержка) |
| `resumeSession(ctx, session)` | 327 | Восстановление сессии после перезапуска |
| `handleStart(ctx)` | 461 | Обработка команды /start — начало анкеты |
| `handleMessage(ctx, overrideText)` | 541 | Основной обработчик сообщений анкеты |
| `startPart2(ctx, session)` | 1114 | Начало второй части вопросов (после оплаты) |
| `proceedToCta(ctx, chatId, session)` | 1122 | Переход к вопросу про CTA |
| `proceedToContentGoal(ctx, chatId, session)` | 1144 | Переход к вопросу про цель контента |
| `proceedToLangDocs(ctx, chatId, session)` | 1164 | Вопрос про язык аналитики |
| `proceedToLangContent(ctx, chatId, session)` | 1176 | Вопрос про язык контента |
| `proceedToLinks(ctx, chatId, session)` | 1188 | Вопрос про ссылки на соцсети |
| `handlePackageSelection(ctx, pkgKey)` | 1502 | Обработка выбора пакета клиентом |
| `completePaidQ5(ctx, platformAnswer)` | 1600 | Завершение вопроса Q5 (платформы) |
| `getLangStripeLink(packageKey, lang)` | 1619 | Получение Stripe-ссылки для пакета |
| `getLangPrice(packageKey)` | 1630 | Получение цены пакета |
| `writeAddlangTrigger(chatId, lang, session)` | 1636 | Создаёт `{id}.addlang_{lang}.trigger` |
| `sendLangUpsell(_ctx, chatId, packageKey)` | 1651 | Предложение доп. языка после получения пакета |
| `showAddLang(ctx)` | 1679 | Показ опции доп. языка |
| `checkStripePayment(...refIds)` | 1765 | Проверка статуса оплаты через Stripe API |
| `finalizeLupsell(ctx, chatId, session)` | 1965 | Финализация допродажи |
| `askWsDomain(ctx)` | 2182 | Вопрос про домен сайта |
| `getWebsiteQuestions(template)` | 2230 | Вопросы для создания сайта |
| `buildAndDeploySite(chatId, session)` | 2235 | Сборка и деплой сайта клиента |
| `handleWebsiteDetails(ctx, chatId, text, session)` | 2266 | Обработка деталей сайта |

## Бесплатный флоу — 3 вопроса (с июня 2026)

Было: 2 вопроса. Добавлено имя клиента.

**Шаги:**
- `FREE_NAME` — "Как к вам обращаться?" → сохраняется как `session.clientName`
- `FREE_Q1` — "Что вы продаёте и кому?" (1-2 предложения)
- `FREE_Q2` — "В каком городе работаете?"
- После ответов → writeTrigger (передаёт `name = clientName`) → Bot1 генерирует пакет
- `COLLECTING_EMAIL_OPT` — email спрашивается ПОСЛЕ доставки пакета (необязательно)

**Уведомления Bot1:**
- При `/start` → "👤 Новый посетитель начал анкету"
- После FREE_Q2 → "✅ Анкета заполнена: [ответ1], [город]"

**Язык:** автоматически из ?start= параметра (`lv_` → латышский).

## Платный флоу — 12 вопросов (с июня 2026)

Было: 6 фиксированных вопросов. Стало: 12 (объединили с убранными из бесплатного).

Вопросы 1-8: бизнес, аудитория, конкуренты, возражения, история контента, цены, кто решает.
Вопросы 9-12: цель месяца, фокус, голос бренда, истории клиентов.

## Мультиязычность интерфейса

Все сообщения через `T(key, lang)` из `src/i18n.js`.
- `session.interfaceLang` — `'ru'` или `'lv'`, определяется при /start из ?start= параметра
- Все кнопки, статусы, приветствия, вопросы на обоих языках

## Поля сессии клиента (session объект)

```javascript
session = {
  chatId,
  interfaceLang,       // язык интерфейса ('ru' | 'lv')
  freeQ1,              // ответ на вопрос 1 бесплатного ("что продаёте")
  freeQ2,              // ответ на вопрос 2 бесплатного ("город")
  email,               // email (собирается после пакета, необязательно)
  packageKey,          // 'pkg_a', 'pkg_standard', 'pkg_v'
  paidAnswers,         // ответы на 12 платных вопросов
  contentLanguage,     // язык контента (RU/LV/EN)
}
```

## Flow анкеты (упрощённо)

```
/start → handleStart()
  → серия вопросов через handleMessage()
  → writeTrigger() — Bot1 подхватывает
  → [после оплаты] startPart2() → серия proceedTo*()
  → writePaidTrigger() — Bot1 запускает генерацию
```
