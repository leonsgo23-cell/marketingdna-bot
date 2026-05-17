const { ask, HAIKU } = require('./claude');

// Нормализует язык из любого формата в 'ru' | 'lv' | 'en'
function normalizeLang(raw) {
  if (!raw) return 'ru';
  const s = String(raw).toLowerCase();
  if (s === 'ru' || s.includes('рус')) return 'ru';
  if (s === 'lv' || s.includes('латыш') || s.includes('latvi') || s.includes('latvie')) return 'lv';
  if (s === 'en' || s.includes('англ') || s.includes('english')) return 'en';
  return 'ru';
}

// Возвращает инструкцию языка для промпта
function getLangInstruction(contentLanguage) {
  const lang = normalizeLang(contentLanguage);
  if (lang === 'lv') return 'Raksti latviešu valodā. (Пиши на латышском языке)';
  if (lang === 'en') return 'Write in English. (Пиши на английском языке)';
  return 'Пиши на русском языке.';
}

// Нужен ли перевод для администратора (язык не RU)
function isNonRussian(contentLanguage) {
  return normalizeLang(contentLanguage) !== 'ru';
}

// Переводит текст на русский (через Haiku — дёшево и быстро)
async function translateToRussian(text, sourceLang) {
  const langName = normalizeLang(sourceLang) === 'lv' ? 'латышского' : 'английского';
  const result = await ask(
    `Переведи текст с ${langName} на русский язык. Сохрани структуру, заголовки и смысл. Только перевод — без пояснений и комментариев.\n\n${text.slice(0, 6000)}`,
    { model: HAIKU, maxTokens: 2500 }
  );
  return result;
}

// Форматирует блок для администратора: оригинал + перевод если нужно
async function adminBlock(label, content, contentLanguage) {
  const lang = normalizeLang(contentLanguage);
  const langLabel = lang === 'lv' ? '🇱🇻 LV' : lang === 'en' ? '🇬🇧 EN' : '🇷🇺 RU';

  if (!isNonRussian(contentLanguage)) {
    return `${label}\n\n${content}`;
  }

  let translation = '';
  try {
    translation = await translateToRussian(content, lang);
  } catch (e) {
    translation = `[Ошибка перевода: ${e.message}]`;
  }

  return `${label} ${langLabel}\n\n${content}\n\n🔵 ПЕРЕВОД ДЛЯ ПРОВЕРКИ (RU):\n${translation}`;
}

module.exports = { normalizeLang, getLangInstruction, isNonRussian, translateToRussian, adminBlock };
