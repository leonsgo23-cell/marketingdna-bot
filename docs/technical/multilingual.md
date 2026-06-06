# Мультиязычность

## Три разных понятия "язык" — не путать

| Понятие | Поле | Что это |
|---------|------|---------|
| Язык интерфейса бота | `session.interfaceLang` | Язык сообщений Bot2 клиенту (RU/LV) |
| Язык аналитики | `session.docsLanguage` | Язык документов, которые читает клиент (SEO-статьи, кастдев) |
| Язык контента | `session.contentLanguage` | Язык публикуемого контента в соцсетях |

---

## 1. Язык интерфейса Bot2 → `src/i18n.js`

Добавлено июнь 2026. Клиент приходит с сайта, бот говорит на его языке.

**Как определяется:** из `?start=` параметра ссылки с сайта:
- Латышская версия сайта: `?start=lv_hero` → `interfaceLang = 'lv'`
- Русская версия сайта: `?start=hero` → `interfaceLang = 'ru'`

**Файл переводов:** `src/i18n.js`
- Функция `T(key, lang)` — возвращает строку на нужном языке
- Функция `langFromStartPayload(payload)` — определяет язык из ?start= параметра
- `QUESTIONS_PART1_LV` и `QUESTIONS_PART2_LV` — 12 вопросов анкеты на латышском

**В bot2.js:**
```js
const { T, langFromStartPayload, QUESTIONS_PART1_LV, QUESTIONS_PART2_LV } = require('./src/i18n');
function getQPart1(lang) { return lang === 'lv' ? QUESTIONS_PART1_LV : QUESTIONS_PART1; }
function getQPart2(lang) { return lang === 'lv' ? QUESTIONS_PART2_LV : QUESTIONS_PART2; }
```

**Добавить новый язык:** в `src/i18n.js` добавить блок с теми же ключами + перевести QUESTIONS_PART1/PART2.

---

## 2. Язык аналитики и контента (выбирается в анкете)

```
Вопрос 14 → session.docsLanguage  (язык что читает клиент)
Вопрос 15 → session.contentLanguage (язык что публикуется)
```

Конфигурация: `src/languages.js`
Инструкции для промптов: `src/lang.js` → `getLangInstruction(lang)`

---

## 3. Доп. язык (платная опция)

```
Клиент оплачивает доп. язык → Stripe → {id}.addlang_{lang}.trigger
→ runTranslationJob(clientChatId, targetLang, session) в index.js (стр. ~1861)
```

| Тип контента | Что происходит |
|-------------|---------------|
| SEO-статьи | Генерируются ЗАНОВО через Claude (перевод не даёт SEO-оптимизацию) |
| Всё остальное | Перевод через Claude Haiku |
| Видео субтитры | Переводятся → ffmpeg пересобирает видео с новыми субтитрами |

---

## Поддержка LV в наложении текста

Шрифт Inter-Bold.ttf поддерживает латышские символы.
`text-to-svg` корректно обрабатывает ā ē ī ū č ģ ķ ļ ņ š ž.
