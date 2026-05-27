const fs   = require('fs');
const path = require('path');
const os   = require('os');

const FREE_TEMPLATE = path.join(__dirname, '..', 'assets', 'free-pack-template.html');
// Используем ту же персистентную папку что и для сессий (Railway volume)
const PACK_PAGES_DIR = path.join(os.homedir(), '.marketingdna-client-sessions', 'pack_pages');

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
    stripe_a:                 'https://buy.stripe.com/9B6aERa3P1cEdJQ9NP5Rm0a',
    stripe_a_discount:        'https://buy.stripe.com/4gMbIVcbXcVm5dke455Rm0g',
    stripe_standard:          'https://buy.stripe.com/00waER0tf4oQeNU4tv5Rm0n',
    stripe_standard_discount: 'https://buy.stripe.com/9B67sFa3P3kM35c7FH5Rm0o',
    stripe_v:                 'https://buy.stripe.com/00waER4Jv2gI5dk2ln5Rm0k',
    stripe_v_discount:        'https://buy.stripe.com/cNi14h7VH6wYdJQ4tv5Rm0l',
    stripe_a_lang:            'https://buy.stripe.com/fZu4gt5Nz7B2cFM2ln5Rm0e',
    stripe_standard_lang:     'https://buy.stripe.com/8x2fZb4Jv5sUbBI8JL5Rm0p',
    stripe_v_lang:            'https://buy.stripe.com/5kQ14hek58F69tA6BD5Rm0m',
    admin_telegram: process.env.ADMIN_TELEGRAM || 'marketingdna_support',
    generated_at: String(now.getTime()),
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

// Встраивает обложку в HTML-страницу клиента
function updatePackPageCover(clientId, coverUrl) {
  const htmlFile = path.join(PACK_PAGES_DIR, `${clientId}.html`);
  if (!fs.existsSync(htmlFile)) return;
  let html = fs.readFileSync(htmlFile, 'utf8');
  const block = `<div style="margin-bottom:12px;border-radius:12px;overflow:hidden"><img src="${coverUrl}" style="width:100%;display:block;max-height:420px;object-fit:cover;border-radius:12px" alt="Обложка для ролика"></div>`;
  html = html.replace(
    /<!-- COVER_SLOT_START -->[\s\S]*?<!-- COVER_SLOT_END -->/,
    `<!-- COVER_SLOT_START -->\n    ${block}\n    <!-- COVER_SLOT_END -->`
  );
  fs.writeFileSync(htmlFile, html, 'utf8');
  console.log(`[site_builder] обложка встроена в страницу для ${clientId}`);
}

// Встраивает слайды карусели в HTML-страницу клиента
function updatePackPageCarousel(clientId, carouselUrls) {
  const htmlFile = path.join(PACK_PAGES_DIR, `${clientId}.html`);
  if (!fs.existsSync(htmlFile)) return;
  let html = fs.readFileSync(htmlFile, 'utf8');
  const imgs = carouselUrls.filter(Boolean).map((url, i) =>
    `<div style="position:relative"><img src="${url}" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px;display:block" alt="Слайд ${i + 1}"><div style="position:absolute;bottom:6px;left:8px;background:rgba(0,0,0,.55);color:#fff;font-size:11px;font-weight:700;padding:2px 7px;border-radius:6px">${i + 1}</div></div>`
  ).join('\n      ');
  const block = `<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:16px">\n      ${imgs}\n    </div>`;
  html = html.replace(
    /<!-- CAROUSEL_SLOT_START -->[\s\S]*?<!-- CAROUSEL_SLOT_END -->/,
    `<!-- CAROUSEL_SLOT_START -->\n    ${block}\n    <!-- CAROUSEL_SLOT_END -->`
  );
  fs.writeFileSync(htmlFile, html, 'utf8');
  console.log(`[site_builder] ${carouselUrls.filter(Boolean).length} слайдов карусели встроены для ${clientId}`);
}

// Встраивает готовое AI-фото прямо в HTML-страницу клиента
function updatePackPagePhoto(clientId, photoUrl) {
  const htmlFile = path.join(PACK_PAGES_DIR, `${clientId}.html`);
  if (!fs.existsSync(htmlFile)) {
    console.log(`[site_builder] updatePackPagePhoto: файл не найден для ${clientId}`);
    return;
  }
  let html = fs.readFileSync(htmlFile, 'utf8');
  const imgBlock = `<div class="post-card-image"><img src="${photoUrl}" style="width:100%;border-radius:12px;display:block;" alt="Готовый пост — AI-изображение"></div>`;
  html = html.replace(
    /<!-- PHOTO_SLOT_START -->[\s\S]*?<!-- PHOTO_SLOT_END -->/,
    `<!-- PHOTO_SLOT_START -->\n      ${imgBlock}\n      <!-- PHOTO_SLOT_END -->`
  );
  fs.writeFileSync(htmlFile, html, 'utf8');
  console.log(`[site_builder] AI-фото встроено в страницу для ${clientId}`);
}

module.exports = { buildAndDeploy, buildFreePackJson, buildPaidPackJson, PACK_PAGES_DIR, updatePackPagePhoto, updatePackPageCover, updatePackPageCarousel };
