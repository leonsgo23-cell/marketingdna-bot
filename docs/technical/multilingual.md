# Мультиязычность

> Актуально: июнь 2026. Поддерживаются RU и LV. EN — подготовлена структура.

## Три разных понятия "язык" — не путать

| Понятие | Поле | Что это |
|---------|------|---------|
| Язык интерфейса бота | `session.interfaceLang` | Язык сообщений Bot2 клиенту (RU/LV) |
| Язык аналитики | `session.docsLanguage` | Язык документов которые читает клиент |
| Язык контента | `session.contentLanguage` | Язык публикуемого контента в соцсетях |

**Правило менеджера**: Bot3 всегда на русском — независимо от языка клиента.

---

## 1. Язык интерфейса Bot2 → `src/i18n.js`

**Как определяется:** из `?start=` параметра ссылки с сайта:
- Латышская версия сайта: `?start=lv_hero` → `interfaceLang = 'lv'`
- Русская версия сайта: `?start=hero` → `interfaceLang = 'ru'`

**Файл переводов:** `src/i18n.js`
- `T(key, lang)` — строка на нужном языке
- `langFromStartPayload(payload)` — определяет язык из ?start=
- `QUESTIONS_PART1_LV` / `QUESTIONS_PART2_LV` — 12 вопросов бесплатной анкеты на LV
- `PAID_ONBOARDING_QUESTIONS_LV` — 12 вопросов платного онбординга на LV (добавлено 17.06.2026)

**Покрытие LV (17.06.2026):**

| Точка взаимодействия | Статус |
|---------------------|--------|
| Бесплатная анкета (4 вопроса) | ✅ LV |
| Платный онбординг Q1-Q12 | ✅ LV (`PAID_ONBOARDING_QUESTIONS_LV`) |
| 3 вводных вопроса прямой покупки (city/site/lang) | ✅ LV (bot2.js, PAID_PRE_CITY/SITE/LANG) |
| Сообщение "пакет готов" при доставке | ✅ LV (index.js, deliverVisualPackage + deliverClientPackage) |
| Напоминания дней 1, 3, 7, 12 | ✅ LV (index.js, checkAnalyticsCycle, isLv_* флаги) |
| HTML-страница пакета | ✅ LV (site_builder.js, HTML_UI словарь) |
| Менеджер Bot3 | ✅ Всегда RU |

---

## 2. HTML-страница пакета → `src/site_builder.js`

**`HTML_UI` словарь** (добавлено 17.06.2026) — объект с ключами `ru` и `lv`, содержит все UI-тексты шаблона.

```js
const HTML_UI = { ru: { ui_page_title: 'Ваш контент-пакет...', ... }, lv: { ui_page_title: 'Jūsu satura pakete...', ... } }
```

**`buildFreePackJson(data, generated)`** — читает `data.contentLanguage`, выбирает нужный `HTML_UI[lang]`, передаёт в шаблон через `...ui` spread.

**`free-pack-template.html`** — все UI-тексты заменены на `{{ui_*}}` переменные (17.06.2026).

**Добавить EN:** добавить `en: { ... }` блок в `HTML_UI` с теми же ключами.

---

## 3. Платный онбординг — выбор вопросов по языку

```js
// index.js, startPaidOnboarding()
const lang      = existing.interfaceLang || 'ru';
const questions = lang === 'lv' ? PAID_ONBOARDING_QUESTIONS_LV : PAID_ONBOARDING_QUESTIONS;
updateClientSession(clientChatId, { paidQuestions: questions });
```

Вопросы из `paidQuestions` используются в bot2.js через `session.paidQuestions[idx]`.

---

## 4. Напоминания checkAnalyticsCycle — язык из сессии

```js
// index.js, checkAnalyticsCycle()
const isLv_nudge = (session.interfaceLang || 'ru') === 'lv';
// все sendMessage вызовы проверяют isLv_* перед отправкой
```

---

## 5. Язык аналитики и контента (выбирается в анкете)

```
FREE_Q3_LANG → session.contentLanguage (бесплатный флоу)
PAID_PRE_LANG → session.contentLanguage (платный без бесплатного)
```

Инструкции для промптов: `src/lang.js` → `getLangInstruction(lang)`

---

## 6. Доп. язык (платная опция)

```
Клиент оплачивает доп. язык → Stripe → {id}.addlang_{lang}.trigger
→ runTranslationJob(clientChatId, targetLang, session) в index.js (~1861)
```

| Тип контента | Что происходит |
|-------------|---------------|
| SEO-статьи | Генерируются ЗАНОВО через Claude |
| Всё остальное | Перевод через Claude Haiku |
| Видео субтитры | Переводятся → ffmpeg пересобирает видео |

---

## 7. Добавление нового языка (EN и другие)

1. `src/i18n.js` — добавить `en: { ... }` в `translations` с теми же ключами что у `ru`
2. `src/i18n.js` — добавить `PAID_ONBOARDING_QUESTIONS_EN` массив (12 вопросов)
3. `src/site_builder.js` — добавить `en: { ... }` в `HTML_UI`
4. Сайт — создать EN версию с `?start=en_hero` параметром
5. `index.js startPaidOnboarding` — добавить `lang === 'en' ? PAID_ONBOARDING_QUESTIONS_EN : ...`
6. `index.js checkAnalyticsCycle` — добавить `isEn_*` флаги по аналогии с `isLv_*`

---

## 8. Поддержка LV символов в визуале

Шрифт Inter-Bold.ttf поддерживает: ā ē ī ū č ģ ķ ļ ņ š ž
`text-to-svg` корректно обрабатывает латышские символы.
