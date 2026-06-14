const fs   = require('fs');
const path = require('path');

const { buildHtml, PACK_PAGES_DIR } = require('./site_builder');
const ADMIN_TEMPLATE = path.join(__dirname, '..', 'assets', 'admin-summary-template.html');

async function buildAndDeployAdminSummary(session, clientChatId) {
  if (!fs.existsSync(PACK_PAGES_DIR)) fs.mkdirSync(PACK_PAGES_DIR, { recursive: true });

  const now     = new Date();
  const dateStr = now.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  const tariffMap = { pkg_v: 'Профи', pkg_standard: 'Стандарт', pkg_a: 'Старт' };

  const data = {
    client_name:      session.name || session.clientData?.name || `Клиент #${clientChatId}`,
    date:             dateStr,
    region:           session.regionLabel || '—',
    tariff:           tariffMap[session.paidPackageKey] || '—',
    business_profile: session.businessProfile || '',
    audience:         session.audience || '',
    castdev:          session.castdev || '',
    semantic_core:    session.semanticCore || '',
    competitors:      session.competitors || '',
    articles:         (session.articles || []).join('\n\n────────────────────\n\n'),
    video_scripts:    session.videoScripts || '',
    carousel_scripts: session.carouselScripts || '',
    photo_scripts:    session.photoScripts || '',
    stories_scripts:  session.storiesScripts || '',
    covers:           session.covers || '',
    content_plan:     session.calendar?.planA || '',
  };

  const html    = buildHtml(ADMIN_TEMPLATE, data);
  const fileId  = `admin_${clientChatId}`;
  const htmlFile = path.join(PACK_PAGES_DIR, `${fileId}.html`);
  fs.writeFileSync(htmlFile, html, 'utf8');

  let baseUrl = (process.env.VISUAL_BASE_URL || '').replace(/\/$/, '');
  if (!baseUrl) return null;
  if (!baseUrl.startsWith('http')) baseUrl = `https://${baseUrl}`;

  return `${baseUrl}/pack/${fileId}`;
}

function buildSummaryText(session) {
  const now = new Date().toLocaleDateString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const lines = [];

  lines.push('╔══════════════════════════════════════╗');
  lines.push('║       MARKETING DNA — ОТЧЁТ          ║');
  lines.push('╚══════════════════════════════════════╝');
  lines.push('');
  lines.push(`Дата: ${now}`);
  lines.push(`Регион: ${session.regionLabel || '—'}`);
  lines.push(`Ссылки: ${session.links && session.links.length > 0 ? session.links.join(', ') : 'не указаны'}`);
  lines.push('');

  if (session.block1Answers && session.block1Answers.length > 0) {
    lines.push('══════════════════════════════════════');
    lines.push('ШАГ 1 — РАСПАКОВКА БИЗНЕСА');
    lines.push('══════════════════════════════════════');
    session.block1Answers.forEach((qa, i) => {
      lines.push('');
      lines.push(`Вопрос ${i + 1}: ${qa.question}`);
      lines.push(`Ответ: ${qa.answer}`);
    });
    lines.push('');
  }

  if (session.businessProfile) {
    lines.push('══════════════════════════════════════');
    lines.push('ПРОФИЛЬ БИЗНЕСА');
    lines.push('══════════════════════════════════════');
    lines.push('');
    lines.push(session.businessProfile);
    lines.push('');
  }

  if (session.block2Answers && session.block2Answers.length > 0) {
    lines.push('══════════════════════════════════════');
    lines.push('ШАГ 2 — ЦЕЛЕВАЯ АУДИТОРИЯ');
    lines.push('══════════════════════════════════════');
    session.block2Answers.forEach((qa, i) => {
      lines.push('');
      lines.push(`Вопрос ${i + 1}: ${qa.question}`);
      lines.push(`Ответ: ${qa.answer}`);
    });
    lines.push('');
  }

  if (session.audience) {
    lines.push('══════════════════════════════════════');
    lines.push('ПОРТРЕТЫ АУДИТОРИИ');
    lines.push('══════════════════════════════════════');
    lines.push('');
    lines.push(session.audience);
    lines.push('');
  }

  if (session.competitorNames && session.competitorNames.length > 0) {
    lines.push('══════════════════════════════════════');
    lines.push('ШАГ 3 — АНАЛИЗ КОНКУРЕНТОВ');
    lines.push('══════════════════════════════════════');
    lines.push('');
    lines.push('Указанные конкуренты:');
    session.competitorNames.forEach(c => lines.push(`  • ${c}`));
    lines.push('');
    if (session.competitors) lines.push(session.competitors);
    lines.push('');
  }

  if (session.castdev) {
    lines.push('══════════════════════════════════════');
    lines.push('ШАГ 4 — КАСТДЕВ (мотивы и страхи)');
    lines.push('══════════════════════════════════════');
    lines.push('');
    lines.push(session.castdev);
    lines.push('');
  }

  if (session.semanticCore) {
    lines.push('══════════════════════════════════════');
    lines.push('ШАГ 5 — СЕМАНТИЧЕСКОЕ ЯДРО');
    lines.push('══════════════════════════════════════');
    lines.push('');
    lines.push(session.semanticCore);
    lines.push('');
  }

  if (session.articles && session.articles.length > 0) {
    lines.push('══════════════════════════════════════');
    lines.push('ШАГ 6 — СТАТЬИ ДЛЯ САЙТА');
    lines.push('══════════════════════════════════════');
    session.articles.forEach((article, i) => {
      lines.push('');
      lines.push(`── СТАТЬЯ ${i + 1} ──`);
      lines.push(article);
    });
    lines.push('');
  }

  if (session.videoScripts) {
    lines.push('══════════════════════════════════════');
    lines.push('ШАГ 7 — ВИДЕОСЦЕНАРИИ (8 штук)');
    lines.push('══════════════════════════════════════');
    lines.push('');
    lines.push(session.videoScripts);
    lines.push('');
  }

  if (session.carouselScripts) {
    lines.push('══════════════════════════════════════');
    lines.push('ШАГ 7 — СЦЕНАРИИ КАРУСЕЛЕЙ (5 штук)');
    lines.push('══════════════════════════════════════');
    lines.push('');
    lines.push(session.carouselScripts);
    lines.push('');
  }

  if (session.photoScripts) {
    lines.push('══════════════════════════════════════');
    lines.push('ШАГ 7 — ФОТО-КОНЦЕПЦИИ (5 штук)');
    lines.push('══════════════════════════════════════');
    lines.push('');
    lines.push(session.photoScripts);
    lines.push('');
  }

  if (session.covers) {
    lines.push('══════════════════════════════════════');
    lines.push('ШАГ 8 — ТЗ НА ОБЛОЖКИ');
    lines.push('══════════════════════════════════════');
    lines.push('');
    lines.push(session.covers);
    lines.push('');
  }

  if (session.calendar && session.calendar.planA) {
    lines.push('══════════════════════════════════════');
    lines.push('ШАГ 9 — КОНТЕНТ-ПЛАН А (привлечение и прогрев)');
    lines.push('══════════════════════════════════════');
    lines.push('');
    lines.push(session.calendar.planA);
    lines.push('');
  }

  if (session.calendar && session.calendar.planB) {
    lines.push('══════════════════════════════════════');
    lines.push('ШАГ 9 — КОНТЕНТ-ПЛАН Б (активация и продажи)');
    lines.push('══════════════════════════════════════');
    lines.push('');
    lines.push(session.calendar.planB);
    lines.push('');
  }

  lines.push('══════════════════════════════════════');
  lines.push('Документ сформирован Marketing DNA Bot');
  lines.push('══════════════════════════════════════');

  return lines.join('\n');
}

// Версия отчёта для клиента — без внутренней базы знаний
function buildClientSummaryText(session) {
  const now = new Date().toLocaleDateString('ru-RU', {
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });

  const lines = [];

  lines.push('╔══════════════════════════════════════╗');
  lines.push('║    MARKETING DNA — ВАШ КОНТЕНТ-КИТ   ║');
  lines.push('╚══════════════════════════════════════╝');
  lines.push('');
  lines.push(`Дата: ${now}`);
  lines.push(`Регион: ${session.regionLabel || '—'}`);
  lines.push('');

  if (session.competitorBrief) {
    lines.push('══════════════════════════════════════');
    lines.push('АНАЛИЗ КОНКУРЕНТОВ — ВАШИ ВОЗМОЖНОСТИ');
    lines.push('══════════════════════════════════════');
    lines.push('');
    lines.push(session.competitorBrief);
    lines.push('');
  }

  if (session.articles && session.articles.length > 0) {
    lines.push('══════════════════════════════════════');
    lines.push('SEO-СТАТЬИ ДЛЯ САЙТА');
    lines.push('══════════════════════════════════════');
    session.articles.forEach((article, i) => {
      lines.push('');
      lines.push(`── СТАТЬЯ ${i + 1} ──`);
      lines.push(article);
    });
    lines.push('');
  }

  if (session.videoScripts) {
    lines.push('══════════════════════════════════════');
    lines.push('ВИДЕОСЦЕНАРИИ (8 штук)');
    lines.push('══════════════════════════════════════');
    lines.push('');
    lines.push(session.videoScripts);
    lines.push('');
  }

  if (session.carouselScripts) {
    lines.push('══════════════════════════════════════');
    lines.push('СЦЕНАРИИ КАРУСЕЛЕЙ (8 штук)');
    lines.push('══════════════════════════════════════');
    lines.push('');
    lines.push(session.carouselScripts);
    lines.push('');
  }

  if (session.photoScripts) {
    lines.push('══════════════════════════════════════');
    lines.push('ФОТО-КОНЦЕПЦИИ (8 штук)');
    lines.push('══════════════════════════════════════');
    lines.push('');
    lines.push(session.photoScripts);
    lines.push('');
  }

  if (session.covers) {
    lines.push('══════════════════════════════════════');
    lines.push('ТЗ НА ОБЛОЖКИ (8 штук)');
    lines.push('══════════════════════════════════════');
    lines.push('');
    lines.push(session.covers);
    lines.push('');
  }

  if (session.calendar && session.calendar.planA) {
    lines.push('══════════════════════════════════════');
    lines.push('КОНТЕНТ-ПЛАН А — ПРОГРЕВ И ПРИВЛЕЧЕНИЕ (30 дней)');
    lines.push('══════════════════════════════════════');
    lines.push('');
    lines.push(session.calendar.planA);
    lines.push('');
  }

  if (session.calendar && session.calendar.planB) {
    lines.push('══════════════════════════════════════');
    lines.push('КОНТЕНТ-ПЛАН Б — АКТИВАЦИЯ И ПРОДАЖИ (30 дней)');
    lines.push('══════════════════════════════════════');
    lines.push('');
    lines.push(session.calendar.planB);
    lines.push('');
  }

  lines.push('══════════════════════════════════════');
  lines.push('Документ подготовлен Marketing DNA');
  lines.push('══════════════════════════════════════');

  return lines.join('\n');
}

async function sendSummaryDocument(ctx, session) {
  const clientChatId = session.targetClientId || ctx.chat.id;

  try {
    const url = await buildAndDeployAdminSummary(session, clientChatId);
    if (url) {
      await ctx.reply(
        `📋 *Внутренний отчёт готов*\n[Открыть в браузере](${url})`,
        { parse_mode: 'Markdown', disable_web_page_preview: false }
      );
      return;
    }
  } catch (e) {
    console.error('[admin-summary] HTML ошибка:', e.message);
  }

  // Fallback: .txt файл если VISUAL_BASE_URL не настроен
  const text = buildSummaryText(session);
  const tmpPath = path.join('/tmp', `marketingdna_${ctx.chat.id}.txt`);
  try {
    fs.writeFileSync(tmpPath, text, 'utf8');
    await ctx.replyWithDocument(
      { source: tmpPath, filename: `MarketingDNA_${session.regionLabel || 'report'}.txt` },
      { caption: '📄 Полный отчёт — все 9 шагов в одном файле. Сохрани или перешли на почту.' }
    );
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

module.exports = { sendSummaryDocument, buildSummaryText, buildClientSummaryText };
