const fs   = require('fs');
const path = require('path');
const os   = require('os');

const FREE_TEMPLATE = path.join(__dirname, '..', 'assets', 'free-pack-template.html');
const PACK_PAGES_DIR = path.join(os.tmpdir(), 'pack_pages');

const COLOR_PRESETS = {
  purple: { accent: '#7C3AED', dark: '#5B21B6', light: '#EDE9FE' },
  blue:   { accent: '#2563EB', dark: '#1D4ED8', light: '#DBEAFE' },
  pink:   { accent: '#DB2777', dark: '#BE185D', light: '#FCE7F3' },
  green:  { accent: '#059669', dark: '#047857', light: '#D1FAE5' },
  coral:  { accent: '#E85D4A', dark: '#C0392B', light: '#FEE2E2' },
  gold:   { accent: '#D97706', dark: '#B45309', light: '#FEF3C7' },
  teal:   { accent: '#0891B2', dark: '#0E7490', light: '#CFFAFE' },
  dark:   { accent: '#1F2937', dark: '#111827', light: '#F3F4F6' },
};

function buildHtml(templateFile, data) {
  let template = fs.readFileSync(templateFile, 'utf8');

  const colorName = (data.color || 'purple').toLowerCase();
  const colors    = COLOR_PRESETS[colorName] || COLOR_PRESETS.purple;
  data.color_accent       = colors.accent;
  data.color_accent_dark  = colors.dark;
  data.color_accent_light = colors.light;

  template = template.replace(/\{\{(\w+)\}\}/g, (match, key) =>
    data[key] !== undefined ? data[key] : match
  );

  const processIf = (tpl) => tpl.replace(
    /\{\{#if (\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
    (match, key, content) => (data[key] && data[key] !== '') ? content : ''
  );
  template = processIf(processIf(template));

  return template;
}

// Собирает HTML и сохраняет в /tmp/pack_pages/{clientId}.html.
// Возвращает { url } или бросает ошибку.
async function buildAndDeploy(jsonData, _templateName, distSuffix) {
  if (!fs.existsSync(PACK_PAGES_DIR)) fs.mkdirSync(PACK_PAGES_DIR, { recursive: true });

  const html = buildHtml(FREE_TEMPLATE, { ...jsonData });

  const clientId = distSuffix.replace(/^free-/, '');
  const htmlFile = path.join(PACK_PAGES_DIR, `${clientId}.html`);
  fs.writeFileSync(htmlFile, html, 'utf8');

  const baseUrl = (process.env.VISUAL_BASE_URL || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('VISUAL_BASE_URL не задан в Railway Variables');

  const url = `${baseUrl}/pack/${clientId}`;
  return { url };
}

// Собирает JSON для бесплатного пакета из данных бота
function buildFreePackJson(data, generated) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

  return {
    client_name: data.name || 'Клиент',
    date: dateStr,
    is_personal_brand: generated.isPersonalBrand ? 'true' : '',
    is_business: generated.isPersonalBrand ? '' : 'true',
    stripe_a: process.env.STRIPE_PKG_A || '#',
    stripe_v: process.env.STRIPE_PKG_V || '#',
    admin_telegram: process.env.ADMIN_TELEGRAM || 'marketingdna_support',
    year: String(now.getFullYear()),
    content_plan: generated.contentPlan || '',
    seo_article: generated.seoArticle || '',
    video_script: generated.videoScript || '',
    carousel_script: generated.carouselScript || '',
    cover_example: generated.coverExample || '',
    photo_post_text: generated.photoExample || ''
  };
}

// Собирает JSON для платного пакета из данных бота
function buildPaidPackJson(session, tariff) {
  const now = new Date();
  const isProfi    = tariff === 'profi' || tariff === 'pkg_v';
  const isStandard = tariff === 'pkg_standard';
  const hasVideo   = isProfi || isStandard;

  const tariffName  = isProfi ? 'Тариф Профи' : isStandard ? 'Тариф Стандарт' : 'Тариф Старт';
  const tariffPrice = isProfi ? '350' : isStandard ? '250' : '150';

  return {
    client_name: session.clientData?.name || 'Клиент',
    tariff_name: tariffName,
    tariff_price: tariffPrice,
    has_ai_video: hasVideo ? 'true' : '',
    content_goal: session.contentGoal || 'привлечение новых клиентов',
    admin_telegram: process.env.ADMIN_TELEGRAM || 'marketingdna_support',
    year: String(now.getFullYear()),
    content_plan: session.calendar?.plan || session.calendar?.planA || '',
    seo_title_1: session.articles?.[0]?.title || '',
    seo_preview_1: session.articles?.[0]?.preview || '',
    seo_title_2: session.articles?.[1]?.title || '',
    seo_preview_2: session.articles?.[1]?.preview || '',
    seo_title_3: session.articles?.[2]?.title || '',
    seo_preview_3: session.articles?.[2]?.preview || '',
    seo_title_4: session.articles?.[3]?.title || '',
    seo_preview_4: session.articles?.[3]?.preview || '',
    seo_title_5: session.articles?.[4]?.title || '',
    seo_preview_5: session.articles?.[4]?.preview || '',
    competitors_analysis: session.competitorsSummary || '',
    rec_1: session.recs?.[0] || '',
    rec_2: session.recs?.[1] || '',
    rec_3: session.recs?.[2] || '',
    rec_avoid: session.recs?.[3] || '',
    ai_video_tips: hasVideo ? (session.videoTips || '') : ''
  };
}

module.exports = { buildAndDeploy, buildFreePackJson, buildPaidPackJson, PACK_PAGES_DIR };
