// Центральный реестр языков.
// Чтобы добавить новый язык — добавь одну строку сюда.
// Всё остальное (кнопки выбора, upsell, addlang, триггеры) подтянется автоматически.
//
// Формат: { label: 'как говорить "на ... языке"', name: 'Название языка', flag: 'эмодзи флага' }

const LANGUAGES = {
  ru: { label: 'русском',    name: 'Русский',    flag: '🇷🇺' },
  lv: { label: 'латышском',  name: 'Латышский',  flag: '🇱🇻' },
  en: { label: 'английском', name: 'Английский', flag: '🇬🇧' },
  // de: { label: 'немецком',   name: 'Немецкий',   flag: '🇩🇪' },
  // fr: { label: 'французском',name: 'Французский',flag: '🇫🇷' },
  // lt: { label: 'литовском',  name: 'Литовский',  flag: '🇱🇹' },
};

// Коды всех активных языков
const ALL_LANG_CODES = Object.keys(LANGUAGES);

// { ru: 'русском 🇷🇺', lv: 'латышском 🇱🇻', ... }
const LANG_LABELS = Object.fromEntries(
  Object.entries(LANGUAGES).map(([code, l]) => [code, `${l.label} ${l.flag}`])
);

// { ru: 'Русский 🇷🇺', lv: 'Латышский 🇱🇻', ... }
const LANG_NAMES = Object.fromEntries(
  Object.entries(LANGUAGES).map(([code, l]) => [code, `${l.name} ${l.flag}`])
);

// Кнопки для выбора языка (исключая указанные коды)
function langButtons(prefix, excludeCodes = []) {
  return ALL_LANG_CODES
    .filter(code => !excludeCodes.includes(code))
    .map(code => [{ text: `${LANGUAGES[code].flag} ${LANGUAGES[code].name}`, callback_data: `${prefix}${code}` }]);
}

module.exports = { LANGUAGES, ALL_LANG_CODES, LANG_LABELS, LANG_NAMES, langButtons };
