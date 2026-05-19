const fs = require('fs');
const path = require('path');

const CRM_DIR = path.join(process.env.HOME || '/tmp', '.marketingdna-crm');
if (!fs.existsSync(CRM_DIR)) fs.mkdirSync(CRM_DIR, { recursive: true });

function crmLog(chatId, event, data = {}) {
  const file = path.join(CRM_DIR, `${chatId}.json`);
  let record = { chatId, events: [] };
  if (fs.existsSync(file)) {
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  }
  // Обновляем верхнеуровневые поля клиента если переданы
  const { name, whatsapp, email, business, isPersonalBrand, ...rest } = data;
  if (name) record.name = name;
  if (whatsapp) record.whatsapp = whatsapp;
  if (email) record.email = email;
  if (business) record.business = business;
  if (isPersonalBrand !== undefined) record.isPersonalBrand = isPersonalBrand;

  record.events.push({ ts: new Date().toISOString(), event, ...rest });
  record.lastEvent = event;
  record.lastEventTs = new Date().toISOString();

  fs.writeFileSync(file, JSON.stringify(record, null, 2));
}

function crmGet(chatId) {
  const file = path.join(CRM_DIR, `${chatId}.json`);
  if (!fs.existsSync(file)) return null;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function crmList() {
  if (!fs.existsSync(CRM_DIR)) return [];
  return fs.readdirSync(CRM_DIR)
    .filter(f => f.endsWith('.json'))
    .map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(CRM_DIR, f), 'utf8')); } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => (b.lastEventTs || '').localeCompare(a.lastEventTs || ''));
}

const EVENT_LABELS = {
  free_delivered:      '📦 Бесплатный пакет отправлен',
  offer_shown:         '💬 Оффер показан',
  pkg_selected:        '🛒 Пакет выбран',
  payment_initiated:   '💳 Ссылка на оплату отправлена',
  code_used:           '🎟 Код доступа активирован',
  paid_delivered:      '🎉 Платный пакет отправлен',
  question_asked:      '❓ Написал вопрос',
  no_response:         '😶 Нет реакции',
  followup_scheduled:  '🕐 Запланирован follow-up',
};

function formatClient(record) {
  const name = record.name || 'Без имени';
  const pkg = record.isPersonalBrand ? 'личный бренд' : 'продукт/видео';
  const lastLabel = EVENT_LABELS[record.lastEvent] || record.lastEvent || '—';
  const lastTs = record.lastEventTs ? new Date(record.lastEventTs).toLocaleString('ru-RU') : '—';
  return `👤 ${name} | ${pkg}\n📱 ${record.whatsapp || '—'} | ${record.email || '—'}\nПоследнее: ${lastLabel}\n🕐 ${lastTs}\nChatId: ${record.chatId}`;
}

function formatClientFull(record) {
  if (!record) return 'Клиент не найден.';
  const lines = [
    `👤 ${record.name || '—'} | ChatId: ${record.chatId}`,
    `📱 WhatsApp: ${record.whatsapp || '—'}`,
    `✉️ Email: ${record.email || '—'}`,
    `🏢 Бизнес: ${record.business || '—'}`,
    `📂 Тип: ${record.isPersonalBrand ? 'Личный бренд' : 'Продукт/пространство/видео'}`,
    ``,
    `📋 История событий:`,
  ];
  (record.events || []).forEach(e => {
    const label = EVENT_LABELS[e.event] || e.event;
    const ts = new Date(e.ts).toLocaleString('ru-RU');
    const extra = e.package ? ` (${e.package})` : e.code ? ` (${e.code})` : e.text ? ` — "${e.text.slice(0, 40)}"` : '';
    lines.push(`  ${ts}  ${label}${extra}`);
  });
  return lines.join('\n');
}

module.exports = { crmLog, crmGet, crmList, formatClient, formatClientFull };
