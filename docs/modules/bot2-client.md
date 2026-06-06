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

## Мультиязычность интерфейса

Добавлено июнь 2026. Все сообщения бота клиенту идут через `T(key, lang)` из `src/i18n.js`.

- `session.interfaceLang` — язык интерфейса (`'ru'` или `'lv'`), определяется при /start из ?start= параметра
- Вопросы анкеты берутся через `getQPart1(lang)` / `getQPart2(lang)` (внутри bot2.js)
- Все кнопки, статусы, приветствия переведены на LV

## Поля сессии клиента (session объект)

```javascript
session = {
  chatId,
  interfaceLang,       // язык интерфейса бота ('ru' | 'lv') — с июня 2026
  packageKey,          // 'pkg_a', 'pkg_standard', 'pkg_v'
  docsLanguage,        // язык аналитики (RU/LV/EN)
  contentLanguage,     // язык контента (RU/LV/EN)
  ctaPreference,       // 'direct_magnet' | 'direct_only' | 'no_cta'
  leadMagnet,          // текст лид-магнита (если direct_magnet)
  contentGoal,         // 'new_clients' | 'existing_audience'
  videoType,           // 'type_a' | 'type_b'
  socialLinks,         // ссылки на соцсети
  // + данные анкеты: ниша, название бизнеса, описание и т.д.
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
