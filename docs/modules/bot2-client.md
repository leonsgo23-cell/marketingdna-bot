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

## Бесплатный флоу — 4 вопроса (июнь 2026)

**Шаги:**
- `FREE_NAME` — "Как к вам обращаться?" → `session.clientName`
- `FREE_Q1` — "Что вы продаёте и кому?"
- `FREE_Q2` — "В каком городе работаете?"
- `FREE_Q3_LANG` — "На каком языке создавать контент?" → кнопки 🇷🇺/🇱🇻/🇬🇧 → `session.contentLanguage`
- После ответов → `writeTrigger` → Bot1 генерирует пакет
- `COLLECTING_EMAIL_OPT` — email спрашивается ПОСЛЕ доставки (необязательно)

**Обработчик языка:** `bot.action(/^free_lang_(ru|lv|en)$/)` — сохраняет `contentLanguage` и вызывает `writeTrigger`.  
**Для демо-кода:** тот же обработчик пишет `.demo.trigger` вместо `.trigger` и НЕ увеличивает `freePackageCount`.

**Язык интерфейса:** автоматически из `?start=` параметра (`lv_` → латышский).

## Демо-пакет (июнь 2026)

Код `DEMO2026` в `access_codes.json` (`type: "demo"`).

**Флоу:**
1. Клиент вводит код → `session.isDemo = true` → запускается `FREE_NAME` анкета
2. Те же 4 вопроса что и в бесплатном пакете
3. После языка → пишется `.demo.trigger` (не `.trigger`)
4. index.js генерирует текст + вызывает `prepare_demo_prompts` + `generate_visual_sample`
5. Менеджер проверяет в Bot3 (те же Переделать/Изм.текст кнопки)
6. В конце кнопка `send_demo_{chatId}` → доставка клиенту

## Аналитика Metricool — `analytics_yes` (июнь 2026)

При нажатии кнопки "✅ Да, подключить аналитику":
1. Создаётся бренд в Metricool (`createClientBrand`) → **только тут**, не при оплате
2. Генерируется анонимная ссылка: `POST /api/v2/settings/brands/connections/anonymous-link?userId=X&blogId=Y`
3. Клиент получает кнопку "📲 Подключить Instagram" с ссылкой `f.mtr.cool/XXXXX`
4. Клиент подключает Instagram **без регистрации в Metricool** — только логин через Instagram

**Важно:** бренд создаётся только по согласию клиента. При оплате ничего не создаётся.

## Платный флоу — 12 вопросов (июнь 2026, исправлен баг)

Все 12 вопросов теперь реально задаются клиенту и сохраняются в `session.paidAnswers`.

| Шаг | Ключ | Вопрос |
|-----|------|--------|
| PAID_Q1 | `ideal_client` | Кто ваш идеальный клиент? |
| PAID_Q2 | `pain_utp` | Главная боль и УТП |
| PAID_Q3 | `competitors` | Конкуренты (название + ссылка) |
| PAID_Q4 | `customer_journey` | Путь клиента к покупке |
| PAID_Q5 | `objections` | Типичные возражения |
| PAID_Q6 | `content_history` | Что пробовали в контенте |
| PAID_Q7 | `price_range` | Ценовой диапазон услуг |
| PAID_Q8 | `decision_maker` | Кто принимает решение о покупке |
| PAID_Q9 | `content_goal_monthly` | Цель контента в этом месяце (кнопки) |
| PAID_Q10 | `monthly_focus` | Что планируется в бизнесе в этом месяце |
| PAID_Q11 | `brand_voice` | Голос и тон бренда |
| PAID_Q12 | `client_stories` | Истории клиентов и результаты |

Q9 имеет кнопки (`paid_cgoal_new` / `paid_cgoal_warm`) + текстовый фолбэк.
`writePaidTrigger` вызывается после Q12 (не после Q6 как раньше).

**Как ответы используются в генерации:**
- Все 12 ответов идут в `buildReturningProfiles` → `session.businessProfile` + `session.audience`
- Q7-Q12 дополнительно сохраняются как отдельные поля сессии: `brandVoice`, `monthlyGoal`, `monthlyFocus`, `clientStories`, `priceRange`, `decisionMaker`
- block7 явно включает эти поля в промпты для видео, сценариев и каруселей

## Лимит бесплатного пакета — 1 на chatId

Перед `writeTrigger` в `FREE_Q2` проверяется `session.freePackageDelivered` и наличие `pending/{chatId}.json`. Повторная попытка → сообщение "уже получили" + предложение платного пакета.

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
