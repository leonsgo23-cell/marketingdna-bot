require('dotenv').config();
const express      = require('express');
const fs           = require('fs');
const path         = require('path');
const os           = require('os');
const { execSync } = require('child_process');

const app = express();
app.use(express.json());

const PORT        = process.env.VISUAL_PORT || 3002;
const KIE_API_KEY = process.env.KIE_API_KEY;
const KIE_BASE    = 'https://api.kie.ai/api/v1';
const { HAIKU }   = require('./src/claude');
const { PACK_PAGES_DIR } = require('./src/site_builder');
const { logFeedback, getVideoLessons, getImageLessons } = require('./src/prompt_learning');

// Use @ffmpeg-installer/ffmpeg bundled binary, fall back to system ffmpeg
let FFMPEG_BIN = 'ffmpeg';
try {
  const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
  if (ffmpegInstaller.path) {
    FFMPEG_BIN = ffmpegInstaller.path;
    console.log('[visual] ffmpeg installer path:', FFMPEG_BIN);
  }
} catch {}
try {
  execSync(`"${FFMPEG_BIN}" -version`, { stdio: 'ignore' });
  console.log('[visual] ffmpeg OK:', FFMPEG_BIN);
} catch {
  console.error('[visual] WARNING: ffmpeg не найден — склейка видео не будет работать');
}

const BASE_DIR      = path.join(os.homedir(), '.marketingdna-client-sessions');
const VISUAL_DIR    = path.join(BASE_DIR, 'visual_queue');
const RESULTS_DIR   = path.join(BASE_DIR, 'visual_results');
const TRIGGERS_DIR  = path.join(BASE_DIR, 'triggers');
const TMP_DIR       = path.join(BASE_DIR, 'tmp_video');
const PENDING_TASKS = path.join(BASE_DIR, 'pending_image_tasks');
const LIBRARY_DIR       = path.join(BASE_DIR, 'video_library');
const PHOTO_LIBRARY_DIR = path.join(BASE_DIR, 'photo_library');
const CONTENT_HISTORY_DIR = path.join(BASE_DIR, 'content_history');
const SLIDES_PER_CAROUSEL_FALLBACK = 7;

// Per-client serialised write queue for results.json — prevents lost-update
// when two concurrent edits (e.g. photo 1 and photo 2) both read-modify-write.
const _resultsQueues = new Map();
function withResultsLock(clientChatId, fn) {
  const prev = _resultsQueues.get(clientChatId) ?? Promise.resolve();
  // Chain fn after previous operation; store a always-resolved tail so next
  // caller's prev.then() always fires even if fn threw.
  const next = prev.then(() => fn());
  _resultsQueues.set(clientChatId, next.then(() => {}, () => {}));
  return next;
}

for (const d of [VISUAL_DIR, RESULTS_DIR, TRIGGERS_DIR, TMP_DIR, PENDING_TASKS, LIBRARY_DIR, PHOTO_LIBRARY_DIR, CONTENT_HISTORY_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// Сохраняем задание на диск — переживёт рестарт контейнера
function saveImageTask(taskId, meta) {
  fs.writeFileSync(
    path.join(PENDING_TASKS, `${taskId}.json`),
    JSON.stringify({ taskId, ...meta, savedAt: Date.now() }, null, 2)
  );
}

function removeImageTask(taskId) {
  const f = path.join(PENDING_TASKS, `${taskId}.json`);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

// Опрашивает задание и сохраняет URL в results, затем удаляет pending файл
async function pollAndSave(taskId, meta) {
  console.log(`[kie] resuming poll: taskId=${taskId} type=${meta.type} clientId=${meta.clientId}`);
  const url = await pollTask(taskId, 900000, 'image');
  removeImageTask(taskId);

  if (!url) {
    console.log(`[kie] pollAndSave: no url for taskId=${taskId}`);
    return;
  }

  // Скачиваем изображение сразу — не доверяем временным URL Kie.ai (живут 24-72ч)
  let localPath = null;
  try {
    const { default: fetch } = await import('node-fetch');
    const imgResp = await fetch(url);
    if (imgResp.ok) {
      const buffer = Buffer.from(await imgResp.arrayBuffer());
      const suffix = meta.slot ? meta.slot.replace('_', '') : 'img';
      localPath = path.join(RESULTS_DIR, `${meta.clientId}_free_${suffix}.jpg`);
      fs.writeFileSync(localPath, buffer);
      console.log(`[kie] downloaded ${localPath} (${buffer.length} bytes)`);
    }
  } catch (e) {
    console.error(`[kie] download error: ${e.message} — fallback to URL`);
  }

  const resultFile = path.join(RESULTS_DIR, `${meta.clientId}.${meta.type}.json`);
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch {}

  if (meta.type === 'free_photo') {
    fs.writeFileSync(resultFile, JSON.stringify({ url, localPath, generatedAt: Date.now() }, null, 2));
    console.log(`[kie] free_photo saved: ${url.slice(0, 80)}`);
  } else if (meta.type === 'free_visuals') {
    const slot = meta.slot;
    existing[slot] = url;
    if (localPath) existing[`${slot}_local`] = localPath;
    fs.writeFileSync(resultFile, JSON.stringify(existing, null, 2));
    console.log(`[kie] free_visuals[${slot}] saved: ${url.slice(0, 80)}`);
    rebuildFreeVisuals(meta.clientId);
  }
}

function rebuildFreeVisuals(clientId) {
  const resultFile = path.join(RESULTS_DIR, `${clientId}.free_visuals.json`);
  let data = {};
  try { data = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch { return; }

  const prevCarousel = Array.isArray(data.carouselUrls) ? data.carouselUrls : [];
  const prevCover    = Array.isArray(data.coverUrls)    ? data.coverUrls    : [];
  const carouselUrls = [0,1,2,3,4].map(i => data[`carousel_${i}`] || prevCarousel[i] || null);
  const coverUrls    = [data['cover_0'] || prevCover[0] || null];

  // Локальные пути (скачанные файлы — не зависят от Kie.ai TTL)
  const carouselLocal = [0,1,2,3,4].map(i => data[`carousel_${i}_local`] || null);
  const coverLocal    = [data['cover_0_local'] || null];

  const carouselDone = carouselUrls.filter(Boolean).length;
  const coverDone    = coverUrls.filter(Boolean).length;
  const generatedAt  = data.generatedAt || Date.now();
  const elapsed      = Date.now() - generatedAt;
  console.log(`[kie] rebuildFreeVisuals: carousel=${carouselDone}/5 cover=${coverDone}/1`);

  fs.writeFileSync(resultFile, JSON.stringify({ carouselUrls, coverUrls, carouselLocal, coverLocal, generatedAt }, null, 2));

  const carouselFlag = path.join(RESULTS_DIR, `${clientId}.carousel_notified`);
  const coverFlag    = path.join(RESULTS_DIR, `${clientId}.cover_notified`);

  // Карусель: отправляем как только все 5 готовы ИЛИ прошло >15 мин и >=4 готово
  const carouselReady = carouselDone === 5 || (carouselDone >= 4 && elapsed > 15 * 60 * 1000);
  if (carouselReady && !fs.existsSync(carouselFlag)) {
    fs.writeFileSync(carouselFlag, String(Date.now()));
    notifyCarouselReady(clientId, carouselUrls, carouselLocal).catch(() => {});
  }

  // Обложка: отправляем сразу как только готова — независимо от карусели
  if (coverDone >= 1 && !fs.existsSync(coverFlag)) {
    fs.writeFileSync(coverFlag, String(Date.now()));
    notifyCoverReady(clientId, coverUrls, coverLocal).catch(() => {});
  }

  // «Отправить клиенту» — показываем когда и карусель и обложка уведомлены
  if (fs.existsSync(carouselFlag) && fs.existsSync(coverFlag)) {
    const allFlag = path.join(RESULTS_DIR, `${clientId}.free_visuals_notified`);
    if (!fs.existsSync(allFlag)) {
      fs.writeFileSync(allFlag, String(Date.now()));
      notifySendButton(clientId).catch(() => {});
    }
  }
}

// Общие утилиты для notify-функций
async function _freeNotifyUtils(clientId) {
  const adminChatId = process.env.BOT3_MANAGER_CHAT_ID;
  const botToken    = process.env.TELEGRAM_BOT3_TOKEN;
  const { default: fetch } = await import('node-fetch');
  const FormData = (await import('form-data')).default;

  const promptsFile = path.join(RESULTS_DIR, `${clientId}.free_prompts.json`);
  let carouselTexts = [], carouselCaptions = [], coverTitle = '';
  try {
    if (fs.existsSync(promptsFile)) {
      const p = JSON.parse(fs.readFileSync(promptsFile, 'utf8'));
      carouselTexts    = p.carouselTexts    || [];
      carouselCaptions = p.carouselCaptions || [];
      coverTitle       = p.coverTitle       || '';
    }
  } catch {}

  const applyOverlayToPath = async (localPath, text, position, sizeKey) => {
    if (!localPath || !fs.existsSync(localPath) || !text) return localPath;
    try {
      const buf = fs.readFileSync(localPath);
      const processed = await overlayTextOnImage(buf, text, position, sizeKey);
      const ovPath = localPath.replace('.jpg', '_ov.jpg');
      fs.writeFileSync(ovPath, processed);
      return ovPath;
    } catch { return localPath; }
  };

  const downloadAndOverlay = async (url, destPath, text, position, sizeKey) => {
    if (!url) return null;
    try {
      const r = await fetch(url);
      if (!r.ok) return null;
      fs.writeFileSync(destPath, Buffer.from(await r.arrayBuffer()));
      return text ? await applyOverlayToPath(destPath, text, position, sizeKey) : destPath;
    } catch { return null; }
  };

  const sendBotMsg = async (text, keyboard) => {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: adminChatId, text, reply_markup: keyboard ? JSON.stringify(keyboard) : undefined }),
    }).catch(() => {});
  };

  return { adminChatId, botToken, fetch, FormData, carouselTexts, carouselCaptions, coverTitle, applyOverlayToPath, downloadAndOverlay, sendBotMsg };
}

// ── Карусель готова — отправляем в Bot3 ────────────────────────────────────
async function notifyCarouselReady(clientId, carouselUrls, carouselLocal = []) {
  const { adminChatId, botToken, fetch, FormData, carouselTexts, carouselCaptions, applyOverlayToPath, downloadAndOverlay, sendBotMsg } = await _freeNotifyUtils(clientId);
  if (!adminChatId || !botToken) return;

  // Обновляем HTML-карусель
  try {
    const { updatePackPageCarousel } = require('./src/site_builder');
    updatePackPageCarousel(clientId, carouselLocal.map((lp, i) => (lp && fs.existsSync(lp)) ? lp : carouselUrls[i]));
  } catch {}

  const logoMeta = getLogoMeta(clientId);
  const readySlides = [];
  for (let i = 0; i < carouselUrls.length; i++) {
    const rawLocal = carouselLocal[i];
    let finalPath = null;
    if (rawLocal && fs.existsSync(rawLocal)) {
      finalPath = await applyOverlayToPath(rawLocal, carouselTexts[i] || '', 'bottom', 'carousel');
    } else if (carouselUrls[i]) {
      const tmpPath = path.join(TMP_DIR, `${clientId}_free_car_${i}.jpg`);
      finalPath = await downloadAndOverlay(carouselUrls[i], tmpPath, carouselTexts[i] || '', 'bottom', 'carousel');
    }
    if (finalPath && logoMeta) finalPath = await applyLogoToFile(finalPath, clientId);
    if (finalPath) readySlides.push({ path: finalPath, index: i });
  }

  if (readySlides.length === 0) return;

  const form = new FormData();
  form.append('chat_id', adminChatId);
  const mediaArr = readySlides.map((s, idx) => ({
    type: 'photo', media: `attach://slide${idx}`,
    caption: `Слайд ${s.index + 1}${carouselTexts[s.index] ? `: "${carouselTexts[s.index]}"` : ''}`,
  }));
  form.append('media', JSON.stringify(mediaArr));
  readySlides.forEach((s, idx) => form.append(`slide${idx}`, fs.createReadStream(s.path)));
  await fetch(`https://api.telegram.org/bot${botToken}/sendMediaGroup`, { method: 'POST', body: form }).catch(() => {});

  const capLines = readySlides.map(s => carouselCaptions[s.index] ? `Слайд ${s.index + 1}: ${carouselCaptions[s.index]}` : null).filter(Boolean);
  if (capLines.length > 0) await sendBotMsg(`📝 Подписи к постам карусели:\n\n${capLines.join('\n\n')}`);

  const btnRows = readySlides.map(s => [
    { text: `🔄 Сл.${s.index + 1}`, callback_data: `regen_fs_c${s.index}_${clientId}` },
    { text: `✏️ Сл.${s.index + 1}`, callback_data: `et_ca_${s.index}_${clientId}` },
    { text: `🚫 Сл.${s.index + 1}`, callback_data: `notxt_ca_${s.index}_${clientId}` },
  ]);
  await sendBotMsg(`🎠 Карусель готова (${readySlides.length} слайдов):`, { inline_keyboard: btnRows });
}

// ── Обложка готова — отправляем в Bot3 независимо ─────────────────────────
async function notifyCoverReady(clientId, coverUrls, coverLocal = []) {
  const { adminChatId, botToken, coverTitle, applyOverlayToPath, downloadAndOverlay, sendBotMsg } = await _freeNotifyUtils(clientId);
  if (!adminChatId || !botToken) return;

  // Обновляем HTML-обложку
  try {
    const { updatePackPageCover } = require('./src/site_builder');
    if (coverLocal[0] && fs.existsSync(coverLocal[0])) updatePackPageCover(clientId, coverLocal[0]);
    else if (coverUrls[0]) updatePackPageCover(clientId, coverUrls[0]);
  } catch {}

  const logoMeta = getLogoMeta(clientId);
  let coverPath = coverLocal[0];
  if (!coverPath || !fs.existsSync(coverPath)) {
    const tmpCover = path.join(TMP_DIR, `${clientId}_free_cover.jpg`);
    coverPath = await downloadAndOverlay(coverUrls[0], tmpCover, coverTitle, 'bottom', 'cover');
  } else {
    coverPath = await applyOverlayToPath(coverPath, coverTitle, 'bottom', 'cover');
  }
  if (coverPath && fs.existsSync(coverPath)) {
    if (logoMeta) coverPath = await applyLogoToFile(coverPath, clientId);
    await bot3SendPhotoFile(adminChatId, coverPath, `🖼 Обложка готова${coverTitle ? `: "${coverTitle}"` : ''}`);
  }
  await sendBotMsg('Обложка:', {
    inline_keyboard: [[
      { text: '🔄 Переделать', callback_data: `regen_fs_cv_${clientId}` },
      { text: '✏️ Изм. текст', callback_data: `et_co_0_${clientId}` },
      { text: '🚫 Без текста', callback_data: `notxt_co_0_${clientId}` },
    ]],
  });
}

// ── Кнопка «Отправить клиенту» — когда карусель И обложка уведомлены ──────
async function notifySendButton(clientId) {
  const { sendBotMsg } = await _freeNotifyUtils(clientId);
  await sendBotMsg('─────────────────────\n✅ Карусель и обложка проверены.', {
    inline_keyboard: [
      [{ text: '📤 Отправить клиенту', callback_data: `send_free_${clientId}` }],
      [{ text: '🔄 Перегенерировать всё', callback_data: `retry_free_${clientId}` }],
    ],
  });
}

// Оставляем для обратной совместимости (вызывается из pollAndSave при photo-ready)
async function notifyFreeVisualsReady(clientId, carouselUrls, coverUrls, carouselLocal = [], coverLocal = []) {
  const carouselFlag = path.join(RESULTS_DIR, `${clientId}.carousel_notified`);
  const coverFlag    = path.join(RESULTS_DIR, `${clientId}.cover_notified`);
  const allFlag      = path.join(RESULTS_DIR, `${clientId}.free_visuals_notified`);
  if (!fs.existsSync(carouselFlag)) {
    fs.writeFileSync(carouselFlag, String(Date.now()));
    await notifyCarouselReady(clientId, carouselUrls, carouselLocal).catch(() => {});
  }
  if (!fs.existsSync(coverFlag) && (coverUrls[0] || coverLocal[0])) {
    fs.writeFileSync(coverFlag, String(Date.now()));
    await notifyCoverReady(clientId, coverUrls, coverLocal).catch(() => {});
  }
  if (!fs.existsSync(allFlag)) {
    fs.writeFileSync(allFlag, String(Date.now()));
    await notifySendButton(clientId).catch(() => {});
  }
}

// При старте: возобновляем все незавершённые задания
function resumePendingTasks() {
  const files = fs.readdirSync(PENDING_TASKS).filter(f => f.endsWith('.json'));
  if (files.length === 0) return;
  console.log(`[kie] resuming ${files.length} pending image tasks after restart`);
  for (const f of files) {
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(PENDING_TASKS, f), 'utf8'));
      pollAndSave(meta.taskId, meta).catch(e => console.error('[kie] resume error:', e.message));
    } catch (e) {
      console.error('[kie] resume read error:', e.message);
    }
  }
}

// При старте: возобновляем незавершённые visual.json задания (если results ещё нет)
function resumePendingVisualJobs() {
  const files = fs.readdirSync(VISUAL_DIR).filter(f => f.endsWith('.visual.json'));
  if (files.length === 0) return;
  for (const f of files) {
    const clientChatId = f.replace('.visual.json', '');
    const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);

    if (fs.existsSync(resultPath)) {
      // Check if videos are expected but incomplete
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(VISUAL_DIR, f), 'utf8'));
        const isProfi    = (pkg.packageKey || '').includes('pkg_v');
        const isStandard = (pkg.packageKey || '').includes('pkg_standard');
        if (isProfi || isStandard) {
          const results = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
          const videoData   = results.results?.videoData || [];
          const expectedCount = isProfi ? 8 : 4;
          const doneCount   = videoData.filter(v => v?.localPath && fs.existsSync(v.localPath)).length;
          if (doneCount >= expectedCount) {
            console.log(`[visual] ${clientChatId}: всё готово (${doneCount} видео), пропускаем`);
            continue;
          }
          console.log(`[visual] resuming interrupted job for ${clientChatId} — видео ${doneCount}/${expectedCount}`);
        } else {
          continue; // no videos expected, skip
        }
      } catch {
        continue;
      }
    }

    console.log(`[visual] resuming interrupted job for ${clientChatId}`);
    runVisualGeneration(clientChatId, { maxVideos: 1 }).catch(e =>
      console.error('[visual] resume job error for', clientChatId, e.message)
    );
  }
}

// ── HTTP endpoints ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true }));

// Раздача файлов для Metricool — изображения должны быть доступны по публичному URL
app.get('/files/:filename', (req, res) => {
  const safeName = path.basename(req.params.filename); // защита от path traversal
  const filePath = path.join(RESULTS_DIR, safeName);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'not found' });
  res.sendFile(filePath);
});

// Тест: генерация одного видео (для отладки)
app.post('/generate_one_video', (req, res) => {
  const { clientChatId } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });

  (async () => {
    const pkgPath = path.join(VISUAL_DIR, `${clientChatId}.visual.json`);
    if (!fs.existsSync(pkgPath)) {
      await bot3Send(process.env.BOT3_MANAGER_CHAT_ID, `❌ visual.json не найден для ${clientChatId}`);
      return;
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const videoScripts = splitVideoScripts(pkg.videoScripts || '');
    if (!videoScripts.length) {
      await bot3Send(process.env.BOT3_MANAGER_CHAT_ID, `❌ Нет видео-сценариев для ${clientChatId}`);
      return;
    }
    await bot3Send(process.env.BOT3_MANAGER_CHAT_ID, `🎬 Тест: генерирую 1 видео — ${pkg.clientName}`);
    const result = await generateOneVideo(videoScripts[0], 0, clientChatId, '');
    await notifyBot3SingleVideo(clientChatId, 0, 1, result?.localPath, result?.subtitleText, result?.libraryMatches);
  })().catch(e => console.error('[generate_one_video] error:', e.message));
});

// Генерирует хук/тему/CTA через Claude Haiku на правильном языке клиента
async function generateVideoTextsForSample(clientChatId, carouselPrompts) {
  // Читаем данные клиента из retry.json (там есть язык и описание бизнеса)
  const retryPath = path.join(BASE_DIR, 'triggers', `${clientChatId}.retry.json`);
  let businessDesc = '';
  let lang = 'ru'; // по умолчанию русский

  try {
    if (fs.existsSync(retryPath)) {
      const data = JSON.parse(fs.readFileSync(retryPath, 'utf8'));
      businessDesc = data.description || (data.answers?.[0]?.answer || '');
      lang = data.contentLanguage || data.analyticsLanguage || data.interfaceLang || 'ru';
    }
  } catch {}

  // Попробуем также сессию клиента если retry не нашли
  if (!businessDesc) {
    try {
      const sessPath = path.join(BASE_DIR, `${clientChatId}.json`);
      if (fs.existsSync(sessPath)) {
        const sess = JSON.parse(fs.readFileSync(sessPath, 'utf8'));
        businessDesc = sess.freeQ1 || sess.description || '';
        lang = sess.contentLanguage || sess.interfaceLang || lang;
      }
    } catch {}
  }

  // Контекст из промптов карусели (первые 2, на английском — описывают бизнес)
  const promptContext = carouselPrompts.slice(0, 2).join(' ').slice(0, 300);

  const langName = lang === 'lv' ? 'Latvian' : lang === 'en' ? 'English' : 'Russian';

  try {
    const { ask } = require('./src/claude');
    const HAIKU = 'claude-haiku-4-5-20251001';
    const result = await ask(
      `You are writing short text overlays for a social media video (Reels/TikTok) for this business:\n` +
      `Business: ${businessDesc || promptContext}\n\n` +
      `Write ONLY in ${langName}. No mixing of languages. No translation. Pure ${langName}.\n\n` +
      `Generate exactly 3 lines:\n` +
      `HOOK: [attention-grabbing question or statement, max 35 characters, ${langName}]\n` +
      `THEME: [what this business offers, max 35 characters, ${langName}]\n` +
      `CTA: [clear call to action with price or benefit, max 70 characters, ${langName}]\n\n` +
      `Rules:\n` +
      `- Each line starts with HOOK:, THEME:, or CTA:\n` +
      `- Real words, not poetic metaphors\n` +
      `- Count characters strictly — do not exceed limits\n` +
      `- Output only the 3 lines, nothing else`,
      { model: HAIKU, maxTokens: 200 }
    );

    const hookM  = result.match(/HOOK:\s*(.+)/i);
    const themeM = result.match(/THEME:\s*(.+)/i);
    const ctaM   = result.match(/CTA:\s*(.+)/i);

    return {
      hookText:  (hookM?.[1]  || '').trim().slice(0, 35),
      themeText: (themeM?.[1] || '').trim().slice(0, 35),
      ctaText:   (ctaM?.[1]   || '').trim().slice(0, 70),
    };
  } catch (e) {
    console.error('[visual_sample] generateVideoTexts error:', e.message);
    // Запасной вариант — из промптов (хоть что-то)
    const fallback = carouselPrompts[0]?.match(/reads ['"«]([^'"»\n]+)/i)?.[1] || '';
    return { hookText: fallback.slice(0, 35), themeText: '', ctaText: '' };
  }
}

// ── Полный визуальный образец: 1 карусель + 1 фото + 1 обложка + 1 сторис + 1 видео ──
app.post('/generate_visual_sample', (req, res) => {
  const { clientChatId, force } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true, message: 'Генерация образца запущена — результаты придут в Bot3' });

  (async () => {
    const adminChatId = process.env.BOT3_MANAGER_CHAT_ID;

    const promptsFile = path.join(RESULTS_DIR, `${clientChatId}.free_prompts.json`);
    if (!fs.existsSync(promptsFile)) {
      await bot3Send(adminChatId, `❌ Промпты не найдены для chatId ${clientChatId}.\nПроведите генерацию бесплатного пакета сначала.`);
      return;
    }

    const prompts         = JSON.parse(fs.readFileSync(promptsFile, 'utf8'));
    const carouselPrompts  = (prompts.carousel || []).filter(Boolean);
    const coverPrompt      = (prompts.cover || [])[0] || carouselPrompts[0] || '';
    const carouselTexts    = prompts.carouselTexts    || [];
    const carouselCaptions = prompts.carouselCaptions || [];
    const coverTitle       = prompts.coverTitle       || '';
    const photoTitle       = prompts.photoTitle       || carouselTexts[1] || carouselTexts[0] || '';
    const photoCaption     = prompts.photoCaption     || '';
    const storyText        = carouselTexts[0]         || coverTitle || '';

    if (!carouselPrompts.length) {
      await bot3Send(adminChatId, `❌ Промпты карусели пусты для chatId ${clientChatId}`);
      return;
    }

    // Лого клиента (если есть)
    const sampleLogoMeta = getLogoMeta(clientChatId);

    // raw = картинка без текста; ov = с наложенным текстом (что отправляем)
    const rawPaths = {
      car:   Array.from({length: carouselPrompts.length}, (_, i) => path.join(RESULTS_DIR, `${clientChatId}_sample_car_raw_${i}.jpg`)),
      photo: path.join(RESULTS_DIR, `${clientChatId}_sample_photo_raw.jpg`),
      cover: path.join(RESULTS_DIR, `${clientChatId}_sample_cover_raw.jpg`),
      story: path.join(RESULTS_DIR, `${clientChatId}_sample_story_raw.jpg`),
    };
    const ovPaths = {
      car:   Array.from({length: carouselPrompts.length}, (_, i) => path.join(RESULTS_DIR, `${clientChatId}_sample_car_${i}.jpg`)),
      photo: path.join(RESULTS_DIR, `${clientChatId}_sample_photo.jpg`),
      cover: path.join(RESULTS_DIR, `${clientChatId}_sample_cover.jpg`),
      story: path.join(RESULTS_DIR, `${clientChatId}_sample_story.jpg`),
    };
    const videoPath = path.join(RESULTS_DIR, `${clientChatId}_sample_video.mp4`);
    const videoRawPath = path.join(RESULTS_DIR, `${clientChatId}_sample_video_raw.mp4`);

    if (force) {
      const all = [...rawPaths.car, ...ovPaths.car, rawPaths.photo, ovPaths.photo,
        rawPaths.cover, ovPaths.cover, rawPaths.story, ovPaths.story, videoPath, videoRawPath];
      for (const f of all) { try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {} }
      console.log(`[visual_sample] force: удалены старые файлы для ${clientChatId}`);
    }

    // Накладывает текст на raw-файл и сохраняет в ov-файл
    const applyOverlay = async (rawPath, ovPath, text, position, sizeKey) => {
      if (!text || !fs.existsSync(rawPath)) return false;
      try {
        const buf       = fs.readFileSync(rawPath);
        const processed = await overlayTextOnImage(buf, text, position, sizeKey);
        fs.writeFileSync(ovPath, processed);
        return true;
      } catch (e) {
        console.error(`[visual_sample] overlay error: ${e.message}`);
        fs.copyFileSync(rawPath, ovPath); // fallback: без текста
        return false;
      }
    };

    // Кнопки под каждым изображением
    const btnImg = (type, idx = null) => ({
      inline_keyboard: [[
        { text: '🔄 Переделать', callback_data: idx !== null ? `vs_regen_${type}_${clientChatId}_${idx}` : `vs_regen_${type}_${clientChatId}` },
        { text: '✏️ Изм. текст', callback_data: idx !== null ? `vs_edit_${type}_${clientChatId}_${idx}` : `vs_edit_${type}_${clientChatId}` },
        { text: '🚫 Без текста', callback_data: idx !== null ? `vs_notxt_${type}_${clientChatId}_${idx}` : `vs_notxt_${type}_${clientChatId}` },
      ]],
    });
    const btnVideo = () => ({
      inline_keyboard: [
        [{ text: '🔄 Переделать видео', callback_data: `vs_regen_v_${clientChatId}` }],
        [{ text: '✏️ Хук', callback_data: `vs_edit_hook_${clientChatId}` }, { text: '✏️ Тема', callback_data: `vs_edit_theme_${clientChatId}` }, { text: '✏️ CTA', callback_data: `vs_edit_cta_${clientChatId}` }],
      ],
    });

    const carRawExists   = rawPaths.car.filter(p => fs.existsSync(p)).length >= carouselPrompts.length;
    const photoRawExists = fs.existsSync(rawPaths.photo);
    const coverRawExists = fs.existsSync(rawPaths.cover);
    const storyRawExists = fs.existsSync(rawPaths.story);
    const videoExists    = fs.existsSync(videoPath);

    const toGen = [];
    if (!carRawExists)   toGen.push('🎠 Карусель');
    if (!photoRawExists) toGen.push('📸 Фото-пост');
    if (!coverRawExists) toGen.push('🖼 Обложка');
    if (!storyRawExists) toGen.push('📱 Сторис');
    if (!videoExists)    toGen.push('🎬 Видео');
    const toSkip = ['🎠 Карусель','📸 Фото-пост','🖼 Обложка','📱 Сторис','🎬 Видео'].filter(x => !toGen.includes(x));

    await bot3Send(adminChatId,
      `🧪 Визуальный образец — chatId ${clientChatId}\n` +
      `Каждый элемент придёт с кнопками 🔄 Переделать / ✏️ Изм. текст\n\n` +
      (toGen.length  ? `Генерирую:\n${toGen.join('\n')}\n\n` : '') +
      (toSkip.length ? `♻️ Уже готово (повторно отправляю):\n${toSkip.join('\n')}` : '') +
      `\n\nПридут по мере готовности...`
    );

    const { default: fetchNode } = await import('node-fetch');

    const downloadToFile = async (url, filePath) => {
      const r = await fetchNode(url);
      if (r.ok) { fs.writeFileSync(filePath, Buffer.from(await r.arrayBuffer())); return true; }
      return false;
    };

    // ── 1. Карусель — ждём все слайды, шлём альбомом + кнопки отдельным сообщением
    try {
      if (!carRawExists) {
        await bot3Send(adminChatId, `🎠 Генерирую карусель (${carouselPrompts.length} слайдов)...`);
        for (let i = 0; i < carouselPrompts.length; i++) {
          const taskId = await startImage(carouselPrompts[i], '1:1').catch(() => null);
          if (!taskId) continue;
          const url = await pollTask(taskId, 600000, 'image');
          if (url) await downloadToFile(url, rawPaths.car[i]);
        }
      }
      // Накладываем тексты и лого на все готовые слайды
      for (let i = 0; i < carouselPrompts.length; i++) {
        if (!fs.existsSync(rawPaths.car[i])) continue;
        const text = carouselTexts[i] || '';
        await applyOverlay(rawPaths.car[i], ovPaths.car[i], text, 'bottom', 'carousel');
        if (sampleLogoMeta && fs.existsSync(ovPaths.car[i])) {
          ovPaths.car[i] = await applyLogoToFile(ovPaths.car[i], clientChatId);
        }
      }
      const readyOv = ovPaths.car.filter(p => fs.existsSync(p));
      if (readyOv.length > 0) {
        // Отправляем как альбом (медиа-группа)
        const { default: fetchNode2 } = await import('node-fetch');
        const FormData2 = (await import('form-data')).default;
        const token = process.env.TELEGRAM_BOT3_TOKEN;
        const form = new FormData2();
        form.append('chat_id', adminChatId);
        const mediaArr = readyOv.map((p, idx) => ({
          type: 'photo',
          media: `attach://slide${idx}`,
          caption: `Слайд ${idx + 1}${carouselTexts[idx] ? `: "${carouselTexts[idx]}"` : ''}`,
        }));
        form.append('media', JSON.stringify(mediaArr));
        readyOv.forEach((p, idx) => form.append(`slide${idx}`, fs.createReadStream(p)));
        await fetchNode2(`https://api.telegram.org/bot${token}/sendMediaGroup`, { method: 'POST', body: form }).catch(() => {});

        // Подписи к слайдам — отдельным сообщением (копируется в соцсеть)
        const captionLines = readyOv.map((_, idx) => {
          const cap = carouselCaptions[idx];
          return cap ? `Слайд ${idx + 1}: ${cap}` : null;
        }).filter(Boolean);
        if (captionLines.length > 0) {
          await fetchNode2(`https://api.telegram.org/bot${token}/sendMessage`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: adminChatId, text: `📝 Подписи к постам карусели:\n\n${captionLines.join('\n\n')}` }),
          }).catch(() => {});
        }

        // Кнопки для каждого слайда
        const btnRows = readyOv.map((_, idx) => [
          { text: `🔄 Слайд ${idx + 1}`, callback_data: `vs_regen_c_${clientChatId}_${idx}` },
          { text: `✏️ Текст ${idx + 1}`, callback_data: `vs_edit_c_${clientChatId}_${idx}` },
        ]);
        await fetchNode2(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: adminChatId,
            text: `🎠 Карусель готова (${readyOv.length} слайдов)\nНажмите кнопку нужного слайда:`,
            reply_markup: { inline_keyboard: btnRows },
          }),
        }).catch(() => {});
      }
    } catch (e) { await bot3Send(adminChatId, `⚠️ Карусель: ${e.message}`); }

    // ── 2. Фото-пост ─────────────────────────────────────────────────────────
    try {
      if (!photoRawExists) {
        await bot3Send(adminChatId, '📸 Генерирую фото-пост...');
        const taskId = await startImage(carouselPrompts[1] || carouselPrompts[0], '1:1').catch(() => null);
        if (taskId) {
          const url = await pollTask(taskId, 600000, 'image');
          if (url) await downloadToFile(url, rawPaths.photo);
        }
      }
      if (fs.existsSync(rawPaths.photo)) {
        await applyOverlay(rawPaths.photo, ovPaths.photo, photoTitle, 'bottom', 'photo');
        let sendPath = fs.existsSync(ovPaths.photo) ? ovPaths.photo : rawPaths.photo;
        if (sampleLogoMeta) sendPath = await applyLogoToFile(sendPath, clientChatId);
        await bot3SendPhotoFile(adminChatId, sendPath, `📸 Фото-пост${photoTitle ? `: "${photoTitle}"` : ''}`, btnImg('ph'));
        if (photoCaption) await bot3Send(adminChatId, `📝 Подпись к фото-посту:\n\n${photoCaption}`);
      }
    } catch (e) { await bot3Send(adminChatId, `⚠️ Фото: ${e.message}`); }

    // ── 3. Обложка ───────────────────────────────────────────────────────────
    try {
      if (!coverRawExists) {
        await bot3Send(adminChatId, '🖼 Генерирую обложку...');
        const taskId = await startImage(coverPrompt, '9:16').catch(() => null);
        if (taskId) {
          const url = await pollTask(taskId, 600000, 'image');
          if (url) await downloadToFile(url, rawPaths.cover);
        }
      }
      if (fs.existsSync(rawPaths.cover)) {
        await applyOverlay(rawPaths.cover, ovPaths.cover, coverTitle, 'bottom', 'cover');
        let sendPath = fs.existsSync(ovPaths.cover) ? ovPaths.cover : rawPaths.cover;
        if (sampleLogoMeta) sendPath = await applyLogoToFile(sendPath, clientChatId);
        await bot3SendPhotoFile(adminChatId, sendPath, `🖼 Обложка${coverTitle ? `: "${coverTitle}"` : ''}`, btnImg('co'));
      }
    } catch (e) { await bot3Send(adminChatId, `⚠️ Обложка: ${e.message}`); }

    // ── 4. Сторис ────────────────────────────────────────────────────────────
    try {
      if (!storyRawExists) {
        await bot3Send(adminChatId, '📱 Генерирую сторис...');
        const storyPrompt = (carouselPrompts[2] || coverPrompt) + ' Vertical 9:16 format, optimized for Instagram Stories.';
        const taskId = await startImage(storyPrompt, '9:16').catch(() => null);
        if (taskId) {
          const url = await pollTask(taskId, 600000, 'image');
          if (url) await downloadToFile(url, rawPaths.story);
        }
      }
      if (fs.existsSync(rawPaths.story)) {
        await applyOverlay(rawPaths.story, ovPaths.story, storyText, 'bottom', 'story');
        let sendPath = fs.existsSync(ovPaths.story) ? ovPaths.story : rawPaths.story;
        if (sampleLogoMeta) sendPath = await applyLogoToFile(sendPath, clientChatId);
        await bot3SendPhotoFile(adminChatId, sendPath, `📱 Сторис${storyText ? `: "${storyText}"` : ''}`, btnImg('st'));
      }
    } catch (e) { await bot3Send(adminChatId, `⚠️ Сторис: ${e.message}`); }

    // ── 5. Видео ─────────────────────────────────────────────────────────────
    try {
      let hookText = prompts.videoHook || '';
      let themeText = prompts.videoTheme || '';
      let ctaText   = prompts.videoCta  || '';

      // Пути к отдельным фрагментам (сохраняются на диск)
      const fragSavedPaths = Array.from({length: 4}, (_, i) =>
        path.join(RESULTS_DIR, `${clientChatId}_sample_frag_saved_${i}.mp4`)
      );
      const fragsExist = fragSavedPaths.filter(p => fs.existsSync(p)).length === 4;

      if (!videoExists) {
        await bot3Send(adminChatId, '🎬 Генерирую видео (4 фрагмента × 8 сек → 30 сек) через Veo3...\nОжидание ~15-20 мин.');
        const basePrompt = carouselPrompts[0].slice(0, 350);
        const scenePrompts = [
          basePrompt + ' Wide establishing shot, smooth push-in camera. Photorealistic B-roll, no talking, no text.',
          (carouselPrompts[1] || basePrompt).slice(0, 350) + ' Close-up detail shot, slow motion. Photorealistic B-roll, no talking.',
          (carouselPrompts[2] || basePrompt).slice(0, 350) + ' Medium shot, gentle pan. Warm lighting. Photorealistic B-roll, no talking.',
          (carouselPrompts[3] || basePrompt).slice(0, 350) + ' Overhead top-down shot, slow tilt. Natural light. Photorealistic B-roll, no talking.',
        ];
        // Сохраняем промпты фрагментов для перегенерации по отдельности
        const updP = JSON.parse(fs.readFileSync(promptsFile, 'utf8'));
        updP.videoFragmentPrompts = scenePrompts;
        fs.writeFileSync(promptsFile, JSON.stringify(updP, null, 2));

        const taskIds  = await Promise.all(scenePrompts.map(p => startVideo(p).catch(() => null)));
        const urls     = await Promise.all(taskIds.map(id => id ? pollTask(id, 900000, 'video') : null));
        const validUrls = urls.filter(Boolean);
        if (!validUrls.length) throw new Error('Veo3 не вернул ни одного фрагмента');

        const fragPaths = [];
        for (let i = 0; i < validUrls.length; i++) {
          const fp = path.join(TMP_DIR, `${clientChatId}_sample_frag${i}.mp4`);
          if (await downloadToFile(validUrls[i], fp)) {
            fragPaths.push(fp);
            // Сохраняем каждый фрагмент отдельно на диск
            fs.copyFileSync(fp, fragSavedPaths[i]);
          }
        }
        if (!fragPaths.length) throw new Error('Не удалось скачать фрагменты');

        const mergedPath = path.join(TMP_DIR, `${clientChatId}_sample_merged.mp4`);
        fragPaths.length > 1 ? mergeVideoFragments(fragPaths, mergedPath) : fs.copyFileSync(fragPaths[0], mergedPath);

        const trimPath = path.join(TMP_DIR, `${clientChatId}_sample_trim.mp4`);
        try {
          require('child_process').execSync(
            `"${FFMPEG_BIN}" -y -i "${mergedPath}" -t 30 -c:v libx264 -preset ultrafast -crf 23 -c:a copy "${trimPath}"`,
            { stdio: 'pipe' }
          );
        } catch { fs.copyFileSync(mergedPath, trimPath); }

        const rawSrc = fs.existsSync(trimPath) && fs.statSync(trimPath).size > 10000 ? trimPath : mergedPath;
        fs.copyFileSync(rawSrc, videoRawPath);

        const vt = await generateVideoTextsForSample(clientChatId, carouselPrompts);
        hookText = vt.hookText; themeText = vt.themeText; ctaText = vt.ctaText;

        const srt = buildTimedSrt(hookText, ctaText, 30, themeText);
        try { addTimedSubtitles(videoRawPath, srt, videoPath); }
        catch { fs.copyFileSync(videoRawPath, videoPath); }

        // Накладываем лого на видео если есть
        if (sampleLogoMeta && fs.existsSync(videoPath)) {
          const videoWithLogo = videoPath.replace('.mp4', '_logo.mp4');
          const ok = await applyLogoToVideo(videoPath, sampleLogoMeta.logoPath, videoWithLogo, sampleLogoMeta.position);
          if (ok && fs.existsSync(videoWithLogo)) {
            fs.renameSync(videoWithLogo, videoPath);
          }
        }

        const updPrompts = JSON.parse(fs.readFileSync(promptsFile, 'utf8'));
        updPrompts.videoHook = hookText; updPrompts.videoTheme = themeText; updPrompts.videoCta = ctaText;
        fs.writeFileSync(promptsFile, JSON.stringify(updPrompts, null, 2));

        for (const f of [...fragPaths, mergedPath, trimPath]) { try { fs.unlinkSync(f); } catch {} }
      }

      if (fs.existsSync(videoPath)) {
        // 1. Сначала полное видео 30 сек с кнопками редактирования текста
        await bot3SendVideo(adminChatId, videoPath);
        const { default: fetchTg } = await import('node-fetch');
        const token = process.env.TELEGRAM_BOT3_TOKEN;
        await fetchTg(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: adminChatId,
            text: `🎬 Видео готово ✅\n\nХук: "${hookText}"\nТема: "${themeText}"\nCTA: "${ctaText}"\n\nЕсли нужно изменить видеоряд — нажмите 🔄 под одним из фрагментов ниже:`,
            reply_markup: btnVideo(),
          }),
        }).catch(() => {});

        // 2. Потом фрагменты — только ✅ Оставить / 🔄 Переделать, без текстовых кнопок
        const savedFrags = fragSavedPaths.filter(p => fs.existsSync(p));
        if (savedFrags.length > 0) {
          await bot3Send(adminChatId, `🎬 Фрагменты (${savedFrags.length} из 4) — нажмите 🔄 если нужно переделать конкретный:`);
          for (let i = 0; i < savedFrags.length; i++) {
            const FormDataV = (await import('form-data')).default;
            const form = new FormDataV();
            form.append('chat_id', adminChatId);
            form.append('video', fs.createReadStream(savedFrags[i]));
            form.append('caption', `Фрагмент ${i + 1} из ${savedFrags.length}`);
            form.append('reply_markup', JSON.stringify({ inline_keyboard: [[
              { text: `✅ Ок`, callback_data: `vs_frag_ok_${clientChatId}_${i}` },
              { text: `🔄 Переделать`, callback_data: `vs_frag_regen_${clientChatId}_${i}` },
            ]]}));
            await fetchTg(`https://api.telegram.org/bot${token}/sendVideo`, { method: 'POST', body: form }).catch(() => {});
          }
        }
      }
    } catch (e) { await bot3Send(adminChatId, `⚠️ Видео: ошибка — ${e.message}`); }

    // Если это демо-пакет — добавляем кнопку отправки клиенту
    const demoPendingFile = path.join(path.join(os.homedir(), '.marketingdna-client-sessions', 'pending'), `${clientChatId}.demo.json`);
    const isDemo = fs.existsSync(demoPendingFile);

    await bot3Send(
      adminChatId,
      `✅ Визуальный образец для chatId ${clientChatId} завершён.\n\n` +
      `Нажмите 🔄 Переделать под любым элементом чтобы перегенерировать картинку/видео.\n` +
      `Нажмите ✏️ Изм. текст чтобы изменить надпись.` +
      (isDemo ? '\n\n🎁 *Это демо-пакет* — проверьте и отправьте клиенту.' : ''),
      isDemo
        ? { inline_keyboard: [[{ text: '📤 Отправить клиенту', callback_data: `send_demo_${clientChatId}` }]] }
        : undefined
    );
  })().catch(e => console.error('[visual_sample] error:', e.message));
});

// ── Visual Sample: перегенерация одного слота ─────────────────────────────────
app.post('/regen_sample_slot', (req, res) => {
  const { clientChatId, type, index = 0, feedback = '' } = req.body;
  if (!clientChatId || !type) return res.status(400).json({ error: 'clientChatId and type required' });
  res.json({ ok: true });

  (async () => {
    const adminChatId = process.env.BOT3_MANAGER_CHAT_ID;
    const promptsFile = path.join(RESULTS_DIR, `${clientChatId}.free_prompts.json`);
    if (!fs.existsSync(promptsFile)) {
      await bot3Send(adminChatId, `❌ Промпты не найдены для ${clientChatId}`); return;
    }
    const prompts      = JSON.parse(fs.readFileSync(promptsFile, 'utf8'));
    const carPrompts   = (prompts.carousel || []).filter(Boolean);
    const coverPrompt  = (prompts.cover || [])[0] || carPrompts[0] || '';
    const carTexts     = prompts.carouselTexts || [];
    const coverTitle   = prompts.coverTitle || '';
    const photoTitle   = prompts.photoTitle || carTexts[1] || carTexts[0] || '';
    const storyText    = carTexts[0] || coverTitle || '';

    const { default: fetchNode } = await import('node-fetch');
    const downloadToFile = async (url, filePath) => {
      const r = await fetchNode(url); if (r.ok) { fs.writeFileSync(filePath, Buffer.from(await r.arrayBuffer())); return true; } return false;
    };
    const applyOverlay = async (rawPath, ovPath, text, position, sizeKey) => {
      if (!text || !fs.existsSync(rawPath)) return;
      try { const buf = fs.readFileSync(rawPath); const p = await overlayTextOnImage(buf, text, position, sizeKey); fs.writeFileSync(ovPath, p); }
      catch { fs.copyFileSync(rawPath, ovPath); }
    };
    const btnImg = (t, i = null) => ({ inline_keyboard: [[
      { text: '🔄 Переделать', callback_data: i !== null ? `vs_regen_${t}_${clientChatId}_${i}` : `vs_regen_${t}_${clientChatId}` },
      { text: '✏️ Изм. текст', callback_data: i !== null ? `vs_edit_${t}_${clientChatId}_${i}` : `vs_edit_${t}_${clientChatId}` },
      { text: '🚫 Без текста', callback_data: i !== null ? `vs_notxt_${t}_${clientChatId}_${i}` : `vs_notxt_${t}_${clientChatId}` },
    ]] });

    // Обогащаем промпт фидбеком менеджера
    const withFeedback = (prompt) =>
      feedback ? `${prompt}. IMPORTANT CHANGE: ${feedback}` : prompt;

    const logSlotFeedback = (origPrompt, mediaType = 'image') => {
      if (feedback) logFeedback(mediaType, origPrompt, feedback);
    };

    try {
      if (type === 'c') {
        const i = Number(index);
        const rawPath = path.join(RESULTS_DIR, `${clientChatId}_sample_car_raw_${i}.jpg`);
        const ovPath  = path.join(RESULTS_DIR, `${clientChatId}_sample_car_${i}.jpg`);
        if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
        if (fs.existsSync(ovPath))  fs.unlinkSync(ovPath);
        logSlotFeedback(carPrompts[i] || carPrompts[0]);
        const taskId = await startImage(withFeedback(carPrompts[i] || carPrompts[0]), '1:1').catch(() => null);
        if (!taskId) { await bot3Send(adminChatId, `❌ Kie.ai не дал taskId для слайда ${i + 1}`); return; }
        const url = await pollTask(taskId, 600000, 'image');
        if (!url || !await downloadToFile(url, rawPath)) { await bot3Send(adminChatId, `❌ Не удалось скачать слайд ${i + 1}`); return; }
        await applyOverlay(rawPath, ovPath, carTexts[i] || '', 'bottom', 'carousel');
        const send = fs.existsSync(ovPath) ? ovPath : rawPath;
        await bot3SendPhotoFile(adminChatId, send, `🔄 Слайд ${i + 1} готов${carTexts[i] ? `: "${carTexts[i]}"` : ''}`, btnImg('c', i));

      } else if (type === 'ph') {
        const rawPath = path.join(RESULTS_DIR, `${clientChatId}_sample_photo_raw.jpg`);
        const ovPath  = path.join(RESULTS_DIR, `${clientChatId}_sample_photo.jpg`);
        if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
        if (fs.existsSync(ovPath))  fs.unlinkSync(ovPath);
        logSlotFeedback(carPrompts[1] || carPrompts[0]);
        const taskId = await startImage(withFeedback(carPrompts[1] || carPrompts[0]), '1:1').catch(() => null);
        if (!taskId) { await bot3Send(adminChatId, '❌ Kie.ai не дал taskId для фото'); return; }
        const url = await pollTask(taskId, 600000, 'image');
        if (!url || !await downloadToFile(url, rawPath)) { await bot3Send(adminChatId, '❌ Не удалось скачать фото'); return; }
        await applyOverlay(rawPath, ovPath, photoTitle, 'bottom', 'photo');
        const send = fs.existsSync(ovPath) ? ovPath : rawPath;
        await bot3SendPhotoFile(adminChatId, send, `🔄 Фото-пост готов${photoTitle ? `: "${photoTitle}"` : ''}`, btnImg('ph'));

      } else if (type === 'co') {
        const rawPath = path.join(RESULTS_DIR, `${clientChatId}_sample_cover_raw.jpg`);
        const ovPath  = path.join(RESULTS_DIR, `${clientChatId}_sample_cover.jpg`);
        if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
        if (fs.existsSync(ovPath))  fs.unlinkSync(ovPath);
        logSlotFeedback(coverPrompt);
        const taskId = await startImage(withFeedback(coverPrompt), '9:16').catch(() => null);
        if (!taskId) { await bot3Send(adminChatId, '❌ Kie.ai не дал taskId для обложки'); return; }
        const url = await pollTask(taskId, 600000, 'image');
        if (!url || !await downloadToFile(url, rawPath)) { await bot3Send(adminChatId, '❌ Не удалось скачать обложку'); return; }
        await applyOverlay(rawPath, ovPath, coverTitle, 'bottom', 'cover');
        const send = fs.existsSync(ovPath) ? ovPath : rawPath;
        await bot3SendPhotoFile(adminChatId, send, `🔄 Обложка готова${coverTitle ? `: "${coverTitle}"` : ''}`, btnImg('co'));

      } else if (type === 'st') {
        const rawPath = path.join(RESULTS_DIR, `${clientChatId}_sample_story_raw.jpg`);
        const ovPath  = path.join(RESULTS_DIR, `${clientChatId}_sample_story.jpg`);
        if (fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
        if (fs.existsSync(ovPath))  fs.unlinkSync(ovPath);
        const baseStoryPrompt = (carPrompts[2] || coverPrompt) + ' Vertical 9:16 format, optimized for Instagram Stories.';
        logSlotFeedback(baseStoryPrompt);
        const taskId = await startImage(withFeedback(baseStoryPrompt), '9:16').catch(() => null);
        if (!taskId) { await bot3Send(adminChatId, '❌ Kie.ai не дал taskId для сторис'); return; }
        const url = await pollTask(taskId, 600000, 'image');
        if (!url || !await downloadToFile(url, rawPath)) { await bot3Send(adminChatId, '❌ Не удалось скачать сторис'); return; }
        await applyOverlay(rawPath, ovPath, storyText, 'bottom', 'story');
        const send = fs.existsSync(ovPath) ? ovPath : rawPath;
        await bot3SendPhotoFile(adminChatId, send, `🔄 Сторис готов${storyText ? `: "${storyText}"` : ''}`, btnImg('st'));

      } else if (type === 'v') {
        // Для видео — перезапускаем через generate_visual_sample с флагом regen_video
        await bot3Send(adminChatId, '🎬 Перегенерирую видео (4 фрагмента × 8 сек)...\nОжидание ~15-20 мин.');
        const videoPath    = path.join(RESULTS_DIR, `${clientChatId}_sample_video.mp4`);
        const videoRawPath = path.join(RESULTS_DIR, `${clientChatId}_sample_video_raw.mp4`);
        if (fs.existsSync(videoPath))    fs.unlinkSync(videoPath);
        if (fs.existsSync(videoRawPath)) fs.unlinkSync(videoRawPath);
        // Вызываем generate_visual_sample только для видео-слота
        const basePrompt = carPrompts[0].slice(0, 350);
        logSlotFeedback(basePrompt, 'video');
        const scenePrompts = [
          basePrompt + ' Wide establishing shot, smooth push-in camera. Photorealistic B-roll, no talking, no text.',
          (carPrompts[1] || basePrompt).slice(0, 350) + ' Close-up detail shot, slow motion. Photorealistic B-roll, no talking.',
          (carPrompts[2] || basePrompt).slice(0, 350) + ' Medium shot, gentle pan. Warm lighting. Photorealistic B-roll, no talking.',
          (carPrompts[3] || basePrompt).slice(0, 350) + ' Overhead top-down shot, slow tilt. Natural light. Photorealistic B-roll, no talking.',
        ];
        const taskIds  = await Promise.all(scenePrompts.map(p => startVideo(p).catch(() => null)));
        const urls     = await Promise.all(taskIds.map(id => id ? pollTask(id, 900000, 'video') : null));
        const validUrls = urls.filter(Boolean);
        if (!validUrls.length) { await bot3Send(adminChatId, '❌ Veo3 не вернул ни одного фрагмента'); return; }
        const fragPaths = [];
        for (let i = 0; i < validUrls.length; i++) {
          const fp = path.join(TMP_DIR, `${clientChatId}_sregen_frag${i}.mp4`);
          if (await downloadToFile(validUrls[i], fp)) fragPaths.push(fp);
        }
        if (!fragPaths.length) { await bot3Send(adminChatId, '❌ Не удалось скачать фрагменты'); return; }
        const mergedPath = path.join(TMP_DIR, `${clientChatId}_sregen_merged.mp4`);
        fragPaths.length > 1 ? mergeVideoFragments(fragPaths, mergedPath) : fs.copyFileSync(fragPaths[0], mergedPath);
        const trimPath = path.join(TMP_DIR, `${clientChatId}_sregen_trim.mp4`);
        try { require('child_process').execSync(`"${FFMPEG_BIN}" -y -i "${mergedPath}" -t 30 -c:v libx264 -preset ultrafast -crf 23 -c:a copy "${trimPath}"`, { stdio: 'pipe' }); }
        catch { fs.copyFileSync(mergedPath, trimPath); }
        const rawSrc = fs.existsSync(trimPath) && fs.statSync(trimPath).size > 10000 ? trimPath : mergedPath;
        fs.copyFileSync(rawSrc, videoRawPath);
        const hookText  = prompts.videoHook  || '';
        const themeText = prompts.videoTheme || '';
        const ctaText   = prompts.videoCta   || '';
        const srt = buildTimedSrt(hookText, ctaText, 30, themeText);
        try { addTimedSubtitles(videoRawPath, srt, videoPath); } catch { fs.copyFileSync(videoRawPath, videoPath); }
        for (const f of [...fragPaths, mergedPath, trimPath]) { try { fs.unlinkSync(f); } catch {} }
        await bot3SendVideo(adminChatId, videoPath);
        const btnVideo = { inline_keyboard: [
          [{ text: '🔄 Переделать видео', callback_data: `vs_regen_v_${clientChatId}` }],
          [{ text: '✏️ Хук', callback_data: `vs_edit_hook_${clientChatId}` }, { text: '✏️ Тема', callback_data: `vs_edit_theme_${clientChatId}` }, { text: '✏️ CTA', callback_data: `vs_edit_cta_${clientChatId}` }],
        ]};
        const token = process.env.TELEGRAM_BOT3_TOKEN;
        const { default: fetchMsg } = await import('node-fetch');
        await fetchMsg(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: adminChatId, text: `🔄 Видео готово ✅\n\nХук: "${hookText}"\nТема: "${themeText}"\nCTA: "${ctaText}"`, reply_markup: btnVideo }),
        }).catch(() => {});
      }
    } catch (e) { await bot3Send(adminChatId, `⚠️ regen_sample_slot (${type}): ${e.message}`); }
  })().catch(e => console.error('[regen_sample_slot] error:', e.message));
});

// ── Visual Sample: перегенерация одного фрагмента видео ──────────────────────
app.post('/regen_sample_fragment', (req, res) => {
  const { clientChatId, fragIndex, feedback = '' } = req.body;
  if (!clientChatId || fragIndex === undefined) return res.status(400).json({ error: 'clientChatId and fragIndex required' });
  res.json({ ok: true });

  (async () => {
    const adminChatId = process.env.BOT3_MANAGER_CHAT_ID;
    const promptsFile = path.join(RESULTS_DIR, `${clientChatId}.free_prompts.json`);
    if (!fs.existsSync(promptsFile)) { await bot3Send(adminChatId, `❌ Промпты не найдены`); return; }

    const prompts       = JSON.parse(fs.readFileSync(promptsFile, 'utf8'));
    const fragPrompts   = prompts.videoFragmentPrompts || [];
    const basePrompt    = fragPrompts[fragIndex] || (prompts.carousel || [])[fragIndex] || '';

    if (!basePrompt) { await bot3Send(adminChatId, `❌ Промпт для фрагмента ${fragIndex + 1} не найден`); return; }

    if (feedback) logFeedback('video', basePrompt, feedback);
    const finalPrompt = feedback ? `${basePrompt}. IMPORTANT CHANGE: ${feedback}` : basePrompt;
    const fragSavedPath = path.join(RESULTS_DIR, `${clientChatId}_sample_frag_saved_${fragIndex}.mp4`);

    try {
      const taskId = await startVideo(finalPrompt).catch(() => null);
      if (!taskId) { await bot3Send(adminChatId, `❌ Veo3 не дал taskId для фрагмента ${fragIndex + 1}`); return; }
      const url = await pollTask(taskId, 900000, 'video');
      if (!url) { await bot3Send(adminChatId, `❌ Veo3 не вернул видео для фрагмента ${fragIndex + 1}`); return; }

      const { default: fetchNode } = await import('node-fetch');
      const r = await fetchNode(url);
      if (!r.ok) { await bot3Send(adminChatId, `❌ Не удалось скачать фрагмент ${fragIndex + 1}`); return; }
      fs.writeFileSync(fragSavedPath, Buffer.from(await r.arrayBuffer()));

      // Отправляем новый фрагмент с кнопками
      const token = process.env.TELEGRAM_BOT3_TOKEN;
      const FormData = (await import('form-data')).default;
      const form = new FormData();
      form.append('chat_id', adminChatId);
      form.append('video', fs.createReadStream(fragSavedPath));
      form.append('caption', `🔄 Фрагмент ${fragIndex + 1} — новая версия`);
      form.append('reply_markup', JSON.stringify({ inline_keyboard: [[
        { text: `✅ Оставить`, callback_data: `vs_frag_ok_${clientChatId}_${fragIndex}` },
        { text: `🔄 Переделать`, callback_data: `vs_frag_regen_${clientChatId}_${fragIndex}` },
      ]]}));
      await fetchNode(`https://api.telegram.org/bot${token}/sendVideo`, { method: 'POST', body: form }).catch(() => {});

      // Пересобираем итоговое видео с новым фрагментом
      const savedPaths = Array.from({length: 4}, (_, i) =>
        path.join(RESULTS_DIR, `${clientChatId}_sample_frag_saved_${i}.mp4`)
      ).filter(p => fs.existsSync(p));

      if (savedPaths.length >= 2) {
        const mergedPath   = path.join(TMP_DIR, `${clientChatId}_frag_remerged.mp4`);
        const trimPath     = path.join(TMP_DIR, `${clientChatId}_frag_retrim.mp4`);
        const videoRawPath = path.join(RESULTS_DIR, `${clientChatId}_sample_video_raw.mp4`);
        const videoPath    = path.join(RESULTS_DIR, `${clientChatId}_sample_video.mp4`);

        savedPaths.length > 1 ? mergeVideoFragments(savedPaths, mergedPath) : fs.copyFileSync(savedPaths[0], mergedPath);
        try { require('child_process').execSync(`"${FFMPEG_BIN}" -y -i "${mergedPath}" -t 30 -c:v libx264 -preset ultrafast -crf 23 -c:a copy "${trimPath}"`, { stdio: 'pipe' }); }
        catch { fs.copyFileSync(mergedPath, trimPath); }

        const rawSrc = fs.existsSync(trimPath) && fs.statSync(trimPath).size > 10000 ? trimPath : mergedPath;
        fs.copyFileSync(rawSrc, videoRawPath);
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);

        const hookText  = prompts.videoHook  || '';
        const themeText = prompts.videoTheme || '';
        const ctaText   = prompts.videoCta   || '';
        const srt = buildTimedSrt(hookText, ctaText, 30, themeText);
        try { addTimedSubtitles(videoRawPath, srt, videoPath); } catch { fs.copyFileSync(videoRawPath, videoPath); }
        for (const f of [mergedPath, trimPath]) { try { fs.unlinkSync(f); } catch {} }

        const btnVideo = { inline_keyboard: [
          [{ text: '🔄 Переделать видео', callback_data: `vs_regen_v_${clientChatId}` }],
          [{ text: '✏️ Хук', callback_data: `vs_edit_hook_${clientChatId}` }, { text: '✏️ Тема', callback_data: `vs_edit_theme_${clientChatId}` }, { text: '✏️ CTA', callback_data: `vs_edit_cta_${clientChatId}` }],
        ]};
        await bot3SendVideo(adminChatId, videoPath);
        const { default: fetchMsg } = await import('node-fetch');
        await fetchMsg(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: adminChatId, text: `✅ Итоговое видео пересобрано с новым фрагментом ${fragIndex + 1}`, reply_markup: btnVideo }),
        }).catch(() => {});
      }
    } catch (e) { await bot3Send(adminChatId, `⚠️ regen_sample_fragment: ${e.message}`); }
  })().catch(e => console.error('[regen_sample_fragment] error:', e.message));
});

// ── Visual Sample: изменить текст на картинке ─────────────────────────────────
app.post('/edit_sample_text', (req, res) => {
  const { clientChatId, type, index = 0, text } = req.body;
  if (!clientChatId || !type || text === undefined) return res.status(400).json({ error: 'clientChatId, type, text required' });
  res.json({ ok: true });

  (async () => {
    const adminChatId = process.env.BOT3_MANAGER_CHAT_ID;
    const promptsFile = path.join(RESULTS_DIR, `${clientChatId}.free_prompts.json`);
    if (!fs.existsSync(promptsFile)) { await bot3Send(adminChatId, `❌ Промпты не найдены`); return; }

    const prompts = JSON.parse(fs.readFileSync(promptsFile, 'utf8'));

    const applyOverlay = async (rawPath, ovPath, overlayText, position, sizeKey) => {
      if (!fs.existsSync(rawPath)) return false;
      try { const buf = fs.readFileSync(rawPath); const p = await overlayTextOnImage(buf, overlayText, position, sizeKey); fs.writeFileSync(ovPath, p); return true; }
      catch { fs.copyFileSync(rawPath, ovPath); return false; }
    };
    const btnImg = (t, i = null) => ({ inline_keyboard: [[
      { text: '🔄 Переделать', callback_data: i !== null ? `vs_regen_${t}_${clientChatId}_${i}` : `vs_regen_${t}_${clientChatId}` },
      { text: '✏️ Изм. текст', callback_data: i !== null ? `vs_edit_${t}_${clientChatId}_${i}` : `vs_edit_${t}_${clientChatId}` },
      { text: '🚫 Без текста', callback_data: i !== null ? `vs_notxt_${t}_${clientChatId}_${i}` : `vs_notxt_${t}_${clientChatId}` },
    ]] });

    const freshOverlay = async (rawPath, ovPath, overlayText, position, sizeKey) => {
      if (!fs.existsSync(rawPath)) { await bot3Send(adminChatId, `❌ Raw-файл не найден: ${path.basename(rawPath)}`); return null; }
      if (fs.existsSync(ovPath)) fs.unlinkSync(ovPath);
      if (overlayText) {
        await applyOverlay(rawPath, ovPath, overlayText, position, sizeKey);
      } else {
        fs.copyFileSync(rawPath, ovPath); // без текста — просто копируем raw
      }
      return fs.existsSync(ovPath) ? ovPath : rawPath;
    };

    // text === '' означает запрос "без текста"
    const noText = text === '';

    try {
      if (type === 'c') {
        const i = Number(index);
        const rawPath = path.join(RESULTS_DIR, `${clientChatId}_sample_car_raw_${i}.jpg`);
        const ovPath  = path.join(RESULTS_DIR, `${clientChatId}_sample_car_${i}.jpg`);
        const send = await freshOverlay(rawPath, ovPath, noText ? '' : text, 'bottom', 'carousel');
        const label = noText ? `🚫 Слайд ${i + 1} — без текста` : `✏️ Слайд ${i + 1} обновлён: "${text}"`;
        if (send) await bot3SendPhotoFile(adminChatId, send, label, btnImg('c', i));
        if (!prompts.carouselTexts) prompts.carouselTexts = [];
        prompts.carouselTexts[i] = text;

      } else if (type === 'ph') {
        const rawPath = path.join(RESULTS_DIR, `${clientChatId}_sample_photo_raw.jpg`);
        const ovPath  = path.join(RESULTS_DIR, `${clientChatId}_sample_photo.jpg`);
        const send = await freshOverlay(rawPath, ovPath, noText ? '' : text, 'bottom', 'photo');
        if (send) await bot3SendPhotoFile(adminChatId, send, noText ? '🚫 Фото-пост — без текста' : `✏️ Фото-пост обновлён: "${text}"`, btnImg('ph'));
        prompts.photoTitle = noText ? '' : text;

      } else if (type === 'co') {
        const rawPath = path.join(RESULTS_DIR, `${clientChatId}_sample_cover_raw.jpg`);
        const ovPath  = path.join(RESULTS_DIR, `${clientChatId}_sample_cover.jpg`);
        const send = await freshOverlay(rawPath, ovPath, noText ? '' : text, 'bottom', 'cover');
        if (send) await bot3SendPhotoFile(adminChatId, send, noText ? '🚫 Обложка — без текста' : `✏️ Обложка обновлена: "${text}"`, btnImg('co'));
        prompts.coverTitle = noText ? '' : text;

      } else if (type === 'st') {
        const rawPath = path.join(RESULTS_DIR, `${clientChatId}_sample_story_raw.jpg`);
        const ovPath  = path.join(RESULTS_DIR, `${clientChatId}_sample_story.jpg`);
        const send = await freshOverlay(rawPath, ovPath, noText ? '' : text, 'bottom', 'story');
        if (send) await bot3SendPhotoFile(adminChatId, send, noText ? '🚫 Сторис — без текста' : `✏️ Сторис обновлён: "${text}"`, btnImg('st'));

      } else if (type === 'hook' || type === 'theme' || type === 'cta') {
        // Переналожить текст на raw-видео с новым хуком/CTA
        const videoPath    = path.join(RESULTS_DIR, `${clientChatId}_sample_video.mp4`);
        const videoRawPath = path.join(RESULTS_DIR, `${clientChatId}_sample_video_raw.mp4`);
        if (!fs.existsSync(videoRawPath)) { await bot3Send(adminChatId, '❌ Raw-видео не найдено. Перегенерируйте видео через 🔄 Переделать.'); return; }
        if (type === 'hook') prompts.videoHook = text;
        else if (type === 'theme') prompts.videoTheme = text;
        else prompts.videoCta = text;
        const hookText  = prompts.videoHook  || '';
        const themeText = prompts.videoTheme || '';
        const ctaText   = prompts.videoCta   || '';
        const srt = buildTimedSrt(hookText, ctaText, 30, themeText);
        if (fs.existsSync(videoPath)) fs.unlinkSync(videoPath);
        try { addTimedSubtitles(videoRawPath, srt, videoPath); } catch { fs.copyFileSync(videoRawPath, videoPath); }
        await bot3SendVideo(adminChatId, videoPath);
        const btnVideo = { inline_keyboard: [
          [{ text: '🔄 Переделать видео', callback_data: `vs_regen_v_${clientChatId}` }],
          [{ text: '✏️ Хук', callback_data: `vs_edit_hook_${clientChatId}` }, { text: '✏️ Тема', callback_data: `vs_edit_theme_${clientChatId}` }, { text: '✏️ CTA', callback_data: `vs_edit_cta_${clientChatId}` }],
        ]};
        const token = process.env.TELEGRAM_BOT3_TOKEN;
        const { default: fetch } = await import('node-fetch');
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: adminChatId, text: `✏️ Видео обновлено\n\nХук: "${hookText}"\nТема: "${themeText}"\nCTA: "${ctaText}"`, reply_markup: btnVideo }),
        }).catch(() => {});
      }

      // Сохраняем обновлённые тексты
      fs.writeFileSync(promptsFile, JSON.stringify(prompts, null, 2));
    } catch (e) { await bot3Send(adminChatId, `⚠️ edit_sample_text (${type}): ${e.message}`); }
  })().catch(e => console.error('[edit_sample_text] error:', e.message));
});

// ── Переналожить текст на существующее видео без регенерации ──────────────────
app.post('/resample_video_text', (req, res) => {
  const { clientChatId, hookText, themeText, ctaText } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });

  (async () => {
    const adminChatId = process.env.BOT3_MANAGER_CHAT_ID;
    const videoPath   = path.join(RESULTS_DIR, `${clientChatId}_sample_video.mp4`);
    const finalPath   = path.join(RESULTS_DIR, `${clientChatId}_sample_video_new.mp4`);

    if (!fs.existsSync(videoPath)) {
      await bot3Send(adminChatId, `❌ Видео для chatId ${clientChatId} не найдено.\nСначала запусти /visual_sample ${clientChatId}`);
      return;
    }

    // Если тексты не переданы — генерируем автоматически
    let hook = hookText, theme = themeText, cta = ctaText;
    if (!hook && !theme && !cta) {
      await bot3Send(adminChatId, '⏳ Генерирую тексты для видео через Claude...');
      const promptsFile = path.join(RESULTS_DIR, `${clientChatId}.free_prompts.json`);
      const prompts = fs.existsSync(promptsFile)
        ? JSON.parse(fs.readFileSync(promptsFile, 'utf8')).carousel || []
        : [];
      const generated = await generateVideoTextsForSample(clientChatId, prompts);
      hook = generated.hookText; theme = generated.themeText; cta = generated.ctaText;
    }

    await bot3Send(adminChatId, `🎬 Переналагаю текст на видео...\n\nХук: "${hook}"\nТема: "${theme}"\nCTA: "${cta}"`);

    try {
      const srt = buildTimedSrt(hook || '', cta || '', 30, theme || '');
      addTimedSubtitles(videoPath, srt, finalPath);

      // Заменяем старый файл новым
      fs.copyFileSync(finalPath, videoPath);
      fs.unlinkSync(finalPath);

      await bot3SendVideo(adminChatId, videoPath);
      await bot3Send(adminChatId, '✅ Готово — новый текст наложен на старое видео');
    } catch (e) {
      await bot3Send(adminChatId, `❌ Ошибка: ${e.message}`);
    }
  })().catch(e => console.error('[resample_video_text] error:', e.message));
});

// Раздаём HTML-страницы бесплатного пакета
app.get('/pack/:clientId', (req, res) => {
  const htmlFile = path.join(PACK_PAGES_DIR, `${req.params.clientId}.html`);
  if (!fs.existsSync(htmlFile)) return res.status(404).send('Страница не найдена');
  res.sendFile(htmlFile);
});

// Раздаём изображения из visual_results по URL /images/{filename}
app.use('/images', express.static(RESULTS_DIR));

app.post('/generate', (req, res) => {
  const { clientChatId, maxVideos, maxPerSection } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  runVisualGeneration(String(clientChatId), { maxVideos, maxPerSection }).catch(e =>
    console.error('[visual] error for', clientChatId, e.message)
  );
});

// Called by Bot3: regenerate one video based on manager feedback
app.post('/regen_video', (req, res) => {
  const { clientChatId, videoIndex, feedback, subtitleOverride } = req.body;
  if (!clientChatId || videoIndex === undefined) return res.status(400).json({ error: 'missing params' });
  res.json({ ok: true });
  if (subtitleOverride !== undefined) {
    regenSubtitle(String(clientChatId), Number(videoIndex), subtitleOverride).catch(e =>
      console.error('[visual] regen_subtitle error', e.message)
    );
  } else {
    regenVideo(String(clientChatId), Number(videoIndex), feedback || '').catch(e =>
      console.error('[visual] regen_video error', e.message)
    );
  }
});

// Called by index.js: translate video subtitles to a second language
app.post('/translate_videos', (req, res) => {
  const { clientChatId, targetLang } = req.body;
  if (!clientChatId || !targetLang) return res.status(400).json({ error: 'missing params' });
  res.json({ ok: true });
  translateVideos(String(clientChatId), targetLang).catch(e =>
    console.error('[visual] translate_videos error', e.message)
  );
});

// Generate carousel slides + cover for free package
app.post('/generate_free_visuals', (req, res) => {
  const { clientChatId, carouselScript, coverExample, photoExample } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  generateFreeVisuals(String(clientChatId), carouselScript || '', coverExample || '', photoExample || '').catch(e =>
    console.error('[visual] generate_free_visuals error', e.message)
  );
});

// Только создаёт free_prompts.json без генерации изображений — для демо-пакета
app.post('/prepare_demo_prompts', async (req, res) => {
  const { clientChatId, carouselScript, coverExample, photoExample } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  try {
    const [carouselPrompts, coverPrompts] = await Promise.all([
      getImagePrompts(carouselScript || '', 'carousel', 5),
      getImagePrompts(coverExample   || '', 'cover',    1),
    ]);
    const carouselTexts    = extractSlideTexts(carouselScript || '', 'carousel');
    const carouselCaptions = carouselPrompts.map((_, i) => extractSlideCaption(carouselScript || '', i + 1) || '');
    const coverTitleMatch  = (coverExample || '').match(/Заголовок на обложке\s*[:\-–]\s*(.+)/i);
    const coverTitle       = coverTitleMatch ? wordSlice(coverTitleMatch[1].trim(), 6) : '';
    const photoTitleMatch  = (photoExample || '').match(/Заголовок поста\s*[:\-–]\s*(.+)/i);
    const photoTitle       = photoTitleMatch ? wordSlice(photoTitleMatch[1].trim(), 6) : '';
    const photoCaptionMatch = (photoExample || '').match(/Подпись к посту\s*[:\-–]\s*([\s\S]+?)(?:\n\n|\nХэштеги|\nПочему|$)/i);
    const photoCaption     = photoCaptionMatch ? photoCaptionMatch[1].trim().slice(0, 500) : '';

    fs.writeFileSync(
      path.join(RESULTS_DIR, `${clientChatId}.free_prompts.json`),
      JSON.stringify({ carousel: carouselPrompts, cover: coverPrompts, carouselTexts, carouselCaptions, coverTitle, photoTitle, photoCaption, savedAt: Date.now() }, null, 2)
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('[prepare_demo_prompts] error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ── /test_overlay — тест наложения текста на уже готовые изображения (без генерации) ──
app.post('/test_overlay', (req, res) => {
  const { clientChatId } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  testOverlayOnCachedImages(String(clientChatId)).catch(e =>
    console.error('[visual] test_overlay error', e.message)
  );
});

async function testOverlayOnCachedImages(clientChatId) {
  const { default: fetch } = await import('node-fetch');
  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  if (!fs.existsSync(resultPath)) {
    await bot3Send(clientChatId, `❌ Нет кэша для ${clientChatId}. Сначала запусти /test_paid.`);
    return;
  }
  const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const results = data.results || data;
  const allUrls = [
    ...(results.photos || []),
    ...(results.carouselSlides || []),
    ...(results.stories || []),
    ...(results.covers || []),
  ].filter(Boolean);

  if (allUrls.length === 0) {
    await bot3Send(clientChatId, `❌ Нет URL изображений в кэше.`);
    return;
  }

  await bot3Send(clientChatId, `🎨 Тест overlay (новый метод: sharp+canvas)\n${Math.min(3, allUrls.length)} изображений...`);

  const testTexts = ['Тест текста работает', 'Test overlay works', 'Проверка шрифта ✓'];
  let sent = 0;

  for (let i = 0; i < Math.min(3, allUrls.length); i++) {
    try {
      const resp = await fetch(allUrls[i]);
      const buf  = await resp.buffer();

      let overlaid;
      try {
        overlaid = await overlayTextOnImage(buf, testTexts[i], i === 1 ? 'center' : 'bottom');
      } catch (oe) {
        await bot3Send(clientChatId, `❌ overlay error [${i}]: ${oe.message}`);
        continue;
      }

      // Проверяем что буфер реально изменился
      const changed = !Buffer.from(buf).equals(Buffer.from(overlaid));
      const outPath = path.join(RESULTS_DIR, `${clientChatId}_ov_${i}.jpg`);
      fs.writeFileSync(outPath, overlaid);
      await bot3SendPhotoFile(clientChatId, outPath, `Test ${i + 1} | changed=${changed} | "${testTexts[i]}"`);
      sent++;
    } catch (e) {
      await bot3Send(clientChatId, `❌ img ${i}: ${e.message}`);
    }
  }

  await bot3Send(clientChatId, `✅ Готово: ${sent}/${Math.min(3, allUrls.length)} отправлено.\nЕсли на фото видна тёмная полоса с текстом — фикс работает.`);
}

// ── /test_carousel — 7 slides from cached results, alternating RU/EN/LV ─────────

app.post('/test_carousel', (req, res) => {
  const { clientChatId } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  testCarouselOverlay(String(clientChatId)).catch(e =>
    console.error('[visual] test_carousel error', e.message)
  );
});

async function testCarouselOverlay(clientChatId) {
  const { default: fetch } = await import('node-fetch');
  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  if (!fs.existsSync(resultPath)) {
    await bot3Send(clientChatId, `❌ Нет кэша для ${clientChatId}.`);
    return;
  }
  const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const results = data.results || data;
  const slides = [
    ...(results.carouselSlides || []),
    ...(results.photos || []),
  ].filter(Boolean).slice(0, 7);

  if (slides.length === 0) {
    await bot3Send(clientChatId, `❌ Нет слайдов в кэше.`);
    return;
  }

  // Alternating RU / EN / LV texts for 7 slides
  const texts = [
    'Как удвоить продажи без бюджета',
    'How to double your revenue',
    'Kā divkāršot savus ieņēmumus',
    'Ваш контент работает на вас',
    'Your content works for you',
    'Jūsu saturs strādā jūsu vietā',
    'Начните сегодня — напишите нам',
  ];
  const langs = ['🇷🇺 RU', '🇬🇧 EN', '🇱🇻 LV', '🇷🇺 RU', '🇬🇧 EN', '🇱🇻 LV', '🇷🇺 RU'];

  await bot3Send(clientChatId, `🎠 Тест карусели (${slides.length} слайдов, RU+EN+LV)...`);

  let sent = 0;
  for (let i = 0; i < slides.length; i++) {
    try {
      const resp = await fetch(slides[i]);
      const buf = await resp.buffer();
      const overlaid = await overlayTextOnImage(buf, texts[i], 'bottom', 'carousel');
      const outPath = path.join(RESULTS_DIR, `${clientChatId}_carousel_${i}.jpg`);
      fs.writeFileSync(outPath, overlaid);
      await bot3SendPhotoFile(clientChatId, outPath, `Слайд ${i + 1} ${langs[i]}: "${texts[i]}"`);
      sent++;
    } catch (e) {
      await bot3Send(clientChatId, `❌ Слайд ${i + 1}: ${e.message}`);
    }
  }

  await bot3Send(clientChatId, `✅ Карусель: ${sent}/${slides.length} слайдов отправлено.`);
}

// ── /test_carousel_variants — 3 варианта формата карусели на одних изображениях ──────

app.post('/test_carousel_variants', (req, res) => {
  const { clientChatId } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  testCarouselVariants(String(clientChatId)).catch(e =>
    console.error('[visual] test_carousel_variants error', e.message)
  );
});

async function testCarouselVariants(clientChatId) {
  const { default: fetch } = await import('node-fetch');
  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  if (!fs.existsSync(resultPath)) {
    await bot3Send(clientChatId, `❌ Нет кэша для ${clientChatId}.`);
    return;
  }
  const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const results = data.results || data;
  const slides = [...(results.carouselSlides || [])].filter(Boolean).slice(0, 3);

  if (slides.length === 0) {
    await bot3Send(clientChatId, `❌ Нет слайдов в кэше.`);
    return;
  }

  const hooks = [
    'Контент без плана — деньги на ветер',
    'Один пост = один новый клиент',
    'Напишите нам — получите план',
  ];
  const captions = [
    'Большинство бизнесов публикует хаотично и теряет аудиторию. Системный контент удерживает внимание и конвертирует в клиентов.',
    'Каждый пост должен вести к цели. Мы создаём контент который работает — не просто красивые картинки.',
    'Готовый контент-план на месяц уже ждёт. Напишите — пришлём пример для вашей ниши бесплатно.',
  ];

  // Загружаем изображения один раз
  const buffers = [];
  for (const url of slides) {
    try {
      const resp = await fetch(url);
      buffers.push(await resp.buffer());
    } catch { buffers.push(null); }
  }

  // ВАРИАНТ 1: хук на изображении, без подписи
  await bot3Send(clientChatId, `━━━━━━━━━━━━━━\n📌 ВАРИАНТ 1\nХук поверх изображения — подписи нет`);
  for (let i = 0; i < buffers.length; i++) {
    if (!buffers[i]) continue;
    try {
      const overlaid = await overlayTextOnImage(buffers[i], hooks[i], 'bottom', 'carousel');
      const outPath = path.join(RESULTS_DIR, `${clientChatId}_cv1_${i}.jpg`);
      fs.writeFileSync(outPath, overlaid);
      await bot3SendPhotoFile(clientChatId, outPath, '');
    } catch (e) { await bot3Send(clientChatId, `❌ V1 слайд ${i + 1}: ${e.message}`); }
  }

  // ВАРИАНТ 2: хук на изображении + подпись под каждым слайдом (как фото-пост)
  await bot3Send(clientChatId, `━━━━━━━━━━━━━━\n📌 ВАРИАНТ 2\nХук поверх изображения + текст под каждым слайдом (как фото-пост)`);
  for (let i = 0; i < buffers.length; i++) {
    if (!buffers[i]) continue;
    try {
      const overlaid = await overlayTextOnImage(buffers[i], hooks[i], 'bottom');
      const outPath = path.join(RESULTS_DIR, `${clientChatId}_cv2_${i}.jpg`);
      fs.writeFileSync(outPath, overlaid);
      await bot3SendPhotoFile(clientChatId, outPath, captions[i]);
    } catch (e) { await bot3Send(clientChatId, `❌ V2 слайд ${i + 1}: ${e.message}`); }
  }

  // ВАРИАНТ 3: слайд 1 — только оверлей (обложка), слайды 2-3 — оверлей + подпись
  await bot3Send(clientChatId, `━━━━━━━━━━━━━━\n📌 ВАРИАНТ 3\nСлайд 1 — только оверлей (обложка), остальные — оверлей + текст`);
  for (let i = 0; i < buffers.length; i++) {
    if (!buffers[i]) continue;
    try {
      const overlaid = await overlayTextOnImage(buffers[i], hooks[i], 'bottom');
      const outPath = path.join(RESULTS_DIR, `${clientChatId}_cv3_${i}.jpg`);
      fs.writeFileSync(outPath, overlaid);
      await bot3SendPhotoFile(clientChatId, outPath, i === 0 ? '' : captions[i]);
    } catch (e) { await bot3Send(clientChatId, `❌ V3 слайд ${i + 1}: ${e.message}`); }
  }

  await bot3Send(clientChatId, `✅ Тест завершён. Три варианта выше — выбери формат для карусели.`);
}

// ── /test_video_overlay — 1 video from library, SRT with RU hook + EN CTA ────────

app.post('/test_video_overlay', (req, res) => {
  const { clientChatId } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  testVideoOverlay(String(clientChatId)).catch(e =>
    console.error('[visual] test_video_overlay error', e.message)
  );
});

async function testVideoOverlay(clientChatId) {
  // Find newest .mp4 in library
  const mp4s = fs.readdirSync(LIBRARY_DIR)
    .filter(f => f.endsWith('.mp4'))
    .map(f => ({ f, t: fs.statSync(path.join(LIBRARY_DIR, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);

  if (mp4s.length === 0) {
    await bot3Send(clientChatId, `❌ В библиотеке нет видео.`);
    return;
  }

  const srcVideoPath = path.join(LIBRARY_DIR, mp4s[0].f);
  await bot3Send(clientChatId, `🎬 Тест видео-оверлея (хук + тема + CTA)...\nФайл: ${mp4s[0].f}`);

  const rawDuration = getVideoDuration(srcVideoPath);
  const MAX_DURATION = 30;
  const trimPath = path.join(TMP_DIR, `${clientChatId}_test_trimmed.mp4`);
  let videoPath = srcVideoPath;
  if (rawDuration > MAX_DURATION + 2) {
    execSync(`"${FFMPEG_BIN}" -y -i "${srcVideoPath}" -t ${MAX_DURATION} -c copy "${trimPath}"`, { stdio: 'pipe' });
    videoPath = trimPath;
  }
  const duration  = Math.min(rawDuration, MAX_DURATION);
  const hookText  = 'Это изменит ваш маркетинг';
  const themeText = 'Маркетинг без бюджета';
  const ctaText   = 'Write to us — get a free plan';
  const srtContent = buildTimedSrt(hookText, ctaText, duration, themeText);

  const outPath = path.join(TMP_DIR, `${clientChatId}_test_video.mp4`);
  try {
    addTimedSubtitles(videoPath, srtContent, outPath);
    await bot3Send(clientChatId,
      `Хук (0–4 сек): "${hookText}"\n` +
      `Тема (${Math.round(duration*0.35)}-${Math.round(duration*0.65)} сек): "${themeText}"\n` +
      `CTA (последние 8 сек): "${ctaText}"\n` +
      `Длина: ${Math.round(duration)} сек (исходник: ${Math.round(rawDuration)} сек)`
    );
    await bot3SendVideo(clientChatId, outPath);
    await bot3Send(clientChatId, `✅ Видео-оверлей готов.`);
  } catch (e) {
    await bot3Send(clientChatId, `❌ ffmpeg error: ${e.message}`);
  } finally {
    for (const f of [outPath, trimPath]) {
      if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch {}
    }
  }
}

// ── /test_mini — 1 карусель + 1 фото + 1 видео (библиотека) + 1 обложка — реальная генерация ──

app.post('/test_mini', (req, res) => {
  const { clientChatId } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  testMini(req.body).catch(e => console.error('[visual] test_mini error', e.message));
});

// Извлекает все "Промпт для изображения:" из первой КАРУСЕЛИ
function extractFirstCarouselImagePrompts(carouselScripts, maxSlides = 7) {
  if (!carouselScripts) return [];
  // Берём блок КАРУСЕЛЬ 1
  const blockMatch = carouselScripts.match(
    /(?:КАРУСЕЛЬ|CAROUSEL)\s*1[:\s][^\n]*\n([\s\S]*?)(?=\n(?:КАРУСЕЛЬ|CAROUSEL)\s*2|$)/i
  );
  const block = blockMatch ? blockMatch[1] : carouselScripts;
  const prompts = block
    .split('\n')
    .filter(l => /Промпт для изображения:/i.test(l))
    .map(l => l.replace(/^Промпт для изображения:\s*/i, '').trim())
    .filter(p => p.length > 5 && !p.startsWith('['))
    .slice(0, maxSlides);
  if (prompts.length > 0) return prompts;
  // Fallback: любые "Промпт для AI" строки
  return block
    .split('\n')
    .filter(l => /Промпт для AI/i.test(l))
    .map(l => l.replace(/^[^:]+:\s*/, '').trim())
    .filter(p => p.length > 5 && !p.startsWith('['))
    .slice(0, maxSlides);
}

// Извлекает промпт первого фото-поста
function extractFirstPhotoImagePrompt(photoScripts) {
  if (!photoScripts) return null;
  const m = photoScripts.match(/Промпт для AI-генерации:\s*([^\n]+)/i);
  return m ? m[1].trim() : null;
}

// Извлекает промпт первой обложки
function extractFirstCoverImagePrompt(covers) {
  if (!covers) return null;
  const m = covers.match(/Промпт для AI(?:-генерации)?:\s*([^\n]+)/i);
  return m ? m[1].trim() : null;
}

async function testMini({ clientChatId, carouselScripts, photoScripts, videoScripts, covers, ctaPreference, leadMagnet }) {
  const { default: fetch } = await import('node-fetch');

  // Останавливаем авторестарт старой полной генерации — удаляем visual.json
  const oldVisualJson = path.join(VISUAL_DIR, `${clientChatId}.visual.json`);
  if (fs.existsSync(oldVisualJson)) {
    try { fs.renameSync(oldVisualJson, oldVisualJson + '.bak'); } catch {}
    console.log(`[test_mini] Остановлена старая генерация для ${clientChatId}`);
  }

  await bot3Send(clientChatId, `🧪 Мини-тест запущен\n1 карусель · 1 фото · 1 видео · 1 обложка\nРеальная генерация через Kie.ai`);

  const carouselPrompts = extractFirstCarouselImagePrompts(carouselScripts, 7);
  const photoPrompt     = extractFirstPhotoImagePrompt(photoScripts);
  const coverPrompt     = extractFirstCoverImagePrompt(covers);

  // Сохраняем промпты в results.json чтобы кнопки 🔄 работали с feedback
  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  const miniData = {
    prompts: {
      carouselPrompts,
      photoPrompts:  photoPrompt  ? [photoPrompt]  : [],
      coverPrompts:  coverPrompt  ? [coverPrompt]  : [],
      storyPrompts:  [],
    },
    results: { carouselSlides: [], photos: [], covers: [], stories: [] },
  };
  fs.writeFileSync(resultPath, JSON.stringify(miniData, null, 2));

  // ── 1. КАРУСЕЛЬ (7 слайдов) ────────────────────────────────────────────────
  await bot3Send(clientChatId, `🎠 Карусель: запускаю ${carouselPrompts.length} слайдов...`);
  if (carouselPrompts.length > 0) {
    const taskIds    = await Promise.all(carouselPrompts.map(p => startImage(p, '1:1').catch(() => null)));
    const urls       = await Promise.all(taskIds.map(id => id ? pollTask(id, 900000, 'image') : null));
    const slideTexts = extractSlideTexts(carouselScripts, 'carousel');
    let sent = 0;
    for (let i = 0; i < Math.min(urls.length, 7); i++) {
      if (!urls[i]) { await bot3Send(clientChatId, `⚠️ Слайд ${i + 1}: нет URL`); continue; }
      try {
        const resp    = await fetch(urls[i]);
        const buf     = await resp.buffer();
        const hook    = slideTexts[i] || '';
        const caption = extractSlideCaption(carouselScripts, i + 1);
        const out     = hook ? await overlayTextOnImage(buf, hook, 'bottom', 'carousel') : buf;
        const outPath = path.join(RESULTS_DIR, `${clientChatId}_mini_car_${i}.jpg`);
        fs.writeFileSync(outPath, out);
        // Сохраняем URL для preview_edit
        miniData.results.carouselSlides[i] = urls[i];
        fs.writeFileSync(resultPath, JSON.stringify(miniData, null, 2));
        await bot3SendPhotoFile(clientChatId, outPath, caption || '', {
          inline_keyboard: [[
            { text: '🔄 Переделать', callback_data: `ri_ca_${i}_${clientChatId}` },
            { text: '✏️ Изм. текст',  callback_data: `et_ca_${i}_${clientChatId}` },
          ]],
        });
        sent++;
      } catch (e) { await bot3Send(clientChatId, `❌ Слайд ${i + 1}: ${e.message}`); }
    }
    await bot3Send(clientChatId, `✅ Карусель: ${sent}/${Math.min(urls.length, 7)} слайдов`);
  } else {
    await bot3Send(clientChatId, `⚠️ Промпты карусели не найдены в сценарии.`);
  }

  // ── 2. ФОТО-ПОСТ ───────────────────────────────────────────────────────────
  if (photoPrompt) {
    await bot3Send(clientChatId, `📸 Фото-пост: генерирую...`);
    const taskId = await startImage(photoPrompt, '1:1').catch(() => null);
    const url    = await pollTask(taskId, 900000, 'image');
    if (url) {
      try {
        const resp    = await fetch(url);
        const buf     = await resp.buffer();
        const texts   = extractSlideTexts(photoScripts, 'photos');
        const caption = extractFirstPhotoCaption(photoScripts);
        const out     = texts[0] ? await overlayTextOnImage(buf, texts[0], 'bottom', 'photo') : buf;
        const outPath = path.join(RESULTS_DIR, `${clientChatId}_mini_photo.jpg`);
        fs.writeFileSync(outPath, out);
        miniData.results.photos[0] = url;
        fs.writeFileSync(resultPath, JSON.stringify(miniData, null, 2));
        await bot3SendPhotoFile(clientChatId, outPath, caption || 'Фото-пост', {
          inline_keyboard: [[
            { text: '🔄 Переделать', callback_data: `ri_ph_0_${clientChatId}` },
            { text: '✏️ Изм. текст',  callback_data: `et_ph_0_${clientChatId}` },
          ]],
        });
        await bot3Send(clientChatId, `✅ Фото-пост готов`);
      } catch (e) { await bot3Send(clientChatId, `❌ Фото: ${e.message}`); }
    } else {
      await bot3Send(clientChatId, `⚠️ Kie.ai не вернул фото.`);
    }
  } else {
    await bot3Send(clientChatId, `⚠️ Промпт для фото не найден.`);
  }

  // ── 3. ВИДЕО (библиотека + текст overlay) ─────────────────────────────────
  const mp4s = fs.existsSync(LIBRARY_DIR)
    ? fs.readdirSync(LIBRARY_DIR)
        .filter(f => f.endsWith('.mp4'))
        .map(f => ({ f, t: fs.statSync(path.join(LIBRARY_DIR, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
    : [];
  if (mp4s.length > 0) {
    const { hookText, themeText, ctaText } = extractVideoTexts(videoScripts, ctaPreference, leadMagnet);
    await bot3Send(clientChatId,
      `🎬 Видео (библиотека + overlay):\nХук: "${hookText}"\nТема: "${themeText}"\nCTA: "${ctaText}"`
    );
    const srcPath  = path.join(LIBRARY_DIR, mp4s[0].f);
    // rawPath сохраняем в RESULTS_DIR (постоянная папка) — нужен для редактирования текста
    const rawPath  = path.join(RESULTS_DIR, `${clientChatId}_mini_raw.mp4`);
    const outPath  = path.join(TMP_DIR, `${clientChatId}_mini_video.mp4`);
    try {
      // Перекодируем чтобы ffmpeg применил rotate-метаданные физически
      execSync(
        `"${FFMPEG_BIN}" -y -i "${srcPath}" -t 30 -c:v libx264 -preset ultrafast -crf 23 -c:a copy "${rawPath}"`,
        { stdio: 'pipe' }
      );
      const usePath = fs.existsSync(rawPath) && fs.statSync(rawPath).size > 1000 ? rawPath : srcPath;
      addTimedSubtitles(usePath, buildTimedSrt(hookText, ctaText, 30, themeText), outPath);
      await bot3SendVideo(clientChatId, outPath);
      // Сохраняем скрипт и rawPath — нужны для редактирования текста
      miniData.videoScripts   = videoScripts;
      miniData.videoTexts     = { hookText, themeText, ctaText };
      miniData.miniVideoRawPath = rawPath;
      fs.writeFileSync(resultPath, JSON.stringify(miniData, null, 2));
      await bot3Send(clientChatId, `✅ Видео готово`, {
        inline_keyboard: [[
          { text: '🔄 Переделать видео', callback_data: `mini_rv_0_${clientChatId}` },
          { text: '✏️ Изм. текст',       callback_data: `et_video_0_${clientChatId}` },
        ]],
      });
    } catch (e) {
      await bot3Send(clientChatId, `❌ Видео: ${e.message}`);
    } finally {
      if (fs.existsSync(outPath)) try { fs.unlinkSync(outPath); } catch {}
      // rawPath НЕ удаляем — нужен для редактирования текста
    }
  } else {
    await bot3Send(clientChatId, `⚠️ Библиотека видео пуста. Добавь .mp4 в video_library/`);
  }

  // ── 4. ОБЛОЖКА (9:16) ─────────────────────────────────────────────────────
  if (coverPrompt) {
    await bot3Send(clientChatId, `🖼 Обложка: генерирую (9:16)...`);
    const taskId = await startImage(coverPrompt, '9:16').catch(() => null);
    const url    = await pollTask(taskId, 900000, 'image');
    if (url) {
      try {
        const resp    = await fetch(url);
        const buf     = await resp.buffer();
        const outPath = path.join(RESULTS_DIR, `${clientChatId}_mini_cover.jpg`);
        fs.writeFileSync(outPath, buf);
        miniData.results.covers[0] = url;
        fs.writeFileSync(resultPath, JSON.stringify(miniData, null, 2));
        await bot3SendPhotoFile(clientChatId, outPath, '🖼 Обложка для видео (Thumbnail 9:16)', {
          inline_keyboard: [[
            { text: '🔄 Переделать', callback_data: `ri_co_0_${clientChatId}` },
          ]],
        });
        await bot3Send(clientChatId, `✅ Обложка готова`);
      } catch (e) { await bot3Send(clientChatId, `❌ Обложка: ${e.message}`); }
    } else {
      await bot3Send(clientChatId, `⚠️ Kie.ai не вернул обложку.`);
    }
  } else {
    await bot3Send(clientChatId, `⚠️ Промпт для обложки не найден.`);
  }

  await bot3Send(clientChatId, `✅ Мини-тест завершён. Проверь результаты выше 👆`);
}

// ── /test_full_client — карусель + пост + видео по реальным сценариям клиента ─────

app.post('/test_full_client', (req, res) => {
  const { clientChatId } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  testFullClient(req.body).catch(e =>
    console.error('[visual] test_full_client error', e.message)
  );
});

async function testFullClient({ clientChatId, carouselScripts, photoScripts, videoScripts, ctaPreference, leadMagnet }) {
  const { default: fetch } = await import('node-fetch');

  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  if (!fs.existsSync(resultPath)) {
    await bot3Send(clientChatId, `❌ Нет кэша изображений для ${clientChatId}. Запусти /retry_visual сначала.`);
    return;
  }
  const data    = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const results = data.results || data;

  await bot3Send(clientChatId, `🚀 Тест: карусель + пост + видео по реальным данным клиента`);

  // ── 1. КАРУСЕЛЬ ────────────────────────────────────────────────────────────────
  const slideUrls   = (results.carouselSlides || []).filter(Boolean);
  const slideTexts  = carouselScripts ? extractSlideTexts(carouselScripts, 'carousel') : [];
  const photoUrls   = (results.photos || []).filter(Boolean);

  if (slideUrls.length > 0) {
    await bot3Send(clientChatId, `🎠 Карусель (${Math.min(slideUrls.length, 7)} слайдов)...`);
    let sentSlides = 0;
    for (let i = 0; i < Math.min(slideUrls.length, 7); i++) {
      try {
        const resp = await fetch(slideUrls[i]);
        const buf  = await resp.buffer();
        const hookText = slideTexts[i] || '';
        const caption  = carouselScripts ? extractSlideCaption(carouselScripts, i + 1) : '';
        const overlaid = (hookText && hookText !== 'без текста')
          ? await overlayTextOnImage(buf, hookText, 'bottom', 'carousel')
          : buf;
        const outPath = path.join(RESULTS_DIR, `${clientChatId}_fc_car_${i}.jpg`);
        fs.writeFileSync(outPath, overlaid);
        await bot3SendPhotoFile(clientChatId, outPath, caption || '');
        sentSlides++;
      } catch (e) {
        await bot3Send(clientChatId, `❌ Слайд ${i + 1}: ${e.message}`);
      }
    }
    await bot3Send(clientChatId, `✅ Карусель: ${sentSlides} слайдов`);
  } else {
    await bot3Send(clientChatId, `⚠️ Нет слайдов карусели в кэше.`);
  }

  // ── 2. ФОТО-ПОСТ ───────────────────────────────────────────────────────────────
  const photoOverlayTexts = photoScripts ? extractSlideTexts(photoScripts, 'photos') : [];
  const photoCaption = extractFirstPhotoCaption(photoScripts);

  if (photoUrls.length > 0) {
    await bot3Send(clientChatId, `📸 Фото-пост...`);
    try {
      const resp = await fetch(photoUrls[0]);
      const buf  = await resp.buffer();
      const overlayText = photoOverlayTexts[0] || '';
      const overlaid = overlayText
        ? await overlayTextOnImage(buf, overlayText, 'bottom', 'photo')
        : buf;
      const outPath = path.join(RESULTS_DIR, `${clientChatId}_fc_photo.jpg`);
      fs.writeFileSync(outPath, overlaid);
      await bot3SendPhotoFile(clientChatId, outPath, photoCaption || 'Фото-пост');
      await bot3Send(clientChatId, `✅ Фото-пост готов`);
    } catch (e) {
      await bot3Send(clientChatId, `❌ Фото: ${e.message}`);
    }
  } else {
    await bot3Send(clientChatId, `⚠️ Нет фото в кэше.`);
  }

  // ── 3. ВИДЕО ───────────────────────────────────────────────────────────────────
  const mp4s = fs.existsSync(LIBRARY_DIR)
    ? fs.readdirSync(LIBRARY_DIR)
        .filter(f => f.endsWith('.mp4'))
        .map(f => ({ f, t: fs.statSync(path.join(LIBRARY_DIR, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t)
    : [];

  if (mp4s.length > 0) {
    const { hookText, themeText, ctaText } = extractVideoTexts(videoScripts, ctaPreference, leadMagnet);
    await bot3Send(clientChatId,
      `🎬 Видео (хук + тема + CTA)...\nХук: "${hookText}"\nТема: "${themeText}"\nCTA: "${ctaText}"`
    );
    const srcVideoPath = path.join(LIBRARY_DIR, mp4s[0].f);
    // Always trim to 30s — don't rely on ffprobe (may not exist in Railway)
    const MAX_DURATION = 30;
    const trimPath = path.join(TMP_DIR, `${clientChatId}_fc_trimmed.mp4`);
    let videoPath = srcVideoPath;
    try {
      execSync(`"${FFMPEG_BIN}" -y -i "${srcVideoPath}" -t ${MAX_DURATION} -c copy "${trimPath}"`, { stdio: 'pipe' });
      if (fs.existsSync(trimPath) && fs.statSync(trimPath).size > 1000) videoPath = trimPath;
    } catch (e) {
      console.error('[visual] trim failed, using original:', e.message);
    }
    const duration   = MAX_DURATION;
    const srtContent = buildTimedSrt(hookText, ctaText, duration, themeText);
    const outPath    = path.join(TMP_DIR, `${clientChatId}_fc_video.mp4`);
    try {
      addTimedSubtitles(videoPath, srtContent, outPath);
      await bot3SendVideo(clientChatId, outPath);
      await bot3Send(clientChatId, `✅ Видео готово (${Math.round(duration)} сек)`);
    } catch (e) {
      await bot3Send(clientChatId, `❌ Видео ffmpeg: ${e.message}`);
    } finally {
      for (const f of [outPath, trimPath]) {
        if (fs.existsSync(f)) try { fs.unlinkSync(f); } catch {}
      }
    }
  } else {
    await bot3Send(clientChatId, `⚠️ В библиотеке нет видео.`);
  }

  await bot3Send(clientChatId, `✅ Тест завершён.`);
}

// Generate one real photo for free package
app.post('/generate_free_photo', (req, res) => {
  const { clientChatId, prompt } = req.body;
  if (!clientChatId || !prompt) return res.status(400).json({ error: 'clientChatId and prompt required' });
  res.json({ ok: true });
  generateFreePhoto(String(clientChatId), prompt).catch(e =>
    console.error('[visual] generate_free_photo error', e.message)
  );
});

// ── Custom video by manager scenario ─────────────────────────────────────────
app.post('/custom_video', (req, res) => {
  const { scenario, chatId } = req.body;
  if (!scenario || !chatId) return res.status(400).json({ error: 'scenario and chatId required' });
  res.json({ ok: true });
  (async () => {
    const { default: fetch } = await import('node-fetch');
    const { ask, HAIKU } = require('./src/claude');
    try {
      await bot3Send(chatId, `🎬 Конвертирую сценарий в промпт для Veo3...`);
      // Конвертируем произвольный сценарий в структурированное ТЗ для generateOneVideo
      const videoScript = await ask(
        `Convert this video scenario into a structured AI video ТЗ format for Veo3 generation.\n\nScenario: ${scenario}\n\nOutput format (plain text, no markdown):\nВИДЕО 1: [theme]\nДлительность: [5/7/10 seconds]\nНастроение: [mood]\nЧто в кадре: [scene description]\nДвижение камеры: [camera movement]\nОсвещение: [lighting]\nЦвета: [colors]\nПромпт для AI-видео: [English prompt 1-2 sentences for Veo3, no people, B-roll]\nЭмоция зрителя: [max 35 chars]`,
        { model: HAIKU, maxTokens: 600 }
      );
      const result = await generateOneVideo(videoScript, 0, chatId, '');
      if (result?.localPath && fs.existsSync(result.localPath)) {
        await bot3SendVideo(chatId, result.localPath);
        await bot3Send(chatId, `✅ Видео по вашему сценарию готово`, {
          inline_keyboard: [[
            { text: '🔄 Переделать', callback_data: `custom_video_regen_${chatId}` },
          ]],
        });
      } else {
        await bot3Send(chatId, `❌ Не удалось сгенерировать видео. Попробуйте ещё раз.`);
      }
    } catch (e) {
      console.error('[visual] custom_video error:', e.message);
      await bot3Send(chatId, `❌ Ошибка: ${e.message}`);
    }
  })().catch(e => console.error('[visual] custom_video fatal:', e.message));
});

// ── Custom carousel by manager scenario ──────────────────────────────────────
app.post('/custom_carousel', (req, res) => {
  const { scenario, hookTexts, chatId } = req.body;
  if (!scenario || !chatId) return res.status(400).json({ error: 'scenario and chatId required' });
  res.json({ ok: true });
  (async () => {
    const { ask, HAIKU } = require('./src/claude');
    const { default: fetch } = await import('node-fetch');
    try {
      await bot3Send(chatId, `🎠 Генерирую карусель по вашему сценарию (7 слайдов)...`);
      // Генерируем промпты для 7 слайдов
      const slideData = await ask(
        `Create 7 carousel slides for this topic: "${scenario}"\n\nFor each slide output (plain text):\nКАДР [N]:\nТекст поверх фото: [3-6 words in Russian]\nПодпись к посту: [1-2 sentences]\nПромпт для изображения: [English — NO text in image, atmospheric]\n`,
        { model: HAIKU, maxTokens: 1500 }
      );
      const prompts = extractFirstCarouselImagePrompts(slideData, 7);
      const slideTexts = extractSlideTexts(slideData, 'carousel');
      if (!prompts.length) {
        await bot3Send(chatId, `❌ Не удалось извлечь промпты из сценария.`); return;
      }
      const taskIds = await Promise.all(prompts.map(p => startImage(p, '1:1').catch(() => null)));
      const urls    = await Promise.all(taskIds.map(id => id ? pollTask(id, 900000, 'image') : null));
      let sent = 0;
      for (let i = 0; i < Math.min(urls.length, 7); i++) {
        if (!urls[i]) continue;
        const resp = await fetch(urls[i]);
        const buf  = await resp.buffer();
        const hook = slideTexts[i] || '';
        const caption = extractSlideCaption(slideData, i + 1);
        const out  = hook ? await overlayTextOnImage(buf, hook, 'bottom', 'carousel') : buf;
        const outPath = path.join(RESULTS_DIR, `custom_carousel_${chatId}_${i}.jpg`);
        fs.writeFileSync(outPath, out);
        await bot3SendPhotoFile(chatId, outPath, caption || '', {
          inline_keyboard: [[
            { text: '🔄 Переделать слайд', callback_data: `ri_ca_${i}_${chatId}` },
            { text: '✏️ Изм. текст',       callback_data: `et_ca_${i}_${chatId}` },
          ]],
        });
        sent++;
      }
      await bot3Send(chatId, `✅ Карусель по вашему сценарию: ${sent}/7 слайдов`);
    } catch (e) {
      console.error('[visual] custom_carousel error:', e.message);
      await bot3Send(chatId, `❌ Ошибка: ${e.message}`);
    }
  })().catch(e => console.error('[visual] custom_carousel fatal:', e.message));
});

// Called by Bot3: regenerate one image slot for free package
app.post('/regen_free_image', (req, res) => {
  const { clientChatId, slotCode } = req.body;
  if (!clientChatId || !slotCode) return res.status(400).json({ error: 'clientChatId and slotCode required' });
  res.json({ ok: true });
  regenFreeImage(String(clientChatId), slotCode).catch(e =>
    console.error('[visual] regen_free_image error', e.message)
  );
});

// Called by Bot3: regenerate a non-video section
app.post('/regen', (req, res) => {
  const { clientChatId, section } = req.body;
  if (!clientChatId || !section) return res.status(400).json({ error: 'missing params' });
  res.json({ ok: true });
  regenSection(String(clientChatId), section).catch(e =>
    console.error('[visual] regen error', e.message)
  );
});

// Called by Bot3: regenerate one individual image item (photo/slide/cover/story)
app.post('/regen_item', (req, res) => {
  const { clientChatId, section, index, feedback } = req.body;
  if (!clientChatId || !section || index === undefined) return res.status(400).json({ error: 'missing params' });
  res.json({ ok: true });
  regenItem(String(clientChatId), section, Number(index), feedback || '').catch(e =>
    console.error('[visual] regen_item error', e.message)
  );
});

// Preview edited text overlaid on existing image — called after manager edits text in testMini
app.post('/preview_edit', (req, res) => {
  const { clientChatId, section, index, text } = req.body;
  if (!clientChatId || !section || index === undefined) return res.status(400).json({ error: 'missing params' });
  res.json({ ok: true });
  previewTextEdit(String(clientChatId), section, Number(index), text || '').catch(e =>
    console.error('[visual] preview_edit error', e.message)
  );
});

async function previewTextEdit(clientChatId, section, index, text) {
  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  if (!fs.existsSync(resultPath)) return;

  const SECTION_MAP = {
    ph: { key: 'photos',         localKey: 'photosLocalPaths',         label: 'Фото',    size: 'photo' },
    ca: { key: 'carouselSlides', localKey: 'carouselSlidesLocalPaths', label: 'Слайд',   size: 'carousel' },
    co: { key: 'covers',         localKey: 'coversLocalPaths',         label: 'Обложка', size: 'photo' },
    st: { key: 'stories',        localKey: 'storiesLocalPaths',        label: 'Story',   size: 'photo' },
  };
  const info = SECTION_MAP[section];
  if (!info) return;

  // Читаем данные ДО тяжёлой обработки — только для получения пути к raw-файлу
  const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const localPaths = (data.results || {})[info.localKey] || [];
  const rawPath = localPaths[index]
    ? localPaths[index].replace('_ov.jpg', '.jpg').replace('_ov.png', '.png')
    : null;

  let buf;
  if (rawPath && fs.existsSync(rawPath)) {
    buf = fs.readFileSync(rawPath);
  } else {
    // Фолбэк: скачать с URL
    const url = ((data.results || {})[info.key] || [])[index];
    if (!url) {
      const chatId = process.env.BOT3_MANAGER_CHAT_ID;
      if (chatId) await bot3Send(chatId, `⚠️ ${info.label} ${index + 1}: исходный файл не найден — пересгенерируйте изображение.`);
      return;
    }
    const { default: fetch } = await import('node-fetch');
    const resp = await fetch(url);
    buf = await resp.buffer();
  }

  // Тяжёлая обработка — вне лока (параллельно для разных элементов)
  const out = text ? await overlayTextOnImage(buf, text, 'bottom', info.size) : buf;
  const ovPath = rawPath
    ? rawPath.replace('.jpg', '_ov.jpg').replace('.png', '_ov.png')
    : path.join(RESULTS_DIR, `${clientChatId}_edited_${section}_${index}.jpg`);
  fs.writeFileSync(ovPath, out);

  // Обновляем results.json внутри лока — защита от гонки при параллельных правках
  await withResultsLock(clientChatId, () => {
    const fresh = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    if (!fresh.results[info.localKey]) fresh.results[info.localKey] = [];
    fresh.results[info.localKey][index] = ovPath;
    fs.writeFileSync(resultPath, JSON.stringify(fresh, null, 2));
  });

  // Обновляем HTML-страницу клиента с исправленным изображением
  try {
    const { updatePackPagePhoto, updatePackPageCover, updatePackPageCarousel } = require('./src/site_builder');
    const freshData = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    if (section === 'ph') {
      updatePackPagePhoto(clientChatId, ovPath);
    } else if (section === 'co') {
      updatePackPageCover(clientChatId, ovPath);
    } else if (section === 'ca') {
      const allSlides = (freshData.results || {}).carouselSlidesLocalPaths || [];
      updatePackPageCarousel(clientChatId, allSlides);
    }
  } catch (e) {
    console.error('[visual] updatePackPage after edit error:', e.message);
  }

  await bot3SendPhotoFile(
    process.env.BOT3_MANAGER_CHAT_ID || clientChatId,
    ovPath,
    `🖼 ${info.label} ${index + 1} — новый текст применён`,
    { inline_keyboard: [[
      { text: '✅ Принять',      callback_data: `ri_accept_${section}_${index}_${clientChatId}` },
      { text: '✏️ Изм. снова',   callback_data: `et_${section}_${index}_${clientChatId}` },
      { text: '🔄 Переделать',   callback_data: `ri_${section}_${index}_${clientChatId}` },
    ]] }
  );
}

// ── Убрать текст с изображения (paid + free пакет) ───────────────────────────
app.post('/remove_text_overlay', (req, res) => {
  const { clientChatId, section, index } = req.body;
  if (!clientChatId || !section || index === undefined) return res.status(400).json({ error: 'missing params' });
  res.json({ ok: true });

  (async () => {
    const adminChatId = process.env.BOT3_MANAGER_CHAT_ID;
    const resultPath  = path.join(RESULTS_DIR, `${clientChatId}.results.json`);

    const SECTION_MAP = {
      carousel: { key: 'carouselSlides', code: 'ca', label: 'Слайд', position: 'bottom', sizeKey: 'carousel' },
      photos:   { key: 'photos',         code: 'ph', label: 'Фото',  position: 'bottom', sizeKey: 'photo'   },
      covers:   { key: 'covers',         code: 'co', label: 'Обложка', position: 'bottom', sizeKey: 'cover' },
      stories:  { key: 'stories',        code: 'st', label: 'Story', position: 'bottom', sizeKey: 'story'   },
    };
    const info = SECTION_MAP[section];
    if (!info) { await bot3Send(adminChatId, `❌ Неизвестный раздел: ${section}`); return; }

    try {
      const { default: fetch } = await import('node-fetch');
      let rawPath = null;

      // Бесплатный пакет — ищем локальный файл
      if (!fs.existsSync(resultPath)) {
        const freeVisualsPath = path.join(RESULTS_DIR, `${clientChatId}.free_visuals.json`);
        if (!fs.existsSync(freeVisualsPath)) { await bot3Send(adminChatId, `❌ Результаты не найдены`); return; }
        const fv = JSON.parse(fs.readFileSync(freeVisualsPath, 'utf8'));

        if (section === 'covers') {
          const localFile = path.join(RESULTS_DIR, `${clientChatId}_free_cover0.jpg`);
          if (fs.existsSync(localFile)) {
            rawPath = localFile;
          } else if (fv.coverUrls?.[index]) {
            rawPath = path.join(RESULTS_DIR, `${clientChatId}_free_cover${index}_notxt.jpg`);
            const r = await fetch(fv.coverUrls[index]); if (!r.ok) { await bot3Send(adminChatId, `❌ Не удалось загрузить обложку`); return; }
            fs.writeFileSync(rawPath, Buffer.from(await r.arrayBuffer()));
          }
        } else if (section === 'carousel') {
          const localFile = path.join(RESULTS_DIR, `${clientChatId}_free_carousel${index}.jpg`);
          if (fs.existsSync(localFile)) {
            rawPath = localFile;
          } else if (fv.carouselUrls?.[index]) {
            rawPath = path.join(RESULTS_DIR, `${clientChatId}_free_car${index}_notxt.jpg`);
            const r = await fetch(fv.carouselUrls[index]); if (!r.ok) { await bot3Send(adminChatId, `❌ Не удалось загрузить слайд`); return; }
            fs.writeFileSync(rawPath, Buffer.from(await r.arrayBuffer()));
          }
        }
        if (!rawPath) { await bot3Send(adminChatId, `❌ Файл не найден для ${info.label} ${index + 1}`); return; }
      } else {
        // Платный пакет — читаем из results.json
        const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        const url = ((data.results || {})[info.key] || [])[index];
        if (!url) { await bot3Send(adminChatId, `❌ URL не найден для ${info.label} ${index + 1}`); return; }
        rawPath = path.join(RESULTS_DIR, `${clientChatId}_${info.code}_${index}_notxt.jpg`);
        const resp = await fetch(url); const buf = await resp.buffer();
        fs.writeFileSync(rawPath, buf);
      }

      const outPath = rawPath;

      await bot3SendPhotoFile(adminChatId, outPath,
        `🚫 ${info.label} ${index + 1} — без текста`,
        { inline_keyboard: [[
          { text: '🔄 Переделать', callback_data: `ri_${info.code}_${index}_${clientChatId}` },
          { text: '✏️ Добавить текст', callback_data: `et_${info.code}_${index}_${clientChatId}` },
        ]] }
      );
    } catch (e) { await bot3Send(adminChatId, `⚠️ remove_text_overlay: ${e.message}`); }
  })().catch(e => console.error('[remove_text_overlay] error:', e.message));
});

app.get('/library_stats', (req, res) => {
  res.json({ video: libraryStats(), photo: photoLibraryStats() });
});

// ── Сохранить одобренный контент в библиотеку ─────────────────────────────────
// Вызывается из index.js когда менеджер одобряет пакет
app.post('/save_approved_content', (req, res) => {
  const { clientChatId, packageType } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });

  (async () => {
    const usedPhotoIds = [];
    const usedVideoIds = [];

    try {
      if (packageType === 'free') {
        // Бесплатный: carousel raw + cover + free photo
        const promptsFile = path.join(RESULTS_DIR, `${clientChatId}.free_prompts.json`);
        const carouselPrompts = fs.existsSync(promptsFile)
          ? (JSON.parse(fs.readFileSync(promptsFile, 'utf8')).carousel || [])
          : [];

        // Карусель
        for (let i = 0; ; i++) {
          const rawPath = path.join(RESULTS_DIR, `${clientChatId}_sample_car_raw_${i}.jpg`);
          if (!fs.existsSync(rawPath)) break;
          const tags = await extractImageTags(carouselPrompts[i] || '');
          const id = await saveToPhotoLibrary(rawPath, carouselPrompts[i] || '', tags, 'carousel');
          if (id) usedPhotoIds.push(id);
        }

        // Обложка
        const coverRaw = path.join(RESULTS_DIR, `${clientChatId}_sample_cover_raw.jpg`);
        if (fs.existsSync(coverRaw)) {
          const coverPrompt = fs.existsSync(promptsFile)
            ? (JSON.parse(fs.readFileSync(promptsFile, 'utf8')).cover || [])[0] || ''
            : '';
          const tags = await extractImageTags(coverPrompt);
          const id = await saveToPhotoLibrary(coverRaw, coverPrompt, tags, 'cover');
          if (id) usedPhotoIds.push(id);
        }

        // Фото-пост
        const photoRaw = path.join(RESULTS_DIR, `${clientChatId}_sample_photo_raw.jpg`);
        if (fs.existsSync(photoRaw)) {
          const tags = await extractImageTags('');
          const id = await saveToPhotoLibrary(photoRaw, '', tags, 'photo');
          if (id) usedPhotoIds.push(id);
        }

      } else if (packageType === 'paid') {
        // Платный: читаем из results.json
        const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
        if (fs.existsSync(resultPath)) {
          const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
          const res2 = data.results || {};

          // Читаем оригинальные промпты из visual.json чтобы теги были осмысленными
          const pkgPath2 = path.join(VISUAL_DIR, `${clientChatId}.visual.json`);
          const promptsMap = { photo: [], carousel: [], story: [], cover: [] };
          if (fs.existsSync(pkgPath2)) {
            const pkg2 = JSON.parse(fs.readFileSync(pkgPath2, 'utf8'));
            promptsMap.photo    = extractByPrefix(pkg2.photoScripts    || '', 'Промпт для AI-генерации');
            promptsMap.carousel = extractByPrefix(pkg2.carouselScripts || '', 'Изображение слайда');
            promptsMap.story    = extractByPrefix(pkg2.storiesScripts  || '', 'Промпт для AI-генерации');
            promptsMap.cover    = extractByPrefix(pkg2.covers          || '', 'Промпт для AI');
          }

          // Фото и карусели — из localPath если есть
          const allImages = [
            ...(res2.photos         || []).map((_, i) => ({ section: 'photo',    idx: i })),
            ...(res2.carouselSlides || []).map((_, i) => ({ section: 'carousel', idx: i })),
            ...(res2.stories        || []).map((_, i) => ({ section: 'story',    idx: i })),
            ...(res2.covers         || []).map((_, i) => ({ section: 'cover',    idx: i })),
          ];

          for (const { section, idx } of allImages) {
            const ovFile = path.join(RESULTS_DIR, `${clientChatId}_${section}_${idx}_ov.jpg`);
            const rawFile = path.join(RESULTS_DIR, `${clientChatId}_${section}_${idx}.jpg`);
            const filePath = fs.existsSync(ovFile) ? ovFile : fs.existsSync(rawFile) ? rawFile : null;
            if (!filePath) continue;
            const prompt = (promptsMap[section] || [])[idx] || '';
            const tags = await extractImageTags(prompt);
            const id = await saveToPhotoLibrary(filePath, prompt, tags, section);
            if (id) usedPhotoIds.push(id);
          }

          // Видео
          for (const vd of (res2.videoData || [])) {
            const vPath = vd?.rawPath || vd?.localPath;
            if (!vPath || !fs.existsSync(vPath)) continue;
            const tags = await extractVideoTags(vd.scenes?.[0] || '').catch(() => []);
            const id = await saveToLibrary(vPath, vd.scenes?.[0] || '', tags);
            if (id) usedVideoIds.push(id);
          }
        }
      }

      // Помечаем контент как использованный этим клиентом
      if (usedPhotoIds.length || usedVideoIds.length) {
        markContentUsed(clientChatId, usedPhotoIds, usedVideoIds);
        console.log(`[library] ${clientChatId}: saved ${usedPhotoIds.length} photos, ${usedVideoIds.length} videos`);
      }
    } catch (e) {
      console.error('[save_approved_content] error:', e.message);
    }
  })().catch(e => console.error('[save_approved_content] async error:', e.message));
});

// Вспомогательная: извлечь теги из промпта изображения
async function extractImageTags(prompt) {
  if (!prompt) return [];
  try {
    const { ask } = require('./src/claude');
    const HAIKU = 'claude-haiku-4-5-20251001';
    const result = await ask(
      `Extract 4-6 search tags from this image prompt. Tags should describe: subject, mood, style, color, setting.\nReturn ONLY a JSON array of lowercase English tags.\nPrompt: ${prompt.slice(0, 300)}`,
      { model: HAIKU, maxTokens: 100 }
    );
    const match = result.match(/\[[\s\S]*?\]/);
    return match ? JSON.parse(match[0]).slice(0, 6) : [];
  } catch { return []; }
}

app.post('/check_fragments', (req, res) => {
  const { clientChatId } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'missing clientChatId' });
  try {
    const files = fs.readdirSync(TMP_DIR).filter(f => f.startsWith(clientChatId) && f.endsWith('.mp4'));
    const fragFiles = files.filter(f => f.includes('_frag'));
    const report = fragFiles.length
      ? `Найдено ${fragFiles.length} фрагментов:\n` + fragFiles.map(f => {
          const size = Math.round(fs.statSync(path.join(TMP_DIR, f)).size / 1024);
          return `  ${f} (${size} KB)`;
        }).join('\n') + `\nffmpeg: ${FFMPEG_BIN}`
      : `Фрагментов для ${clientChatId} не найдено в ${TMP_DIR}.\nffmpeg: ${FFMPEG_BIN}`;
    res.json({ report, count: fragFiles.length, files: fragFiles });
  } catch (e) {
    res.json({ report: `Ошибка: ${e.message}`, count: 0 });
  }
});

app.post('/reapply_overlays', (req, res) => {
  const { clientChatId } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'missing clientChatId' });
  res.json({ ok: true });
  (async () => {
    const pkgPath    = path.join(VISUAL_DIR,    `${clientChatId}.visual.json`);
    const resultPath = path.join(RESULTS_DIR,   `${clientChatId}.results.json`);
    if (!fs.existsSync(pkgPath) || !fs.existsSync(resultPath)) {
      await bot3Send(process.env.BOT3_MANAGER_CHAT_ID, `❌ Нет данных для ${clientChatId}`);
      return;
    }
    const pkg  = JSON.parse(fs.readFileSync(pkgPath,    'utf8'));
    const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const res2 = data.results || {};
    await bot3Send(process.env.BOT3_MANAGER_CHAT_ID, `🎨 Накладываю текст на готовые материалы для ${pkg.clientName}...`);

    // Extract texts from new scripts
    const photoTexts    = extractSlideTexts(pkg.photoScripts    || '', 'photos');
    const storyTexts    = extractSlideTexts(pkg.storiesScripts  || '', 'stories');
    const coverTexts    = extractSlideTexts(pkg.covers          || '', 'covers');
    const carouselTexts = (() => {
      const result = [];
      const parts = (pkg.carouselScripts || '').split(/(?:^|\n)(?:КАРУСЕЛЬ|CAROUSEL)\s+\d+[:\s]/im);
      for (let c = 1; c < parts.length; c++) {
        const slideMap = {};
        for (const line of parts[c].split('\n')) {
          const m = line.match(/^Слайд\s+(\d+)(?:\s*\([^)]*\))?:\s*(.+)/i);
          if (m && !line.toLowerCase().includes('изображение')) slideMap[Number(m[1])] = m[2].trim().slice(0, 100);
        }
        const max = Math.max(0, ...Object.keys(slideMap).map(Number));
        for (let s = 1; s <= max; s++) result.push(slideMap[s] || '');
      }
      return result;
    })();

    // Reapply overlays to images
    if (res2.photos?.length)         { const lp = await applyAndSaveOverlays(res2.photos,        photoTexts,    clientChatId, 'photos',   'bottom'); await sendSectionImages(clientChatId, pkg.clientName, 'ph', '📸 Фото постов',  res2.photos,        'Фото',    lp); }
    if (res2.carouselSlides?.length) { const lp = await applyAndSaveOverlays(res2.carouselSlides, carouselTexts, clientChatId, 'carousel', 'bottom'); const cg = getCarouselGroups(pkg.carouselScripts, res2.carouselSlides.length); await notifyBot3SectionCarousels(clientChatId, pkg.clientName, res2.carouselSlides, cg, lp); }
    if (res2.stories?.length)        { const lp = await applyAndSaveOverlays(res2.stories,        storyTexts,    clientChatId, 'stories',  'center'); await sendSectionImages(clientChatId, pkg.clientName, 'st', '📱 Stories',       res2.stories,        'Story',   lp); }
    if (res2.covers?.length)         { const lp = await applyAndSaveOverlays(res2.covers,         coverTexts,    clientChatId, 'covers',   'bottom'); await sendSectionImages(clientChatId, pkg.clientName, 'co', '🖼 Обложки',        res2.covers,         'Обложка', lp); }

    // Reapply timed overlay to existing videos
    const ctaPref  = pkg.ctaPreference || '';
    const videoCTA = ctaPref === 'direct_magnet' ? `Напиши в директ — пришлю ${pkg.leadMagnet || 'подарок'}`.slice(0,50)
                   : ctaPref === 'direct_only'   ? 'Пиши в директ — отвечу на вопрос'
                   : 'Ссылка в bio ↑';
    const videoScripts = splitVideoScripts(pkg.videoScripts || '');
    const videoData    = res2.videoData || [];
    let vApplied = 0;
    for (let i = 0; i < videoData.length; i++) {
      const vd = videoData[i];
      if (!vd?.rawPath || !fs.existsSync(vd.rawPath)) continue;
      const vs   = videoScripts[i] || '';
      const { hook } = extractTimedTexts(vs, videoCTA);
      const tmpBase   = path.join(TMP_DIR, `${clientChatId}_v${i}_reoverlay`);
      const finalPath = `${tmpBase}_final.mp4`;
      try {
        const dur = getVideoDuration(vd.rawPath);
        const srt = buildTimedSrt(hook, videoCTA, dur);
        if (srt.trim()) addTimedSubtitles(vd.rawPath, srt, finalPath);
        else fs.copyFileSync(vd.rawPath, finalPath);
        data.results.videoData[i] = { ...vd, localPath: finalPath };
        await notifyBot3SingleVideo(clientChatId, i, videoData.length, finalPath, hook, []);
        vApplied++;
      } catch (e) { console.error(`[reoverlay] video ${i} error:`, e.message); }
    }
    fs.writeFileSync(resultPath, JSON.stringify(data, null, 2));
    await bot3Send(process.env.BOT3_MANAGER_CHAT_ID, `✅ Готово: текст наложен на все изображения и ${vApplied} видео.`);
  })().catch(e => console.error('[reapply_overlays] error:', e.message));
});

app.post('/merge_saved_fragments', (req, res) => {
  const { clientChatId } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'missing clientChatId' });
  res.json({ ok: true });
  (async () => {
    const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
    if (!fs.existsSync(resultPath)) { console.error('[merge] results.json not found'); return; }
    const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const videoData = data.results?.videoData || [];
    let merged = 0;
    for (let i = 0; i < videoData.length; i++) {
      const vd = videoData[i];
      if (!vd) continue;
      const fragPaths = (vd.fragPaths || []).filter(p => p && fs.existsSync(p));
      if (fragPaths.length <= 1) {
        console.log(`[merge] Видео ${i+1}: ${fragPaths.length} фрагментов — нечего склеивать`);
        continue;
      }
      const tmpBase  = path.join(TMP_DIR, `${clientChatId}_v${i}`);
      const mergedPath = `${tmpBase}_remerged.mp4`;
      try {
        mergeVideoFragments(fragPaths, mergedPath);
        const subtitleText = vd.subtitleText || '';
        const finalPath = `${tmpBase}_final_merged.mp4`;
        if (subtitleText) {
          try { addSubtitles(mergedPath, subtitleText, finalPath); }
          catch { fs.copyFileSync(mergedPath, finalPath); }
        } else {
          fs.copyFileSync(mergedPath, finalPath);
        }
        data.results.videoData[i] = { ...vd, localPath: finalPath, rawPath: mergedPath };
        fs.writeFileSync(resultPath, JSON.stringify(data, null, 2));
        await notifyBot3Regen(clientChatId, `видео ${i+1} (склеено ${fragPaths.length} фрагментов)`, finalPath);
        // Save to library
        const tags = await extractVideoTags(vd.scenes?.[0] || '').catch(() => []);
        saveToLibrary(mergedPath, vd.scenes?.[0] || '', tags).catch(() => {});
        merged++;
        console.log(`[merge] Видео ${i+1}: склеено ${fragPaths.length} фрагментов → ${finalPath}`);
      } catch (e) {
        console.error(`[merge] Видео ${i+1} ошибка:`, e.message);
      }
    }
    await bot3Send(process.env.BOT3_MANAGER_CHAT_ID, `✅ Склейка завершена: ${merged} видео пересобрано из сохранённых фрагментов.`);
  })().catch(e => console.error('[merge_saved_fragments] error:', e.message));
});

app.post('/cleanup_fragments', (req, res) => {
  const { clientChatId } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'missing clientChatId' });
  res.json({ ok: true });
  cleanupVideoFragments(String(clientChatId));
});

// ── Kie.ai API ─────────────────────────────────────────────────────────────────

async function kiePost(endpoint, body) {
  const { default: fetch } = await import('node-fetch');
  const r = await fetch(`${KIE_BASE}${endpoint}`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${KIE_API_KEY}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  const json = await r.json();
  console.log(`[kie] POST ${endpoint} → status=${r.status} resp=${JSON.stringify(json).slice(0, 200)}`);
  return json;
}

async function kieGet(taskId, taskType = 'image') {
  const endpoint = taskType === 'video' ? '/veo/record-info' : '/gpt4o-image/record-info';
  const { default: fetch } = await import('node-fetch');
  const r = await fetch(`${KIE_BASE}${endpoint}?taskId=${taskId}`, {
    headers: { Authorization: `Bearer ${KIE_API_KEY}` },
  });
  const json = await r.json();
  // Full log so we can see actual field names in Veo3 response
  console.log(`[kie] GET ${endpoint} httpStatus=${r.status} resp=${JSON.stringify(json)}`);
  return json;
}

// Генерация изображений через gpt4o-image (Kie.ai)
// API принимает ratio-строки: '1:1' (квадрат), '2:3' (вертикаль ~portrait)
// '9:16' не поддерживается — используем ближайший '2:3'
function kieSize(ratio) {
  if (ratio === '9:16' || ratio === '3:4') return '2:3';
  if (ratio === '16:9' || ratio === '4:3') return '3:2';
  return '1:1';
}

// Убирает инструкции по наложению текста из промпта — текст добавляется отдельно через overlay
function stripTextFromPrompt(prompt) {
  return prompt
    // Английские паттерны: "text overlay reads: «текст»"
    .replace(/[,.]?\s*(bold\s+)?(large\s+)?(white\s+)?(text\s+overlay|caption|label|text)\s+(reads|says|centered[^.]*reads?|at\s+\w+\s+reads?)[:\s]+[«"']?[^.»"'\n]{0,120}[»"']?/gi, '')
    .replace(/text\s+overlay[^.]*\./gi, '')
    .replace(/\bBold\s+(?:large\s+)?(?:white\s+)?text\s+overlay\b[^,.]*/gi, '')
    // Русские паттерны: "ОБЯЗАТЕЛЬНО включи заголовок/текст как надпись на изображении"
    .replace(/ОБЯЗАТЕЛЬНО\s+включи[^,.\n]{0,200}/gi, '')
    .replace(/включи\s+(заголовок|текст|надпись)[^,.\n]{0,150}/gi, '')
    .replace(/как\s+крупн[^,.\n]{0,100}(на\s+изображении|на\s+обложке|прямо\s+на)/gi, '')
    // Убираем «текст в кавычках» после "reads" / "надпись"
    .replace(/[«"][^»"]{0,120}[»"]/g, '')
    // Убираем структурные метки скрипта
    .replace(/КАДР\s+\d+[:\s]*/gi, '')
    .replace(/Текст поверх фото[:\s]+[^\n]*/gi, '')
    // Чистим артефакты
    .replace(/\s{2,}/g, ' ')
    .replace(/,\s*,/g, ',')
    .replace(/\.\s*\./g, '.')
    .trim();
}

// Ищет подходящее фото в библиотеке ДО обращения к Kie.ai
// Возвращает localPath если нашли, null если надо генерировать
async function tryPhotoLibrary(prompt, clientChatId, section = 'photo') {
  if (!clientChatId) return null;
  try {
    const tags = await extractImageTags(prompt);
    if (tags.length < 2) return null;
    const matches = searchPhotoLibrary(tags, clientChatId, 1, section);
    if (matches.length > 0 && matches[0].localPath) {
      console.log(`[photo-lib] Использую из библиотеки: ${matches[0].photoId} (совпадений: ${matches[0].matchCount})`);
      return matches[0].localPath;
    }
  } catch {}
  return null;
}

async function startImage(prompt, size = '1:1') {
  // Убираем текстовые инструкции из промпта — текст добавляется через overlay отдельно
  const cleanPrompt = stripTextFromPrompt(prompt);
  const lessons = getImageLessons();
  // Принудительный реалистичный стиль — для всех ниш, всегда
  // ВАЖНО: контекст бизнеса (арт-студия, галерея и т.п.) не должен влиять на СТИЛЬ съёмки
  const realisticSuffix = ' STYLE: real photograph only, shot on professional camera, photorealistic, natural lighting, candid documentary style. STRICTLY FORBIDDEN: painting, illustration, drawing, digital art, artwork, artistic style, canvas texture, brush strokes, watercolor, oil painting, sketch, cartoon, animation, render. The business context does NOT define the image style — always shoot as a real photo regardless of industry.';
  const finalImagePrompt = lessons ? `${cleanPrompt} ${lessons}${realisticSuffix}` : `${cleanPrompt}${realisticSuffix}`;
  const d = await kiePost('/gpt4o-image/generate', { prompt: finalImagePrompt, size: kieSize(size) });
  return d?.data?.taskId || d?.taskId || null;
}

async function startVideo(prompt) {
  const lessons = getVideoLessons();
  const baseVideoPrompt = lessons ? `${prompt} ${lessons}` : prompt;
  const enforcedPrompt = `${baseVideoPrompt}. Vertical 9:16 portrait format. ABSOLUTELY NO text, letters, words, subtitles, captions, watermarks, logos, or any written content anywhere in the video frame — this is strictly forbidden. Pure visual B-roll only. People only as background silhouettes or hands if needed.`;
  const d = await kiePost('/veo/generate', {
    prompt:         enforcedPrompt,
    model:          'veo3_fast',
    generationType: 'TEXT_2_VIDEO',
    aspectRatio:    '9:16',
    duration:       8,
  });
  // 402 = баланс Kie.ai исчерпан
  if (d?.code === 402) throw new Error('⚠️ Недостаточно кредитов Kie.ai — пополните баланс на app.kie.ai');
  return d?.data?.taskId || d?.taskId || null;
}

async function pollTask(taskId, maxMs = 900000, taskType = 'image') {
  if (!taskId) return null;
  const deadline = Date.now() + maxMs;
  let pollCount = 0;
  while (Date.now() < deadline) {
    await sleep(12000);
    pollCount++;
    try {
      const d = await kieGet(taskId, taskType);

      if (taskType === 'image') {
        // /gpt4o-image/record-info: data.status = "GENERATING" | "SUCCESS" | "CREATE_TASK_FAILED" | "GENERATE_FAILED"
        const state = d?.data?.status;
        if (pollCount % 3 === 1 || (state && state !== 'GENERATING')) {
          console.log(`[kie] poll#${pollCount} taskId=${taskId.slice(0,8)} imageStatus=${state}`);
        }
        if (state === 'SUCCESS') {
          const url = (d?.data?.response?.resultUrls || [])[0] || null;
          console.log(`[kie] image ${taskId}: SUCCESS url=${url ? url.slice(0, 80) : 'null'}`);
          return url;
        }
        if (state === 'CREATE_TASK_FAILED' || state === 'GENERATE_FAILED') {
          console.log(`[kie] image ${taskId}: ${state}`);
          return null;
        }
      } else {
        // /veo/record-info: successFlag=1 → done, errorCode!=null → fail
        const dd = d?.data || d || {};
        const successFlag = dd.successFlag;
        const errorCode   = dd.errorCode;
        if (pollCount % 3 === 1) {
          console.log(`[kie] poll#${pollCount} taskId=${taskId.slice(0,8)} successFlag=${successFlag} errorCode=${errorCode}`);
        }
        if (errorCode !== null && errorCode !== undefined) {
          console.log(`[kie] video ${taskId}: error errorCode=${errorCode} msg=${dd.errorMessage}`);
          return null;
        }
        if (successFlag === 1) {
          // response field: may be a URL string, object, or JSON string
          const resp = dd.response;
          console.log(`[kie] video ${taskId}: successFlag=1 response=${JSON.stringify(resp)}`);
          let url = null;
          if (typeof resp === 'string' && resp.startsWith('http')) {
            url = resp;
          } else if (typeof resp === 'object' && resp !== null) {
            url = resp.url || resp.videoUrl || resp.resultUrl
              || (resp.resultUrls || resp.videoUrls || [])[0]
              || null;
          } else if (typeof resp === 'string' && resp.length > 0) {
            try {
              const parsed = JSON.parse(resp);
              url = parsed?.url || parsed?.videoUrl || parsed?.resultUrl
                || (parsed?.resultUrls || parsed?.videoUrls || [])[0]
                || null;
            } catch {}
          }
          // Fallback: check other fields
          url = url || dd.url || dd.videoUrl || dd.resultUrl
            || (dd.resultUrls || dd.videoUrls || [])[0]
            || null;
          console.log(`[kie] video ${taskId}: URL=${url ? url.slice(0, 100) : 'null'}`);
          return url;
        }
      }
    } catch (e) { console.log(`[kie] pollTask ${taskId}: poll error ${e.message}`); }
  }
  console.log(`[kie] pollTask ${taskId}: timeout`);
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Carousel group detection ───────────────────────────────────────────────────

function getCarouselGroups(carouselScripts, totalSlides) {
  try {
    // Split by КАРУСЕЛЬ N: or CAROUSEL N: headers
    const parts = carouselScripts.split(/(?:^|\n)(?:КАРУСЕЛЬ|CAROUSEL)\s+\d+[:\s]/im);
    const groups = [];
    let remaining = totalSlides;
    for (let i = 1; i < parts.length && remaining > 0; i++) {
      // Считаем слайды: поддерживаем форматы КАДР N: (новый block7) и Изображение слайда (старый)
      const count = (parts[i].match(/(?:^|\n)\s*(?:КАДР|Изображение слайда|slide image)\s*\d+/gim) || []).length;
      if (count > 0) {
        const take = Math.min(count, remaining);
        groups.push(take);
        remaining -= take;
      }
    }
    if (groups.length > 0 && groups.reduce((a, b) => a + b, 0) === totalSlides) return groups;
  } catch { /* fall through */ }

  // Fallback: split by fixed size
  const groups = [];
  let rem = totalSlides;
  while (rem > 0) {
    groups.push(Math.min(SLIDES_PER_CAROUSEL_FALLBACK, rem));
    rem -= SLIDES_PER_CAROUSEL_FALLBACK;
  }
  return groups;
}

// ── Prompt extraction ──────────────────────────────────────────────────────────

function extractByPrefix(text, prefix) {
  return text
    .split('\n')
    .filter(l => l.trim().toLowerCase().startsWith(prefix.toLowerCase()))
    .map(l => l.slice(l.toLowerCase().indexOf(prefix.toLowerCase()) + prefix.length).replace(/^[\s:]+/, '').trim())
    .filter(p => p.length > 10 && !p.startsWith('['));
}

function extractByContains(text, prefix) {
  return text
    .split('\n')
    .filter(l => l.toLowerCase().includes(prefix.toLowerCase()))
    .map(l => {
      const idx = l.toLowerCase().indexOf(prefix.toLowerCase());
      return l.slice(idx + prefix.length).replace(/^[\s:]+/, '').trim();
    })
    .filter(p => p.length > 10 && !p.startsWith('['));
}

// Извлечение промптов через Claude Haiku как последний запасной вариант
async function extractPromptsViaAI(text, type) {
  const { ask } = require('./src/claude');
  const n = type === 'carousel' ? 5 : 1;
  const instruction = type === 'carousel'
    ? `Extract exactly ${n} English image generation prompts for carousel slides from the text below. Return ONLY a JSON array of ${n} English strings, nothing else.`
    : `Extract 1 English image generation prompt for a cover/thumbnail from the text below. Return ONLY a JSON array with 1 English string, nothing else.`;
  try {
    const result = await ask(`${instruction}\n\n${text.slice(0, 2500)}`, { model: HAIKU, maxTokens: 600 });
    const match = result.match(/\[[\s\S]*?\]/);
    if (match) {
      const arr = JSON.parse(match[0]).filter(p => typeof p === 'string' && p.length > 10);
      return arr.slice(0, n);
    }
  } catch (e) {
    console.error('[visual] extractPromptsViaAI error:', e.message);
  }
  return [];
}

// Трёхуровневое извлечение: startsWith → contains → Claude Haiku
async function getImagePrompts(text, type, maxCount) {
  const prefix = type === 'carousel' ? 'Изображение слайда' : 'Промпт для AI-генерации';

  let prompts = extractByPrefix(text, prefix).slice(0, maxCount);
  if (prompts.length > 0) {
    console.log(`[visual] prompts(${type}): ${prompts.length} via startsWith`);
    return prompts;
  }

  prompts = extractByContains(text, prefix).slice(0, maxCount);
  if (prompts.length > 0) {
    console.log(`[visual] prompts(${type}): ${prompts.length} via contains`);
    return prompts;
  }

  console.log(`[visual] prompts(${type}): prefix не найден → Claude Haiku`);
  console.log(`[visual] текст (первые 400 символов): ${text.slice(0, 400).replace(/\n/g, '↵')}`);
  prompts = await extractPromptsViaAI(text, type);
  console.log(`[visual] prompts(${type}): ${prompts.length} via Claude`);
  return prompts;
}

// ── Text overlay: text-to-svg converts glyphs to <path> data, sharp composites ───
// librsvg renders <path> elements perfectly; font rendering (scribbles) is bypassed

let _textRenderer = null;
function getTextRenderer() {
  if (_textRenderer) return _textRenderer;
  try {
    const TextToSVG = require('text-to-svg');
    const fontPath = path.join(__dirname, 'assets', 'Inter-Bold.ttf');
    if (fs.existsSync(fontPath)) {
      _textRenderer = TextToSVG.loadSync(fontPath);
      console.log('[visual] text-to-svg font loaded OK');
    } else {
      console.error('[visual] WARNING: Inter-Bold.ttf not found');
    }
  } catch (e) {
    console.error('[visual] text-to-svg load error:', e.message);
  }
  return _textRenderer;
}

function escapeXml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function wrapText(text, maxCharsPerLine) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  for (const word of words) {
    if ((current + ' ' + word).trim().length > maxCharsPerLine) {
      if (current) lines.push(current.trim());
      current = word;
    } else {
      current = (current + ' ' + word).trim();
    }
  }
  if (current) lines.push(current.trim());
  return lines;
}

// sizeKey определяет размер шрифта:
//   'carousel' — мелкий (много слайдов, мало места)
//   'photo'    — средний (один пост, стандарт)
//   'cover'    — крупный (одиночный большой кадр)
//   'story'    — крупный (9:16 вертикаль, читается с расстояния)
const FONT_DIVISOR = { carousel: 18, photo: 14, cover: 10, story: 10 };

// ── Лого клиента: наложение на изображение ───────────────────────────────────

function getLogoMeta(clientChatId) {
  const logoPath = path.join(RESULTS_DIR, `${clientChatId}.logo.png`);
  const metaPath = path.join(RESULTS_DIR, `${clientChatId}.logo.json`);
  if (!fs.existsSync(logoPath)) return null;
  let position = 'br';
  try { position = JSON.parse(fs.readFileSync(metaPath, 'utf8')).position || 'br'; } catch {}
  return { logoPath, position };
}

async function applyLogoToImage(imageBuffer, logoPath, position = 'br') {
  try {
    const sharp = require('sharp');
    const meta  = await sharp(imageBuffer).metadata();
    const w = meta.width;
    const h = meta.height;

    // Лого — 18% от ширины изображения
    const logoW = Math.round(w * 0.18);
    const logoResized = await sharp(logoPath).resize(logoW, null, { fit: 'inside' }).toBuffer();
    const logoMeta = await sharp(logoResized).metadata();
    const lw = logoMeta.width;
    const lh = logoMeta.height;
    const pad = Math.round(w * 0.04); // отступ 4%

    const left = position.endsWith('r') ? w - lw - pad : pad;
    const top  = position.startsWith('b') ? h - lh - pad : pad;

    return await sharp(imageBuffer)
      .composite([{ input: logoResized, left, top }])
      .toBuffer();
  } catch (e) {
    console.error('[logo] applyLogoToImage error:', e.message);
    return imageBuffer;
  }
}

async function applyLogoToVideo(videoPath, logoPath, outputPath, position = 'br') {
  try {
    const sharp = require('sharp');
    // Ресайзим лого до фиксированного размера для вертикального 9:16 видео (~180px шириной)
    const logoResized = await sharp(logoPath).resize(180, null, { fit: 'inside' }).toBuffer();
    const logoMeta    = await sharp(logoResized).metadata();
    const lw = logoMeta.width;
    const lh = logoMeta.height;
    const pad = 20;

    // Определяем overlay position для ffmpeg
    let overlayPos;
    if (position === 'br') overlayPos = `W-${lw + pad}:H-${lh + pad}`;
    else if (position === 'bl') overlayPos = `${pad}:H-${lh + pad}`;
    else if (position === 'tr') overlayPos = `W-${lw + pad}:${pad}`;
    else overlayPos = `${pad}:${pad}`; // tl

    const tmpLogo = path.join(TMP_DIR, `logo_tmp_${Date.now()}.png`);
    fs.writeFileSync(tmpLogo, logoResized);

    require('child_process').execSync(
      `"${FFMPEG_BIN}" -y -i "${videoPath}" -i "${tmpLogo}" -filter_complex "[1:v]format=rgba[logo];[0:v][logo]overlay=${overlayPos}" -c:v libx264 -preset ultrafast -crf 23 -c:a copy "${outputPath}"`,
      { stdio: 'pipe' }
    );
    try { fs.unlinkSync(tmpLogo); } catch {}
    return true;
  } catch (e) {
    console.error('[logo] applyLogoToVideo error:', e.message);
    return false;
  }
}

// Применяет лого к файлу изображения (читает, накладывает, перезаписывает)
async function applyLogoToFile(filePath, clientChatId) {
  const meta = getLogoMeta(clientChatId);
  if (!meta || !fs.existsSync(filePath)) return filePath;
  try {
    const buf = fs.readFileSync(filePath);
    const withLogo = await applyLogoToImage(buf, meta.logoPath, meta.position);
    const outPath = filePath.replace(/(\.\w+)$/, '_logo$1');
    fs.writeFileSync(outPath, withLogo);
    return outPath;
  } catch { return filePath; }
}

async function overlayTextOnImage(imageBuffer, text, position = 'bottom', sizeKey = 'photo') {
  if (!text || text === 'без текста' || text === 'no text') return imageBuffer;
  try {
    const sharp = require('sharp');
    const renderer = getTextRenderer();

    const meta = await sharp(imageBuffer).metadata();
    const w = meta.width;
    const h = meta.height;

    const divisor  = FONT_DIVISOR[sizeKey] || 14;
    const padH     = Math.round(w * 0.06); // 6% от ширины — горизонтальный отступ
    const fontSize = Math.max(24, Math.floor(w / divisor));
    // Ограничиваем maxChars с учётом горизонтального отступа с обеих сторон
    const effectiveW = w - padH * 2;
    const maxChars = Math.floor(effectiveW / (fontSize * 0.55));
    const lines    = wrapText(text.slice(0, 120), maxChars);
    const lineH    = Math.floor(fontSize * 1.5);
    const barH     = lineH * lines.length + 48;
    const barY     = position === 'center' ? Math.floor((h - barH) / 2) : h - barH;

    let pathEls = '';
    if (renderer) {
      // Convert each line of text to SVG <path> outline — no font rendering by librsvg
      pathEls = lines.map((line, i) => {
        const cx = Math.round(w / 2);
        const cy = Math.round(barY + 24 + (i + 0.5) * lineH);
        try {
          return renderer.getPath(line, {
            x: cx, y: cy,
            fontSize,
            anchor: 'center middle',
            attributes: { fill: 'white' }
          });
        } catch (err) {
          console.error('[visual] getPath error:', err.message, 'line:', line);
          return '';
        }
      }).join('\n');
    } else {
      // Fallback: plain SVG <text> with sans-serif if font file missing
      pathEls = lines.map((line, i) => {
        const cx = Math.round(w / 2);
        const cy = Math.round(barY + 24 + (i + 0.5) * lineH);
        return `<text x="${cx}" y="${cy}" font-family="sans-serif" font-size="${fontSize}" font-weight="bold" fill="white" text-anchor="middle" dominant-baseline="middle">${escapeXml(line)}</text>`;
      }).join('\n');
    }

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect x="0" y="${barY}" width="${w}" height="${barH}" fill="rgba(0,0,0,0.45)"/>${pathEls}</svg>`;

    return await sharp(imageBuffer)
      .composite([{ input: Buffer.from(svg), top: 0, left: 0 }])
      .jpeg({ quality: 90 })
      .toBuffer();
  } catch (e) {
    console.error('[visual] overlayTextOnImage error:', e.message);
    return imageBuffer;
  }
}

// Extract per-slide text from carousel/photo/stories scripts
function extractSlideTexts(scripts, sectionType) {
  const lines = scripts.split('\n');
  const result = [];
  if (sectionType === 'carousel') {
    // Format 1 (new): "КАДР N:\nТекст поверх фото: [short]\nПодпись к посту: [long]"
    // Format 2 (compat): "Слайд N:\nТекст поверх фото: [short]"
    // Format 3 (old): "Слайд N: [long text on same line]"
    let currentSlide = -1;
    for (const line of lines) {
      // КАДР N: header (new format) — с текстом или без после двоеточия
      const kadrHeader = line.match(/^КАДР\s+(\d+)(?:\s*\([^)]*\))?[:\s]*/i);
      if (kadrHeader && !line.match(/^КАДР\s+\d+.*Текст поверх/i)) {
        currentSlide = Number(kadrHeader[1]) - 1; continue;
      }
      // Слайд N: header on own line (compat)
      const slideHeader = line.match(/^Слайд\s+(\d+)(?:\s*\([^)]*\))?[:\s]*$/i);
      if (slideHeader) { currentSlide = Number(slideHeader[1]) - 1; continue; }
      // "Текст поверх фото:" — works in both КАДР and Слайд blocks
      const textFmt = line.match(/^Текст поверх фото:\s*(.+)/i);
      if (textFmt && currentSlide >= 0) {
        result[currentSlide] = wordSlice(textFmt[1].trim(), 6);
        continue;
      }
      // Legacy: "Хук слайда N: [text]"
      const hookFmt = line.match(/^Хук слайда\s+(\d+)(?:\s*\([^)]*\))?:\s*(.+)/i);
      if (hookFmt) {
        result[Number(hookFmt[1]) - 1] = wordSlice(hookFmt[2].trim(), 6);
        continue;
      }
      // Old: "Слайд N: [long text]" — first sentence as hook
      const oldFmt = line.match(/^Слайд\s+(\d+)(?:\s*\([^)]*\))?:\s*(.+)/i);
      if (oldFmt && !line.toLowerCase().includes('изображение') && !line.toLowerCase().includes('промпт')) {
        const fullText = oldFmt[2].trim();
        const sentenceEnd = fullText.search(/[.?!—]/);
        const firstSentence = sentenceEnd > 0 ? fullText.slice(0, sentenceEnd) : fullText;
        result[Number(oldFmt[1]) - 1] = wordSlice(firstSentence.trim(), 6);
        currentSlide = Number(oldFmt[1]) - 1;
      }
    }
  } else if (sectionType === 'stories') {
    for (const line of lines) {
      const m = line.match(/^Текст на экране:\s*(.+)/i);
      if (m) result.push(m[1].trim().slice(0, 60));
    }
  } else if (sectionType === 'photos') {
    for (const line of lines) {
      const m = line.match(/^Текст поверх фото:\s*(.+)/i);
      if (m && m[1].trim() !== 'без текста') result.push(m[1].trim().slice(0, 80));
      else if (m) result.push('');
    }
  } else if (sectionType === 'covers') {
    for (const line of lines) {
      const m = line.match(/^Главная фраза:\s*["«]?(.+?)["»]?\s*$/i);
      if (m) result.push(m[1].trim().slice(0, 60));
    }
  }
  return result;
}

// ── Split video script into 4-5 scene prompts via Claude ──────────────────────

async function splitScriptToScenes(videoScript) {
  // Primary: extract pre-written "СЦЕНА N:" blocks from Block7 ТЗ (EN lines go directly to Veo3)
  const extracted = [];
  const sceneRegex = /СЦЕНА\s*(\d+)\s*\(\d+-\d+\s*сек\s*\)[\s\S]*?EN\s*:\s*([^\n]+)/gi;
  let m;
  while ((m = sceneRegex.exec(videoScript)) !== null) {
    const enPrompt = m[2].trim();
    if (enPrompt && !enPrompt.startsWith('[')) extracted.push(enPrompt);
  }
  if (extracted.length >= 4) return extracted.slice(0, 4);
  if (extracted.length >= 2) {
    // Pad to 4 by cycling
    while (extracted.length < 4) extracted.push(extracted[extracted.length - 1]);
    return extracted;
  }

  // Fallback: Haiku generates scenes (for old-format scripts without СЦЕНА blocks)
  const { ask } = require('./src/claude'); // eslint-disable-line
  const scenes = await ask(`
You are a video director. Split this video script into EXACTLY 4 short scene descriptions for AI video generation.
You MUST return exactly 4 scenes — no more, no less. This is required to reach 25-30 seconds of video.
Each scene = one visual shot, 8 seconds, B-roll atmospheric style.

MANDATORY requirements for EVERY scene prompt:
- Vertical 9:16 portrait orientation, smartphone format (Instagram Reels / TikTok / YouTube Shorts)
- NO text, NO words, NO letters, NO watermarks, NO captions inside the video frame
- NO talking head, NO direct face close-ups — people only as background silhouettes, hands, or softly blurred figures in the background, never as the main subject
- Focus on: product details, space/environment, hands, textures, atmosphere, movement
- Include SPECIFIC details from the business described in the script — niche, product, space. NOT generic.

Return ONLY a JSON array of English prompts, nothing else.
Example: ["cinematic close-up of coffee beans falling into cup, vertical 9:16 portrait, warm golden lighting, no text, no people", "hands pouring latte art slow motion, vertical format, steam rising, blurred cafe background, no text"]

SCRIPT:
${videoScript.slice(0, 1500)}
`, { model: HAIKU, maxTokens: 800 });

  try {
    const match = scenes.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
  } catch { /* fallback */ }

  // Last resort: use old single-prompt field repeated 4 times
  const klingPrompt = extractByPrefix(videoScript, 'Промпт для AI-видео')[0]
    || videoScript.slice(0, 200);
  return [klingPrompt, klingPrompt, klingPrompt, klingPrompt];
}

// ── ffmpeg helpers ─────────────────────────────────────────────────────────────

async function downloadFile(url, destPath) {
  const { default: fetch } = await import('node-fetch');
  const resp = await fetch(url);
  const buffer = await resp.buffer();
  fs.writeFileSync(destPath, buffer);
}

function mergeVideoFragments(fragmentPaths, outputPath) {
  const listFile = outputPath + '.txt';
  const lines = fragmentPaths.map(p => `file '${p}'`).join('\n');
  fs.writeFileSync(listFile, lines);
  execSync(`"${FFMPEG_BIN}" -y -f concat -safe 0 -i "${listFile}" -c copy "${outputPath}"`, { stdio: 'pipe' });
  fs.unlinkSync(listFile);
}

// Slice text to N words, respecting word boundaries (no mid-word cuts)
function wordSlice(text, maxWords) {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) return words.join(' ');
  return words.slice(0, maxWords).join(' ') + '...';
}

function getVideoDuration(videoPath) {
  try {
    const FFPROBE = FFMPEG_BIN.replace(/ffmpeg$/, 'ffprobe');
    const out = execSync(
      `"${FFPROBE}" -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
      { stdio: 'pipe' }
    ).toString().trim();
    return parseFloat(out) || 30;
  } catch {
    return 30;
  }
}

function srtTime(sec) {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = Math.floor(sec % 60);
  const ms = Math.round((sec % 1) * 1000);
  return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(s).padStart(2,'0')},${String(ms).padStart(3,'0')}`;
}

function buildTimedSrt(hookText, ctaText, duration, themeText = '') {
  const entries = [];
  let idx = 1;

  // Hook: первые 4 секунды
  const hookEnd = Math.min(4, duration);
  if (hookText) {
    entries.push(`${idx++}\n${srtTime(0)} --> ${srtTime(hookEnd)}\n${hookText}`);
  }

  // CTA: последние 8 секунд (вычисляем сначала чтобы тема не перекрывала)
  const ctaStart = Math.max(hookEnd + 5, duration - 8);
  const ctaEnd   = duration; // до конца видео (не "99:59:59" — чтобы не мерцало)

  // Тема: середина видео, строго между хуком и CTA с отступом 1 сек
  if (themeText) {
    const themeStart = Math.max(hookEnd + 2, Math.round(duration * 0.35));
    const themeEnd   = Math.min(ctaStart - 1, Math.round(duration * 0.65));
    if (themeStart < themeEnd) {
      entries.push(`${idx++}\n${srtTime(themeStart)} --> ${srtTime(themeEnd)}\n${themeText}`);
    }
  }

  if (ctaText && ctaStart < ctaEnd) {
    entries.push(`${idx++}\n${srtTime(ctaStart)} --> ${srtTime(ctaEnd)}\n${ctaText}`);
  }

  return entries.join('\n\n');
}

// Parse hook, theme, CTA from a video script (Старт or Профи format)
function extractVideoTexts(videoScripts, ctaPreference, leadMagnet) {
  if (!videoScripts) return { hookText: '', themeText: '', ctaText: '' };

  // Title: СЦЕНАРИЙ 1 or ВИДЕО 1 → becomes themeText (5 words max, no mid-word cut)
  const titleMatch = videoScripts.match(/(?:СЦЕНАРИЙ|ВИДЕО)\s*1[:\s]+([^\n]+)/i);
  const rawTitle   = titleMatch ? titleMatch[1].trim() : '';
  let themeText = wordSlice(rawTitle, 5);

  // Hook: "А:" variant for Старт format, "Эмоция зрителя:" for B-roll (Профи/Стандарт)
  const hookMatch = videoScripts.match(/^А:\s*([^\n]+)/mi);
  let hookText = hookMatch ? wordSlice(hookMatch[1].trim(), 7) : '';
  if (!hookText) {
    const emotionMatch = videoScripts.match(/^Эмоция зрителя:\s*([^\n]+)/mi);
    hookText = emotionMatch ? wordSlice(emotionMatch[1].trim(), 7) : '';
  }
  if (!hookText || hookText === themeText) {
    const bokMatch = videoScripts.match(/^Б:\s*([^\n]+)/mi);
    hookText = bokMatch ? wordSlice(bokMatch[1].trim(), 7) : 'Смотрите как это работает';
  }

  // CTA: from [00:25-00:30] line OR from ctaPreference
  const ctaLineMatch = videoScripts.match(/\[00:25[^\]]*\][^\n]*?CTA[:\s-]*([^\n]+)/i) ||
                       videoScripts.match(/CTA[:\s]+([^\n]+)/i);
  let ctaText = ctaLineMatch ? wordSlice(ctaLineMatch[1].trim().replace(/^[-–—]\s*/, ''), 8) : '';
  if (!ctaText) {
    if (ctaPreference === 'direct_magnet' && leadMagnet) {
      ctaText = `Напишите в директ — пришлю ${leadMagnet.slice(0, 30)}`;
    } else if (ctaPreference === 'direct_only') {
      ctaText = 'Напишите нам в директ — отвечу';
    } else {
      ctaText = 'Подробности в описании профиля';
    }
  }
  return { hookText, themeText, ctaText };
}

// Extract caption for first photo post
function extractFirstPhotoCaption(photoScripts) {
  if (!photoScripts) return '';
  const m = photoScripts.match(/Подпись к посту:\s*([^\n]+)/i);
  return m ? m[1].trim() : '';
}

// Extract per-slide captions for carousel Telegram captions
// Format 1 (current): within "Слайд N:" block → "Подпись: [text]"
function extractSlideCaption(scripts, slideNum) {
  if (!scripts) return '';
  // Format 1 (new): find "КАДР N:" block → "Подпись к посту:"
  const kadrBlock = scripts.match(
    new RegExp(`КАДР\\s+${slideNum}(?:\\s*\\([^)]*\\))?[:\\s]*\\n([\\s\\S]*?)(?=\\nКАДР\\s+\\d|\\nКАРУСЕЛЬ\\s+\\d|$)`, 'i')
  );
  if (kadrBlock) {
    const m = kadrBlock[1].match(/^Подпись к посту:\s*(.+)/im);
    if (m) return m[1].trim();
  }
  // Format 2 (compat): find "Слайд N:" block → "Подпись к посту:" or "Подпись:"
  const slideBlock = scripts.match(
    new RegExp(`Слайд\\s+${slideNum}(?:\\s*\\([^)]*\\))?[:\\s]*\\n([\\s\\S]*?)(?=\\nСлайд\\s+\\d|\\nКАРУСЕЛЬ\\s+\\d|$)`, 'i')
  );
  if (slideBlock) {
    const m = slideBlock[1].match(/^(?:Подпись к посту|Подпись):\s*(.+)/im);
    if (m) return m[1].trim();
  }
  // Format 3 (legacy): "Подпись к слайду N: [text]"
  const fmt3 = scripts.match(new RegExp(`Подпись к слайду\\s+${slideNum}[^:]*:\\s*([^\\n]+)`, 'i'));
  if (fmt3) return fmt3[1].trim();
  // Format 4 (old): "Слайд N: [long text]" — after first sentence
  const fmt4 = scripts.match(new RegExp(`^Слайд\\s+${slideNum}(?:\\s*\\([^)]*\\))?:\\s*(.+)`, 'im'));
  if (fmt4) {
    const fullText = fmt4[1].trim();
    const sentenceEnd = fullText.search(/[.?!—]/);
    if (sentenceEnd > 0) {
      const rest = fullText.slice(sentenceEnd + 1).trim();
      if (rest.length > 5) return rest;
    }
  }
  return '';
}

function extractTimedTexts(videoScript, ctaText) {
  // Хук: "Эмоция зрителя:" (block7 формат) → "Хук:" → пусто (НЕ брать первую строку — там заголовок ВИДЕО N:)
  const emotionM = videoScript.match(/Эмоция зрителя:\s*([^\n]+)/i);
  const hookLineM = videoScript.match(/Хук[:\s]+([^\n]+)/i);
  const hook = (emotionM ? emotionM[1].trim() : hookLineM ? hookLineM[1].trim() : '').slice(0, 35);

  // CTA: сначала ctaText (передан снаружи), потом строка CTA: в скрипте, потом дефолт
  const ctaFromScript = videoScript.match(/^CTA:\s*(.+)/im)?.[1]?.trim().slice(0, 70) || '';
  const cta = (ctaText || ctaFromScript || 'Пишите нам в директ').slice(0, 70);

  return { hook, cta };
}

// Split text into lines of at most maxChars each (word-aware)
function _splitLines(text, maxChars) {
  if (text.length <= maxChars) return [text];
  const words = text.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    const test = cur ? `${cur} ${w}` : w;
    if (test.length > maxChars && cur) { lines.push(cur); cur = w; }
    else cur = test;
  }
  if (cur) lines.push(cur);
  return lines.slice(0, 3); // max 3 lines
}

// Build drawtext filter(s) for one text block — handles word wrap, padding, timing
// Returns { filters: string[], tmpFiles: string[] }
function _buildDrawtextBlock(text, start, end, baseTmpPath) {
  const fontPath = path.join(__dirname, 'assets', 'Inter-Bold.ttf');
  const fontArg  = fontPath.replace(/'/g, "\\'");
  const fontSize = 52;
  const lineH    = 68;
  const padV     = 24;

  // 1080px видео, Inter-Bold 52px → ~22 символа в строке с безопасными полями.
  const textLines = _splitLines(text, 22);
  const barH = textLines.length * lineH + padV * 2;

  const timingEnable = (start !== null && end !== null)
    ? `:enable='between(t,${start},${end})'`
    : '';
  const boxEnable = (start !== null && end !== null)
    ? `:enable='between(t,${start},${end})'`
    : '';

  const filters = [];
  const tmpFiles = [];

  // ONE dark bar covering all lines — like carousel/photo overlay
  filters.push(
    `drawbox=x=0:y=h-${barH}:w=iw:h=${barH}:color=black@0.72:t=fill${boxEnable}`
  );

  // Text lines on top of the bar — no individual boxes
  textLines.forEach((line, i) => {
    const f = `${baseTmpPath}_${i}.txt`;
    fs.writeFileSync(f, line, 'utf8');
    tmpFiles.push(f);
    const fileArg = f.replace(/'/g, "\\'");
    const yExpr   = `h-${barH}+${padV + i * lineH}`;
    filters.push(
      `drawtext=fontfile='${fontArg}':textfile='${fileArg}'${timingEnable}` +
      `:fontsize=${fontSize}:fontcolor=white` +
      `:x=(w-text_w)/2:y=${yExpr}`
    );
  });

  return { filters, tmpFiles };
}

function addSubtitles(videoPath, subtitleText, outputPath) {
  const { filters, tmpFiles } = _buildDrawtextBlock(subtitleText, null, null, videoPath + '_sub');
  try {
    execSync(`"${FFMPEG_BIN}" -y -i "${videoPath}" -vf "${filters.join(', ')}" -c:a copy "${outputPath}"`, { stdio: 'pipe' });
  } finally {
    tmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  }
}

function addTimedSubtitles(videoPath, srtContent, outputPath) {
  if (!srtContent.trim()) { fs.copyFileSync(videoPath, outputPath); return; }

  function srtToSec(ts) {
    const m = ts.match(/(\d+):(\d+):(\d+)[,.](\d+)/);
    return m ? +m[1]*3600 + +m[2]*60 + +m[3] + +m[4]/1000 : 0;
  }
  const blocks = srtContent.trim().split(/\n\n+/).map(block => {
    const lines = block.trim().split('\n');
    if (lines.length < 3) return null;
    const tm = lines[1].match(/(.+?)\s*-->\s*(.+)/);
    if (!tm) return null;
    return { start: srtToSec(tm[1]), end: srtToSec(tm[2]), text: lines.slice(2).join(' ').trim() };
  }).filter(Boolean);

  if (blocks.length === 0) { fs.copyFileSync(videoPath, outputPath); return; }

  const allFilters = [];
  const allTmpFiles = [];
  blocks.forEach((b, bi) => {
    const { filters, tmpFiles } = _buildDrawtextBlock(b.text, b.start, b.end, videoPath + `_b${bi}`);
    allFilters.push(...filters);
    allTmpFiles.push(...tmpFiles);
  });

  try {
    execSync(`"${FFMPEG_BIN}" -y -i "${videoPath}" -vf "${allFilters.join(', ')}" -c:a copy "${outputPath}"`, { stdio: 'pipe' });
  } finally {
    allTmpFiles.forEach(f => { try { fs.unlinkSync(f); } catch {} });
  }
}

function extractSubtitleFromScript(videoScript) {
  const match = videoScript.match(/ВИДЕО\s*\d+[:\s]+([^\n]+)/i);
  return match
    ? match[1].trim().slice(0, 60)
    : (videoScript.match(/^\s*(.+)/)?.[1]?.trim().slice(0, 60) || '');
}

// ── Generate one complete video (fragments → merge → subtitles) ───────────────

async function generateOneVideo(videoScript, videoIndex, clientChatId, ctaOverride = '') {
  const scenes = await splitScriptToScenes(videoScript);
  console.log(`[visual] Видео ${videoIndex + 1}: ${scenes.length} сцен`);

  // Search library for similar existing video
  const firstPrompt = scenes[0] || videoScript.slice(0, 300);
  const tags = await extractVideoTags(firstPrompt);
  const libraryMatches = searchLibrary(tags);
  if (libraryMatches.length > 0) {
    console.log(`[library] Найдено ${libraryMatches.length} похожих видео для видео ${videoIndex + 1}: ${libraryMatches.map(m => m.videoId).join(', ')}`);
  }

  // Generate all fragments in parallel batches of 2
  const fragmentUrls = [];
  for (let i = 0; i < scenes.length; i += 2) {
    const batch = scenes.slice(i, i + 2);
    const taskIds = await Promise.all(batch.map(p => startVideo(p).catch(() => null)));
    const urls    = await Promise.all(taskIds.map(id => pollTask(id, 900000, 'video')));
    fragmentUrls.push(...urls);
  }

  const validUrls = fragmentUrls.filter(Boolean);
  if (!validUrls.length) {
    console.error(`[visual] Видео ${videoIndex + 1}: нет готовых фрагментов`);
    return { localPath: null, rawPath: null, subtitleText: '', scenes, fragmentUrls, validCount: 0 };
  }

  // Download fragments
  const tmpBase = path.join(TMP_DIR, `${clientChatId}_v${videoIndex}`);
  const fragPaths = [];
  for (let i = 0; i < validUrls.length; i++) {
    const p = `${tmpBase}_frag${i}.mp4`;
    try {
      await downloadFile(validUrls[i], p);
      fragPaths.push(p);
    } catch (e) {
      console.error(`[visual] Видео ${videoIndex + 1}: ошибка загрузки фрагмента ${i}:`, e.message);
    }
  }

  if (!fragPaths.length) {
    return { localPath: null, rawPath: null, subtitleText: '', scenes, fragmentUrls, validCount: 0 };
  }

  // Merge fragments (fallback: use first fragment if ffmpeg not available)
  const mergedPath = `${tmpBase}_merged.mp4`;
  try {
    if (fragPaths.length > 1) {
      mergeVideoFragments(fragPaths, mergedPath);
    } else {
      fs.copyFileSync(fragPaths[0], mergedPath);
    }
  } catch (e) {
    console.error('[visual] ffmpeg merge error:', e.message);
    // Fallback: use first fragment without merging
    try {
      fs.copyFileSync(fragPaths[0], mergedPath);
      console.log('[visual] Fallback: используем первый фрагмент без склейки');
    } catch (e2) {
      console.error('[visual] fallback copy error:', e2.message);
      return { localPath: null, rawPath: null, subtitleText: '', scenes, fragmentUrls, validCount: validUrls.length };
    }
  }

  // Keep fragments on disk for scene-level regen (cleaned up after delivery)
  // fragPaths are persisted — don't delete here

  // Add timed text overlay (hook at start + theme in middle + CTA at end)
  const titleM = videoScript.match(/ВИДЕО\s*\d+[:\s]+([^\n]+)/i);
  const themeText = titleM ? wordSlice(titleM[1].trim(), 5) : '';
  const { hook, cta } = extractTimedTexts(videoScript, ctaOverride);
  const subtitleText = hook || extractSubtitleFromScript(videoScript);
  const finalPath = `${tmpBase}_final.mp4`;
  try {
    const duration = getVideoDuration(mergedPath);
    const srtContent = buildTimedSrt(hook, cta, duration, themeText);
    if (srtContent.trim()) {
      addTimedSubtitles(mergedPath, srtContent, finalPath);
      console.log(`[visual] Видео ${videoIndex + 1}: хук="${hook}" тема="${themeText}" CTA="${cta}", длина=${Math.round(duration)}s`);
    } else {
      fs.copyFileSync(mergedPath, finalPath);
    }
  } catch (e) {
    console.error('[visual] timed subtitle error:', e.message);
    fs.copyFileSync(mergedPath, finalPath);
  }

  // Save to library for future reuse
  saveToLibrary(mergedPath, firstPrompt, tags).catch(() => {});

  return { localPath: finalPath, rawPath: mergedPath, subtitleText, scenes, fragmentUrls, fragPaths, validCount: validUrls.length, libraryMatches };
}

// ── Cleanup video fragments after delivery to client ──────────────────────────
function cleanupVideoFragments(clientChatId) {
  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  if (!fs.existsSync(resultPath)) return;
  try {
    const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    let cleaned = 0;
    for (const vd of (data.results?.videoData || [])) {
      for (const p of (vd?.fragPaths || [])) {
        if (p && fs.existsSync(p)) { fs.unlinkSync(p); cleaned++; }
      }
    }
    if (cleaned > 0) console.log(`[visual] Очищено ${cleaned} фрагментов для ${clientChatId}`);
  } catch (e) {
    console.error('[visual] cleanupVideoFragments error:', e.message);
  }
}

// ── Video Library ──────────────────────────────────────────────────────────────

async function extractVideoTags(prompt) {
  const { ask } = require('./src/claude');
  try {
    const result = await ask(
      `Extract 6-8 tags from this video prompt for a searchable library.
Tags should cover: industry/niche, scene type, mood/emotion, key objects, setting.
Return ONLY a JSON array of short lowercase strings (Russian or English — match the prompt language).
Example: ["кофе", "руки", "утро", "уют", "атмосфера", "детали"]

PROMPT: ${prompt.slice(0, 400)}`,
      { model: HAIKU, maxTokens: 150 }
    );
    const match = result.match(/\[[\s\S]*?\]/);
    if (match) return JSON.parse(match[0]).filter(t => typeof t === 'string' && t.length > 1);
  } catch {}
  return [];
}

function searchLibrary(tags, limit = 3) {
  try {
    const metaFiles = fs.readdirSync(LIBRARY_DIR).filter(f => f.endsWith('.meta.json'));
    const results = [];
    for (const mf of metaFiles) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(LIBRARY_DIR, mf), 'utf8'));
        if (!fs.existsSync(path.join(LIBRARY_DIR, meta.fileName))) continue;
        const matchCount = tags.filter(t => (meta.tags || []).some(lt => lt.includes(t) || t.includes(lt))).length;
        if (matchCount >= 2) results.push({ ...meta, matchCount });
      } catch {}
    }
    return results.sort((a, b) => b.matchCount - a.matchCount).slice(0, limit);
  } catch { return []; }
}

async function saveToLibrary(localPath, prompt, tags) {
  try {
    const videoId  = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const fileName = `${videoId}.mp4`;
    fs.copyFileSync(localPath, path.join(LIBRARY_DIR, fileName));
    const meta = {
      videoId, fileName,
      prompt:    prompt.slice(0, 500),
      tags:      tags || [],
      season:    (() => {
        const m = new Date().getMonth();
        return m < 3 ? 'winter' : m < 6 ? 'spring' : m < 9 ? 'summer' : 'autumn';
      })(),
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(LIBRARY_DIR, `${videoId}.meta.json`), JSON.stringify(meta, null, 2));
    console.log(`[library] Сохранено: ${videoId} теги=[${tags.join(', ')}]`);
    return videoId;
  } catch (e) {
    console.error('[library] saveToLibrary error:', e.message);
    return null;
  }
}

function libraryStats() {
  try {
    const files = fs.readdirSync(LIBRARY_DIR).filter(f => f.endsWith('.mp4'));
    const totalMb = files.reduce((sum, f) => {
      try { return sum + fs.statSync(path.join(LIBRARY_DIR, f)).size / 1024 / 1024; } catch { return sum; }
    }, 0);
    return { count: files.length, totalMb: Math.round(totalMb) };
  } catch { return { count: 0, totalMb: 0 }; }
}

// ── История контента клиента ───────────────────────────────────────────────────

function getClientHistory(clientChatId) {
  const f = path.join(CONTENT_HISTORY_DIR, `${clientChatId}.json`);
  try { return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : { usedPhotoIds: [], usedVideoIds: [] }; }
  catch { return { usedPhotoIds: [], usedVideoIds: [] }; }
}

function markContentUsed(clientChatId, photoIds = [], videoIds = []) {
  const h = getClientHistory(clientChatId);
  h.usedPhotoIds = [...new Set([...h.usedPhotoIds, ...photoIds])];
  h.usedVideoIds = [...new Set([...h.usedVideoIds, ...videoIds])];
  h.lastUpdated  = new Date().toISOString();
  fs.writeFileSync(path.join(CONTENT_HISTORY_DIR, `${clientChatId}.json`), JSON.stringify(h, null, 2));
}

// ── Фото-библиотека ────────────────────────────────────────────────────────────

function getSeason() {
  const m = new Date().getMonth();
  return m < 3 ? 'winter' : m < 6 ? 'spring' : m < 9 ? 'summer' : 'autumn';
}

async function saveToPhotoLibrary(localPath, prompt, tags, section = 'photo') {
  try {
    const photoId  = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const fileName = `${photoId}.jpg`;
    fs.copyFileSync(localPath, path.join(PHOTO_LIBRARY_DIR, fileName));
    const meta = {
      photoId, fileName, section,
      prompt:    (prompt || '').slice(0, 500),
      tags:      tags || [],
      season:    getSeason(),
      createdAt: new Date().toISOString(),
    };
    fs.writeFileSync(path.join(PHOTO_LIBRARY_DIR, `${photoId}.meta.json`), JSON.stringify(meta, null, 2));
    console.log(`[photo-lib] Сохранено: ${photoId} section=${section} теги=[${(tags || []).join(', ')}]`);
    return photoId;
  } catch (e) {
    console.error('[photo-lib] saveToPhotoLibrary error:', e.message);
    return null;
  }
}

function searchPhotoLibrary(tags, clientChatId, limit = 3, section = null) {
  try {
    const history     = getClientHistory(clientChatId);
    const usedIds     = new Set(history.usedPhotoIds || []);
    const metaFiles   = fs.readdirSync(PHOTO_LIBRARY_DIR).filter(f => f.endsWith('.meta.json'));
    const currentSeason = getSeason();
    const results = [];

    for (const mf of metaFiles) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(PHOTO_LIBRARY_DIR, mf), 'utf8'));
        if (!fs.existsSync(path.join(PHOTO_LIBRARY_DIR, meta.fileName))) continue;
        if (usedIds.has(meta.photoId)) continue;                        // уже было у этого клиента
        if (section && meta.section !== section) continue;              // фильтр по типу
        if (meta.season && meta.season !== currentSeason) continue;     // сезон должен совпадать

        const matchCount = (tags || []).filter(t =>
          (meta.tags || []).some(lt => lt.includes(t) || t.includes(lt))
        ).length;
        if (matchCount >= 2) results.push({ ...meta, matchCount, localPath: path.join(PHOTO_LIBRARY_DIR, meta.fileName) });
      } catch {}
    }
    return results.sort((a, b) => b.matchCount - a.matchCount).slice(0, limit);
  } catch { return []; }
}

// Улучшаем searchLibrary — исключаем видео уже использованные этим клиентом
function searchVideoLibrary(tags, clientChatId, limit = 3) {
  try {
    const history   = getClientHistory(clientChatId);
    const usedIds   = new Set(history.usedVideoIds || []);
    const metaFiles = fs.readdirSync(LIBRARY_DIR).filter(f => f.endsWith('.meta.json'));
    const currentSeason = getSeason();
    const results = [];

    for (const mf of metaFiles) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(LIBRARY_DIR, mf), 'utf8'));
        if (!fs.existsSync(path.join(LIBRARY_DIR, meta.fileName))) continue;
        if (usedIds.has(meta.videoId)) continue;
        if (meta.season && meta.season !== currentSeason) continue;

        const matchCount = (tags || []).filter(t =>
          (meta.tags || []).some(lt => lt.includes(t) || t.includes(lt))
        ).length;
        if (matchCount >= 2) results.push({ ...meta, matchCount, localPath: path.join(LIBRARY_DIR, meta.fileName) });
      } catch {}
    }
    return results.sort((a, b) => b.matchCount - a.matchCount).slice(0, limit);
  } catch { return []; }
}

function photoLibraryStats() {
  try {
    const files = fs.readdirSync(PHOTO_LIBRARY_DIR).filter(f => f.endsWith('.jpg'));
    const totalMb = files.reduce((sum, f) => {
      try { return sum + fs.statSync(path.join(PHOTO_LIBRARY_DIR, f)).size / 1024 / 1024; } catch { return sum; }
    }, 0);
    return { count: files.length, totalMb: Math.round(totalMb) };
  } catch { return { count: 0, totalMb: 0 }; }
}

// ── Mini-test video regen: uses first video script + Haiku feedback → Veo3 ─────

async function regenVideoFromScript(clientChatId, videoScripts, feedback) {
  const { ask, HAIKU } = require('./src/claude');
  const notify = async (text) => bot3Send(process.env.BOT3_MANAGER_CHAT_ID || clientChatId, text);

  await notify(`🎬 Перегенерирую видео${feedback ? `\nИзменение: "${feedback}"` : ''}...\nЗапускаю Veo3 (~7-10 минут)`);

  // Берём первый сценарий из videoScripts
  const firstScriptMatch = videoScripts.match(/(?:ВИДЕО|ТЗ)\s*1[:\s][\s\S]*?(?=(?:ВИДЕО|ТЗ)\s*2|$)/i);
  const firstScript = firstScriptMatch ? firstScriptMatch[0] : videoScripts.slice(0, 1200);

  // Haiku модифицирует сценарий под фидбек
  let finalScript = firstScript;
  if (feedback) {
    try {
      finalScript = await ask(
        `You are editing a video production brief.\n\nOriginal brief:\n"${firstScript}"\n\nManager requested change: "${feedback}"\n\nRewrite the brief incorporating the change. Keep the same structure and language. Return ONLY the modified brief.`,
        { model: HAIKU, maxTokens: 600 }
      );
    } catch { finalScript = firstScript; }
  }

  // Разбиваем на сцены и генерируем через Veo3
  const scenes = await splitScriptToScenes(finalScript);
  if (!scenes.length) { await notify(`❌ Не удалось разбить сценарий на сцены`); return; }

  await notify(`🎬 Генерирую ${scenes.length} сцен через Veo3...`);
  const taskIds = [];
  for (const scene of scenes) {
    const id = await startVideo(scene).catch(() => null);
    taskIds.push(id);
  }
  const urls = await Promise.all(taskIds.map(id => id ? pollTask(id, 600000, 'video') : null));
  const validUrls = urls.filter(Boolean);

  if (!validUrls.length) { await notify(`❌ Veo3 не вернул ни одного фрагмента`); return; }

  // Скачиваем и мержим
  const { default: fetch } = await import('node-fetch');
  const tmpBase  = path.join(TMP_DIR, `${clientChatId}_mini_rv`);
  const fragPaths = [];
  for (let i = 0; i < validUrls.length; i++) {
    const p = `${tmpBase}_frag${i}.mp4`;
    try {
      const r = await fetch(validUrls[i]);
      fs.writeFileSync(p, await r.buffer());
      fragPaths.push(p);
    } catch {}
  }

  const mergedPath = `${tmpBase}_merged.mp4`;
  const outPath    = `${tmpBase}_final.mp4`;
  try {
    if (fragPaths.length > 1) mergeVideoFragments(fragPaths, mergedPath);
    else fs.copyFileSync(fragPaths[0], mergedPath);
    fragPaths.forEach(p => { try { fs.unlinkSync(p); } catch {} });

    // Достаём тексты и накладываем субтитры
    const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
    const saved = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : {};
    const { hookText = '', themeText = '', ctaText = '' } = saved.videoTexts || {};
    const srt = buildTimedSrt(hookText, ctaText, 30, themeText);
    addTimedSubtitles(mergedPath, srt, outPath);

    await bot3SendVideo(process.env.BOT3_MANAGER_CHAT_ID || clientChatId, outPath);
    await bot3Send(process.env.BOT3_MANAGER_CHAT_ID || clientChatId, `✅ Новое видео готово`, {
      inline_keyboard: [[
        { text: '🔄 Переделать снова', callback_data: `mini_rv_0_${clientChatId}` },
        { text: '✏️ Изм. текст (хук/тема/CTA)', callback_data: `et_video_0_${clientChatId}` },
      ]],
    });
  } catch (e) {
    await notify(`❌ Ошибка сборки: ${e.message}`);
  } finally {
    for (const f of [mergedPath, outPath]) { try { fs.unlinkSync(f); } catch {} }
  }
}

// ── Regen one video based on manager feedback ──────────────────────────────────

async function regenVideo(clientChatId, videoIndex, feedback) {
  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  if (!fs.existsSync(resultPath)) return;
  const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));

  const videoData = data.results?.videoData?.[videoIndex];

  // Мини-тест: videoData нет, но есть videoScripts — генерируем Veo3 с нуля по скрипту
  if (!videoData && data.videoScripts) {
    await regenVideoFromScript(clientChatId, data.videoScripts, feedback);
    return;
  }
  if (!videoData) return;

  console.log(`[visual] Регенерация видео ${videoIndex + 1} для ${clientChatId}. Фидбек: ${feedback}`);

  // Ask Claude which scene(s) to fix
  const { ask } = require('./src/claude');
  const scenes = videoData.scenes || [];
  let scenesToRegen = [];

  if (feedback && scenes.length > 0) logFeedback('video', scenes.join(' | '), feedback);

  if (feedback && scenes.length > 0) {
    const analysis = await ask(`
Manager feedback about a video: "${feedback}"

Video has ${scenes.length} scenes:
${scenes.map((s, i) => `Scene ${i + 1}: ${s}`).join('\n')}

Which scene numbers need to be regenerated based on the feedback?
Reply ONLY with a JSON array of scene indexes (0-based). Example: [0] or [1, 2]
`, { model: HAIKU, maxTokens: 200 });

    try {
      const match = analysis.match(/\[[\s\S]*?\]/);
      if (match) scenesToRegen = JSON.parse(match[0]);
    } catch { /* regen all */ }
  }

  // If couldn't determine or no feedback → regen all scenes
  if (!scenesToRegen.length) scenesToRegen = scenes.map((_, i) => i);

  console.log(`[visual] Переделываю сцены: ${scenesToRegen.join(', ')}`);

  // Regen specific scenes
  const newFragmentUrls = [...(videoData.fragmentUrls || [])];
  for (const idx of scenesToRegen) {
    const prompt  = scenes[idx];
    if (!prompt) continue;
    const taskId  = await startVideo(prompt).catch(() => null);
    const url     = await pollTask(taskId, 600000, 'video');
    newFragmentUrls[idx] = url;
  }

  // Re-download and merge
  const tmpBase  = path.join(TMP_DIR, `${clientChatId}_v${videoIndex}_regen`);
  const fragPaths = [];
  for (let i = 0; i < newFragmentUrls.length; i++) {
    const url = newFragmentUrls[i];
    if (!url) continue;
    const p = `${tmpBase}_frag${i}.mp4`;
    await downloadFile(url, p);
    fragPaths.push(p);
  }

  const mergedPath = `${tmpBase}_merged.mp4`;
  try {
    if (fragPaths.length > 1) {
      mergeVideoFragments(fragPaths, mergedPath);
    } else if (fragPaths.length === 1) {
      fs.copyFileSync(fragPaths[0], mergedPath);
    }
    fragPaths.forEach(p => fs.existsSync(p) && fs.unlinkSync(p));
  } catch (e) {
    console.error('[visual] ffmpeg regen merge error:', e.message);
    return;
  }

  // Re-apply subtitle overlay
  const subtitleText = videoData.subtitleText || '';
  const finalPath = mergedPath.replace('_merged.mp4', '_final.mp4');
  if (subtitleText) {
    try {
      addSubtitles(mergedPath, subtitleText, finalPath);
    } catch (e) {
      console.error('[visual] regen subtitle error:', e.message);
      fs.copyFileSync(mergedPath, finalPath);
    }
  } else {
    fs.copyFileSync(mergedPath, finalPath);
  }

  // Update results
  data.results.videoData[videoIndex] = {
    ...videoData,
    fragmentUrls: newFragmentUrls,
    rawPath:      mergedPath,
    localPath:    finalPath,
    subtitleText,
  };
  delete (data.results.videoApproved || {})[videoIndex];
  fs.writeFileSync(resultPath, JSON.stringify(data, null, 2));

  await notifyBot3Regen(clientChatId, `видео ${videoIndex + 1}`, finalPath);
}

// ── Rebuild video with new subtitle text only (no re-generation) ──────────────
async function regenSubtitle(clientChatId, videoIndex, newSubtitleText) {
  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  if (!fs.existsSync(resultPath)) return;
  const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));

  // ── Мини-тест: три текста (хук|тема|CTA) + rawPath из miniVideoRawPath ──────
  if (data.miniVideoRawPath && fs.existsSync(data.miniVideoRawPath)) {
    const finalPath = path.join(TMP_DIR, `${clientChatId}_mini_video_edit.mp4`);
    // Парсим три части: "Хук: ...\nТема: ...\nCTA: ..."
    const hookMatch  = newSubtitleText.match(/Хук:\s*(.+)/i);
    const themeMatch = newSubtitleText.match(/Тема:\s*(.+)/i);
    const ctaMatch   = newSubtitleText.match(/CTA:\s*(.+)/i);
    const hookText  = hookMatch  ? hookMatch[1].trim()  : (data.videoTexts?.hookText  || '');
    const themeText = themeMatch ? themeMatch[1].trim() : (data.videoTexts?.themeText || '');
    const ctaText   = ctaMatch   ? ctaMatch[1].trim()   : (data.videoTexts?.ctaText   || '');
    try {
      addTimedSubtitles(data.miniVideoRawPath, buildTimedSrt(hookText, ctaText, 30, themeText), finalPath);
      data.videoTexts = { hookText, themeText, ctaText };
      fs.writeFileSync(resultPath, JSON.stringify(data, null, 2));
      await notifyBot3Regen(clientChatId, 'видео (новый текст)', finalPath);
    } catch (e) {
      console.error('[visual] regenSubtitle mini error:', e.message);
    } finally {
      if (fs.existsSync(finalPath)) try { fs.unlinkSync(finalPath); } catch {}
    }
    return;
  }

  // ── Платный пакет: стандартный rawPath ────────────────────────────────────
  const videoData = data.results?.videoData?.[videoIndex];
  if (!videoData?.rawPath || !fs.existsSync(videoData.rawPath)) {
    console.error(`[visual] regenSubtitle: rawPath не найден для видео ${videoIndex}`);
    return;
  }
  const tmpBase   = path.join(TMP_DIR, `${clientChatId}_v${videoIndex}`);
  const finalPath = `${tmpBase}_final_sub.mp4`;
  try {
    addSubtitles(videoData.rawPath, newSubtitleText, finalPath);
  } catch (e) {
    console.error('[visual] regenSubtitle ffmpeg error:', e.message);
    fs.copyFileSync(videoData.rawPath, finalPath);
  }
  data.results.videoData[videoIndex] = { ...videoData, localPath: finalPath, subtitleText: newSubtitleText };
  fs.writeFileSync(resultPath, JSON.stringify(data, null, 2));
  await notifyBot3Regen(clientChatId, `видео ${videoIndex + 1} (новый субтитр)`, finalPath);
}

// ── Section regeneration (non-video) ──────────────────────────────────────────

async function regenSection(clientChatId, section) {
  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  if (!fs.existsSync(resultPath)) return;
  const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const p    = data.prompts;

  console.log(`[visual] Регенерация секции ${section} для ${clientChatId}`);

  let newUrls = [];
  if (section === 'photos')    newUrls = await genBatch(p.photoPrompts,    q => startImage(q, '1:1'),  'Фото (regen)');
  if (section === 'stories')   newUrls = await genBatch(p.storyPrompts,    q => startImage(q, '9:16'), 'Stories (regen)');
  if (section === 'carousels') newUrls = await genBatch(p.carouselPrompts, q => startImage(q, '1:1'),  'Карусели (regen)');
  if (section === 'covers')    newUrls = await genBatch(p.coverPrompts,    q => startImage(q, '9:16'), 'Обложки (regen)');

  data.results[section] = newUrls;
  delete data.approved[section];
  fs.writeFileSync(resultPath, JSON.stringify(data, null, 2));

  await notifyBot3RegenSection(clientChatId, section);
}

// ── Video subtitle translation ─────────────────────────────────────────────────

async function translateSubtitle(text, targetLang) {
  if (!text) return '';
  const langNames = { lv: 'Latvian', en: 'English', ru: 'Russian', de: 'German', fr: 'French', lt: 'Lithuanian' };
  const { ask } = require('./src/claude');
  const result = await ask(
    `Translate this short video subtitle/caption to ${langNames[targetLang] || targetLang}.\nReturn ONLY the translated text, nothing else. Keep it short (max 60 characters).\n\n${text}`,
    { model: HAIKU, maxTokens: 100 }
  );
  return result.trim().slice(0, 60);
}

async function translateVideos(clientChatId, targetLang) {
  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  if (!fs.existsSync(resultPath)) {
    console.error('[visual] results not found for translate:', clientChatId); return;
  }
  const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const videoData = data.results.videoData || [];

  console.log(`[visual] Перевод субтитров для ${clientChatId} → ${targetLang} (${videoData.length} видео)`);

  const translatedPaths = [];
  for (let i = 0; i < videoData.length; i++) {
    const vd = videoData[i];
    if (!vd?.rawPath || !fs.existsSync(vd.rawPath)) {
      translatedPaths.push(null);
      continue;
    }
    const translatedText = await translateSubtitle(vd.subtitleText || '', targetLang);
    const outPath = path.join(TMP_DIR, `${clientChatId}_v${i}_${targetLang}_final.mp4`);
    try {
      addSubtitles(vd.rawPath, translatedText, outPath);
      translatedPaths.push(outPath);
      console.log(`[visual] Видео ${i + 1} переведено: "${translatedText}"`);
    } catch (e) {
      console.error(`[visual] subtitle translate error video ${i}:`, e.message);
      translatedPaths.push(null);
    }
  }

  const transResultPath = path.join(RESULTS_DIR, `${clientChatId}.trans_${targetLang}.json`);
  fs.writeFileSync(transResultPath, JSON.stringify({
    clientChatId, targetLang, videos: translatedPaths, timestamp: Date.now(),
  }, null, 2));

  await notifyBot3Translation(clientChatId, targetLang, translatedPaths);
}

// ── Download image URL, apply text overlay, save to disk ──────────────────────

// Маппинг sectionKey → sizeKey для overlayTextOnImage
const SECTION_SIZE = { carousel: 'carousel', carousels: 'carousel', photos: 'photo', covers: 'cover', stories: 'story' };

async function applyAndSaveOverlays(urls, texts, clientChatId, sectionKey, position = 'bottom') {
  const { default: fetch } = await import('node-fetch');
  const sizeKey = SECTION_SIZE[sectionKey] || 'photo';
  const localPaths = [];
  for (let i = 0; i < urls.length; i++) {
    const url  = urls[i];
    const text = (texts[i] || '').trim();
    if (!url || !text || text === 'без текста' || text === 'no text') {
      localPaths.push(null); continue;
    }
    try {
      const resp = await fetch(url);
      const buf  = await resp.buffer();
      const processed = await overlayTextOnImage(buf, text, position, sizeKey);
      const outPath   = path.join(RESULTS_DIR, `${clientChatId}_${sectionKey}_${i}_ov.jpg`);
      fs.writeFileSync(outPath, processed);
      localPaths.push(outPath);
      console.log(`[visual] overlay ${sectionKey}[${i}] sizeKey=${sizeKey}: "${text.slice(0, 50)}"`);
    } catch (e) {
      console.error(`[visual] overlay error ${sectionKey}[${i}]:`, e.message);
      localPaths.push(null);
    }
  }
  return localPaths;
}

async function bot3SendPhotoFile(chatId, filePath, caption, replyMarkup) {
  const token = process.env.TELEGRAM_BOT3_TOKEN;
  if (!token || !chatId || !filePath || !fs.existsSync(filePath)) return false;
  const { default: fetch } = await import('node-fetch');
  const FormData = (await import('form-data')).default;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('photo', fs.createReadStream(filePath));
  if (caption) form.append('caption', caption);
  if (replyMarkup) form.append('reply_markup', JSON.stringify(replyMarkup));
  const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', body: form });
  return r.ok;
}

// ── Batched image generation ───────────────────────────────────────────────────

async function genBatch(prompts, startFn, label, batchSize = 5) {
  const out = [];
  for (let i = 0; i < prompts.length; i += batchSize) {
    const slice = prompts.slice(i, i + batchSize);
    console.log(`[visual] ${label}: ${i + 1}–${Math.min(i + batchSize, prompts.length)}/${prompts.length}`);
    const taskIds = await Promise.all(slice.map(p => startFn(p).catch(() => null)));
    const urls    = await Promise.all(taskIds.map(id => pollTask(id, 900000, 'image')));
    out.push(...urls);
  }
  return out;
}

// ── Free package: carousel slides + cover ─────────────────────────────────────

async function generateFreeVisuals(clientChatId, carouselScript, coverExample, photoExample = '') {
  console.log(`[visual] generateFreeVisuals: ${clientChatId}`);

  // Очищаем флаги от предыдущих запусков
  for (const flag of ['free_visuals_notified', 'visuals_6done', 'carousel_notified', 'cover_notified']) {
    const f = path.join(RESULTS_DIR, `${clientChatId}.${flag}`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  const [carouselPrompts, coverPrompts] = await Promise.all([
    getImagePrompts(carouselScript, 'carousel', 5),
    getImagePrompts(coverExample,   'cover',    1),
  ]);

  // Извлекаем тексты для наложения на изображения
  const carouselTexts = extractSlideTexts(carouselScript, 'carousel');

  // Заголовок обложки — строка "Заголовок на обложке: ..."
  const coverTitleMatch = coverExample.match(/Заголовок на обложке\s*[:\-–]\s*(.+)/i);
  const coverTitle = coverTitleMatch ? wordSlice(coverTitleMatch[1].trim(), 6) : '';

  // Заголовок фото-поста — строка "Заголовок поста: ..."
  const photoTitleMatch = photoExample.match(/Заголовок поста\s*[:\-–]\s*(.+)/i);
  const photoTitle = photoTitleMatch ? wordSlice(photoTitleMatch[1].trim(), 6) : '';

  // Подписи к постам (текст под публикацией в соцсети)
  const carouselCaptions = carouselPrompts.map((_, i) => extractSlideCaption(carouselScript, i + 1) || '');
  const photoCaptionMatch = photoExample.match(/Подпись к посту\s*[:\-–]\s*([\s\S]+?)(?:\n\n|\nХэштеги|\nПочему|$)/i);
  const photoCaption = photoCaptionMatch ? photoCaptionMatch[1].trim().slice(0, 500) : '';

  console.log(`[visual] freeVisuals: карусель=${carouselPrompts.length} обложка=${coverPrompts.length} текстов-слайдов=${carouselTexts.length}`);

  // Сохраняем промпты И тексты И подписи — используются при visual_sample и перегенерации
  fs.writeFileSync(
    path.join(RESULTS_DIR, `${clientChatId}.free_prompts.json`),
    JSON.stringify({
      carousel: carouselPrompts,
      cover: coverPrompts,
      carouselTexts,
      carouselCaptions,
      coverTitle,
      photoTitle,
      photoCaption,
      savedAt: Date.now(),
    }, null, 2)
  );

  // Инициализируем файл результатов
  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.free_visuals.json`);
  fs.writeFileSync(resultPath, JSON.stringify({ carouselUrls: [], coverUrls: [], generatedAt: Date.now() }, null, 2));

  // Запускаем все задания — сначала проверяем библиотеку, потом Kie.ai
  const allPromises = [];

  for (let i = 0; i < carouselPrompts.length; i++) {
    // Проверяем фото-библиотеку перед Kie.ai
    const libPath = await tryPhotoLibrary(carouselPrompts[i], clientChatId, 'carousel');
    if (libPath) {
      // Есть в библиотеке — имитируем готовый результат
      const { default: fetch } = await import('node-fetch');
      const tmpUrl = `file://${libPath}`;
      console.log(`[photo-lib] carousel_${i} взят из библиотеки`);
      allPromises.push(
        (async () => {
          const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
          while (data.carouselUrls.length <= i) data.carouselUrls.push(null);
          data.carouselUrls[i] = tmpUrl;
          // Копируем файл в results
          const destPath = path.join(RESULTS_DIR, `${clientChatId}_carousel_${i}.jpg`);
          fs.copyFileSync(libPath, destPath);
          data.carouselUrls[i] = destPath; // используем локальный путь
          fs.writeFileSync(resultPath, JSON.stringify(data, null, 2));
        })()
      );
      continue;
    }
    const taskId = await startImage(carouselPrompts[i], '1:1').catch(() => null);
    if (taskId) {
      saveImageTask(taskId, { clientId: clientChatId, type: 'free_visuals', slot: `carousel_${i}` });
      allPromises.push(pollAndSave(taskId, { clientId: clientChatId, type: 'free_visuals', slot: `carousel_${i}`, taskId }));
    }
  }
  for (let i = 0; i < coverPrompts.length; i++) {
    const libPath = await tryPhotoLibrary(coverPrompts[i], clientChatId, 'cover');
    if (libPath) {
      console.log(`[photo-lib] cover_${i} взят из библиотеки`);
      allPromises.push(
        (async () => {
          const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
          while (data.coverUrls.length <= i) data.coverUrls.push(null);
          const destPath = path.join(RESULTS_DIR, `${clientChatId}_cover_${i}.jpg`);
          fs.copyFileSync(libPath, destPath);
          data.coverUrls[i] = destPath;
          fs.writeFileSync(resultPath, JSON.stringify(data, null, 2));
        })()
      );
      continue;
    }
    const taskId = await startImage(coverPrompts[i], '9:16').catch(() => null);
    if (taskId) {
      saveImageTask(taskId, { clientId: clientChatId, type: 'free_visuals', slot: `cover_${i}` });
      allPromises.push(pollAndSave(taskId, { clientId: clientChatId, type: 'free_visuals', slot: `cover_${i}`, taskId }));
    }
  }

  // Ждём завершения всех (уведомление Bot3 отправляется из rebuildFreeVisuals при done===6)
  await Promise.all(allPromises);

  const finalResult = (() => { try { return JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch { return {}; } })();
  console.log(`[visual] generateFreeVisuals done: carousel=${(finalResult.carouselUrls || []).filter(Boolean).length} cover=${(finalResult.coverUrls || []).filter(Boolean).length}`);
}

// ── Free package: one real photo ──────────────────────────────────────────────

async function generateFreePhoto(clientChatId, prompt) {
  console.log(`[visual] generateFreePhoto: ${clientChatId} prompt=${prompt ? prompt.slice(0, 100) : 'EMPTY'}`);
  if (!prompt || prompt.length < 10) {
    console.error('[visual] generateFreePhoto: промпт пустой или слишком короткий');
    return;
  }
  const taskId = await startImage(prompt, '1:1').catch(() => null);
  if (!taskId) { console.error('[visual] generateFreePhoto: нет taskId'); return; }

  // Сохраняем на диск — переживёт рестарт
  saveImageTask(taskId, { clientId: clientChatId, type: 'free_photo', slot: 'photo_0', taskId });
  const url = await pollTask(taskId, 900000, 'image');
  removeImageTask(taskId);

  if (!url) {
    console.error('[visual] generateFreePhoto: no URL returned');
    return;
  }

  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.free_photo.json`);
  fs.writeFileSync(resultPath, JSON.stringify({ url, prompt, generatedAt: Date.now() }, null, 2));
  console.log(`[visual] generateFreePhoto done: ${url}`);

  // Встраиваем фото прямо в HTML-страницу клиента
  try {
    const { updatePackPagePhoto } = require('./src/site_builder');
    updatePackPagePhoto(clientChatId, url);
  } catch (e) {
    console.error('[visual] updatePackPagePhoto error:', e.message);
  }

  // Фото отправляется независимо ниже — карусель и обложка уже ушли своим путём

  // Уведомляем Bot3 — используем локальный файл если есть
  const adminChatId = process.env.BOT3_MANAGER_CHAT_ID;
  const botToken    = process.env.TELEGRAM_BOT3_TOKEN;
  if (!adminChatId || !botToken) return;

  const { default: fetch } = await import('node-fetch');
  const FormData = (await import('form-data')).default;

  // Читаем localPath из сохранённого JSON
  let photoLocalPath = null;
  try {
    const saved = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${clientChatId}.free_photo.json`), 'utf8'));
    photoLocalPath = saved.localPath || null;
  } catch {}

  if (photoLocalPath && fs.existsSync(photoLocalPath)) {
    const form = new FormData();
    form.append('chat_id', adminChatId);
    form.append('photo', fs.createReadStream(photoLocalPath), { filename: 'photo.jpg' });
    form.append('caption', '📸 AI-фото для бесплатного пакета');
    await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: 'POST', body: form }).catch(() => {});
  } else {
    await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: adminChatId, photo: url, caption: '📸 AI-фото для бесплатного пакета' }),
    }).catch(() => {});
  }

  // Кнопки редактирования под фото
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: adminChatId,
      text: 'AI-фото:',
      reply_markup: JSON.stringify({
        inline_keyboard: [[
          { text: '🔄 Переделать', callback_data: `regen_fs_ph_${clientChatId}` },
          { text: '✏️ Изм. текст', callback_data: `et_ph_0_${clientChatId}` },
        ]],
      }),
    }),
  }).catch(() => {});
}

// ── Regenerate one free-package image slot ─────────────────────────────────────
// slotCode: c0..c4 = carousel slides, cv = cover, ph = photo

const SLOT_CODE_MAP = {
  c0: 'carousel_0', c1: 'carousel_1', c2: 'carousel_2', c3: 'carousel_3', c4: 'carousel_4',
  cv: 'cover_0',
  ph: 'photo_0',
};

async function regenFreeImage(clientChatId, slotCode) {
  const slotKey = SLOT_CODE_MAP[slotCode];
  if (!slotKey) { console.error('[visual] regenFreeImage: unknown slotCode', slotCode); return; }

  const adminChatId = process.env.BOT3_MANAGER_CHAT_ID;
  const botToken    = process.env.TELEGRAM_BOT3_TOKEN;
  const { default: fetch } = await import('node-fetch');

  const notify = async (text) => {
    if (!adminChatId || !botToken) return;
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: adminChatId, text }),
    }).catch(() => {});
  };

  console.log(`[visual] regenFreeImage: ${clientChatId} slot=${slotKey}`);

  let prompt = null;

  if (slotKey === 'photo_0') {
    const photoFile = path.join(RESULTS_DIR, `${clientChatId}.free_photo.json`);
    try { prompt = JSON.parse(fs.readFileSync(photoFile, 'utf8')).prompt || null; } catch {}
  } else {
    const promptsFile = path.join(RESULTS_DIR, `${clientChatId}.free_prompts.json`);
    try {
      const p = JSON.parse(fs.readFileSync(promptsFile, 'utf8'));
      if (slotKey.startsWith('carousel_')) {
        const idx = Number(slotKey.split('_')[1]);
        prompt = (p.carousel || [])[idx] || null;
      } else if (slotKey === 'cover_0') {
        prompt = (p.cover || [])[0] || null;
      }
    } catch {}
  }

  if (!prompt) {
    await notify(`⚠️ Промпт для ${slotKey} не найден — нельзя перегенерировать.`);
    return;
  }

  await notify(`🔄 Перегенерирую ${slotKey === 'photo_0' ? 'AI-фото' : slotKey === 'cover_0' ? 'обложку' : 'слайд ' + (Number(slotKey.split('_')[1]) + 1)}...`);

  const size = (slotKey === 'cover_0') ? '9:16' : '1:1';
  const taskId = await startImage(prompt, size).catch(() => null);
  if (!taskId) { await notify(`❌ Ошибка запуска генерации для ${slotKey}`); return; }

  const url = await pollTask(taskId, 900000, 'image');
  if (!url) { await notify(`❌ Генерация не удалась для ${slotKey}`); return; }

  // Обновляем результат на диске
  if (slotKey === 'photo_0') {
    const photoFile = path.join(RESULTS_DIR, `${clientChatId}.free_photo.json`);
    try {
      const existing = JSON.parse(fs.readFileSync(photoFile, 'utf8'));
      fs.writeFileSync(photoFile, JSON.stringify({ ...existing, url, generatedAt: Date.now() }, null, 2));
    } catch { fs.writeFileSync(photoFile, JSON.stringify({ url, prompt, generatedAt: Date.now() }, null, 2)); }
    const { updatePackPagePhoto } = require('./src/site_builder');
    updatePackPagePhoto(clientChatId, url);
  } else {
    const visualsFile = path.join(RESULTS_DIR, `${clientChatId}.free_visuals.json`);
    try {
      const existing = JSON.parse(fs.readFileSync(visualsFile, 'utf8'));
      existing[slotKey] = url;
      fs.writeFileSync(visualsFile, JSON.stringify(existing, null, 2));
    } catch {}
    // Пересобираем массивы и обновляем страницу
    rebuildFreeVisuals(clientChatId);
  }

  // Отправляем новое изображение менеджеру
  if (adminChatId && botToken) {
    const label = slotKey === 'photo_0' ? 'AI-фото' : slotKey === 'cover_0' ? 'Обложка' : `Слайд ${Number(slotKey.split('_')[1]) + 1}`;
    await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: adminChatId, photo: url, caption: `✅ ${label} перегенерирован` }),
    }).catch(() => {});
  }
}

// ── Helpers ────────────────────────────────────────────────────────────────────

function savePartialResults(clientChatId, pkg, prompts, results, existing, notifiedSections) {
  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  fs.writeFileSync(resultPath, JSON.stringify({
    clientChatId,
    clientName: pkg.clientName,
    packageKey: pkg.packageKey,
    prompts,
    results,
    approved:         (existing || {}).approved || {},
    notifiedSections: notifiedSections || (existing || {}).notifiedSections || {},
    timestamp: Date.now(),
  }, null, 2));
}

// ── Per-section notifications with per-item regen buttons ─────────────────────

async function sendSectionImages(clientChatId, clientName, sectionCode, sectionTitle, urls, itemLabel, localPaths = []) {
  const chatId = process.env.BOT3_MANAGER_CHAT_ID;
  const token  = process.env.TELEGRAM_BOT3_TOKEN;
  if (!chatId || !token) return;
  const { default: fetch } = await import('node-fetch');
  const FormData = (await import('form-data')).default;

  const valid = urls.filter(Boolean);
  await bot3Send(chatId, `${sectionTitle} готовы — *${clientName}*\n${valid.length}/${urls.length}`);

  // Применяем лого к локальным файлам если оно есть
  const logoMeta = getLogoMeta(clientChatId);
  const logoLocalPaths = logoMeta
    ? await Promise.all(localPaths.map(lp => lp && fs.existsSync(lp) ? applyLogoToFile(lp, clientChatId) : Promise.resolve(lp)))
    : localPaths;

  // Send images one by one — use local file (with text overlay) if available, else URL
  for (let i = 0; i < urls.length; i += 10) {
    const batch = urls.slice(i, i + 10);
    const batchLocal = logoLocalPaths.slice(i, i + 10);

    // Check if any in this batch have local overlay files
    const hasLocal = batch.some((_, j) => batchLocal[j] && fs.existsSync(batchLocal[j]));

    if (hasLocal) {
      // Send as media group with attach:// for local files
      const validBatch = batch.map((url, j) => ({ url, lp: batchLocal[j], idx: i + j })).filter(x => x.url || (x.lp && fs.existsSync(x.lp)));
      if (validBatch.length > 1) {
        const FormData = (await import('form-data')).default;
        const form = new FormData();
        form.append('chat_id', String(chatId));
        const media = validBatch.map((x, k) => {
          const key = `photo${k}`;
          if (x.lp && fs.existsSync(x.lp)) {
            form.append(key, fs.createReadStream(x.lp), { filename: `${key}.jpg`, contentType: 'image/jpeg' });
            return { type: 'photo', media: `attach://${key}`, caption: k === 0 ? `${itemLabel} ${x.idx + 1}` : undefined };
          } else {
            return { type: 'photo', media: x.url, caption: k === 0 ? `${itemLabel} ${x.idx + 1}` : undefined };
          }
        });
        form.append('media', JSON.stringify(media));
        await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, { method: 'POST', body: form }).catch(() => {});
      } else if (validBatch.length === 1) {
        const x = validBatch[0];
        if (x.lp && fs.existsSync(x.lp)) {
          await bot3SendPhotoFile(chatId, x.lp, `${itemLabel} ${x.idx + 1}`).catch(() => {});
        } else {
          await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, photo: x.url, caption: `${itemLabel} ${x.idx + 1}` }) }).catch(() => {});
        }
      }
    } else {
      // No overlays — send as media group (URLs)
      const validBatch = batch.filter(Boolean);
      if (validBatch.length > 1) {
        await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            media: validBatch.map((url, j) => ({ type: 'photo', media: url, caption: `${itemLabel} ${i + j + 1}` })),
          }),
        }).catch(() => {});
      } else if (validBatch.length === 1) {
        await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, photo: validBatch[0], caption: `${itemLabel} ${i + 1}` }),
        }).catch(() => {});
      }
    }
  }

  if (urls.length === 0) return;
  // Each item: [🔄 N] [✏️ N] [🚫 N]
  const rows = [];
  for (let i = 0; i < urls.length; i++) {
    const ok = !!urls[i];
    rows.push([
      { text: `${ok ? '🔄' : '❌'} ${i + 1}`, callback_data: `ri_${sectionCode}_${i}_${clientChatId}` },
      { text: `✏️ ${i + 1}`, callback_data: `et_${sectionCode}_${i}_${clientChatId}` },
      { text: `🚫 ${i + 1}`, callback_data: `notxt_${sectionCode}_${i}_${clientChatId}` },
    ]);
  }

  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      text: '🔄 — перегенерировать   ✏️ — изменить текст/подпись:',
      reply_markup: JSON.stringify({ inline_keyboard: rows }),
    }),
  }).catch(() => {});
}

async function notifyBot3SectionPhotos(clientChatId, clientName, photos, captions, localPaths = []) {
  await sendSectionImages(clientChatId, clientName, 'ph', '📸 Фото постов', photos, 'Фото', localPaths);
  if (captions && captions.length > 0) {
    const captionText = captions.map((c, i) => `📝 Фото ${i + 1}:\n${c}`).join('\n\n');
    const chatId = process.env.BOT3_MANAGER_CHAT_ID;
    const token  = process.env.TELEGRAM_BOT3_TOKEN;
    if (chatId && token) {
      const { default: fetch } = await import('node-fetch');
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: `📝 Подписи к постам (фото):\n\n${captionText}` }),
      }).catch(() => {});
    }
  }
}

async function notifyBot3SectionStories(clientChatId, clientName, stories, localPaths = []) {
  await sendSectionImages(clientChatId, clientName, 'st', '📱 Stories', stories, 'Story', localPaths);
}

async function notifyBot3SectionCovers(clientChatId, clientName, covers, localPaths = []) {
  await sendSectionImages(clientChatId, clientName, 'co', '🖼 Обложки', covers, 'Обложка', localPaths);
}

async function notifyBot3SectionCarousels(clientChatId, clientName, carouselSlides, groups, localPaths = []) {
  const chatId = process.env.BOT3_MANAGER_CHAT_ID;
  const token  = process.env.TELEGRAM_BOT3_TOKEN;
  if (!chatId || !token) return;
  const { default: fetch } = await import('node-fetch');

  const total = carouselSlides.length;
  const valid = carouselSlides.filter(Boolean);
  await bot3Send(chatId, `🎠 Карусели готовы — *${clientName}*\n${valid.length}/${total} слайдов`);

  // Применяем лого к локальным файлам если оно есть
  const logoMeta = getLogoMeta(clientChatId);
  if (logoMeta) {
    for (let i = 0; i < localPaths.length; i++) {
      if (localPaths[i] && fs.existsSync(localPaths[i])) {
        localPaths[i] = await applyLogoToFile(localPaths[i], clientChatId);
      }
    }
  }

  // Use detected groups (dynamic 5/6/7 per carousel) or fall back to fixed
  const resolvedGroups = (groups && groups.length > 0)
    ? groups
    : (() => {
        const g = []; let rem = total;
        while (rem > 0) { g.push(Math.min(SLIDES_PER_CAROUSEL_FALLBACK, rem)); rem -= SLIDES_PER_CAROUSEL_FALLBACK; }
        return g;
      })();

  let start = 0;
  for (let c = 0; c < resolvedGroups.length; c++) {
    const rawCount = resolvedGroups[c];
    const count = Math.min(7, Math.max(5, rawCount));
    const slides      = carouselSlides.slice(start, start + count);
    const slideLocal  = localPaths.slice(start, start + count);
    const validSlides = slides.filter(Boolean);
    const hasLocal    = slides.some((_, j) => slideLocal[j] && fs.existsSync(slideLocal[j]));

    if (hasLocal) {
      // Send individually with text overlay files
      for (let j = 0; j < slides.length; j++) {
        const lp  = slideLocal[j];
        const url = slides[j];
        const cap = j === 0 ? `Карусель ${c + 1}` : undefined;
        if (lp && fs.existsSync(lp)) {
          await bot3SendPhotoFile(chatId, lp, cap).catch(() => {});
        } else if (url) {
          await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: chatId, photo: url, ...(cap ? { caption: cap } : {}) }),
          }).catch(() => {});
        }
      }
    } else if (validSlides.length > 1) {
      await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          media: validSlides.map((url, j) => ({
            type: 'photo', media: url,
            caption: j === 0 ? `Карусель ${c + 1}` : undefined,
          })),
        }),
      }).catch(() => {});
    } else if (validSlides.length === 1) {
      await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, photo: validSlides[0], caption: `Карусель ${c + 1}` }),
      }).catch(() => {});
    }

    const rows = [];
    for (let j = 0; j < slides.length; j++) {
      const ok = !!slides[j];
      rows.push([
        { text: `${ok ? '🔄' : '❌'} Сл.${start + j + 1}`, callback_data: `ri_ca_${start + j}_${clientChatId}` },
        { text: `✏️ Сл.${start + j + 1}`, callback_data: `et_ca_${start + j}_${clientChatId}` },
        { text: `🚫 Сл.${start + j + 1}`, callback_data: `notxt_ca_${start + j}_${clientChatId}` },
      ]);
    }

    if (rows.length > 0) {
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: chatId,
          text: `Карусель ${c + 1} (${count} слайдов) — 🔄 перегенерировать   ✏️ изменить текст:`,
          reply_markup: JSON.stringify({ inline_keyboard: rows }),
        }),
      }).catch(() => {});
    }

    start += count;
  }
}

// ── Regenerate one individual image item ───────────────────────────────────────

async function regenItem(clientChatId, section, index, feedback = '') {
  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  if (!fs.existsSync(resultPath)) {
    console.error('[visual] regenItem: results not found for', clientChatId); return;
  }
  const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const p    = data.prompts;

  const chatId = process.env.BOT3_MANAGER_CHAT_ID;
  const token  = process.env.TELEGRAM_BOT3_TOKEN;
  const { default: fetch } = await import('node-fetch');

  const notify = async (text) => {
    if (!chatId || !token) return;
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    }).catch(() => {});
  };

  const SECTION_MAP = {
    ph: { prompts: p.photoPrompts,    ratio: '1:1',  key: 'photos',         label: 'Фото' },
    ca: { prompts: p.carouselPrompts, ratio: '1:1',  key: 'carouselSlides', label: 'Слайд' },
    co: { prompts: p.coverPrompts,    ratio: '9:16', key: 'covers',         label: 'Обложка' },
    st: { prompts: p.storyPrompts,    ratio: '9:16', key: 'stories',        label: 'Story' },
  };

  const info = SECTION_MAP[section];
  if (!info) { await notify(`❌ Неизвестная секция: ${section}`); return; }

  const originalPrompt = (info.prompts || [])[index];
  const itemLabel      = `${info.label} ${index + 1}`;
  if (!originalPrompt) { await notify(`⚠️ Промпт для ${itemLabel} не найден`); return; }

  if (feedback) logFeedback('image', originalPrompt, feedback);

  // Если менеджер указал что изменить — модифицируем промпт через Claude Haiku
  let finalPrompt = originalPrompt;
  if (feedback) {
    const { ask, HAIKU } = require('./src/claude');
    try {
      finalPrompt = await ask(
        `You are editing an image generation prompt.\n\nOriginal prompt: "${originalPrompt}"\n\nRequired change: "${feedback}"\n\nRewrite the prompt incorporating the required change while keeping all other visual elements the same. Return ONLY the modified prompt, no explanation.`,
        { model: HAIKU, maxTokens: 300 }
      );
      console.log(`[visual] regenItem: feedback="${feedback}" → modified prompt: ${finalPrompt.slice(0, 100)}`);
    } catch {
      finalPrompt = `${originalPrompt}. ${feedback}`;
    }
  }

  console.log(`[visual] regenItem: ${clientChatId} section=${section} index=${index}${feedback ? ' with feedback' : ''}`);
  await notify(`🔄 Перегенерирую ${itemLabel}${feedback ? `\nИзменение: "${feedback}"` : ''}...`);

  const taskId = await startImage(finalPrompt, info.ratio).catch(() => null);
  if (!taskId) { await notify(`❌ Ошибка запуска для ${itemLabel}`); return; }

  const url = await pollTask(taskId, 900000, 'image');
  if (!url) { await notify(`❌ Генерация не удалась для ${itemLabel}`); return; }

  // Скачиваем в постоянный файл (URL Kie.ai истекает через 24-72ч)
  const localKeyMap = { ph: 'photosLocalPaths', ca: 'carouselSlidesLocalPaths', co: 'coversLocalPaths', st: 'storiesLocalPaths' };
  const localKey = localKeyMap[section];
  const savedPath = path.join(RESULTS_DIR, `${clientChatId}_regen_${section}_${index}.jpg`);

  try {
    const imgResp = await fetch(url);
    const imgBuf  = await imgResp.buffer();
    fs.writeFileSync(savedPath, imgBuf);

    data.results[info.key] = data.results[info.key] || [];
    data.results[info.key][index] = url;
    if (localKey) {
      data.results[localKey] = data.results[localKey] || [];
      data.results[localKey][index] = savedPath;
    }
    fs.writeFileSync(resultPath, JSON.stringify(data, null, 2));

    // Обновляем HTML-страницу клиента с новым изображением
    try {
      const { updatePackPagePhoto, updatePackPageCover, updatePackPageCarousel } = require('./src/site_builder');
      if (section === 'ph') {
        updatePackPagePhoto(clientChatId, savedPath);
      } else if (section === 'co') {
        updatePackPageCover(clientChatId, savedPath);
      } else if (section === 'ca') {
        updatePackPageCarousel(clientChatId, data.results.carouselSlidesLocalPaths || []);
      }
    } catch (e2) {
      console.error('[visual] updatePackPage after regen error:', e2.message);
    }

    await bot3SendPhotoFile(clientChatId, savedPath, `✅ ${itemLabel} перегенерирован`, {
      inline_keyboard: [[
        { text: '🔄 Переделать ещё раз', callback_data: `ri_${section}_${index}_${clientChatId}` },
        { text: '✏️ Изм. текст',          callback_data: `et_${section}_${index}_${clientChatId}` },
      ]],
    });
  } catch (e) {
    await notify(`❌ Не удалось сохранить/отправить ${itemLabel}: ${e.message}`);
  }
}

// ── Main generation ────────────────────────────────────────────────────────────

async function runVisualGeneration(clientChatId, opts = {}) {
  const pkgPath = path.join(VISUAL_DIR, `${clientChatId}.visual.json`);
  if (!fs.existsSync(pkgPath)) {
    console.error('[visual] visual.json not found for', clientChatId); return;
  }
  const pkg        = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const isProfi    = pkg.packageKey.includes('pkg_v');
  const isStandard = pkg.packageKey.includes('pkg_standard');
  const fullVideoCount = isProfi ? 8 : 4;
  const videoCount = opts.maxVideos !== undefined ? Math.min(opts.maxVideos, fullVideoCount) : fullVideoCount;
  if (opts.maxVideos !== undefined) console.log(`[visual] Лимит видео: ${videoCount} (из ${fullVideoCount})`);

  console.log(`[visual] Старт: ${pkg.clientName} (${pkg.packageKey})`);

  // Build CTA text for video overlay from stored ctaPreference
  const ctaPref   = pkg.ctaPreference || '';
  const leadMagnet = pkg.leadMagnet || '';
  const videoCTA  = ctaPref === 'direct_magnet'
    ? `Напиши в директ — пришлю ${leadMagnet || 'подарок'}`.slice(0, 50)
    : ctaPref === 'direct_only'
    ? 'Пиши в директ — отвечу на вопрос'
    : ''; // CTA будет взят из скрипта в extractTimedTexts

  // maxPerSection=1 для качественного теста (1 карусель, 1 фото, 1 сторис, 1 обложка)
  const maxPerSection = opts.maxPerSection;
  const maxCovers = isStandard ? 2 : 4; // Wave 1 only — половина месячного пакета

  // Карусель: 1 карусель = первая группа слайдов (обычно 7)
  // Извлечение промптов: prefix (строка начинается с префикса) → fallback contains (слово где угодно в строке)
  const getPrompts = (text, prefix, limit) => {
    const byPrefix = extractByPrefix(text || '', prefix);
    if (byPrefix.length > 0) return byPrefix.slice(0, limit);
    const byContains = extractByContains(text || '', prefix);
    if (byContains.length > 0) return byContains.slice(0, limit);
    // Универсальный fallback для любого языка: промпты всегда содержат "photorealistic"
    const byPhotorealistic = (text || '').split('\n')
      .filter(l => l.toLowerCase().includes('photorealistic') && l.length > 30)
      .map(l => { const i = l.indexOf(':'); return i >= 0 ? l.slice(i + 1).trim() : l.trim(); })
      .filter(p => p.length > 20 && !p.startsWith('['));
    return byPhotorealistic.slice(0, limit);
  };

  const allCarouselPrompts = getPrompts(pkg.carouselScripts, 'Промпт для изображения', 28);
  const allCarouselGroups  = getCarouselGroups(pkg.carouselScripts, allCarouselPrompts.length);
  const carouselGroups     = maxPerSection ? allCarouselGroups.slice(0, maxPerSection) : allCarouselGroups;
  const carouselSlideCount = carouselGroups.reduce((s, n) => s + n, 0);
  const carouselPrompts    = allCarouselPrompts.slice(0, carouselSlideCount);

  const photoPrompts  = getPrompts(pkg.photoScripts,   'Промпт для AI-генерации', maxPerSection || 4);
  const photoCaptions = getPrompts(pkg.photoScripts,   'Подпись к посту',         maxPerSection || 4);
  const storyPrompts  = getPrompts(pkg.storiesScripts, 'Промпт для AI-генерации', maxPerSection || 7);
  const coverPrompts  = getPrompts(pkg.covers,         'Промпт для AI',           maxPerSection ? 1 : maxCovers);

  const prompts = { photoPrompts, photoCaptions, storyPrompts, carouselPrompts, coverPrompts, carouselGroups };

  // Extract overlay texts — sliced to match prompt counts
  const photoTexts = extractSlideTexts(pkg.photoScripts   || '', 'photos').slice(0, photoPrompts.length);
  const storyTexts = extractSlideTexts(pkg.storiesScripts || '', 'stories').slice(0, storyPrompts.length);
  const coverTexts = extractSlideTexts(pkg.covers         || '', 'covers').slice(0, coverPrompts.length);
  const carouselTexts = extractSlideTexts(pkg.carouselScripts || '', 'carousel').slice(0, carouselSlideCount);

  console.log(`[visual] Карусели: ${carouselGroups.length} каруселей, слайды: [${carouselGroups.join(',')}]`);

  console.log(`[visual] Промпты: фото=${photoPrompts.length} stories=${storyPrompts.length} карусели=${carouselPrompts.length} обложки=${coverPrompts.length}`);

  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch {}

  const notified = existing?.notifiedSections || {};

  // Shared results — updated by each section as it completes (JS single-thread = no race)
  // Если quality test — обрезаем существующие результаты до maxPerSection
  // чтобы не отправить полный пакет из кэша при повторном запуске
  const truncate = (arr, max) => max ? (arr || []).slice(0, max) : (arr || []);
  const allResults = {
    photos:         truncate(existing?.results?.photos,         maxPerSection),
    stories:        truncate(existing?.results?.stories,        maxPerSection),
    carouselSlides: truncate(existing?.results?.carouselSlides, maxPerSection ? carouselSlideCount : undefined),
    covers:         truncate(existing?.results?.covers,         maxPerSection),
    videoData:      truncate(existing?.results?.videoData,      opts.maxVideos || (maxPerSection ? 1 : undefined)),
  };

  const save = () => savePartialResults(clientChatId, pkg, prompts, { ...allResults }, existing, notified);

  // ── Фаза 1: каждый тип изображений генерируется параллельно,
  //            уведомление отправляется сразу как секция готова ────────────────

  async function runImageSection(key, sectionPrompts, startFn, label, notifyFn, overlayTexts = [], overlayPos = 'bottom') {
    if (allResults[key].some(Boolean)) {
      console.log(`[visual] ${key} уже есть — пропускаем генерацию`);
      if (!notified[key]) {
        const localPaths = allResults[`${key}LocalPaths`] || [];
        await notifyFn(clientChatId, pkg.clientName, allResults[key], localPaths);
        notified[key] = true;
        save();
      }
      return;
    }
    if (sectionPrompts.length === 0) {
      console.log(`[visual] ${key}: нет промптов — пропускаем`); return;
    }
    const results = await genBatch(sectionPrompts, startFn, label);
    allResults[key] = results;
    save();
    // Apply text overlay on generated images
    const localPaths = overlayTexts.length
      ? await applyAndSaveOverlays(results, overlayTexts, clientChatId, key, overlayPos)
      : [];
    allResults[`${key}LocalPaths`] = localPaths;
    save();
    if (!notified[key] && results.some(Boolean)) {
      await notifyFn(clientChatId, pkg.clientName, results, localPaths);
      notified[key] = true;
      save();
    }
  }

  await Promise.all([
    runImageSection('photos',         photoPrompts,    p => startImage(p, '1:1'),  'Фото постов',
      (id, name, photos, lp) => notifyBot3SectionPhotos(id, name, photos, prompts.photoCaptions, lp),
      photoTexts, 'bottom'),
    runImageSection('carouselSlides', carouselPrompts, p => startImage(p, '1:1'),  'Карусели',
      (id, name, slides, lp) => notifyBot3SectionCarousels(id, name, slides, carouselGroups, lp),
      carouselTexts, 'bottom'),
    runImageSection('covers',         coverPrompts,    p => startImage(p, '9:16'), 'Обложки',
      (id, name, covers, lp) => notifyBot3SectionCovers(id, name, covers, lp),
      coverTexts, 'bottom'),
    runImageSection('stories',        storyPrompts,    p => startImage(p, '9:16'), 'Stories',
      (id, name, stories, lp) => notifyBot3SectionStories(id, name, stories, lp),
      storyTexts, 'center'),
  ]);

  // ── Фаза 2: видео по одному, уведомление после каждого ────────────────────
  if (isProfi || isStandard) {
    const videoScripts = splitVideoScripts(pkg.videoScripts).slice(0, videoCount);
    console.log(`[visual] Генерирую ${videoScripts.length} видео...`);

    // Показываем менеджеру RU-сценарии всех видео до начала генерации
    await notifyBot3VideoScriptsPreview(clientChatId, pkg.clientName, videoScripts);

    // Штамп генерации: защита от старой генерации продолжающейся после /reset_client
    // Файл удаляется reset_client → проверка перед каждым видео → aborting
    const stampPath = path.join(RESULTS_DIR, `${clientChatId}.gen_stamp.json`);
    const stampValue = `${Date.now()}`;
    fs.writeFileSync(stampPath, JSON.stringify({ stamp: stampValue }));

    for (let i = 0; i < videoScripts.length; i++) {
      // Проверяем штамп — если файл удалён или изменён (новый запуск), прекращаем
      try {
        const currentStamp = JSON.parse(fs.readFileSync(stampPath, 'utf8')).stamp;
        if (currentStamp !== stampValue) {
          console.log(`[visual] Штамп изменился — генерация отменена для ${clientChatId}`);
          break;
        }
      } catch {
        console.log(`[visual] Штамп удалён — генерация отменена для ${clientChatId} (reset_client?)`);
        break;
      }

      if (allResults.videoData[i]?.localPath && fs.existsSync(allResults.videoData[i].localPath)) {
        console.log(`[visual] Видео ${i + 1} уже есть — пропускаем`);
        continue;
      }
      const result = await generateOneVideo(videoScripts[i], i, clientChatId, videoCTA);
      allResults.videoData[i] = result;
      save();
      await notifyBot3SingleVideo(clientChatId, i, videoScripts.length, result?.localPath, result?.subtitleText, result?.libraryMatches);
    }
  }

  // ── Итоговое уведомление ────────────────────────────────────────────────────
  save();
  console.log(`[visual] Генерация завершена: ${pkg.clientName}`);
  await notifyBot3Final(clientChatId, pkg.clientName, pkg.packageKey, allResults);
}

// Split videoScripts text into individual video scripts (keeps "ВИДЕО N:" header in each part)
function splitVideoScripts(text) {
  const parts = text.split(/(?=(?:^|\n)ВИДЕО\s+\d+:)/im);
  return parts.map(s => s.trim()).filter(s => s.length > 50).slice(0, 8);
}

// ── Bot3 notifications ─────────────────────────────────────────────────────────

async function bot3Send(chatId, text, replyMarkup) {
  const token = process.env.TELEGRAM_BOT3_TOKEN;
  if (!token || !chatId) return;
  const { default: fetch } = await import('node-fetch');
  const body = { chat_id: chatId, parse_mode: 'Markdown', text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
}

async function bot3SendVideo(chatId, filePath) {
  const token = process.env.TELEGRAM_BOT3_TOKEN;
  if (!token || !chatId || !filePath || !fs.existsSync(filePath)) return;
  const { default: fetch } = await import('node-fetch');
  const FormData = (await import('form-data')).default;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('video', fs.createReadStream(filePath));
  await fetch(`https://api.telegram.org/bot${token}/sendVideo`, {
    method: 'POST',
    body:   form,
  });
}

// Фаза 1: изображения готовы, видео ещё генерируются
async function notifyBot3Images(clientChatId, clientName, packageKey, results) {
  const chatId     = process.env.BOT3_MANAGER_CHAT_ID;
  const isProfi    = packageKey.includes('pkg_v');
  const isStandard = packageKey.includes('pkg_standard');
  const hasVideos  = isProfi || isStandard;
  const maxVideos  = isProfi ? 4 : 2; // Wave 1 only
  await bot3Send(chatId,
    `🖼 Изображения готовы — *${clientName}*\n\n` +
    `📸 Фото: ${(results.photos || []).filter(Boolean).length}\n` +
    `🎠 Карусели: ${(results.carouselSlides || []).filter(Boolean).length} слайдов\n` +
    `📱 Stories: ${(results.stories || []).filter(Boolean).length}\n` +
    `🖼 Обложки: ${(results.covers || []).filter(Boolean).length}\n` +
    (hasVideos ? `\n🎬 Видео генерируются... (0/${maxVideos}) — пришлю по одному\n` : '') +
    `\nМожно начать проверку: /review_${clientChatId}`
  );
}

// Фаза 2: одно видео готово
// Превью всех видео-сценариев для менеджера на русском — отправляется ДО генерации
async function notifyBot3VideoScriptsPreview(clientChatId, clientName, videoScripts) {
  // Не отправляем если нет видео для генерации (nv-режим или пустой список)
  if (!videoScripts || videoScripts.length === 0) return;

  const chatId = process.env.BOT3_MANAGER_CHAT_ID;
  const token  = process.env.TELEGRAM_BOT3_TOKEN;
  if (!chatId || !token) return;

  const name = (clientName && clientName !== '—') ? clientName : `клиент ${clientChatId}`;
  const videoParts = [];

  for (let i = 0; i < videoScripts.length; i++) {
    const script = videoScripts[i];

    const titleM = script.match(/ВИДЕО\s*\d+\s*[:\s]+([^\n]+)/i);
    const title  = titleM ? titleM[1].trim().slice(0, 60) : `Видео ${i + 1}`;

    const hookM = script.match(/Эмоция зрителя\s*[:\s]+([^\n]+)/i);
    const hook  = hookM ? hookM[1].trim() : '';

    // Извлекаем RU-описания из блоков СЦЕНА N (новый формат block7)
    const ruLines = [];
    const ruRegex = /СЦЕНА\s*(\d+)[^\n]*[\s\S]*?RU\s*:\s*([^\n]+)/gi;
    let m;
    while ((m = ruRegex.exec(script)) !== null) {
      ruLines.push(`  ${m[1]}. ${m[2].trim()}`);
    }

    // Для старого формата (без СЦЕНА блоков) — показываем "что в кадре" как fallback
    let scenesText = '';
    if (ruLines.length) {
      scenesText = ruLines.join('\n');
    } else {
      const whatM = script.match(/Что в кадре\s*[:\s]+([^\n]+)/i);
      const moodM = script.match(/Настроение\s*[:\s]+([^\n]+)/i);
      if (whatM) scenesText = `  ${whatM[1].trim()}`;
      if (moodM) scenesText += (scenesText ? ` · ${moodM[1].trim()}` : moodM[1].trim());
    }

    let card = `*Видео ${i + 1}: ${title}*`;
    if (hook) card += `\nХук: "${hook}"`;
    if (scenesText) card += '\n' + scenesText;
    videoParts.push(card);
  }

  // Отправляем только если есть что показать
  if (videoParts.length === 0) return;

  const msg = `🎬 *Сценарии видео — ${name}*\nЧто будет в каждом ролике:\n\n` +
    videoParts.join('\n\n') +
    `\n\n_Начинаю генерацию. После готовности — 🔄 Переснять сцену если нужно._`;
  await bot3Send(chatId, msg);
}

async function notifyBot3SingleVideo(clientChatId, videoIndex, totalVideos, localPath, subtitleText, libraryMatches) {
  const chatId = process.env.BOT3_MANAGER_CHAT_ID;
  const token  = process.env.TELEGRAM_BOT3_TOKEN;
  if (!chatId || !token) return;
  const { default: fetch } = await import('node-fetch');

  if (localPath && fs.existsSync(localPath)) {
    await bot3Send(chatId, `🎬 Видео ${videoIndex + 1}/${totalVideos} готово:`);
    await bot3SendVideo(chatId, localPath).catch(() => {});

    // Show library matches if found
    if (libraryMatches && libraryMatches.length > 0) {
      const stats = libraryStats();
      await bot3Send(chatId,
        `📚 Библиотека: найдено ${libraryMatches.length} похожих видео (совпадения по тегам)\n` +
        `Теги: ${libraryMatches[0].tags?.slice(0, 4).join(', ')}\n` +
        `Всего в библиотеке: ${stats.count} видео (${stats.totalMb} МБ)\n\n` +
        `Можно использовать видео из библиотеки с другим субтитром — сэкономит 5-7 минут генерации.`
      );
    }

    // Send subtitle text separately with edit button
    const caption = subtitleText || '';
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:      chatId,
        text:         `📝 Текст субтитра:\n"${caption || '(нет текста)'}"`,
        reply_markup: {
          inline_keyboard: [[
            { text: `✏️ Изменить текст`, callback_data: `et_video_${videoIndex}_${clientChatId}` },
            { text: `🔄 Переснять сцену`, callback_data: `rscene_${videoIndex}_${clientChatId}` },
          ]],
        },
      }),
    }).catch(() => {});
  } else {
    await bot3Send(chatId, `⚠️ Видео ${videoIndex + 1}/${totalVideos} — не удалось собрать. Перегенерировать: /regen_video_${clientChatId}_${videoIndex}`);
  }
}

// Финальное уведомление
async function notifyBot3Final(clientChatId, clientName, packageKey, results) {
  const chatId     = process.env.BOT3_MANAGER_CHAT_ID;
  const isProfi    = packageKey.includes('pkg_v');
  const isStandard = packageKey.includes('pkg_standard');
  const maxVideos  = isProfi ? 4 : 2; // Wave 1 only
  const validVideos = (results.videoData || []).filter(v => v?.localPath && fs.existsSync(v.localPath)).length;
  await bot3Send(chatId,
    `✅ Генерация завершена — *${clientName}*\n\n` +
    `📸 Фото: ${(results.photos || []).filter(Boolean).length}\n` +
    `🎠 Карусели: ${(results.carouselSlides || []).filter(Boolean).length} слайдов\n` +
    `📱 Stories: ${(results.stories || []).filter(Boolean).length}\n` +
    `🖼 Обложки: ${(results.covers || []).filter(Boolean).length}\n` +
    ((isProfi || isStandard) ? `🎬 Видео: ${validVideos}/${maxVideos}\n` : '') +
    `\nПроверка и отправка клиенту: /review_${clientChatId}`
  );
}

// Оставляем для обратной совместимости
async function notifyBot3(clientChatId, clientName, packageKey, results) {
  await notifyBot3Final(clientChatId, clientName, packageKey, results);
}

async function notifyBot3Regen(clientChatId, label, localPath) {
  const chatId = process.env.BOT3_MANAGER_CHAT_ID;
  await bot3Send(chatId, `✅ *${label}* переделан. Отправляю...`);
  if (localPath) await bot3SendVideo(chatId, localPath);
  await bot3Send(chatId, `Что дальше?`, {
    inline_keyboard: [
      [{ text: '🔄 Переделать видео',        callback_data: `vs_regen_v_${clientChatId}` }],
      [
        { text: '✏️ Хук',  callback_data: `vs_edit_hook_${clientChatId}` },
        { text: '✏️ Тема', callback_data: `vs_edit_theme_${clientChatId}` },
        { text: '✏️ CTA',  callback_data: `vs_edit_cta_${clientChatId}` },
      ],
      [{ text: '✅ Продолжить проверку', callback_data: `review_resume_${clientChatId}` }],
    ],
  });
}

async function notifyBot3RegenSection(clientChatId, section) {
  const chatId = process.env.BOT3_MANAGER_CHAT_ID;
  await bot3Send(chatId,
    `✅ Секция *${section}* переделана.\n\nПродолжите проверку: /review_${clientChatId}`
  );
}

async function notifyBot3Translation(clientChatId, targetLang, videoPaths) {
  const { LANG_NAMES } = require('./src/languages');
  const chatId  = process.env.BOT3_MANAGER_CHAT_ID;
  const langLabel = LANG_NAMES[targetLang] || targetLang;
  const count   = videoPaths.filter(Boolean).length;
  await bot3Send(chatId,
    `🌐 Перевод видео готов — *${langLabel}*\n\n` +
    `🎬 Видео с субтитрами: ${count}/${videoPaths.length}\n\n` +
    `Отправьте клиенту: /send_trans_videos_${clientChatId}_${targetLang}`
  );
  for (let i = 0; i < videoPaths.length; i++) {
    if (videoPaths[i]) await bot3SendVideo(chatId, videoPaths[i]).catch(() => null);
  }
}

app.listen(PORT, () => {
  console.log(`[visual] Сервис запущен на порту ${PORT}`);
  resumePendingTasks();
  resumePendingVisualJobs();
});
