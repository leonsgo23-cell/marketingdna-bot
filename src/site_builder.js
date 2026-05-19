const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

const TEMPLATES_DIR = path.join(os.homedir(), 'client-site-template');
const BUILD_SCRIPT = path.join(TEMPLATES_DIR, 'build.js');

// Генерирует HTML из данных и деплоит на Netlify.
// Возвращает { url, distDir } или бросает ошибку.
async function buildAndDeploy(jsonData, templateName, distSuffix) {
  // Уникальная папка для каждого клиента
  const distDir = path.join(TEMPLATES_DIR, `dist-${distSuffix}`);
  const jsonFile = path.join(TEMPLATES_DIR, `_tmp-${distSuffix}.json`);
  const templateFile = path.join(TEMPLATES_DIR, templateName);

  try {
    // Записываем JSON во временный файл
    fs.writeFileSync(jsonFile, JSON.stringify(jsonData, null, 2), 'utf8');

    // Запускаем build.js
    execSync(`node "${BUILD_SCRIPT}" "${jsonFile}" "${templateFile}" "${distDir}"`, {
      cwd: TEMPLATES_DIR,
      timeout: 30000
    });

    // Деплоим на Netlify и получаем URL
    const netlifyOutput = execSync(`netlify deploy --dir="${distDir}"`, {
      cwd: TEMPLATES_DIR,
      timeout: 60000
    }).toString();

    // Парсим Draft URL из вывода
    const match = netlifyOutput.match(/Draft URL:\s*<?(https:\/\/[^\s>]+)>?/);
    if (!match) throw new Error('Netlify не вернул URL. Вывод:\n' + netlifyOutput);

    const url = match[1];
    return { url, distDir };
  } finally {
    // Удаляем временный JSON
    if (fs.existsSync(jsonFile)) fs.unlinkSync(jsonFile);
  }
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
  const isProfi = tariff === 'profi' || tariff === 'pkg_v';

  return {
    client_name: session.clientData?.name || 'Клиент',
    tariff_name: isProfi ? 'Тариф Профи' : 'Тариф Старт',
    tariff_price: isProfi ? '250' : '150',
    has_ai_video: isProfi ? 'true' : '',
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
    ai_video_tips: isProfi ? (session.videoTips || '') : ''
  };
}

module.exports = { buildAndDeploy, buildFreePackJson, buildPaidPackJson };
