const fs   = require('fs');
const path = require('path');
const os   = require('os');

const FREE_TEMPLATE = path.join(__dirname, '..', 'assets', 'free-pack-template.html');
const PAID_TEMPLATE = path.join(__dirname, '..', 'assets', 'paid-pack-template.html');
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
async function buildAndDeploy(jsonData, templateName, distSuffix) {
  if (!fs.existsSync(PACK_PAGES_DIR)) fs.mkdirSync(PACK_PAGES_DIR, { recursive: true });

  const templateFile = templateName === 'paid-pack-template.html' ? PAID_TEMPLATE : FREE_TEMPLATE;
  const html = buildHtml(templateFile, { ...jsonData });

  const clientId = distSuffix.replace(/^free-/, '');
  const htmlFile = path.join(PACK_PAGES_DIR, `${clientId}.html`);
  fs.writeFileSync(htmlFile, html, 'utf8');

  let baseUrl = (process.env.VISUAL_BASE_URL || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('VISUAL_BASE_URL не задан в Railway Variables');
  if (!baseUrl.startsWith('http')) baseUrl = `https://${baseUrl}`;

  const url = `${baseUrl}/pack/${clientId}`;
  return { url };
}

function extractPhotoCaption(text) {
  if (!text) return '';
  // Extract: caption + hashtags + "почему это зайдёт" — skip title and English prompt
  const capM = text.match(/Подпись к посту:\s*\n([\s\S]*?)(?=\n\nХэштеги:|\n\nПочему|\n\nКак разместить:|$)/i);
  if (!capM) return text;
  let result = capM[1].trim();
  const tagM = text.match(/Хэштеги:\s*\n?([\s\S]*?)(?=\n\nПочему|\n\nКак разместить:|$)/i);
  if (tagM) result += '\n\n' + tagM[1].trim();
  const whyM = text.match(/Почему это зайдёт аудитории:\s*\n([\s\S]*?)(?=\n\nКак разместить:|$)/i);
  if (whyM) result += '\n\n— Почему это зайдёт:\n' + whyM[1].trim();
  return result;
}

// Собирает JSON для бесплатного пакета из данных бота
function buildFreePackJson(data, generated) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });

  // Добавляем client_reference_id к каждой Stripe-ссылке — чтобы webhook знал кто заплатил
  const chatId = data.chatId || '';
  const s = (base, pkgKey) =>
    chatId ? `${base}?client_reference_id=${chatId}--${pkgKey}` : base;

  return {
    client_name: data.name || 'Клиент',
    date: dateStr,
    is_personal_brand: generated.isPersonalBrand ? 'true' : '',
    is_business: generated.isPersonalBrand ? '' : 'true',
    stripe_a:                 s('https://buy.stripe.com/9B6aERa3P1cEdJQ9NP5Rm0a',         'pkg_a'),
    stripe_a_discount:        s('https://buy.stripe.com/4gMbIVcbXcVm5dke455Rm0g',         'pkg_a_discount'),
    stripe_standard:          s('https://buy.stripe.com/00waER0tf4oQeNU4tv5Rm0n',         'pkg_standard'),
    stripe_standard_discount: s('https://buy.stripe.com/9B67sFa3P3kM35c7FH5Rm0o',         'pkg_standard_discount'),
    stripe_v:                 s('https://buy.stripe.com/00waER4Jv2gI5dk2ln5Rm0k',         'pkg_v'),
    stripe_v_discount:        s('https://buy.stripe.com/cNi14h7VH6wYdJQ4tv5Rm0l',         'pkg_v_discount'),
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
    photo_post_text: extractPhotoCaption(generated.photoExample || '')
  };
}

// Собирает JSON для платного пакета (waveNum: 1 или 2)
function buildPaidPackJson(session, tariff, waveNum = 1) {
  const now = new Date();
  const dateStr = now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  const isProfi    = tariff === 'profi' || tariff === 'pkg_v';
  const isStandard = tariff === 'pkg_standard';
  const tariffName = isProfi ? 'Тариф Профи' : isStandard ? 'Тариф Стандарт' : 'Тариф Старт';

  // Статьи: Wave1 → первые 2, Wave2 → третья
  const allArticles = session.articles || [];
  const mid = Math.ceil(allArticles.length / 2);
  const waveArticles = waveNum === 2 ? allArticles.slice(mid) : allArticles.slice(0, mid);

  // Контент-план: Wave1 → planA (дни 1-15), Wave2 → planB (дни 16-30)
  const contentPlan = waveNum === 2
    ? (session.calendar?.planB || '')
    : (session.calendar?.planA || session.calendar?.plan || '');

  // Конкуренты и рекомендации — только в Wave1
  const competitorsSummary = waveNum === 1 ? (session.competitorsSummary || '') : '';
  const recDo    = waveNum === 1 ? ((session.recs || []).slice(0, 3).join('\n') || '') : '';
  const recAvoid = waveNum === 1 ? ((session.recs || [])[3] || '') : '';

  const waveLabel = waveNum === 2
    ? 'Часть 2 — следующие 15 дней'
    : 'Часть 1 — первые 15 дней';

  return {
    client_name:          session.clientData?.name || session.name || 'Клиент',
    date:                 dateStr,
    tariff_name:          tariffName,
    wave_label:           waveLabel,
    wave_num:             String(waveNum),
    content_plan:         contentPlan,
    article_1:            waveArticles[0] || '',
    article_2:            waveArticles[1] || '',
    competitors_analysis: competitorsSummary,
    rec_do:               recDo,
    rec_avoid:            recAvoid,
    admin_telegram:       process.env.ADMIN_TELEGRAM || 'marketingdna_support',
    // Флаги для инструкции публикации — управляют видимостью секций
    has_videos:  (isProfi || isStandard) ? '1' : '',
    has_covers:  (isProfi || isStandard) ? '1' : '',
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

  const baseUrl = (process.env.VISUAL_BASE_URL || '').replace(/\/$/, '');

  // Конвертируем локальные пути в публичные URL /images/{filename}
  const toPublicUrl = (urlOrPath) => {
    if (!urlOrPath) return null;
    if (urlOrPath.startsWith('/') || urlOrPath.startsWith('C:\\')) {
      const filename = path.basename(urlOrPath);
      return baseUrl ? `${baseUrl}/images/${filename}` : null;
    }
    return urlOrPath; // уже URL
  };

  const readySlides = carouselUrls.map(toPublicUrl).filter(Boolean);
  const count = readySlides.length;

  const imgs = readySlides.map((url, i) =>
    `<div style="position:relative"><img src="${url}" style="width:100%;aspect-ratio:1;object-fit:cover;border-radius:10px;display:block" alt="Слайд ${i + 1}"><div style="position:absolute;bottom:6px;left:8px;background:rgba(0,0,0,.55);color:#fff;font-size:11px;font-weight:700;padding:2px 7px;border-radius:6px">${i + 1}</div></div>`
  ).join('\n      ');
  const block = `<div style="display:grid;grid-template-columns:repeat(5,1fr);gap:8px;margin-bottom:16px">\n      ${imgs}\n    </div>`;
  html = html.replace(
    /<!-- CAROUSEL_SLOT_START -->[\s\S]*?<!-- CAROUSEL_SLOT_END -->/,
    `<!-- CAROUSEL_SLOT_START -->\n    ${block}\n    <!-- CAROUSEL_SLOT_END -->`
  );

  // Обновляем счётчик слайдов в инструкции публикации
  html = html
    .replace(/все 7 слайдов по порядку — с 1 по 7/g, `все ${count} слайдов по порядку — с 1 по ${count}`)
    .replace(/📎 7 файлов слайдов отправлены отдельно/g, `📎 ${count} файлов слайдов отправлены отдельно`)
    .replace(/все 5 слайдов по порядку — с 1 по 5/g, `все ${count} слайдов по порядку — с 1 по ${count}`)
    .replace(/📎 5 файлов слайдов отправлены отдельно/g, `📎 ${count} файлов слайдов отправлены отдельно`);

  fs.writeFileSync(htmlFile, html, 'utf8');
  console.log(`[site_builder] ${count} слайдов карусели встроены для ${clientId}`);
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
