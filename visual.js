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
  const prevStory    = Array.isArray(data.storyUrls)    ? data.storyUrls    : [];
  const carouselUrls = [0,1,2,3,4,5,6].map(i => data[`carousel_${i}`] || prevCarousel[i] || null);
  const coverUrls    = [data['cover_0'] || prevCover[0] || null];
  const storyUrls    = [data['story_0'] || prevStory[0] || null];

  // Локальные пути (скачанные файлы — не зависят от Kie.ai TTL)
  const carouselLocal = [0,1,2,3,4,5,6].map(i => data[`carousel_${i}_local`] || null);
  const coverLocal    = [data['cover_0_local'] || null];
  const storyLocal    = [data['story_0_local'] || null];

  const carouselDone = carouselUrls.filter(Boolean).length;
  const coverDone    = coverUrls.filter(Boolean).length;
  const storyDone    = storyUrls.filter(Boolean).length;
  const generatedAt  = data.generatedAt || Date.now();
  const elapsed      = Date.now() - generatedAt;
  console.log(`[kie] rebuildFreeVisuals: carousel=${carouselDone}/7 cover=${coverDone}/1 story=${storyDone}/1`);

  fs.writeFileSync(resultFile, JSON.stringify({ carouselUrls, coverUrls, storyUrls, carouselLocal, coverLocal, storyLocal, generatedAt }, null, 2));

  const carouselFlag = path.join(RESULTS_DIR, `${clientId}.carousel_notified`);
  const coverFlag    = path.join(RESULTS_DIR, `${clientId}.cover_notified`);
  const storyFlag    = path.join(RESULTS_DIR, `${clientId}.story_notified`);

  // Карусель: отправляем как только все 7 готовы ИЛИ прошло >15 мин и >=6 готово
  const carouselReady = carouselDone === 7 || (carouselDone >= 6 && elapsed > 15 * 60 * 1000);
  if (carouselReady && !fs.existsSync(carouselFlag)) {
    fs.writeFileSync(carouselFlag, String(Date.now()));
    notifyCarouselReady(clientId, carouselUrls, carouselLocal).catch(() => {});
  }

  // Обложка: отправляем сразу как только готова
  if (coverDone >= 1 && !fs.existsSync(coverFlag)) {
    fs.writeFileSync(coverFlag, String(Date.now()));
    notifyCoverReady(clientId, coverUrls, coverLocal).catch(() => {});
  }

  // Сторис: отправляем сразу как только готова
  if (storyDone >= 1 && !fs.existsSync(storyFlag)) {
    fs.writeFileSync(storyFlag, String(Date.now()));
    notifyStoryReady(clientId, storyUrls, storyLocal).catch(() => {});
  }

  // «Отправить клиенту» — когда карусель, обложка И сторис уведомлены
  if (fs.existsSync(carouselFlag) && fs.existsSync(coverFlag) && fs.existsSync(storyFlag)) {
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
  let carouselTexts = [], carouselCaptions = [], coverTitle = '', storyText = '';
  try {
    if (fs.existsSync(promptsFile)) {
      const p = JSON.parse(fs.readFileSync(promptsFile, 'utf8'));
      carouselTexts    = p.carouselTexts    || [];
      carouselCaptions = p.carouselCaptions || [];
      coverTitle       = p.coverTitle       || '';
      storyText        = p.storyText        || '';
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

  return { adminChatId, botToken, fetch, FormData, carouselTexts, carouselCaptions, coverTitle, storyText, applyOverlayToPath, downloadAndOverlay, sendBotMsg };
}

// ── Карусель готова — отправляем в Bot3 ────────────────────────────────────
async function notifyCarouselReady(clientId, carouselUrls, carouselLocal = []) {
  const { adminChatId, botToken, fetch, FormData, carouselTexts, carouselCaptions, applyOverlayToPath, downloadAndOverlay, sendBotMsg } = await _freeNotifyUtils(clientId);
  if (!adminChatId || !botToken) return;

  const logoMeta = getLogoMeta(clientId);
  const readySlides = [];
  for (let i = 0; i < carouselUrls.length; i++) {
    const rawLocal = carouselLocal[i];
    let finalPath = null;
    if (rawLocal && fs.existsSync(rawLocal)) {
      finalPath = await applyOverlayToPath(rawLocal, carouselTexts[i] || '', 'bottom', 'carousel');
    } else if (carouselUrls[i]) {
      // Сохраняем в RESULTS_DIR — только оттуда раздаётся /images/ для HTML
      const dlPath = path.join(RESULTS_DIR, `${clientId}_free_carousel${i}.jpg`);
      finalPath = await downloadAndOverlay(carouselUrls[i], dlPath, carouselTexts[i] || '', 'bottom', 'carousel');
    }
    if (finalPath && logoMeta) finalPath = await applyLogoToFile(finalPath, clientId);
    if (finalPath) readySlides.push({ path: finalPath, index: i });
  }

  if (readySlides.length === 0) return;

  // Обновляем HTML-карусель — ПОСЛЕ наложения текста, используем готовые пути
  try {
    const { updatePackPageCarousel } = require('./src/site_builder');
    updatePackPageCarousel(clientId, readySlides.map(s => s.path));
  } catch (e) { console.error('[visual] updatePackPageCarousel error:', e.message, e.stack); }

  // Отправляем каждый слайд отдельно с кнопками (sendMediaGroup падал тихо из-за ограничений Telegram)
  for (const s of readySlides) {
    const caption = `Слайд ${s.index + 1}${carouselTexts[s.index] ? `: "${carouselTexts[s.index]}"` : ''}`;
    await bot3SendPhotoFile(adminChatId, s.path, caption, {
      inline_keyboard: [[
        { text: '🔄 Переделать', callback_data: `regen_fs_c${s.index}_${clientId}` },
        { text: '✏️ Изм. текст', callback_data: `et_ca_${s.index}_${clientId}` },
        { text: '🚫 Без текста', callback_data: `notxt_ca_${s.index}_${clientId}` },
      ]],
    });
  }

  const capLines = readySlides.map(s => carouselCaptions[s.index] ? `Слайд ${s.index + 1}: ${carouselCaptions[s.index]}` : null).filter(Boolean);
  if (capLines.length > 0) await sendBotMsg(`📝 Подписи к постам карусели:\n\n${capLines.join('\n\n')}`);
}

// ── Обложка готова — отправляем в Bot3 независимо ─────────────────────────
async function notifyCoverReady(clientId, coverUrls, coverLocal = []) {
  const { adminChatId, botToken, coverTitle, applyOverlayToPath, downloadAndOverlay, sendBotMsg } = await _freeNotifyUtils(clientId);
  if (!adminChatId || !botToken) return;

  const logoMeta = getLogoMeta(clientId);
  let coverPath = coverLocal[0];
  if (!coverPath || !fs.existsSync(coverPath)) {
    // Сохраняем в RESULTS_DIR — только оттуда раздаётся /images/ для HTML
    const dlPath = path.join(RESULTS_DIR, `${clientId}_free_cover0.jpg`);
    coverPath = await downloadAndOverlay(coverUrls[0], dlPath, coverTitle, 'bottom', 'cover');
  } else {
    coverPath = await applyOverlayToPath(coverPath, coverTitle, 'bottom', 'cover');
  }
  if (coverPath && fs.existsSync(coverPath)) {
    if (logoMeta) coverPath = await applyLogoToFile(coverPath, clientId);
    // Обновляем HTML — ПОСЛЕ наложения текста, используем готовый путь
    try {
      const { updatePackPageCover } = require('./src/site_builder');
      updatePackPageCover(clientId, coverPath);
    } catch (e) { console.error('[visual] updatePackPageCover error:', e.message, e.stack); }
    const sent = await bot3SendPhotoFile(adminChatId, coverPath, `🖼 Обложка готова${coverTitle ? `: "${coverTitle}"` : ''}`);
    if (!sent) console.error(`[notifyCoverReady] failed to send cover photo for ${clientId}`);
  }
  await sendBotMsg('Обложка:', {
    inline_keyboard: [[
      { text: '🔄 Переделать', callback_data: `regen_fs_cv_${clientId}` },
      { text: '✏️ Изм. текст', callback_data: `et_co_0_${clientId}` },
      { text: '🚫 Без текста', callback_data: `notxt_co_0_${clientId}` },
    ]],
  });
}

// ── Сторис готова — отправляем в Bot3 независимо ──────────────────────────
async function notifyStoryReady(clientId, storyUrls, storyLocal = []) {
  const { adminChatId, botToken, storyText, applyOverlayToPath, downloadAndOverlay, sendBotMsg } = await _freeNotifyUtils(clientId);
  if (!adminChatId || !botToken) return;

  const logoMeta = getLogoMeta(clientId);
  let storyPath = storyLocal[0];
  if (!storyPath || !fs.existsSync(storyPath)) {
    // Сохраняем в RESULTS_DIR — только оттуда раздаётся /images/ для HTML
    const dlPath = path.join(RESULTS_DIR, `${clientId}_free_story0.jpg`);
    storyPath = await downloadAndOverlay(storyUrls[0], dlPath, storyText, 'center', 'cover');
  } else {
    storyPath = await applyOverlayToPath(storyPath, storyText, 'center', 'cover');
  }
  if (storyPath && fs.existsSync(storyPath)) {
    if (logoMeta) storyPath = await applyLogoToFile(storyPath, clientId);
    try {
      const { updatePackPageStory } = require('./src/site_builder');
      updatePackPageStory(clientId, storyPath);
    } catch (e) { console.error('[visual] updatePackPageStory error:', e.message, e.stack); }
    const sent = await bot3SendPhotoFile(adminChatId, storyPath, `📱 Сторис готова${storyText ? `: "${storyText}"` : ''}`);
    if (!sent) console.error(`[notifyStoryReady] failed to send story photo for ${clientId}`);
  }
  await sendBotMsg('Сторис:', {
    inline_keyboard: [[
      { text: '🔄 Переделать', callback_data: `regen_fs_st_${clientId}` },
      { text: '✏️ Изм. текст', callback_data: `et_st_0_${clientId}` },
      { text: '🚫 Без текста', callback_data: `notxt_st_0_${clientId}` },
    ]],
  });
}

// ── Кнопка «Отправить клиенту» — когда карусель, обложка И сторис уведомлены ──
async function notifySendButton(clientId) {
  const { sendBotMsg } = await _freeNotifyUtils(clientId);
  await sendBotMsg('─────────────────────\n✅ Карусель, обложка и сторис проверены.', {
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

    // Если генерация уже завершена и доставлена — пропускаем без лишних проверок
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(VISUAL_DIR, f), 'utf8'));
      if (pkg.deliveredAt) {
        console.log(`[visual] ${clientChatId}: уже доставлен, пропускаем resume`);
        continue;
      }
    } catch {}

    if (fs.existsSync(resultPath)) {
      // Check if videos are expected but incomplete
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(VISUAL_DIR, f), 'utf8'));
        const isProfi    = (pkg.packageKey || '').includes('pkg_v');
        const isStandard = (pkg.packageKey || '').includes('pkg_standard');
        if (isProfi || isStandard) {
          const results = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
          const videoData   = results.results?.videoData || [];
          const expectedCount = isProfi ? 4 : 2;
          if (results.videosSkipped) {
            console.log(`[visual] ${clientChatId}: видео пропущены (nv), пропускаем resume`);
            continue;
          }
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

    // Файловый лок на клиента — защита от параллельных resume при множественных рестартах
    const lockPath = path.join(TRIGGERS_DIR, `${clientChatId}.resume.lock`);
    if (fs.existsSync(lockPath)) {
      try {
        const lockAge = Date.now() - parseInt(fs.readFileSync(lockPath, 'utf8') || '0');
        if (lockAge < 30 * 60 * 1000) {
          console.log(`[visual] ${clientChatId}: resume уже запущен (${Math.round(lockAge / 1000)}s назад), пропускаем`);
          continue;
        }
        fs.unlinkSync(lockPath); // устаревший лок — удаляем
      } catch { fs.unlinkSync(lockPath); }
    }
    fs.writeFileSync(lockPath, String(Date.now()));

    console.log(`[visual] resuming interrupted job for ${clientChatId}`);
    runVisualGeneration(clientChatId, { isResume: true })
      .catch(e => console.error('[visual] resume job error for', clientChatId, e.message))
      .finally(() => { try { fs.unlinkSync(lockPath); } catch {} });
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

// Принудительная генерация одного видео через Veo3 — без проверки библиотеки
// Вызывается когда менеджер нажимает "🆕 Сгенерировать новое" на библиотечном видео
app.post('/force_generate_video', (req, res) => {
  const { clientChatId, videoIndex = 0 } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  (async () => {
    const managerChatId = process.env.BOT3_MANAGER_CHAT_ID;
    const pkgPath = path.join(VISUAL_DIR, `${clientChatId}.visual.json`);
    if (!fs.existsSync(pkgPath)) {
      await bot3Send(managerChatId, `❌ visual.json не найден для ${clientChatId}`);
      return;
    }
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    const videoScripts = splitVideoScripts(pkg.videoScripts || '');
    const script = videoScripts[videoIndex] || videoScripts[0];
    if (!script) {
      await bot3Send(managerChatId, `❌ Нет видео-сценария для ${clientChatId}`);
      return;
    }
    const ctaPref    = pkg.ctaPreference || '';
    const leadMagnet = pkg.leadMagnet || '';
    const videoCTA   = ctaPref === 'direct_magnet'
      ? `Напиши в директ — пришлю ${leadMagnet || 'подарок'}`.slice(0, 50)
      : ctaPref === 'direct_only' ? 'Напиши в директ' : '';
    await bot3Send(managerChatId, `🎬 Запускаю Veo3 для Видео ${videoIndex + 1}... (~7-10 мин)`);
    const result = await generateOneVideo(script, videoIndex, clientChatId, videoCTA);
    if (result?.localPath) {
      // Обновляем results.json — заменяем библиотечное видео свежим
      const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
      try {
        const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        if (!data.results) data.results = {};
        if (!data.results.videoData) data.results.videoData = [];
        data.results.videoData[videoIndex] = result;
        fs.writeFileSync(resultPath, JSON.stringify(data, null, 2));
      } catch {}
    }
    await notifyBot3SingleVideo(clientChatId, videoIndex, videoScripts.length, result?.localPath, result?.subtitleText, null);
  })().catch(e => {
    console.error('[visual] force_generate_video error:', e.message);
    bot3Send(process.env.BOT3_MANAGER_CHAT_ID, `❌ Ошибка генерации: ${e.message}`);
  });
});

// Called by Bot3 va_ok_: генерирует все видео из video_scripts_pending.json
app.post('/generate_videos_from_pending', (req, res) => {
  const { clientChatId } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  (async () => {
    const managerChatId = process.env.BOT3_MANAGER_CHAT_ID;

    // Проверяем heartbeat: если waitForVideoApproval жива (обновляла файл <10 сек назад),
    // она сама обработает одобрение через runVisualGeneration — не дублируем генерацию
    const heartbeatPath = path.join(RESULTS_DIR, `${clientChatId}.veo_heartbeat.json`);
    try {
      const hb = JSON.parse(fs.readFileSync(heartbeatPath, 'utf8'));
      if (Date.now() - hb.ts < 10000) {
        console.log(`[visual] generate_videos_from_pending: waitForVideoApproval активна для ${clientChatId}, пропускаем прямую генерацию`);
        return;
      }
    } catch {}

    let scripts = [];
    let clientName = `клиент ${clientChatId}`;
    let videoCTA   = '';

    // Читаем сценарии из pending
    try {
      const p = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${clientChatId}.video_scripts_pending.json`), 'utf8'));
      scripts = p.scripts || [];
    } catch {}
    // Fallback: done_snapshot
    if (!scripts.length) {
      try {
        const snap = JSON.parse(fs.readFileSync(path.join(TRIGGERS_DIR, `${clientChatId}.done_snapshot.json`), 'utf8'));
        if (snap.videoScripts) scripts = splitVideoScripts(snap.videoScripts);
      } catch {}
    }
    // Данные клиента из visual.json
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(VISUAL_DIR, `${clientChatId}.visual.json`), 'utf8'));
      clientName = pkg.clientName || clientName;
      const ctaPref    = pkg.ctaPreference || '';
      const leadMagnet = pkg.leadMagnet    || '';
      videoCTA = ctaPref === 'direct_magnet'
        ? `Напиши в директ — пришлю ${leadMagnet || 'подарок'}`.slice(0, 50)
        : ctaPref === 'direct_only' ? 'Напиши в директ' : '';
    } catch {}

    if (!scripts.length) {
      await bot3Send(managerChatId, `❌ Сценарии для ${clientChatId} не найдены — запустите /run_visual заново.`);
      return;
    }

    await bot3Send(managerChatId, `🎬 Запускаю генерацию ${scripts.length} видео Veo3 для ${clientName}...\nПришлю каждое по готовности (~7-10 мин/видео).`);

    for (let i = 0; i < scripts.length; i++) {
      try {
        const result = await generateOneVideo(scripts[i], i, clientChatId, videoCTA);
        if (!result) continue; // null = placeholder detected, alert already sent above
        // Сохраняем в results.json
        const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
        try {
          const data = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : {};
          if (!data.results) data.results = {};
          if (!data.results.videoData) data.results.videoData = [];
          data.results.videoData[i] = result;
          fs.writeFileSync(resultPath, JSON.stringify(data, null, 2));
        } catch {}
        await notifyBot3SingleVideo(clientChatId, i, scripts.length, result?.localPath, result?.subtitleText, null);
      } catch (e) {
        console.error(`[visual] generate_videos_from_pending видео ${i + 1} ошибка:`, e.message);
        await bot3Send(managerChatId, `❌ Видео ${i + 1} не удалось: ${e.message}`);
      }
    }
  })().catch(e => {
    console.error('[visual] generate_videos_from_pending fatal:', e.message);
    bot3Send(process.env.BOT3_MANAGER_CHAT_ID, `❌ Ошибка генерации видео: ${e.message}`);
  });
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
        // Отправляем каждый слайд отдельно с кнопками (sendMediaGroup падал тихо)
        for (let idx = 0; idx < readyOv.length; idx++) {
          const caption = `Слайд ${idx + 1}${carouselTexts[idx] ? `: "${carouselTexts[idx]}"` : ''}`;
          await bot3SendPhotoFile(adminChatId, readyOv[idx], caption, {
            inline_keyboard: [[
              { text: `🔄 Слайд ${idx + 1}`, callback_data: `vs_regen_c_${clientChatId}_${idx}` },
              { text: `✏️ Текст ${idx + 1}`, callback_data: `vs_edit_c_${clientChatId}_${idx}` },
            ]],
          });
        }

        // Подписи к слайдам — отдельным сообщением
        const { default: fetchNode2 } = await import('node-fetch');
        const token = process.env.TELEGRAM_BOT3_TOKEN;
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

// Диагностика: список файлов клиента в RESULTS_DIR
app.get('/debug/files/:clientId', (req, res) => {
  try {
    const files = fs.readdirSync(RESULTS_DIR)
      .filter(f => f.startsWith(req.params.clientId))
      .map(f => { const s = fs.statSync(path.join(RESULTS_DIR, f)); return `${f} (${s.size} bytes)`; });
    res.json({ resultsDir: RESULTS_DIR, count: files.length, files });
  } catch (e) { res.json({ error: e.message }); }
});

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
  const { clientChatId, carouselScript, coverExample, photoExample, storyExample } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  generateFreeVisuals(String(clientChatId), carouselScript || '', coverExample || '', photoExample || '', storyExample || '').catch(e =>
    console.error('[visual] generate_free_visuals error', e.message)
  );
});

// Ручной ретрай пропущенных слайдов карусели (вызывается из Bot3 /retry_free_slots)
app.post('/retry_free_carousel', async (req, res) => {
  const { clientChatId } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  (async () => {
    const id = String(clientChatId);
    const promptsPath = path.join(RESULTS_DIR, `${id}.free_prompts.json`);
    const visuPath = path.join(RESULTS_DIR, `${id}.free_visuals.json`);
    if (!fs.existsSync(promptsPath)) {
      const { sendBotMsg } = await _freeNotifyUtils(id).catch(() => ({}));
      if (sendBotMsg) await sendBotMsg(`❌ Нет free_prompts.json для ${id} — нельзя сделать ретрай`);
      return;
    }
    const prompts = JSON.parse(fs.readFileSync(promptsPath, 'utf8'));
    const carouselPrompts = prompts.carousel || [];
    const current = (() => { try { return JSON.parse(fs.readFileSync(visuPath, 'utf8')); } catch { return {}; } })();
    const missingSlots = carouselPrompts.map((_, i) => i).filter(i =>
      !current[`carousel_${i}`] && !(current.carouselUrls && current.carouselUrls[i])
    );
    if (missingSlots.length === 0) {
      const { sendBotMsg } = await _freeNotifyUtils(id).catch(() => ({}));
      if (sendBotMsg) await sendBotMsg(`✅ Все слайды уже на месте для ${id}`);
      return;
    }
    const { sendBotMsg } = await _freeNotifyUtils(id).catch(() => ({}));
    if (sendBotMsg) await sendBotMsg(`🔄 Ретрай слайдов ${missingSlots.map(i => i + 1).join(', ')} для ${id}...`);
    // Сбрасываем флаг карусели чтобы rebuildFreeVisuals мог снова отправить
    const cFlag = path.join(RESULTS_DIR, `${id}.carousel_notified`);
    if (fs.existsSync(cFlag)) fs.unlinkSync(cFlag);
    const retryPromises = [];
    for (const i of missingSlots) {
      const tid = await startImage(carouselPrompts[i], '1:1').catch(() => null);
      if (tid) {
        saveImageTask(tid, { clientId: id, type: 'free_visuals', slot: `carousel_${i}` });
        retryPromises.push(pollAndSave(tid, { clientId: id, type: 'free_visuals', slot: `carousel_${i}`, taskId: tid }));
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    await Promise.all(retryPromises);
    const after = (() => { try { return JSON.parse(fs.readFileSync(visuPath, 'utf8')); } catch { return {}; } })();
    const stillMissing = missingSlots.filter(i => !after[`carousel_${i}`] && !(after.carouselUrls && after.carouselUrls[i]));
    if (sendBotMsg) {
      if (stillMissing.length > 0) {
        await sendBotMsg(`❌ Ретрай: слайды ${stillMissing.map(i => i + 1).join(', ')} всё равно не пришли`);
      } else {
        await sendBotMsg(`✅ Ретрай успешен — все слайды получены для ${id}`);
      }
    }
  })().catch(e => console.error('[visual] retry_free_carousel error', e.message));
});

// Повторная отправка уже готового AI-фото в Bot3 (без перегенерации)
app.post('/resend_free_photo', async (req, res) => {
  const { clientChatId } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  (async () => {
    const id = String(clientChatId);
    const adminChatId = process.env.BOT3_MANAGER_CHAT_ID;
    const botToken = process.env.TELEGRAM_BOT3_TOKEN;
    if (!adminChatId || !botToken) return;
    const fpPath = path.join(RESULTS_DIR, `${id}.free_photo.json`);
    if (!fs.existsSync(fpPath)) {
      const { default: fetch } = await import('node-fetch');
      await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: adminChatId, text: `❌ free_photo.json не найден для ${id}` }),
      }).catch(() => {});
      return;
    }
    const fp = JSON.parse(fs.readFileSync(fpPath, 'utf8'));
    const localPath = fp.localPath || null;
    let photoCaption = '';
    try {
      const promptsFile = path.join(RESULTS_DIR, `${id}.free_prompts.json`);
      if (fs.existsSync(promptsFile)) photoCaption = JSON.parse(fs.readFileSync(promptsFile, 'utf8')).photoCaption || '';
    } catch {}
    const { default: fetch } = await import('node-fetch');
    const sendMsg = async (text) => fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: adminChatId, text }),
    }).catch(() => {});
    if (photoCaption) await sendMsg(`📝 Подпись к фото-посту:\n\n${photoCaption}`);
    const sent = localPath && fs.existsSync(localPath)
      ? await bot3SendPhotoFile(adminChatId, localPath, '📸 AI-фото готово', {
          inline_keyboard: [[
            { text: '🔄 Переделать', callback_data: `regen_fs_ph_${id}` },
            { text: '✏️ Изм. текст', callback_data: `et_ph_0_${id}` },
          ]],
        })
      : false;
    if (!sent) {
      const url = fp.url || null;
      if (url) {
        await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: adminChatId, photo: url, caption: '📸 AI-фото (URL fallback)',
            reply_markup: JSON.stringify({ inline_keyboard: [[
              { text: '🔄 Переделать', callback_data: `regen_fs_ph_${id}` },
              { text: '✏️ Изм. текст', callback_data: `et_ph_0_${id}` },
            ]] }) }),
        }).catch(e => console.error('[visual] resend_free_photo URL fallback error:', e.message));
      } else {
        await sendMsg(`❌ Файл фото не найден на диске для ${id}, URL тоже отсутствует`);
      }
    }
  })().catch(e => console.error('[visual] resend_free_photo error', e.message));
});

// Повторная отправка уже сгенерированного видео платного пакета в Bot3
app.post('/resend_video', async (req, res) => {
  const { clientChatId, videoIndex = 0 } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  (async () => {
    const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
    if (!fs.existsSync(resultPath)) {
      await bot3Send(process.env.BOT3_MANAGER_CHAT_ID, `❌ results.json не найден для ${clientChatId}`);
      return;
    }
    const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const videoData = data.results?.videoData || [];
    const video = videoData[videoIndex];
    if (!video?.localPath || !fs.existsSync(video.localPath)) {
      await bot3Send(process.env.BOT3_MANAGER_CHAT_ID,
        `❌ Видео ${videoIndex + 1} не найдено на диске для ${clientChatId}`);
      return;
    }
    await bot3Send(process.env.BOT3_MANAGER_CHAT_ID, `🔄 Повторная отправка видео ${videoIndex + 1}...`);
    await notifyBot3SingleVideo(clientChatId, videoIndex, videoData.length, video.localPath, video.subtitleText, null);
  })().catch(e => console.error('[visual] resend_video error', e.message));
});

// Только создаёт free_prompts.json без генерации изображений — для демо-пакета
app.post('/prepare_demo_prompts', async (req, res) => {
  const { clientChatId, carouselScript, coverExample, photoExample } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  try {
    const [carouselPrompts, coverPrompts] = await Promise.all([
      getImagePrompts(carouselScript || '', 'carousel', 7),
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

// ── Rewrite video scripts based on manager feedback ────────────────────────────
app.post('/rewrite_video_scripts', (req, res) => {
  const { clientChatId, feedback } = req.body;
  if (!clientChatId || !feedback) return res.status(400).json({ error: 'clientChatId and feedback required' });
  res.json({ ok: true });
  (async () => {
    const { ask, SONNET } = require('./src/claude');
    const managerChatId = process.env.BOT3_MANAGER_CHAT_ID;
    try {
      const pendingPath = path.join(RESULTS_DIR, `${clientChatId}.video_scripts_pending.json`);
      let currentScripts = [];
      let clientName = `клиент ${clientChatId}`;
      try {
        const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
        currentScripts = pending.scripts || [];
      } catch {}
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(VISUAL_DIR, `${clientChatId}.visual.json`), 'utf8'));
        clientName = pkg.clientName || clientName;
      } catch {}

      // Fallback: восстановить сценарии из done_snapshot если pending пустой
      if (!currentScripts.length) {
        try {
          const snap = JSON.parse(fs.readFileSync(path.join(TRIGGERS_DIR, `${clientChatId}.done_snapshot.json`), 'utf8'));
          if (snap.videoScripts) {
            currentScripts = splitVideoScripts(snap.videoScripts);
            if (currentScripts.length) {
              fs.writeFileSync(pendingPath, JSON.stringify({ scripts: currentScripts, timestamp: Date.now() }));
              console.log(`[visual] rewrite_video_scripts: восстановлено ${currentScripts.length} сценариев из done_snapshot для ${clientChatId}`);
            }
          }
        } catch {}
      }

      if (!currentScripts.length) {
        const token = process.env.TELEGRAM_BOT3_TOKEN;
        const { default: fetch } = await import('node-fetch');
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: managerChatId,
            text: `❌ Сценарии для ${clientChatId} не найдены ни в pending, ни в done_snapshot.\nЗапустите /run_visual ${clientChatId} заново.`,
          }),
        }).catch(() => {});
        return;
      }

      await bot3Send(managerChatId, `✍️ Перерабатываю сценарии с учётом вашего фидбека...`);

      const scriptsText = currentScripts.map((s, i) => `=== ВИДЕО ${i + 1} ===\n${s}`).join('\n\n');
      const revised = await ask(
        `Ты — контент-продюсер. Перепиши эти видео-сценарии для клиента "${clientName}" с учётом фидбека менеджера.\n\nТЕКУЩИЕ СЦЕНАРИИ:\n${scriptsText}\n\nФИДБЕК МЕНЕДЖЕРА:\n${feedback}\n\nТРЕБОВАНИЯ:\n- Сохрани точно такую же структуру (ВИДЕО N:, СЦЕНА N:, EN:, RU:, Эмоция зрителя: и т.д.)\n- Все названия полей ВСЕГДА на русском языке — это технические маркеры, не переводить\n- Учти замечание менеджера для всех видео\n- EN-сцены должны быть конкретными (ниша + продукт + место), не generic\n- Не добавляй объяснений — только сами сценарии`,
        { model: SONNET, maxTokens: 4000 }
      );

      const revisedScripts = splitVideoScripts(revised);
      if (!revisedScripts.length) {
        const token = process.env.TELEGRAM_BOT3_TOKEN;
        const { default: fetch } = await import('node-fetch');
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: managerChatId,
            text: `❌ Не удалось разобрать переработанные сценарии. Выберите действие:`,
            reply_markup: { inline_keyboard: [[
              { text: '✅ Запустить с текущими', callback_data: `va_ok_${clientChatId}` },
              { text: '✏️ Исправить снова',      callback_data: `va_edit_${clientChatId}` },
            ]] },
          }),
        }).catch(() => {});
        return;
      }

      // Сохраняем фидбек для обучения
      const LEARNING_DIR = path.join(os.homedir(), '.marketingdna-client-sessions', 'prompt_learning');
      if (!fs.existsSync(LEARNING_DIR)) fs.mkdirSync(LEARNING_DIR, { recursive: true });
      const logPath = path.join(LEARNING_DIR, 'script_feedback_log.json');
      let log = [];
      try { log = JSON.parse(fs.readFileSync(logPath, 'utf8')); } catch {}
      log.push({ clientChatId, clientName, originalScripts: currentScripts, feedback, revisedScripts, ts: Date.now() });
      fs.writeFileSync(logPath, JSON.stringify(log, null, 2));

      // Обновляем pending с новыми сценариями и показываем новый превью
      fs.writeFileSync(pendingPath, JSON.stringify({ scripts: revisedScripts, timestamp: Date.now() }));
      await notifyBot3VideoScriptsPreview(clientChatId, clientName, revisedScripts);
    } catch (e) {
      console.error('[visual] rewrite_video_scripts error:', e.message);
      const token = process.env.TELEGRAM_BOT3_TOKEN;
      const { default: fetch } = await import('node-fetch');
      await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: process.env.BOT3_MANAGER_CHAT_ID,
          text: `❌ Ошибка переработки сценариев: ${e.message}\n\nВыберите действие:`,
          reply_markup: { inline_keyboard: [[
            { text: '✅ Запустить с текущими', callback_data: `va_ok_${clientChatId}` },
            { text: '✏️ Исправить снова',      callback_data: `va_edit_${clientChatId}` },
          ]] },
        }),
      }).catch(() => {});
    }
  })().catch(e => console.error('[visual] rewrite_video_scripts fatal:', e.message));
});

// Called by Bot3: повторно показать сценарии видео с кнопками (recovery)
app.post('/resend_scripts', (req, res) => {
  const { clientChatId } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  (async () => {
    const managerChatId = process.env.BOT3_MANAGER_CHAT_ID;
    let scripts = [];
    let clientName = `клиент ${clientChatId}`;
    // 1. Читаем pending
    try {
      const p = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${clientChatId}.video_scripts_pending.json`), 'utf8'));
      scripts = p.scripts || [];
    } catch {}
    // 2. Fallback: done_snapshot
    if (!scripts.length) {
      try {
        const snap = JSON.parse(fs.readFileSync(path.join(TRIGGERS_DIR, `${clientChatId}.done_snapshot.json`), 'utf8'));
        if (snap.videoScripts) scripts = splitVideoScripts(snap.videoScripts);
        if (scripts.length) {
          fs.writeFileSync(path.join(RESULTS_DIR, `${clientChatId}.video_scripts_pending.json`), JSON.stringify({ scripts, timestamp: Date.now() }));
        }
      } catch {}
    }
    // 3. clientName из visual.json
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(VISUAL_DIR, `${clientChatId}.visual.json`), 'utf8'));
      clientName = pkg.clientName || clientName;
    } catch {}

    if (!scripts.length) {
      await bot3Send(managerChatId, `❌ Сценарии для ${clientChatId} не найдены. Запустите /run_visual ${clientChatId} заново.`);
      return;
    }
    await notifyBot3VideoScriptsPreview(clientChatId, clientName, scripts);
  })().catch(e => console.error('[visual] resend_scripts error:', e.message));
});

// Called by Bot3 /regen_scripts: перегенерировать видео-сценарии из done_snapshot
// Берёт уже сохранённые ответы клиента и прогоняет через обновлённый Block7
app.post('/regen_scripts', (req, res) => {
  const { clientChatId } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  (async () => {
    const { generateVideoScriptsFromSnap } = require('./src/steps/block7_scripts');
    const managerChatId = process.env.BOT3_MANAGER_CHAT_ID;
    try {
      const snapPath = path.join(TRIGGERS_DIR, `${clientChatId}.done_snapshot.json`);
      if (!fs.existsSync(snapPath)) {
        await bot3Send(managerChatId, `❌ done_snapshot для клиента ${clientChatId} не найден.\nКлиент должен сначала пройти полную генерацию.`);
        return;
      }
      const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
      let clientName = snap.clientName || snap.targetClientName || `клиент ${clientChatId}`;
      try {
        const pkg = JSON.parse(fs.readFileSync(path.join(VISUAL_DIR, `${clientChatId}.visual.json`), 'utf8'));
        if (pkg.clientName && pkg.clientName !== '—') clientName = pkg.clientName;
      } catch {}

      await bot3Send(managerChatId, `✍️ Генерирую новые видео-сценарии для ${clientName} по обновлённым правилам...\n~2-3 минуты.`);

      const newScripts = await generateVideoScriptsFromSnap(snap);
      if (!newScripts) {
        await bot3Send(managerChatId, `⚠️ Тариф клиента не поддерживает AI-видео (только Стандарт и Профи).`);
        return;
      }

      const scripts = splitVideoScripts(newScripts);
      if (!scripts.length) {
        await bot3Send(managerChatId, `❌ Sonnet не вернул сценарии. Попробуйте ещё раз.`);
        return;
      }

      // Сохраняем как pending — менеджер одобряет перед генерацией
      const pendingPath = path.join(RESULTS_DIR, `${clientChatId}.video_scripts_pending.json`);
      fs.writeFileSync(pendingPath, JSON.stringify({ scripts, timestamp: Date.now() }));

      // Удаляем старый approved файл — требуем нового одобрения
      const approvedPath = path.join(RESULTS_DIR, `${clientChatId}.video_scripts_approved.json`);
      if (fs.existsSync(approvedPath)) fs.unlinkSync(approvedPath);

      await notifyBot3VideoScriptsPreview(clientChatId, clientName, scripts);
    } catch (e) {
      console.error('[visual] regen_scripts error:', e.message);
      await bot3Send(managerChatId, `❌ Ошибка генерации сценариев: ${e.message}`).catch(() => {});
    }
  })().catch(e => console.error('[visual] regen_scripts fatal:', e.message));
});

// Called by Bot3 /regen_all_scripts: перегенерировать карусели + фото + сторис из done_snapshot
app.post('/regen_all_scripts', (req, res) => {
  const { clientChatId } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  (async () => {
    const { generateAllScriptsFromSnap } = require('./src/steps/block7_scripts');
    const managerChatId = process.env.BOT3_MANAGER_CHAT_ID;
    try {
      const snapPath = path.join(TRIGGERS_DIR, `${clientChatId}.done_snapshot.json`);
      if (!fs.existsSync(snapPath)) {
        await bot3Send(managerChatId, `❌ done_snapshot для клиента ${clientChatId} не найден.`);
        return;
      }
      const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
      const clientName = snap.clientName || snap.targetClientName || `клиент ${clientChatId}`;

      await bot3Send(managerChatId,
        `✍️ Генерирую новые карусели + фото + сторис для ${clientName} по обновлённым правилам...\n⏳ ~4-6 минут.`
      );

      const result = await generateAllScriptsFromSnap(snap);
      if (!result) {
        await bot3Send(managerChatId, `⚠️ Тариф клиента не поддерживает эту операцию (только Стандарт и Профи).`);
        return;
      }

      // Обновляем done_snapshot — новые скрипты сразу доступны для /run_visual
      snap.carouselScripts = result.carouselScripts;
      snap.photoScripts    = result.photoScripts;
      snap.storiesScripts  = result.storiesScripts;
      if (result.videoScripts) snap.videoScripts = result.videoScripts;
      if (result.covers)       snap.covers       = result.covers;
      fs.writeFileSync(snapPath, JSON.stringify(snap, null, 2));

      // Обновляем visual.json если существует
      const visualPath = path.join(VISUAL_DIR, `${clientChatId}.visual.json`);
      if (fs.existsSync(visualPath)) {
        const pkg = JSON.parse(fs.readFileSync(visualPath, 'utf8'));
        pkg.carouselScripts = result.carouselScripts;
        pkg.photoScripts    = result.photoScripts;
        pkg.storiesScripts  = result.storiesScripts;
        if (result.videoScripts) pkg.videoScripts = result.videoScripts;
        if (result.covers)       pkg.covers       = result.covers;
        fs.writeFileSync(visualPath, JSON.stringify(pkg, null, 2));
      }

      await bot3Send(managerChatId,
        `✅ Новые скрипты готовы для ${clientName}!\n\n` +
        `📌 Теперь запусти:\n/reset_client ${clientChatId}\n/run_visual ${clientChatId} nv\n\n` +
        `Это сгенерирует новые изображения по обновлённым правилам.`
      );
    } catch (e) {
      console.error('[visual] regen_all_scripts error:', e.message);
      await bot3Send(process.env.BOT3_MANAGER_CHAT_ID, `❌ Ошибка: ${e.message}`).catch(() => {});
    }
  })().catch(e => console.error('[visual] regen_all_scripts fatal:', e.message));
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
  const resultPath    = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  const freeVisualsPath = path.join(RESULTS_DIR, `${clientChatId}.free_visuals.json`);

  const SECTION_MAP = {
    ph: { key: 'photos',         localKey: 'photosLocalPaths',         label: 'Фото',    size: 'photo' },
    ca: { key: 'carouselSlides', localKey: 'carouselSlidesLocalPaths', label: 'Слайд',   size: 'carousel' },
    co: { key: 'covers',         localKey: 'coversLocalPaths',         label: 'Обложка', size: 'photo' },
    st: { key: 'stories',        localKey: 'storiesLocalPaths',        label: 'Story',   size: 'photo' },
  };
  const info = SECTION_MAP[section];
  if (!info) return;

  let buf = null;
  let rawPath = null;
  const isFreePackage = fs.existsSync(freeVisualsPath);

  // Попытка 1: платный пакет — читаем из results.json (только если есть реальные данные изображений)
  if (fs.existsSync(resultPath)) {
    const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    const localPaths = (data.results || {})[info.localKey] || [];
    const candidate = localPaths[index]
      ? localPaths[index].replace('_ov.jpg', '.jpg').replace('_ov.png', '.png')
      : null;

    if (candidate && fs.existsSync(candidate)) {
      rawPath = candidate;
      buf = fs.readFileSync(rawPath);
    } else {
      const url = ((data.results || {})[info.key] || [])[index];
      if (url) {
        const { default: fetch } = await import('node-fetch');
        const resp = await fetch(url);
        if (resp.ok) buf = await resp.buffer();
      }
    }
  }

  // Попытка 2: бесплатный пакет — ищем локальные файлы (ca/co/st → free_visuals.json, ph → free_photo.json)
  if (!buf && isFreePackage) {
    let localFile = null;
    let urlFallback = null;

    if (section === 'ca') {
      localFile = path.join(RESULTS_DIR, `${clientChatId}_free_carousel${index}.jpg`);
      const fv = JSON.parse(fs.readFileSync(freeVisualsPath, 'utf8'));
      urlFallback = (fv.carouselUrls || [])[index] || null;
    } else if (section === 'co') {
      localFile = path.join(RESULTS_DIR, `${clientChatId}_free_cover0.jpg`);
      const fv = JSON.parse(fs.readFileSync(freeVisualsPath, 'utf8'));
      urlFallback = (fv.coverUrls || [])[0] || null;
    } else if (section === 'st') {
      localFile = path.join(RESULTS_DIR, `${clientChatId}_free_story0.jpg`);
      const fv = JSON.parse(fs.readFileSync(freeVisualsPath, 'utf8'));
      urlFallback = (fv.storyUrls || [])[0] || null;
    } else if (section === 'ph') {
      const fpPath = path.join(RESULTS_DIR, `${clientChatId}.free_photo.json`);
      if (fs.existsSync(fpPath)) {
        const fp = JSON.parse(fs.readFileSync(fpPath, 'utf8'));
        localFile = fp.localPath || null;
        urlFallback = fp.url || null;
      }
    }

    if (localFile && fs.existsSync(localFile)) {
      rawPath = localFile;
      buf = fs.readFileSync(localFile);
    } else if (urlFallback) {
      const { default: fetch } = await import('node-fetch');
      const resp = await fetch(urlFallback);
      if (resp.ok) {
        buf = Buffer.from(await resp.arrayBuffer());
        rawPath = localFile || path.join(RESULTS_DIR, `${clientChatId}_free_${section}_${index}_dl.jpg`);
        fs.writeFileSync(rawPath, buf);
      }
    }
  }

  if (!buf) {
    const chatId = process.env.BOT3_MANAGER_CHAT_ID;
    if (chatId) await bot3Send(chatId, `⚠️ ${info.label} ${index + 1}: исходный файл не найден — пересгенерируйте изображение.`);
    return;
  }

  // Накладываем текст
  const out = text ? await overlayTextOnImage(buf, text, 'bottom', info.size) : buf;
  const ovPath = rawPath
    ? rawPath.replace('.jpg', '_ov.jpg').replace('.png', '_ov.png')
    : path.join(RESULTS_DIR, `${clientChatId}_edited_${section}_${index}.jpg`);
  fs.writeFileSync(ovPath, out);

  // Обновляем results.json для платного пакета (только если там есть реальные данные)
  if (fs.existsSync(resultPath)) {
    const dataCheck = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
    if (((dataCheck.results || {})[info.localKey] || []).length > 0) {
      await withResultsLock(clientChatId, () => {
        const fresh = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        if (!fresh.results[info.localKey]) fresh.results[info.localKey] = [];
        fresh.results[info.localKey][index] = ovPath;
        fs.writeFileSync(resultPath, JSON.stringify(fresh, null, 2));
      });
    }
  }

  // Обновляем free_visuals.json / free_photo.json / free_prompts.json для бесплатного пакета
  if (isFreePackage) {
    try {
      if (section === 'ph') {
        const fpPath = path.join(RESULTS_DIR, `${clientChatId}.free_photo.json`);
        if (fs.existsSync(fpPath)) {
          const fp = JSON.parse(fs.readFileSync(fpPath, 'utf8'));
          fp.localPath = ovPath;
          fs.writeFileSync(fpPath, JSON.stringify(fp, null, 2));
        }
      } else {
        const fv = JSON.parse(fs.readFileSync(freeVisualsPath, 'utf8'));
        if (section === 'ca') fv[`carousel_${index}_local`] = ovPath;
        else if (section === 'co') fv['cover_0_local'] = ovPath;
        else if (section === 'st') fv['story_0_local'] = ovPath;
        fs.writeFileSync(freeVisualsPath, JSON.stringify(fv, null, 2));
      }

      if (text) {
        const promptsPath = path.join(RESULTS_DIR, `${clientChatId}.free_prompts.json`);
        if (fs.existsSync(promptsPath)) {
          const prompts = JSON.parse(fs.readFileSync(promptsPath, 'utf8'));
          if (section === 'ca') { prompts.carouselTexts = prompts.carouselTexts || []; prompts.carouselTexts[index] = text; }
          else if (section === 'co') prompts.coverTitle = text;
          else if (section === 'st') prompts.storyText = text;
          fs.writeFileSync(promptsPath, JSON.stringify(prompts, null, 2));
        }
      }
    } catch (e) { console.error('[visual] free update after edit:', e.message); }
  }

  // Обновляем HTML-страницу клиента с исправленным изображением
  try {
    const { updatePackPagePhoto, updatePackPageCover, updatePackPageCarousel } = require('./src/site_builder');
    if (section === 'ph') {
      updatePackPagePhoto(clientChatId, ovPath);
    } else if (section === 'co') {
      updatePackPageCover(clientChatId, ovPath);
    } else if (section === 'ca') {
      // Для платного — из results.json. Для бесплатного — перестраиваем из free_visuals.json
      if (fs.existsSync(resultPath)) {
        const fd = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
        const allSlides = (fd.results || {}).carouselSlidesLocalPaths || [];
        if (allSlides.length > 0) { updatePackPageCarousel(clientChatId, allSlides); }
      }
      if (isFreePackage) {
        const fv = JSON.parse(fs.readFileSync(freeVisualsPath, 'utf8'));
        const freeSlides = [0,1,2,3,4,5,6].map(i => fv[`carousel_${i}_local`] || fv[`carousel_${i}`] || null).filter(Boolean);
        if (freeSlides.length > 0) updatePackPageCarousel(clientChatId, freeSlides);
      }
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

      // Бесплатный пакет — определяем по наличию free_visuals.json (не по отсутствию results.json,
      // т.к. bot3 может создать results.json для free-клиента при редактировании текста)
      const freeVisualsPath = path.join(RESULTS_DIR, `${clientChatId}.free_visuals.json`);
      if (fs.existsSync(freeVisualsPath)) {
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
        } else if (section === 'stories') {
          const localFile = path.join(RESULTS_DIR, `${clientChatId}_free_story0.jpg`);
          if (fs.existsSync(localFile)) {
            rawPath = localFile;
          } else if (fv.storyUrls?.[0]) {
            rawPath = path.join(RESULTS_DIR, `${clientChatId}_free_story0_notxt.jpg`);
            const r = await fetch(fv.storyUrls[0]); if (!r.ok) { await bot3Send(adminChatId, `❌ Не удалось загрузить сторис`); return; }
            fs.writeFileSync(rawPath, Buffer.from(await r.arrayBuffer()));
          }
        } else if (section === 'photos') {
          const photoFile = path.join(RESULTS_DIR, `${clientChatId}.free_photo.json`);
          if (fs.existsSync(photoFile)) {
            const fp = JSON.parse(fs.readFileSync(photoFile, 'utf8'));
            const localFile = fp.localPath || null;
            if (localFile && fs.existsSync(localFile)) {
              rawPath = localFile;
            } else if (fp.url) {
              rawPath = path.join(RESULTS_DIR, `${clientChatId}_free_photo_notxt.jpg`);
              const r = await fetch(fp.url); if (!r.ok) { await bot3Send(adminChatId, `❌ Не удалось загрузить AI-фото`); return; }
              fs.writeFileSync(rawPath, Buffer.from(await r.arrayBuffer()));
            }
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

// ── /library_matches — какие видео из библиотеки подходят клиенту (по тегам сценариев) ──
app.post('/library_matches', async (req, res) => {
  const { clientChatId } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });

  let videoScripts = '';
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(VISUAL_DIR, `${clientChatId}.visual.json`), 'utf8'));
    videoScripts = pkg.videoScripts || '';
  } catch {}
  if (!videoScripts) {
    try {
      const snap = JSON.parse(fs.readFileSync(path.join(TRIGGERS_DIR, `${clientChatId}.done_snapshot.json`), 'utf8'));
      videoScripts = snap.videoScripts || '';
    } catch {}
  }
  if (!videoScripts) return res.json({ scripts: [] });

  const scripts = splitVideoScripts(videoScripts);
  const result  = [];

  for (let i = 0; i < scripts.length; i++) {
    const scenes = await splitScriptToScenes(scripts[i]).catch(() => []);
    const prompt = scenes[0] || scripts[i].slice(0, 300);
    const tags   = await extractVideoTags(prompt).catch(() => []);
    // Use searchLibrary (not searchVideoLibrary) so manager sees ALL matches regardless of season/history
    const metaFiles = fs.existsSync(LIBRARY_DIR) ? fs.readdirSync(LIBRARY_DIR).filter(f => f.endsWith('.meta.json')) : [];
    const matches = [];
    for (const mf of metaFiles) {
      try {
        const meta     = JSON.parse(fs.readFileSync(path.join(LIBRARY_DIR, mf), 'utf8'));
        const filePath = path.join(LIBRARY_DIR, meta.fileName);
        if (!fs.existsSync(filePath)) continue;
        const matchCount = tags.filter(t => (meta.tags || []).some(lt => lt.includes(t) || t.includes(lt))).length;
        if (matchCount >= 2) matches.push({ ...meta, matchCount, localPath: filePath });
      } catch {}
    }
    matches.sort((a, b) => b.matchCount - a.matchCount);
    const titleM = scripts[i].match(/ВИДЕО\s*\d+[:\s]+([^\n]+)/i);
    result.push({ index: i, title: titleM ? titleM[1].trim().slice(0, 60) : `Видео ${i + 1}`, tags, matches: matches.slice(0, 3) });
  }

  res.json({ scripts: result });
});

// ── /apply_library_video — применить библиотечное видео к клиенту (по выбору менеджера) ──
app.post('/apply_library_video', (req, res) => {
  const { clientChatId, videoIndex, videoId } = req.body;
  if (!clientChatId || videoIndex === undefined || !videoId) {
    return res.status(400).json({ error: 'clientChatId, videoIndex, videoId required' });
  }
  res.json({ ok: true });

  (async () => {
    const managerChatId = process.env.BOT3_MANAGER_CHAT_ID;
    const idx = Number(videoIndex);

    // Find library entry by videoId
    const metaPath = path.join(LIBRARY_DIR, `${videoId}.meta.json`);
    if (!fs.existsSync(metaPath)) {
      await bot3Send(managerChatId, `❌ Видео ${videoId} не найдено в библиотеке.`);
      return;
    }
    const meta      = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const localPath = path.join(LIBRARY_DIR, meta.fileName);
    if (!fs.existsSync(localPath)) {
      await bot3Send(managerChatId, `❌ Файл видео ${videoId} не найден на диске.`);
      return;
    }
    const libMatch = { ...meta, localPath };

    // Read video script for this index
    let videoScript = '';
    let videoCTA    = '';
    let totalVideos = 1;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(VISUAL_DIR, `${clientChatId}.visual.json`), 'utf8'));
      const scripts = splitVideoScripts(pkg.videoScripts || '');
      videoScript = scripts[idx] || scripts[0] || '';
      totalVideos = scripts.length;
      const ctaPref    = pkg.ctaPreference || '';
      const leadMagnet = pkg.leadMagnet    || '';
      videoCTA = ctaPref === 'direct_magnet'
        ? `Напиши в директ — пришлю ${leadMagnet || 'подарок'}`.slice(0, 50)
        : ctaPref === 'direct_only' ? 'Напиши в директ' : '';
    } catch {}
    if (!videoScript) {
      try {
        const snap    = JSON.parse(fs.readFileSync(path.join(TRIGGERS_DIR, `${clientChatId}.done_snapshot.json`), 'utf8'));
        const scripts = splitVideoScripts(snap.videoScripts || '');
        videoScript   = scripts[idx] || scripts[0] || '';
        totalVideos   = scripts.length;
      } catch {}
    }
    if (!videoScript) {
      await bot3Send(managerChatId, `❌ Сценарий видео ${idx + 1} не найден для ${clientChatId}.`);
      return;
    }

    await bot3Send(managerChatId, `⏳ Накладываю текст из сценария на библиотечное видео...`);
    const result = await applyLibraryVideo(libMatch, videoScript, idx, clientChatId, videoCTA);

    // Save to results.json
    const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
    try {
      const data = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : {};
      if (!data.results) data.results = {};
      if (!data.results.videoData) data.results.videoData = [];
      data.results.videoData[idx] = result;
      fs.writeFileSync(resultPath, JSON.stringify(data, null, 2));
    } catch {}

    await notifyBot3SingleVideo(clientChatId, idx, totalVideos, result?.localPath, result?.subtitleText, null);
  })().catch(e => {
    console.error('[visual] apply_library_video error:', e.message);
    bot3Send(process.env.BOT3_MANAGER_CHAT_ID, `❌ Ошибка применения видео: ${e.message}`);
  });
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
    const carouselTexts = extractAllCarouselTexts(pkg.carouselScripts || '');

    // Reapply overlays to images
    if (res2.photos?.length)         { const lp = await applyAndSaveOverlays(res2.photos,        photoTexts,    clientChatId, 'photos',   'bottom'); await sendSectionImages(clientChatId, pkg.clientName, 'ph', '📸 Фото постов',  res2.photos,        'Фото',    lp); }
    if (res2.carouselSlides?.length) { const lp = await applyAndSaveOverlays(res2.carouselSlides, carouselTexts, clientChatId, 'carousel', 'bottom'); const cg = getCarouselGroups(pkg.carouselScripts, res2.carouselSlides.length); await notifyBot3SectionCarousels(clientChatId, pkg.clientName, res2.carouselSlides, cg, lp); }
    if (res2.stories?.length)        { const lp = await applyAndSaveOverlays(res2.stories,        storyTexts,    clientChatId, 'stories',  'bottom'); await sendSectionImages(clientChatId, pkg.clientName, 'st', '📱 Stories',       res2.stories,        'Story',   lp); }
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

// ── Creatomate — Slideshow Reel Generation ────────────────────────────────────

function buildCreatomateSource(slides, textPosition = 'bottom') {
  const SLIDE_DURATION = 7.5;
  const TEXT_Y = { top: '15%', center: '50%', bottom: '80%' };
  const textY = TEXT_Y[textPosition] || '80%';
  const elements = [];

  slides.forEach((slide, i) => {
    const t0 = i * SLIDE_DURATION;

    // track:1 — фоновые изображения, color_overlay — тёмный слой прямо на картинке
    elements.push({
      type: 'image',
      track: 1,
      source: slide.photoUrl,
      time: t0,
      duration: SLIDE_DURATION,
      fit: 'cover',
      color_overlay: 'rgba(0,0,0,0.5)',
      ...(i > 0 ? { transition: { type: 'fade', duration: 0.5 } } : {})
    });

    // track:2 — главный текст
    elements.push({
      type: 'text',
      track: 2,
      text: slide.mainText,
      time: t0,
      duration: SLIDE_DURATION,
      x: '50%',
      y: textY,
      width: '85%',
      font_family: 'Montserrat',
      font_weight: '700',
      font_size: '7 vmin',
      fill_color: '#ffffff',
      text_alignment: 'center',
      enter_animation: { type: 'fade', duration: 0.5 }
    });
  });

  return {
    output_format: 'mp4',
    width: 1080,
    height: 1920,
    duration: slides.length * SLIDE_DURATION,
    frame_rate: 30,
    elements
  };
}

// Ken Burns анимации — чередуем для разнообразия
const KB_MOTIONS = [
  { start_scale: '115%', end_scale: '100%' }, // zoom out
  { start_scale: '100%', end_scale: '115%' }, // zoom in
  { start_scale: '110%', end_scale: '100%' }, // zoom out soft
  { start_scale: '100%', end_scale: '110%' }, // zoom in soft
];

// slides: [{ url, mainText?, subText? }]
// smallKenBurns: true когда фото с вшитым текстом — уменьшаем зум чтобы текст не вылезал
function buildCarouselVideoSource(slides, slideDuration = 4, smallKenBurns = false, textPosition = 'bottom') {
  const KB_SMALL = [
    { start_scale: '107%', end_scale: '100%' },
    { start_scale: '100%', end_scale: '107%' },
    { start_scale: '105%', end_scale: '100%' },
    { start_scale: '100%', end_scale: '105%' },
  ];
  const motions  = smallKenBurns ? KB_SMALL : KB_MOTIONS;
  const elements = [];

  const TEXT_Y = { top: '15%', center: '50%', bottom: '80%' };
  const mainY  = TEXT_Y[textPosition] || '80%';

  slides.forEach(({ url, mainText, subText }, i) => {
    const t0     = i * slideDuration;
    const motion = motions[i % motions.length];

    // Фоновое фото с Ken Burns (масштабируется)
    elements.push({
      type: 'image',
      track: 1,
      source: url,
      time: t0,
      duration: slideDuration,
      fit: 'cover',
      color_overlay: 'rgba(0,0,0,0.45)',
      animations: [
        { type: 'scale', easing: 'linear', start_scale: motion.start_scale, end_scale: motion.end_scale, fade: false }
      ],
      ...(i > 0 ? { transition: { type: 'fade', duration: 0.4 } } : {})
    });

    // Текст фиксированный поверх (не входит в анимацию фото)
    if (mainText) {
      elements.push({
        type: 'text',
        track: 2,
        text: mainText,
        time: t0,
        duration: slideDuration,
        x: '50%',
        y: mainY,
        width: '85%',
        font_family: 'Montserrat',
        font_weight: '700',
        font_size: '6.5 vmin',
        fill_color: '#ffffff',
        text_alignment: 'center',
        enter_animation: { type: 'fade', duration: 0.4 },
        exit_animation:  { type: 'fade', duration: 0.4 }
      });
    }
    if (subText) {
      elements.push({
        type: 'text',
        track: 3,
        text: subText,
        time: t0,
        duration: slideDuration,
        x: '50%',
        y: textPosition === 'bottom' ? '90%' : '60%',
        width: '80%',
        font_family: 'Montserrat',
        font_weight: '400',
        font_size: '4 vmin',
        fill_color: '#ffffff',
        text_alignment: 'center',
        enter_animation: { type: 'fade', duration: 0.4 },
        exit_animation:  { type: 'fade', duration: 0.4 }
      });
    }
  });

  return {
    output_format: 'mp4',
    width: 1080,
    height: 1920,
    duration: slides.length * slideDuration,
    frame_rate: 30,
    elements
  };
}

app.post('/test_carousel_video', (req, res) => {
  const { clientChatId, textPosition } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  testCarouselVideoForClient(String(clientChatId), textPosition).catch(e =>
    console.error('[carousel_video] error', e.message)
  );
});

async function testCarouselVideoForClient(clientChatId, textPosition = 'bottom') {
  const chatId    = process.env.BOT3_MANAGER_CHAT_ID;
  const bot3Token = process.env.TELEGRAM_BOT3_TOKEN;

  const sendTgSafe = (text) => new Promise((resolve) => {
    const https = require('https');
    const body  = JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000) });
    const req   = https.request({
      hostname: 'api.telegram.org', path: `/bot${bot3Token}/sendMessage`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 8000
    }, (res) => { res.resume(); resolve(); });
    req.on('error', resolve); req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(body); req.end();
  });

  const HARD_TIMEOUT = 4 * 60 * 1000;
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Creatomate не ответил за 4 минуты')), HARD_TIMEOUT);
  });

  try {
    await bot3Send(chatId, `🎬 Carousel→Video тест для ${clientChatId}\n⏳ Ищу слайды карусели...`);

    const apiKey = process.env.CREATOMATE_API_KEY;
    if (!apiKey) throw new Error('CREATOMATE_API_KEY не задан');

    let baseUrl = (process.env.VISUAL_BASE_URL || '').replace(/\/$/, '');
    if (!baseUrl.startsWith('http')) baseUrl = `https://${baseUrl}`;

    // ── Ищем чистые фоны (без вшитого текста) ──
    // Приоритет: 1) _carousel_*_raw.jpg (свежие от /run_visual), 2) _sample_car_raw_*, 3) _photos_*_raw.jpg
    // Fallback: _ov.jpg (текст вшит — Ken Burns уменьшен)
    const allFiles = fs.existsSync(RESULTS_DIR) ? fs.readdirSync(RESULTS_DIR) : [];

    const numIdx = f => { const m = f.match(/_(\d+)_(raw|ov)\.jpg$/); return m ? +m[1] : 0; };
    // Приоритет: _carouselSlides_* (от /run_visual), иначе _carousel_* (от /reapply_overlays)
    // Нельзя смешивать оба набора — при одинаковых индексах файлы перемешаются
    let carRaw = allFiles
      .filter(f => f.startsWith(`${clientChatId}_carouselSlides_`) && f.endsWith('_raw.jpg'))
      .sort((a, b) => numIdx(a) - numIdx(b)).map(f => path.join(RESULTS_DIR, f));
    if (carRaw.length < 2) carRaw = allFiles
      .filter(f => f.startsWith(`${clientChatId}_carousel_`) && f.endsWith('_raw.jpg'))
      .sort((a, b) => numIdx(a) - numIdx(b)).map(f => path.join(RESULTS_DIR, f));

    const sampleRaw = allFiles
      .filter(f => f.startsWith(`${clientChatId}_sample_car_raw_`) && f.endsWith('.jpg'))
      .sort().map(f => path.join(RESULTS_DIR, f));

    const photosRaw = allFiles
      .filter(f => f.startsWith(`${clientChatId}_photos_`) && f.endsWith('_raw.jpg'))
      .sort().map(f => path.join(RESULTS_DIR, f));

    let carOv = allFiles
      .filter(f => f.startsWith(`${clientChatId}_carouselSlides_`) && f.endsWith('_ov.jpg'))
      .sort((a, b) => numIdx(a) - numIdx(b)).map(f => path.join(RESULTS_DIR, f));
    if (carOv.length < 2) carOv = allFiles
      .filter(f => f.startsWith(`${clientChatId}_carousel_`) && f.endsWith('_ov.jpg'))
      .sort((a, b) => numIdx(a) - numIdx(b)).map(f => path.join(RESULTS_DIR, f));

    const rawCandidates = [...carRaw, ...sampleRaw];
    const useRaw        = rawCandidates.length >= 2;
    const localPaths    = (useRaw ? rawCandidates : carOv).slice(0, 7);

    // Диагностика — менеджер видит точно откуда взяты файлы
    await bot3Send(chatId,
      `🔍 Диагностика файлов:\n` +
      `carRaw: ${carRaw.length} | sampleRaw: ${sampleRaw.length} | photosRaw: ${photosRaw.length} | carOv: ${carOv.length}\n` +
      `Источник: ${useRaw ? (carRaw.length >= 2 ? 'carRaw ✅' : sampleRaw.length >= 2 ? 'sampleRaw ⚠️' : 'photosRaw') : 'carOv (fallback) ❌'}`
    );

    if (localPaths.length < 2) {
      await bot3Send(chatId, `❌ Нет слайдов карусели для ${clientChatId}\nДождись /run_visual и попробуй снова.`);
      return;
    }

    // ── Берём тексты из done_snapshot (не вызываем Claude заново) ──
    let slideTexts = [];
    const snapPath = path.join(TRIGGERS_DIR, `${clientChatId}.done_snapshot.json`);
    if (useRaw && fs.existsSync(snapPath)) {
      try {
        const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));

        // Вариант 1: carouselScripts — полный скрипт (строка с КАДР N:)
        const scriptStr = typeof snap.carouselScripts === 'string'
          ? snap.carouselScripts
          : (Array.isArray(snap.carouselScripts) ? snap.carouselScripts.join('\n') : '');
        if (scriptStr) {
          const extracted = extractAllCarouselTexts(scriptStr);
          slideTexts = extracted.filter(Boolean).slice(0, localPaths.length);
        }

        // Вариант 2: carouselTexts — массив коротких текстов (visual_sample, free_prompts)
        if (!slideTexts.length) {
          const pt = snap.carouselTexts || snap.prompts?.carouselTexts || [];
          slideTexts = pt.filter(Boolean).slice(0, localPaths.length);
        }
      } catch (e) {
        console.error('[carousel_video] snapshot texts error:', e.message);
      }
    }

    const stripMd = t => t ? t.replace(/\*\*/g, '').replace(/\*/g, '').replace(/_/g, '').trim() : t;
    const slideDuration = 4; // 7 × 4с = 28с
    const slides        = localPaths.map((p, i) => ({
      url:      `${baseUrl}/images/${path.basename(p)}`,
      mainText: stripMd(slideTexts[i] || ''),
      subText:  ''
    }));

    await bot3Send(chatId,
      `📸 ${useRaw ? '✅ Чистые фоны (без вшитого текста)' : '⚠️ Raw не найдены — используем ov (Ken Burns уменьшен)'}\n` +
      `Позиция текста: ${textPosition}\n` +
      `${localPaths.length} слайдов × ${slideDuration}с = ${localPaths.length * slideDuration}с\n` +
      slides.map((s, i) => `${i + 1}. ${path.basename(localPaths[i])}${s.mainText ? `\n   "${s.mainText.slice(0, 50)}"` : ''}`).join('\n') +
      `\n\n⏳ Отправляю в Creatomate с Ken Burns...`
    );

    const source   = buildCarouselVideoSource(slides, slideDuration, !useRaw, textPosition);
    const { default: fetch } = await import('node-fetch');

    // Отправить рендер
    const renderResp = await fetch('https://api.creatomate.com/v1/renders', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source })
    });
    const renderText = await Promise.race([
      renderResp.text(),
      new Promise((_, r) => setTimeout(() => r(new Error('render submit timeout')), 15000))
    ]);
    if (!renderResp.ok) throw new Error(`Creatomate HTTP ${renderResp.status}: ${renderText.slice(0, 200)}`);
    const renders = JSON.parse(renderText);
    const renderId = renders[0]?.id;
    if (!renderId) throw new Error(`Нет render id. Ответ: ${renderText.slice(0, 200)}`);

    await bot3Send(chatId, `🔵 Render ${renderId} запущен, опрашиваю...`);

    // Poll
    let status = '';
    let pollData;
    for (let i = 0; i < 36 && status !== 'succeeded' && status !== 'failed'; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const pr  = await fetch(`https://api.creatomate.com/v1/renders/${renderId}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      const pj  = await Promise.race([
        pr.json(),
        new Promise((_, r) => setTimeout(() => r({}), 8000))
      ]);
      pollData = pj;
      status   = pj.status || '';
      if (i === 0 || status === 'succeeded' || status === 'failed') {
        await bot3Send(chatId, `🔵 Poll ${i + 1}: status=${status}`);
      }
    }

    if (status !== 'succeeded') {
      const errMsg = pollData?.error_message || pollData?.error || 'unknown';
      throw new Error(`Render ${status}: ${errMsg}`);
    }

    const videoUrl  = pollData.url;
    const localPath = path.join(RESULTS_DIR, `${clientChatId}_carousel_video.mp4`);
    const dlResp    = await fetch(videoUrl);
    const buffer    = await Promise.race([
      dlResp.buffer(),
      new Promise((_, r) => setTimeout(() => r(new Error('download timeout 55s')), 55000))
    ]);
    fs.writeFileSync(localPath, buffer);

    clearTimeout(timeoutId);
    await bot3Send(chatId, `✅ Carousel Ken Burns видео готово!\n🔗 ${videoUrl}`);
    const uploaded = await bot3SendVideo(chatId, localPath);
    if (!uploaded) await bot3Send(chatId, `⚠️ Файл не загрузился, но URL выше рабочий.`);

  } catch (e) {
    clearTimeout(timeoutId);
    await sendTgSafe(`❌ Carousel Video: ${e.message}`);
  }
}

// ── Stories → Video с Ken Burns (аналог testCarouselVideoForClient) ────────────
app.post('/test_stories_video', (req, res) => {
  const { clientChatId, textPosition } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  testStoriesVideoForClient(String(clientChatId), textPosition).catch(e =>
    console.error('[stories_video] error', e.message)
  );
});

async function testStoriesVideoForClient(clientChatId, textPosition = 'bottom') {
  const chatId    = process.env.BOT3_MANAGER_CHAT_ID;
  const bot3Token = process.env.TELEGRAM_BOT3_TOKEN;

  const sendTgSafe = (text) => new Promise((resolve) => {
    const https = require('https');
    const body  = JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000) });
    const req   = https.request({
      hostname: 'api.telegram.org', path: `/bot${bot3Token}/sendMessage`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 8000
    }, (res) => { res.resume(); resolve(); });
    req.on('error', resolve); req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(body); req.end();
  });

  const HARD_TIMEOUT = 4 * 60 * 1000;
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Creatomate не ответил за 4 минуты')), HARD_TIMEOUT);
  });

  try {
    await bot3Send(chatId, `🎬 Stories→Video тест для ${clientChatId}\n⏳ Ищу слайды сторис...`);

    const apiKey = process.env.CREATOMATE_API_KEY;
    if (!apiKey) throw new Error('CREATOMATE_API_KEY не задан');

    let baseUrl = (process.env.VISUAL_BASE_URL || '').replace(/\/$/, '');
    if (!baseUrl.startsWith('http')) baseUrl = `https://${baseUrl}`;

    const allFiles = fs.existsSync(RESULTS_DIR) ? fs.readdirSync(RESULTS_DIR) : [];

    // Приоритет: _stories_*_raw.jpg → _stories_*_ov.jpg
    const storiesRaw = allFiles
      .filter(f => f.startsWith(`${clientChatId}_stories_`) && f.endsWith('_raw.jpg'))
      .sort().map(f => path.join(RESULTS_DIR, f));

    const storiesOv = allFiles
      .filter(f => f.startsWith(`${clientChatId}_stories_`) && f.endsWith('_ov.jpg'))
      .sort().map(f => path.join(RESULTS_DIR, f));

    const useRaw   = storiesRaw.length >= 2;
    const localPaths = (useRaw ? storiesRaw : storiesOv).slice(0, 7);

    await bot3Send(chatId,
      `🔍 Диагностика:\nstoriesRaw: ${storiesRaw.length} | storiesOv: ${storiesOv.length}\n` +
      `Источник: ${useRaw ? 'raw ✅' : 'ov (fallback) ⚠️'}`
    );

    if (localPaths.length < 2) {
      await bot3Send(chatId, `❌ Нет слайдов сторис для ${clientChatId}\nСначала запусти /run_visual ${clientChatId} nv`);
      return;
    }

    // Тексты из done_snapshot.storiesScripts — "Текст на экране:"
    let slideTexts = [];
    const snapPath = path.join(TRIGGERS_DIR, `${clientChatId}.done_snapshot.json`);
    if (useRaw && fs.existsSync(snapPath)) {
      try {
        const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
        const storiesStr = typeof snap.storiesScripts === 'string'
          ? snap.storiesScripts
          : (Array.isArray(snap.storiesScripts) ? snap.storiesScripts.join('\n') : '');
        if (storiesStr) {
          slideTexts = extractSlideTexts(storiesStr, 'stories')
            .filter(Boolean)
            .slice(0, localPaths.length);
        }
      } catch (e) {
        console.error('[stories_video] snapshot error:', e.message);
      }
    }

    const stripMd = t => t ? t.replace(/\*\*/g, '').replace(/\*/g, '').replace(/_/g, '').trim() : t;
    const slideDuration = 4; // 7 × 4с = 28с
    const slides = localPaths.map((p, i) => ({
      url:      `${baseUrl}/images/${path.basename(p)}`,
      mainText: stripMd(slideTexts[i] || ''),
      subText:  ''
    }));

    await bot3Send(chatId,
      `📱 ${useRaw ? '✅ Чистые фоны' : '⚠️ Raw не найдены — используем ov'}\n` +
      `Позиция текста: ${textPosition}\n` +
      `${localPaths.length} сторис × ${slideDuration}с = ${localPaths.length * slideDuration}с\n` +
      slides.map((s, i) => `${i + 1}. ${path.basename(localPaths[i])}${s.mainText ? `\n   "${s.mainText.slice(0, 50)}"` : ''}`).join('\n') +
      `\n\n⏳ Отправляю в Creatomate с Ken Burns...`
    );

    const source = buildCarouselVideoSource(slides, slideDuration, !useRaw, textPosition);
    const { default: fetch } = await import('node-fetch');

    const renderResp = await fetch('https://api.creatomate.com/v1/renders', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source })
    });
    const renderText = await Promise.race([
      renderResp.text(),
      new Promise((_, r) => setTimeout(() => r(new Error('render submit timeout')), 15000))
    ]);
    if (!renderResp.ok) throw new Error(`Creatomate HTTP ${renderResp.status}: ${renderText.slice(0, 200)}`);
    const renders  = JSON.parse(renderText);
    const renderId = renders[0]?.id;
    if (!renderId) throw new Error(`Нет render id. Ответ: ${renderText.slice(0, 200)}`);

    await bot3Send(chatId, `🔵 Render ${renderId} запущен, опрашиваю...`);

    let status = '', pollData;
    for (let i = 0; i < 36 && status !== 'succeeded' && status !== 'failed'; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const pr = await fetch(`https://api.creatomate.com/v1/renders/${renderId}`, {
        headers: { 'Authorization': `Bearer ${apiKey}` }
      });
      const pj = await Promise.race([pr.json(), new Promise((_, r) => setTimeout(() => r({}), 8000))]);
      pollData = pj;
      status   = pj.status || '';
      if (i === 0 || status === 'succeeded' || status === 'failed') {
        await bot3Send(chatId, `🔵 Poll ${i + 1}: status=${status}`);
      }
    }

    if (status !== 'succeeded') {
      throw new Error(`Render ${status}: ${pollData?.error_message || 'unknown'}`);
    }

    const videoUrl  = pollData.url;
    const localPath = path.join(RESULTS_DIR, `${clientChatId}_stories_video.mp4`);
    const dlResp    = await fetch(videoUrl);
    const buffer    = await Promise.race([
      dlResp.buffer(),
      new Promise((_, r) => setTimeout(() => r(new Error('download timeout 55s')), 55000))
    ]);
    fs.writeFileSync(localPath, buffer);

    clearTimeout(timeoutId);
    await bot3Send(chatId, `✅ Stories Ken Burns видео готово!\n🔗 ${videoUrl}`);
    const uploaded = await bot3SendVideo(chatId, localPath);
    if (!uploaded) await bot3Send(chatId, `⚠️ Файл не загрузился, но URL выше рабочий.`);

  } catch (e) {
    clearTimeout(timeoutId);
    await sendTgSafe(`❌ Stories Video: ${e.message}`);
  }
}

async function generateCreatomateVideo(clientChatId, slides, videoIndex, notifyFn, textPosition = 'bottom') {
  const apiKey = process.env.CREATOMATE_API_KEY;
  if (!apiKey) throw new Error('CREATOMATE_API_KEY не задан в Railway env');

  let baseUrl = (process.env.VISUAL_BASE_URL || '').replace(/\/$/, '');
  if (!baseUrl) throw new Error('VISUAL_BASE_URL не задан — Creatomate не сможет загрузить фотографии');
  if (!baseUrl.startsWith('http')) baseUrl = `https://${baseUrl}`;

  const slidesWithUrls = slides.map(s => ({
    ...s,
    photoUrl: s.photoLocalPath
      ? `${baseUrl}/images/${path.basename(s.photoLocalPath)}`
      : (s.photoUrl || '')
  }));

  console.log(`[creatomate] Фото URLs: ${slidesWithUrls.map(s => s.photoUrl).join(', ')}`);

  const source = buildCreatomateSource(slidesWithUrls, textPosition);
  console.log(`[creatomate] JSON source: ${JSON.stringify(source).slice(0, 600)}`);

  const { default: fetch } = await import('node-fetch');

  const doFetch = async (url, opts, timeoutMs) => {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...opts, signal: ctrl.signal });
      return r;
    } finally {
      clearTimeout(tid);
    }
  };

  // Отправляем запрос на рендер (20s timeout)
  let resp;
  try {
    resp = await doFetch('https://api.creatomate.com/v1/renders', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ source })
    }, 20000);
  } catch (e) {
    throw new Error(`Creatomate POST failed (${e.message})`);
  }

  const respText = await Promise.race([
    resp.text(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('resp.text() timeout 15s')), 15000))
  ]);
  console.log(`[creatomate] POST ${resp.status}: ${respText.slice(0, 500)}`);
  if (!resp.ok) throw new Error(`Creatomate API ${resp.status}: ${respText.slice(0, 300)}`);

  let renderData;
  try { renderData = JSON.parse(respText); } catch { throw new Error(`Creatomate: bad JSON: ${respText.slice(0, 200)}`); }

  const renders  = Array.isArray(renderData) ? renderData : [renderData];
  const renderId = renders[0]?.id;
  if (!renderId) throw new Error(`Creatomate: no render id: ${respText.slice(0, 200)}`);
  console.log(`[creatomate] Render ${renderId}: статус=${renders[0]?.status}`);

  // Milestone 1: render submitted
  if (notifyFn) { try { await notifyFn(`🔵 Render ${renderId} запущен, опрашиваю...`); } catch {} }

  // Polling — 36 итераций × 5s = 3 мин (внешний таймаут testCreatomateForClient даст ещё запас)
  let status     = renders[0]?.status || 'planned';
  let videoUrl   = renders[0]?.url;
  let lastErrMsg = renders[0]?.errorMessage || renders[0]?.error_message || renders[0]?.error || '';
  let firstPollDone = false;

  for (let i = 0; i < 36 && status !== 'succeeded' && status !== 'failed'; i++) {
    await new Promise(r => setTimeout(r, 5000));
    try {
      const pr = await doFetch(
        `https://api.creatomate.com/v1/renders/${renderId}`,
        { headers: { 'Authorization': `Bearer ${apiKey}` } },
        10000
      );
      const pd   = await Promise.race([
        pr.json(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('poll json timeout 8s')), 8000))
      ]);
      status     = pd.status;
      videoUrl   = pd.url;
      lastErrMsg = pd.errorMessage || pd.error_message || pd.error || '';
      if (status === 'failed' && !lastErrMsg) lastErrMsg = JSON.stringify(pd).slice(0, 400);
      const pct  = pd.progress !== undefined ? Math.round(pd.progress * 100) : '?';
      console.log(`[creatomate] poll ${i + 1}: ${status} ${pct}%`);
      // Milestone 2: first poll result (only once)
      if (!firstPollDone && notifyFn) {
        firstPollDone = true;
        try { await notifyFn(`🔵 Poll 1: status=${status} progress=${pct}%`); } catch {}
      }
    } catch (e) {
      console.warn(`[creatomate] poll ${i + 1} err: ${e.message}`);
    }
  }

  if (status !== 'succeeded' || !videoUrl) {
    const detail = lastErrMsg ? `: ${lastErrMsg}` : '';
    throw new Error(`Creatomate: status=${status}${detail}`);
  }

  const outputPath = path.join(RESULTS_DIR, `${clientChatId}_v${videoIndex}_cr.mp4`);
  const dlResp = await doFetch(videoUrl, {}, 60000);
  const buffer = await Promise.race([
    dlResp.buffer(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('download buffer timeout 55s')), 55000))
  ]);
  fs.writeFileSync(outputPath, buffer);
  console.log(`[creatomate] скачано: ${outputPath}`);

  return { localPath: outputPath, videoUrl };
}

app.post('/test_creatomate', (req, res) => {
  const { clientChatId, textPosition } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  testCreatomateForClient(String(clientChatId), textPosition).catch(e =>
    console.error('[creatomate] test error', e.message)
  );
});

async function testCreatomateForClient(clientChatId, textPosition = 'bottom') {
  const { generateSlideTextsFromSnap } = require('./src/steps/block7_scripts');
  const chatId = process.env.BOT3_MANAGER_CHAT_ID;

  const snapPath = path.join(TRIGGERS_DIR, `${clientChatId}.done_snapshot.json`);
  if (!fs.existsSync(snapPath)) {
    await bot3Send(chatId, `❌ done_snapshot не найден для ${clientChatId}\nКлиент должен сначала пройти полную генерацию.`);
    return;
  }
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));

  await bot3Send(chatId, `🎬 Creatomate тест для ${clientChatId}\n⏳ Шаг 1/3: Генерирую тексты слайдов через Claude...`);

  let slideVideos;
  try {
    const timeoutMs = 90000; // 90 сек — не ждём бесконечно
    const slidePromise = generateSlideTextsFromSnap(snap);
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Claude timeout 90s — попробуй ещё раз')), timeoutMs)
    );
    slideVideos = await Promise.race([slidePromise, timeoutPromise]);
  } catch (e) {
    await bot3Send(chatId, `❌ Шаг 1 провалился: ${e.message}`);
    return;
  }

  if (!slideVideos || !slideVideos.length) {
    await bot3Send(chatId, `❌ Тариф клиента не поддерживает видео (только Стандарт и Профи)\npaidPackageKey=${snap.paidPackageKey || 'не найден'}`);
    return;
  }

  await bot3Send(chatId, `✅ Шаг 1 готов: ${slideVideos.length} видео сгенерировано\n⏳ Шаг 2/3: Ищу фотографии...`);

  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  const resultData = fs.existsSync(resultPath)
    ? JSON.parse(fs.readFileSync(resultPath, 'utf8'))
    : {};
  const results = resultData.results || resultData;

  // 1. Из results.json (raw без overlay, затем overlay как запасной)
  const fromResults = [
    ...(results.photosLocalPaths         || []),
    ...(results.carouselSlidesLocalPaths || [])
  ].filter(Boolean).map(p => {
    const raw = p.replace('_ov.jpg', '_raw.jpg').replace('_ov.png', '_raw.png');
    if (fs.existsSync(raw)) return raw;
    if (fs.existsSync(p))   return p;   // overlay тоже подойдёт как фон
    return null;
  }).filter(Boolean);

  // 2. Прямой скан: сначала _photos_ (чистые фото без текста), потом карусели как запасной вариант
  const allFiles = fs.existsSync(RESULTS_DIR) ? fs.readdirSync(RESULTS_DIR) : [];
  const photosScanned = allFiles
    .filter(f => f.startsWith(`${clientChatId}_photos_`) && f.endsWith('_raw.jpg'))
    .sort()
    .map(f => path.join(RESULTS_DIR, f));
  const numIdxRaw = f => { const m = f.match(/_(\d+)_raw\.jpg$/); return m ? +m[1] : 0; };
  let carouselScanned = allFiles
    .filter(f => f.startsWith(`${clientChatId}_carouselSlides_`) && f.endsWith('_raw.jpg'))
    .sort((a, b) => numIdxRaw(a) - numIdxRaw(b))
    .map(f => path.join(RESULTS_DIR, f));
  if (carouselScanned.length < 2) carouselScanned = allFiles
    .filter(f => f.startsWith(`${clientChatId}_carousel_`) && f.endsWith('_raw.jpg'))
    .sort((a, b) => numIdxRaw(a) - numIdxRaw(b))
    .map(f => path.join(RESULTS_DIR, f));
  const scanned = [...photosScanned, ...carouselScanned];

  // Берём уникальные пути (results.json приоритет)
  const seenBase = new Set(fromResults.map(p => path.basename(p)));
  const localPaths = [
    ...fromResults,
    ...scanned.filter(p => !seenBase.has(path.basename(p)))
  ].slice(0, 4);

  await bot3Send(chatId,
    `📸 Шаг 2: из results.json ${fromResults.length}, из скана папки ${scanned.length}\n` +
    `Итого для слайдов: ${localPaths.length}\n` +
    localPaths.map((p, i) => `${i + 1}. ${path.basename(p)}`).join('\n')
  );

  if (localPaths.length < 2) {
    await bot3Send(chatId, `❌ Нет локальных фотографий.\nДождись пока /run_visual полностью завершится (придут все секции), потом запусти /test_creatomate снова.`);
    return;
  }

  const photoSources = localPaths.map(p => ({ photoLocalPath: p, photoUrl: null }));

  const firstVideo = slideVideos[0];
  const slides = (firstVideo.slides || []).map((s, i) => ({
    ...photoSources[i % photoSources.length],
    mainText: s.mainText || '',
    subText:  s.subText  || ''
  }));
  while (slides.length < 4) {
    slides.push({ ...photoSources[slides.length % photoSources.length], mainText: '…', subText: '' });
  }

  await bot3Send(chatId,
    `📋 Тема: ${firstVideo.title || '—'}\n\n` +
    slides.map((s, i) =>
      `Слайд ${i + 1}: "${s.mainText}"${s.subText ? `\n↳ ${s.subText}` : ''}`
    ).join('\n\n')
  );
  await bot3Send(chatId, `⏳ Шаг 3/3: Отправляю в Creatomate...`);

  // Жёсткий таймаут снаружи — если generateCreatomateVideo повиснет, через 3 мин придёт сообщение
  const HARD_TIMEOUT = 3 * 60 * 1000;
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Creatomate не ответил за 3 минуты — попробуй ещё раз')), HARD_TIMEOUT);
  });

  // Guaranteed error delivery via raw https (bypasses bot3Send/node-fetch entirely)
  const sendTgMessage = (token, tgChatId, text) => new Promise((resolve) => {
    const https = require('https');
    const msgBody = JSON.stringify({ chat_id: tgChatId, text: String(text).slice(0, 4000) });
    const req = https.request({
      hostname: 'api.telegram.org',
      path: `/bot${token}/sendMessage`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(msgBody) },
      timeout: 8000
    }, (res) => { res.resume(); resolve(); });
    req.on('error', resolve);
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(msgBody);
    req.end();
  });

  const bot3Token = process.env.TELEGRAM_BOT3_TOKEN;

  try {
    // notifyFn sends milestones from inside generateCreatomateVideo so we can see where it stalls
    const notifyFn = async (msg) => { await bot3Send(chatId, msg); };
    const renderPromise = generateCreatomateVideo(clientChatId, slides, 0, notifyFn, textPosition);

    const result = await Promise.race([renderPromise, timeoutPromise]);
    clearTimeout(timeoutId);
    const { localPath, videoUrl } = result;

    // Fix 5: Send URL first so manager always gets it even if file upload hangs
    await bot3Send(chatId, `✅ Creatomate видео готово!\n🔗 URL: ${videoUrl}`);

    // Then try to upload the file (with timeouts now in bot3SendVideo)
    const uploaded = await bot3SendVideo(chatId, localPath);
    if (!uploaded) {
      await bot3Send(chatId, `⚠️ Файл не удалось отправить в Telegram — но URL выше рабочий.`);
    }
  } catch (e) {
    clearTimeout(timeoutId);
    // Use raw https for guaranteed delivery — bot3Send might also hang
    if (bot3Token && chatId) {
      await sendTgMessage(bot3Token, chatId, `❌ Шаг 3 Creatomate: ${e.message}`);
    }
  }
}

// ── Kling (fal.ai) — AI Photo Animation ───────────────────────────────────────

const KLING_MOTION_PROMPTS = [
  'slow cinematic zoom in, smooth professional motion, high quality',
  'gentle camera pan left to right, cinematic depth of field, smooth',
  'slow zoom out revealing the scene, subtle parallax motion, cinematic',
  'gentle floating parallax motion, soft depth of field, professional'
];

async function generateKlingClip(photoUrl, motionPrompt, durationSec = 5) {
  const { default: fetch } = await import('node-fetch');
  const FAL_KEY = process.env.FAL_API_KEY;
  if (!FAL_KEY) throw new Error('FAL_API_KEY не задан в Railway env');

  const MODEL = 'fal-ai/kling-video/v1.6/standard/image-to-video';
  const BASE  = `https://queue.fal.run/${MODEL}`;
  const HDR   = { 'Authorization': `Key ${FAL_KEY}`, 'Content-Type': 'application/json' };

  const doFetch = async (url, opts, timeoutMs) => {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
    try { const r = await fetch(url, { ...opts, signal: ctrl.signal }); clearTimeout(tid); return r; }
    catch (e)  { clearTimeout(tid); throw e; }
  };

  const readText = (resp, label, ms) => Promise.race([
    resp.text(),
    new Promise((_, r) => setTimeout(() => r(new Error(`${label} timeout ${ms}ms`)), ms))
  ]);

  // Submit
  const subResp = await doFetch(BASE, { method: 'POST', headers: HDR, body: JSON.stringify({ image_url: photoUrl, prompt: motionPrompt, duration: String(durationSec) }) }, 20000);
  const subText = await readText(subResp, 'submit', 10000);
  console.log(`[kling] submit status=${subResp.status} body=${subText.slice(0, 300)}`);
  if (!subResp.ok) throw new Error(`Kling HTTP ${subResp.status}: ${subText.slice(0, 300)}`);
  let subJson;
  try { subJson = JSON.parse(subText); } catch { throw new Error(`Kling submit: не JSON (${subResp.status}): ${subText.slice(0, 200)}`); }
  const { request_id } = subJson;
  if (!request_id) throw new Error(`Kling submit: нет request_id. Ответ: ${subText.slice(0, 200)}`);

  // Poll (max 5 мин, интервал 8с)
  for (let i = 0; i < 38; i++) {
    await new Promise(r => setTimeout(r, 8000));
    const stResp = await doFetch(`${BASE}/requests/${request_id}/status`, { headers: HDR }, 15000);
    const stText = await readText(stResp, 'status', 8000);
    const { status } = JSON.parse(stText);
    if (status === 'COMPLETED') {
      const resResp = await doFetch(`${BASE}/requests/${request_id}`, { headers: HDR }, 15000);
      const resText = await readText(resResp, 'result', 8000);
      const result  = JSON.parse(resText);
      const videoUrl = result?.video?.url;
      if (!videoUrl) throw new Error(`Kling: нет video.url. Ответ: ${resText.slice(0, 200)}`);
      return videoUrl;
    }
    if (status === 'FAILED') throw new Error(`Kling render failed для фото`);
  }
  throw new Error('Kling timeout 5 мин — попробуй ещё раз');
}

app.post('/test_kling', (req, res) => {
  const { clientChatId } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  testKlingForClient(String(clientChatId)).catch(e =>
    console.error('[kling] test error', e.message)
  );
});

async function testKlingForClient(clientChatId) {
  const chatId    = process.env.BOT3_MANAGER_CHAT_ID;
  const bot3Token = process.env.TELEGRAM_BOT3_TOKEN;

  const sendTgSafe = (text) => new Promise((resolve) => {
    const https  = require('https');
    const body   = JSON.stringify({ chat_id: chatId, text: String(text).slice(0, 4000) });
    const req    = https.request({
      hostname: 'api.telegram.org', path: `/bot${bot3Token}/sendMessage`, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, timeout: 8000
    }, (res) => { res.resume(); resolve(); });
    req.on('error', resolve); req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(body); req.end();
  });

  // Жёсткий таймаут 10 мин (4 клипа параллельно + скачивание)
  const HARD_TIMEOUT = 10 * 60 * 1000;
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error('Kling не ответил за 10 минут — попробуй ещё раз')), HARD_TIMEOUT);
  });

  try {
    const result = await Promise.race([_testKlingInner(clientChatId, chatId), timeoutPromise]);
    clearTimeout(timeoutId);
    return result;
  } catch (e) {
    clearTimeout(timeoutId);
    await sendTgSafe(`❌ Kling тест: ${e.message}`);
  }
}

async function _testKlingInner(clientChatId, chatId) {
  const { default: fetch } = await import('node-fetch');

  await bot3Send(chatId, `🎬 Kling тест для ${clientChatId}\n⏳ Шаг 1/3: Ищу фотографии...`);

  // Найти фото (та же логика что и в testCreatomateForClient)
  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  const resultData = fs.existsSync(resultPath) ? JSON.parse(fs.readFileSync(resultPath, 'utf8')) : {};
  const results    = resultData.results || resultData;

  const fromResults = [
    ...(results.photosLocalPaths         || []),
    ...(results.carouselSlidesLocalPaths || [])
  ].filter(Boolean).map(p => {
    const raw = p.replace('_ov.jpg', '_raw.jpg').replace('_ov.png', '_raw.png');
    if (fs.existsSync(raw)) return raw;
    if (fs.existsSync(p))   return p;
    return null;
  }).filter(Boolean);

  const allFiles      = fs.existsSync(RESULTS_DIR) ? fs.readdirSync(RESULTS_DIR) : [];
  const photosScanned = allFiles
    .filter(f => f.startsWith(`${clientChatId}_photos_`) && f.endsWith('_raw.jpg'))
    .sort().map(f => path.join(RESULTS_DIR, f));
  const numIdxKling = f => { const m = f.match(/_(\d+)_raw\.jpg$/); return m ? +m[1] : 0; };
  let carouselScanned = allFiles
    .filter(f => f.startsWith(`${clientChatId}_carouselSlides_`) && f.endsWith('_raw.jpg'))
    .sort((a, b) => numIdxKling(a) - numIdxKling(b))
    .map(f => path.join(RESULTS_DIR, f));
  if (carouselScanned.length < 2) carouselScanned = allFiles
    .filter(f => f.startsWith(`${clientChatId}_carousel_`) && f.endsWith('_raw.jpg'))
    .sort((a, b) => numIdxKling(a) - numIdxKling(b))
    .map(f => path.join(RESULTS_DIR, f));

  const seenBase   = new Set(fromResults.map(p => path.basename(p)));
  const localPaths = [
    ...fromResults,
    ...[...photosScanned, ...carouselScanned].filter(p => !seenBase.has(path.basename(p)))
  ].slice(0, 4);

  if (!localPaths.length) {
    await bot3Send(chatId, `❌ Нет фотографий для ${clientChatId}\nДождись /run_visual и попробуй снова.`);
    return;
  }

  let baseUrl = (process.env.VISUAL_BASE_URL || '').replace(/\/$/, '');
  if (!baseUrl.startsWith('http')) baseUrl = `https://${baseUrl}`;

  const photoUrls = localPaths.map(p => `${baseUrl}/images/${path.basename(p)}`);

  await bot3Send(chatId,
    `📸 Нашёл ${localPaths.length} фото:\n` +
    localPaths.map((p, i) => `${i + 1}. ${path.basename(p)}`).join('\n') +
    `\n\n⏳ Шаг 2/3: Анимирую через Kling (${localPaths.length} клипа × 5с параллельно)...`
  );

  // Анимировать все клипы параллельно
  const clipResults = await Promise.allSettled(
    photoUrls.map((url, i) => generateKlingClip(url, KLING_MOTION_PROMPTS[i % KLING_MOTION_PROMPTS.length], 5))
  );

  const successClips = [];
  const errors       = [];
  clipResults.forEach((r, i) => {
    if (r.status === 'fulfilled') successClips.push({ index: i, videoUrl: r.value });
    else errors.push(`Фото ${i + 1}: ${r.reason?.message || String(r.reason)}`);
  });

  if (errors.length) await bot3Send(chatId, `⚠️ Ошибки анимации:\n${errors.join('\n')}`);
  if (!successClips.length) { await bot3Send(chatId, `❌ Ни один клип не сгенерирован.`); return; }

  await bot3Send(chatId, `✅ ${successClips.length}/${localPaths.length} клипов готово\n⏳ Шаг 3/3: Скачиваю и склеиваю...`);

  // Скачать клипы локально
  const clipPaths = [];
  for (const { index, videoUrl } of successClips) {
    const clipPath = path.join(RESULTS_DIR, `${clientChatId}_kling_clip${index}.mp4`);
    const dlResp   = await fetch(videoUrl);
    const buffer   = await Promise.race([
      dlResp.buffer(),
      new Promise((_, r) => setTimeout(() => r(new Error('download timeout 60s')), 60000))
    ]);
    fs.writeFileSync(clipPath, buffer);
    clipPaths.push(clipPath);
  }

  // Склеить через ffmpeg
  const finalPath = path.join(RESULTS_DIR, `${clientChatId}_kling_final.mp4`);
  if (clipPaths.length === 1) {
    fs.copyFileSync(clipPaths[0], finalPath);
  } else {
    try {
      mergeVideoFragments(clipPaths, finalPath);
    } catch {
      // fallback: re-encode для совместимости
      const listFile = finalPath + '.txt';
      fs.writeFileSync(listFile, clipPaths.map(p => `file '${p}'`).join('\n'));
      execSync(`"${FFMPEG_BIN}" -y -f concat -safe 0 -i "${listFile}" -c:v libx264 -preset fast -crf 23 -an "${finalPath}"`, { stdio: 'pipe' });
      fs.unlinkSync(listFile);
    }
  }

  // Удалить временные клипы
  clipPaths.forEach(p => { try { fs.unlinkSync(p); } catch {} });

  await bot3Send(chatId, `✅ Kling видео готово! ${successClips.length} клипа × 5с`);
  await bot3SendVideo(chatId, finalPath);
}

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
  const hasSceneBlocks = /СЦЕНА\s*\d+/i.test(videoScript);
  const extracted = [];
  let placeholderCount = 0;
  const sceneRegex = /СЦЕНА\s*(\d+)\s*\(\d+-\d+\s*сек\s*\)[\s\S]*?EN\s*:\s*([^\n]+)/gi;
  let m;
  while ((m = sceneRegex.exec(videoScript)) !== null) {
    const enPrompt = m[2].trim();
    if (enPrompt && !enPrompt.startsWith('[')) {
      extracted.push(enPrompt);
    } else if (enPrompt.startsWith('[')) {
      placeholderCount++;
    }
  }
  if (extracted.length >= 4) return extracted.slice(0, 4);
  if (extracted.length >= 2) {
    // Pad to 4 by cycling
    while (extracted.length < 4) extracted.push(extracted[extracted.length - 1]);
    return extracted;
  }

  // Если СЦЕНА-блоки есть, но EN-строки — плейсхолдеры [ДЕЙСТВИЕ+ЭМОЦИЯ: ...]
  // Haiku без контекста бизнеса → генерирует generic → хуже чем ничего
  // Сигнализируем наверх чтобы менеджер переписал сценарий
  if (hasSceneBlocks && placeholderCount > 0) {
    const err = new Error('PLACEHOLDER_DETECTED');
    err.placeholderCount = placeholderCount;
    throw err;
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
  const ctaEnd   = 9999; // до реального конца видео (не duration — ffprobe может вернуть 30 как fallback)

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
  return lines.slice(0, 3); // max 3 lines (3 × 22 символа = 66 символов)
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
  let scenes;
  try {
    scenes = await splitScriptToScenes(videoScript);
  } catch (e) {
    if (e.message === 'PLACEHOLDER_DETECTED') {
      const msg = `⚠️ Видео ${videoIndex + 1} (клиент ${clientChatId})\n\nSonnet написал шаблон вместо реального EN-промпта (${e.placeholderCount} сцен).\n\nНажми /resend_scripts ${clientChatId} чтобы переписать сценарий.`;
      console.warn(`[visual] ${msg}`);
      await bot3Send(process.env.BOT3_MANAGER_CHAT_ID, msg).catch(() => {});
      return null;
    }
    throw e;
  }
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

  return { localPath: finalPath, rawPath: mergedPath, subtitleText, hookText: hook, themeText, ctaText: cta, scenes, fragmentUrls, fragPaths, validCount: validUrls.length, libraryMatches };
}

// Применить новый субтитр к готовому видео из библиотеки (без Veo3 генерации)
async function applyLibraryVideo(libMatch, videoScript, videoIndex, clientChatId, ctaOverride = '') {
  const titleM    = videoScript.match(/ВИДЕО\s*\d+[:\s]+([^\n]+)/i);
  const themeText = titleM ? wordSlice(titleM[1].trim(), 5) : '';
  const { hook, cta } = extractTimedTexts(videoScript, ctaOverride);
  const subtitleText  = hook || extractSubtitleFromScript(videoScript);

  const finalPath = path.join(TMP_DIR, `${clientChatId}_v${videoIndex}_lib_final.mp4`);
  try {
    const duration   = getVideoDuration(libMatch.localPath);
    const srtContent = buildTimedSrt(hook, cta, duration, themeText);
    if (srtContent.trim()) {
      addTimedSubtitles(libMatch.localPath, srtContent, finalPath);
    } else {
      fs.copyFileSync(libMatch.localPath, finalPath);
    }
  } catch (e) {
    console.error(`[visual] applyLibraryVideo error:`, e.message);
    fs.copyFileSync(libMatch.localPath, finalPath);
  }

  console.log(`[library] Видео ${videoIndex + 1} взято из библиотеки: ${libMatch.videoId} (совпадение: ${libMatch.matchCount} тегов)`);
  return { localPath: finalPath, rawPath: libMatch.localPath, subtitleText, fromLibrary: true, libraryVideoId: libMatch.videoId };
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

  // Re-download and merge — приоритет: локальные кэшированные фрагменты, fallback URL
  const managerChatId = process.env.BOT3_MANAGER_CHAT_ID;
  const tmpBase  = path.join(TMP_DIR, `${clientChatId}_v${videoIndex}_regen`);
  const cachedFragPaths = videoData.fragPaths || [];
  const fragPaths = [];
  for (let i = 0; i < newFragmentUrls.length; i++) {
    const p = `${tmpBase}_frag${i}.mp4`;
    const cached = cachedFragPaths[i];
    if (!scenesToRegen.includes(i) && cached && fs.existsSync(cached)) {
      // Сцена не менялась — берём локальный кэш
      fs.copyFileSync(cached, p);
      fragPaths.push(p);
    } else if (newFragmentUrls[i]) {
      // Новая или перегенерированная сцена — скачиваем
      try { await downloadFile(newFragmentUrls[i], p); fragPaths.push(p); } catch {}
    }
  }

  if (!fragPaths.length) {
    await bot3Send(managerChatId, `❌ Видео ${videoIndex + 1}: не удалось получить фрагменты (CDN-ссылки истекли и локальный кэш пуст).\nПопробуйте /resend_scripts ${clientChatId} и запустите генерацию заново.`);
    return;
  }

  const mergedPath = `${tmpBase}_merged.mp4`;
  try {
    if (fragPaths.length > 1) {
      mergeVideoFragments(fragPaths, mergedPath);
    } else {
      fs.copyFileSync(fragPaths[0], mergedPath);
    }
    fragPaths.forEach(p => fs.existsSync(p) && fs.unlinkSync(p));
  } catch (e) {
    console.error('[visual] ffmpeg regen merge error:', e.message);
    await bot3Send(managerChatId, `❌ Видео ${videoIndex + 1}: ошибка склейки фрагментов: ${e.message}`);
    return;
  }

  // Re-apply subtitle overlay
  const subtitleText = videoData.subtitleText || '';
  const finalPath = mergedPath.replace('_merged.mp4', '_final.mp4');
  try {
    if (subtitleText) {
      addSubtitles(mergedPath, subtitleText, finalPath);
    } else {
      fs.copyFileSync(mergedPath, finalPath);
    }
  } catch (e) {
    console.error('[visual] regen subtitle error:', e.message);
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

  const totalVideos = (data.results.videoData || []).length;
  await notifyBot3SingleVideo(clientChatId, videoIndex, totalVideos, finalPath, subtitleText, null);
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
  const managerChatId = process.env.BOT3_MANAGER_CHAT_ID;
  if (!videoData?.rawPath || !fs.existsSync(videoData.rawPath)) {
    console.error(`[visual] regenSubtitle: rawPath не найден для видео ${videoIndex}`);
    await bot3Send(managerChatId, `❌ Видео ${videoIndex + 1}: не удалось изменить текст — исходный файл не найден.\nПопробуйте /resend_video ${clientChatId} ${videoIndex} и повторите.`);
    return;
  }

  // Парсим структурированный ввод; для пропущенных полей берём сохранённые значения
  const hookMatch  = newSubtitleText.match(/Хук:\s*(.+)/i);
  const themeMatch = newSubtitleText.match(/Тема:\s*(.+)/i);
  const ctaMatch   = newSubtitleText.match(/(?:CTA|СТА|ста|cta):\s*(.+)/i);
  const hookText   = (hookMatch  ? hookMatch[1].trim()  : videoData.hookText  || videoData.subtitleText || '').slice(0, 35);
  const themeText  = (themeMatch ? themeMatch[1].trim() : videoData.themeText || '').slice(0, 35);
  const ctaText    = (ctaMatch   ? ctaMatch[1].trim()   : videoData.ctaText   || '').slice(0, 70);

  const tmpBase   = path.join(TMP_DIR, `${clientChatId}_v${videoIndex}`);
  const finalPath = `${tmpBase}_final_sub.mp4`;
  try {
    const duration   = getVideoDuration(videoData.rawPath);
    const srtContent = buildTimedSrt(hookText, ctaText, duration, themeText);
    if (srtContent.trim()) {
      addTimedSubtitles(videoData.rawPath, srtContent, finalPath);
    } else {
      fs.copyFileSync(videoData.rawPath, finalPath);
    }
  } catch (e) {
    console.error('[visual] regenSubtitle ffmpeg error:', e.message);
    try { fs.copyFileSync(videoData.rawPath, finalPath); } catch {}
  }

  data.results.videoData[videoIndex] = { ...videoData, localPath: finalPath, subtitleText: hookText, hookText, themeText, ctaText };
  fs.writeFileSync(resultPath, JSON.stringify(data, null, 2));
  const totalVideos = (data.results.videoData || []).length;
  await notifyBot3SingleVideo(clientChatId, videoIndex, totalVideos, finalPath, hookText, null);
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
    if (!url) { localPaths.push(null); continue; }
    try {
      const resp = await fetch(url);
      if (!resp.ok) { localPaths.push(null); continue; }
      const buf = await resp.buffer();
      if (!text || text === 'без текста' || text === 'no text') {
        // Нет текста — сохраняем сырой файл чтобы URL не истёк
        const rawPath = path.join(RESULTS_DIR, `${clientChatId}_${sectionKey}_${i}_raw.jpg`);
        fs.writeFileSync(rawPath, buf);
        localPaths.push(rawPath);
        console.log(`[visual] saved raw (no text) ${sectionKey}[${i}]`);
      } else {
        // Сохраняем raw для ВСЕХ секций — один набор картинок для постов (ov) и видео (raw)
        const rawPath = path.join(RESULTS_DIR, `${clientChatId}_${sectionKey}_${i}_raw.jpg`);
        if (!fs.existsSync(rawPath)) fs.writeFileSync(rawPath, buf);
        const processed = await overlayTextOnImage(buf, text, position, sizeKey);
        const outPath   = path.join(RESULTS_DIR, `${clientChatId}_${sectionKey}_${i}_ov.jpg`);
        fs.writeFileSync(outPath, processed);
        localPaths.push(outPath);
        console.log(`[visual] overlay ${sectionKey}[${i}] sizeKey=${sizeKey}: "${text.slice(0, 50)}"`);
      }
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

    // Ретрай упавших — один раз, с задержкой 5 сек
    const failedIdxs = urls.map((u, idx) => u ? -1 : idx).filter(idx => idx >= 0);
    if (failedIdxs.length > 0) {
      console.log(`[visual] ${label}: ретрай ${failedIdxs.length}/${slice.length} упавших...`);
      await sleep(5000);
      const retryIds   = await Promise.all(failedIdxs.map(idx => startFn(slice[idx]).catch(() => null)));
      const retryUrls  = await Promise.all(retryIds.map(id => pollTask(id, 900000, 'image')));
      failedIdxs.forEach((origIdx, retryIdx) => { urls[origIdx] = retryUrls[retryIdx]; });
    }

    out.push(...urls);
  }
  return out;
}

// ── Free package: carousel slides + cover ─────────────────────────────────────

async function generateFreeVisuals(clientChatId, carouselScript, coverExample, photoExample = '', storyExample = '') {
  console.log(`[visual] generateFreeVisuals: ${clientChatId}`);

  // Очищаем флаги от предыдущих запусков
  for (const flag of ['free_visuals_notified', 'visuals_6done', 'carousel_notified', 'cover_notified', 'story_notified']) {
    const f = path.join(RESULTS_DIR, `${clientChatId}.${flag}`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  const [carouselPrompts, coverPrompts, storyPrompts] = await Promise.all([
    getImagePrompts(carouselScript, 'carousel', 7),
    getImagePrompts(coverExample,   'cover',    1),
    getImagePrompts(storyExample,   'story',    1),
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

  const storyTextMatch = storyExample.match(/Текст на Stories\s*[:\-–]\s*(.+)/i);
  const storyText = storyTextMatch ? storyTextMatch[1].trim().slice(0, 80) : '';

  console.log(`[visual] freeVisuals: карусель=${carouselPrompts.length} обложка=${coverPrompts.length} сторис=${storyPrompts.length} текстов-слайдов=${carouselTexts.length}`);

  // Сохраняем промпты И тексты И подписи — используются при visual_sample и перегенерации
  fs.writeFileSync(
    path.join(RESULTS_DIR, `${clientChatId}.free_prompts.json`),
    JSON.stringify({
      carousel: carouselPrompts,
      cover: coverPrompts,
      story: storyPrompts,
      carouselTexts,
      carouselCaptions,
      coverTitle,
      photoTitle,
      photoCaption,
      storyText,
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
    await new Promise(r => setTimeout(r, 2000));
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
    await new Promise(r => setTimeout(r, 2000));
  }

  for (let i = 0; i < storyPrompts.length; i++) {
    const taskId = await startImage(storyPrompts[i], '9:16').catch(() => null);
    if (taskId) {
      saveImageTask(taskId, { clientId: clientChatId, type: 'free_visuals', slot: `story_${i}` });
      allPromises.push(pollAndSave(taskId, { clientId: clientChatId, type: 'free_visuals', slot: `story_${i}`, taskId }));
    }
    await new Promise(r => setTimeout(r, 2000));
  }

  // Ждём завершения всех (уведомление Bot3 отправляется из rebuildFreeVisuals при done===6)
  await Promise.all(allPromises);

  const finalResult = (() => { try { return JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch { return {}; } })();
  console.log(`[visual] generateFreeVisuals done: carousel=${(finalResult.carouselUrls || []).filter(Boolean).length} cover=${(finalResult.coverUrls || []).filter(Boolean).length}`);

  // Авто-ретрай: если какие-то слайды карусели не пришли — 1 попытка
  // Слайд считается готовым если есть в carousel_N (Kie.ai) ИЛИ в carouselUrls[N] (библиотека)
  const missingSlots = carouselPrompts.map((_, i) => i).filter(i =>
    !finalResult[`carousel_${i}`] && !(finalResult.carouselUrls && finalResult.carouselUrls[i])
  );
  if (missingSlots.length > 0) {
    console.log(`[visual] free carousel retry: слайды ${missingSlots.map(i => i + 1).join(',')} не пришли, ретрай...`);
    try {
      const { sendBotMsg } = await _freeNotifyUtils(clientChatId);
      if (sendBotMsg) await sendBotMsg(`⚠️ Слайды ${missingSlots.map(i => i + 1).join(', ')} не пришли от Kie.ai — отправляем повторно (1 попытка)`);
    } catch {}
    const retryPromises = [];
    for (const i of missingSlots) {
      const tid = await startImage(carouselPrompts[i], '1:1').catch(() => null);
      if (tid) {
        saveImageTask(tid, { clientId: clientChatId, type: 'free_visuals', slot: `carousel_${i}` });
        retryPromises.push(pollAndSave(tid, { clientId: clientChatId, type: 'free_visuals', slot: `carousel_${i}`, taskId: tid }));
      }
      await new Promise(r => setTimeout(r, 2000));
    }
    await Promise.all(retryPromises);
    const afterRetry = (() => { try { return JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${clientChatId}.free_visuals.json`), 'utf8')); } catch { return {}; } })();
    const stillMissing = missingSlots.filter(i => !afterRetry[`carousel_${i}`]);
    console.log(`[visual] free carousel retry done: ещё не пришли: ${stillMissing.length > 0 ? stillMissing.map(i => i + 1).join(',') : 'нет'}`);
    try {
      const { sendBotMsg } = await _freeNotifyUtils(clientChatId);
      if (sendBotMsg) {
        if (stillMissing.length > 0) {
          await sendBotMsg(`❌ После ретрая слайды ${stillMissing.map(i => i + 1).join(', ')} всё равно не пришли.\nИспользуй /retry_free_slots ${clientChatId} для ручного запуска.`);
        } else {
          await sendBotMsg(`✅ Ретрай успешен — все слайды получены`);
        }
      }
    } catch {}
  }
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

  // Скачиваем локально — Kie.ai URL истекает через 24-72ч
  let localPath = null;
  try {
    const { default: fetchDl } = await import('node-fetch');
    const r = await fetchDl(url);
    if (r.ok) {
      localPath = path.join(RESULTS_DIR, `${clientChatId}_free_photo.jpg`);
      fs.writeFileSync(localPath, Buffer.from(await r.arrayBuffer()));
    }
  } catch (e) {
    console.error('[visual] generateFreePhoto: download error', e.message);
  }

  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.free_photo.json`);
  fs.writeFileSync(resultPath, JSON.stringify({ url, localPath, prompt, generatedAt: Date.now() }, null, 2));
  console.log(`[visual] generateFreePhoto done: ${url} local=${localPath || 'н/д'}`);

  // Встраиваем фото в HTML-страницу — передаём localPath, site_builder сам строит https:// URL
  try {
    const { updatePackPagePhoto } = require('./src/site_builder');
    updatePackPagePhoto(clientChatId, localPath || url);
  } catch (e) {
    console.error('[visual] updatePackPagePhoto error:', e.message);
  }

  // Уведомляем Bot3 — используем bot3SendPhotoFile (тот же путь что карусель/обложка/сторис)
  const adminChatId = process.env.BOT3_MANAGER_CHAT_ID;
  if (!adminChatId) return;

  const { default: fetch } = await import('node-fetch');
  const botToken = process.env.TELEGRAM_BOT3_TOKEN;
  if (!botToken) return;

  const sendMsg = async (text, replyMarkup) => {
    await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: adminChatId, text, reply_markup: replyMarkup ? JSON.stringify(replyMarkup) : undefined }),
    }).catch(e => console.error('[visual] generateFreePhoto sendMsg error:', e.message));
  };

  // Подпись к посту
  try {
    const promptsFile = path.join(RESULTS_DIR, `${clientChatId}.free_prompts.json`);
    if (fs.existsSync(promptsFile)) {
      const p = JSON.parse(fs.readFileSync(promptsFile, 'utf8'));
      if (p.photoCaption) await sendMsg(`📝 Подпись к фото-посту:\n\n${p.photoCaption}`);
    }
  } catch {}

  // Само фото — через bot3SendPhotoFile (тот же код что и карусель/обложка)
  const photoKey = localPath && fs.existsSync(localPath) ? localPath : null;
  const photoSent = photoKey
    ? await bot3SendPhotoFile(adminChatId, photoKey, `📸 AI-фото готово`, {
        inline_keyboard: [[
          { text: '🔄 Переделать', callback_data: `regen_fs_ph_${clientChatId}` },
          { text: '✏️ Изм. текст', callback_data: `et_ph_0_${clientChatId}` },
        ]],
      })
    : false;

  if (!photoSent) {
    console.error(`[visual] generateFreePhoto: bot3SendPhotoFile failed, localPath=${localPath}, exists=${localPath ? fs.existsSync(localPath) : 'n/a'}`);
    // Fallback: URL через sendPhoto
    await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: adminChatId, photo: url, caption: '📸 AI-фото (URL fallback)',
        reply_markup: JSON.stringify({ inline_keyboard: [[
          { text: '🔄 Переделать', callback_data: `regen_fs_ph_${clientChatId}` },
          { text: '✏️ Изм. текст', callback_data: `et_ph_0_${clientChatId}` },
        ]] }),
      }),
    }).catch(e => console.error('[visual] generateFreePhoto URL fallback error:', e.message));
  }
}

// ── Regenerate one free-package image slot ─────────────────────────────────────
// slotCode: c0..c4 = carousel slides, cv = cover, ph = photo

const SLOT_CODE_MAP = {
  c0: 'carousel_0', c1: 'carousel_1', c2: 'carousel_2', c3: 'carousel_3', c4: 'carousel_4',
  c5: 'carousel_5', c6: 'carousel_6',
  cv: 'cover_0',
  ph: 'photo_0',
  st: 'story_0',
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
      } else if (slotKey === 'story_0') {
        prompt = (p.story || [])[0] || null;
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

  // Скачиваем локально — Kie.ai URL истекает через 24-72ч
  let localPath = null;
  try {
    const { default: fetchDl } = await import('node-fetch');
    const r = await fetchDl(url);
    if (r.ok) {
      const suffix = slotKey === 'photo_0' ? 'photo' : slotKey.replace('_', '');
      localPath = path.join(RESULTS_DIR, `${clientChatId}_free_${suffix}.jpg`);
      fs.writeFileSync(localPath, Buffer.from(await r.arrayBuffer()));
    }
  } catch (e) {
    console.error('[visual] regenFreeImage: download error', e.message);
  }

  const baseUrl = (process.env.VISUAL_BASE_URL || '').replace(/\/$/, '');

  // Обновляем результат на диске
  if (slotKey === 'photo_0') {
    const photoFile = path.join(RESULTS_DIR, `${clientChatId}.free_photo.json`);
    try {
      const existing = JSON.parse(fs.readFileSync(photoFile, 'utf8'));
      fs.writeFileSync(photoFile, JSON.stringify({ ...existing, url, localPath, generatedAt: Date.now() }, null, 2));
    } catch { fs.writeFileSync(photoFile, JSON.stringify({ url, localPath, prompt, generatedAt: Date.now() }, null, 2)); }
    const { updatePackPagePhoto } = require('./src/site_builder');
    updatePackPagePhoto(clientChatId, localPath || url);
  } else {
    const visualsFile = path.join(RESULTS_DIR, `${clientChatId}.free_visuals.json`);
    try {
      const existing = JSON.parse(fs.readFileSync(visualsFile, 'utf8'));
      existing[slotKey] = url;
      if (localPath) existing[`${slotKey}_local`] = localPath;
      fs.writeFileSync(visualsFile, JSON.stringify(existing, null, 2));
    } catch {}
    rebuildFreeVisuals(clientChatId);
  }

  // Отправляем новое изображение менеджеру — локальным файлом если есть
  if (adminChatId && botToken) {
    const label = slotKey === 'photo_0' ? 'AI-фото' : slotKey === 'cover_0' ? 'Обложка' : slotKey === 'story_0' ? 'Сторис' : `Слайд ${Number(slotKey.split('_')[1]) + 1}`;
    const FormData = (await import('form-data')).default;
    if (localPath && fs.existsSync(localPath)) {
      const form = new FormData();
      form.append('chat_id', adminChatId);
      form.append('photo', fs.createReadStream(localPath), { filename: 'photo.jpg' });
      form.append('caption', `✅ ${label} перегенерирован`);
      await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, { method: 'POST', body: form }).catch(() => {});
    } else {
      await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: adminChatId, photo: url, caption: `✅ ${label} перегенерирован` }),
      }).catch(() => {});
    }
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
        const batchRes  = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, { method: 'POST', body: form });
        const batchData = await batchRes.json().catch(() => ({}));
        if (!batchData.ok) {
          // Batch failed — fallback: send one by one
          console.error(`[sendSectionImages] sendMediaGroup failed: ${batchData.description || 'unknown'} — retrying one by one`);
          for (const x of validBatch) {
            if (x.lp && fs.existsSync(x.lp)) {
              const sent = await bot3SendPhotoFile(chatId, x.lp, `${itemLabel} ${x.idx + 1}`);
              if (!sent) console.error(`[sendSectionImages] single photo also failed: ${itemLabel} ${x.idx + 1}`);
            } else if (x.url) {
              const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, photo: x.url, caption: `${itemLabel} ${x.idx + 1}` }) });
              const rd = await r.json().catch(() => ({}));
              if (!rd.ok) console.error(`[sendSectionImages] single URL photo failed: ${itemLabel} ${x.idx + 1}: ${rd.description || 'unknown'}`);
            }
          }
        }
      } else if (validBatch.length === 1) {
        const x = validBatch[0];
        if (x.lp && fs.existsSync(x.lp)) {
          const sent = await bot3SendPhotoFile(chatId, x.lp, `${itemLabel} ${x.idx + 1}`);
          if (!sent) console.error(`[sendSectionImages] single photo failed: ${itemLabel} ${x.idx + 1}`);
        } else {
          const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, photo: x.url, caption: `${itemLabel} ${x.idx + 1}` }) });
          const rd = await r.json().catch(() => ({}));
          if (!rd.ok) console.error(`[sendSectionImages] single URL photo failed: ${itemLabel} ${x.idx + 1}: ${rd.description || 'unknown'}`);
        }
      }
    } else {
      // No overlays — send as media group (URLs)
      const validBatch = batch.filter(Boolean);
      if (validBatch.length > 1) {
        const batchRes  = await fetch(`https://api.telegram.org/bot${token}/sendMediaGroup`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: chatId,
            media: validBatch.map((url, j) => ({ type: 'photo', media: url, caption: `${itemLabel} ${i + j + 1}` })),
          }),
        });
        const batchData = await batchRes.json().catch(() => ({}));
        if (!batchData.ok) {
          console.error(`[sendSectionImages] URL sendMediaGroup failed: ${batchData.description || 'unknown'} — retrying one by one`);
          for (let j = 0; j < validBatch.length; j++) {
            const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: chatId, photo: validBatch[j], caption: `${itemLabel} ${i + j + 1}` }) });
            const rd = await r.json().catch(() => ({}));
            if (!rd.ok) console.error(`[sendSectionImages] single URL retry failed: ${itemLabel} ${i + j + 1}: ${rd.description || 'unknown'}`);
          }
        }
      } else if (validBatch.length === 1) {
        const r = await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ chat_id: chatId, photo: validBatch[0], caption: `${itemLabel} ${i + 1}` }),
        });
        const rd = await r.json().catch(() => ({}));
        if (!rd.ok) console.error(`[sendSectionImages] single URL photo failed: ${itemLabel} ${i + 1}: ${rd.description || 'unknown'}`);
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

async function notifyBot3SectionHighlights(clientChatId, clientName, highlights, localPaths = []) {
  await sendSectionImages(clientChatId, clientName, 'hl', '🔵 Highlights', highlights, 'Highlight', localPaths);
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
    ph: { prompts: p.photoPrompts,      ratio: '1:1',  key: 'photos',         label: 'Фото' },
    ca: { prompts: p.carouselPrompts,   ratio: '1:1',  key: 'carouselSlides', label: 'Слайд' },
    co: { prompts: p.coverPrompts,      ratio: '9:16', key: 'covers',         label: 'Обложка' },
    st: { prompts: p.storyPrompts,      ratio: '9:16', key: 'stories',        label: 'Story' },
    hl: { prompts: p.highlightPrompts,  ratio: '1:1',  key: 'highlights',     label: 'Highlight' },
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
  const localKeyMap = { ph: 'photosLocalPaths', ca: 'carouselSlidesLocalPaths', co: 'coversLocalPaths', st: 'storiesLocalPaths', hl: 'highlightsLocalPaths' };
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

// Извлекает тексты всех каруселей с правильным порядком (КАРУСЕЛЬ 1→N, КАДР 1→7 каждая)
// extractSlideTexts не подходит — перезаписывает индексы при повторяющемся КАДР 1-7
function extractAllCarouselTexts(carouselScripts) {
  const result = [];
  const parts  = (carouselScripts || '').split(/(?:^|\n)(?:КАРУСЕЛЬ|CAROUSEL)\s+\d+[:\s]/im);
  for (let c = 1; c < parts.length; c++) {
    const slideMap = {};
    for (const line of parts[c].split('\n')) {
      // Формат "Слайд N: текст"
      const slm = line.match(/^Слайд\s+(\d+)(?:\s*\([^)]*\))?:\s*(.+)/i);
      if (slm && !line.toLowerCase().includes('изображение')) {
        slideMap[Number(slm[1])] = slm[2].trim().slice(0, 100); continue;
      }
      // Формат "КАДР N:\nТекст поверх фото: текст"
      const km = line.match(/^КАДР\s+(\d+)/i);
      if (km) { slideMap._cur = Number(km[1]); continue; }
      const tm = line.match(/^Текст поверх фото:\s*(.+)/i);
      if (tm && slideMap._cur) slideMap[slideMap._cur] = tm[1].trim().slice(0, 100);
    }
    const max = Math.max(0, ...Object.keys(slideMap).filter(k => k !== '_cur').map(Number));
    for (let s = 1; s <= max; s++) result.push(slideMap[s] || '');
  }
  // Fallback: если нет КАРУСЕЛЬ-разделителей — extractSlideTexts для одной карусели
  if (!result.length) return extractSlideTexts(carouselScripts || '', 'carousel');
  return result;
}

// ── Main generation ────────────────────────────────────────────────────────────

async function runVisualGeneration(clientChatId, opts = {}) {
  const isResume = !!opts.isResume;
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

  const photoPrompts    = getPrompts(pkg.photoScripts,     'Промпт для AI-генерации', maxPerSection || 4);
  const photoCaptions   = getPrompts(pkg.photoScripts,     'Подпись к посту',         maxPerSection || 4);
  const storyPrompts    = getPrompts(pkg.storiesScripts,   'Промпт для AI-генерации', maxPerSection || 8);
  const coverPrompts    = getPrompts(pkg.covers,           'Промпт для AI',           maxPerSection ? 1 : maxCovers);
  const maxHighlights   = maxPerSection ? 0 : (pkg.highlightsBonus ? (isStandard ? 4 : isProfi ? 8 : 0) : 0);
  const highlightPrompts = maxHighlights > 0 ? getPrompts(pkg.highlightCovers || '', 'Промпт для AI', maxHighlights) : [];

  // Подписи к постам для каруселей (одна на каждую карусель)
  const carouselPostCaptions = (() => {
    if (!pkg.carouselScripts) return [];
    const parts = pkg.carouselScripts.split(/(?=(?:^|\n)КАРУСЕЛЬ\s+\d+:)/im);
    return parts
      .filter(p => p.trim().length > 20)
      .map(p => { const m = p.match(/Подпись к посту:\s*([^\n]+)/i); return m ? m[1].trim() : ''; })
      .slice(0, carouselGroups.length);
  })();

  const prompts = { photoPrompts, photoCaptions, carouselPostCaptions, storyPrompts, carouselPrompts, coverPrompts, carouselGroups, highlightPrompts };

  // Extract overlay texts — sliced to match prompt counts
  const photoTexts = extractSlideTexts(pkg.photoScripts   || '', 'photos').slice(0, photoPrompts.length);
  const storyTexts = extractSlideTexts(pkg.storiesScripts || '', 'stories').slice(0, storyPrompts.length);
  const coverTexts = extractSlideTexts(pkg.covers         || '', 'covers').slice(0, coverPrompts.length);
  const carouselTexts = extractAllCarouselTexts(pkg.carouselScripts || '').slice(0, carouselSlideCount);

  console.log(`[visual] Карусели: ${carouselGroups.length} каруселей, слайды: [${carouselGroups.join(',')}]`);

  console.log(`[visual] Промпты: фото=${photoPrompts.length} stories=${storyPrompts.length} карусели=${carouselPrompts.length} обложки=${coverPrompts.length} хайлайты=${highlightPrompts.length}`);

  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch {}

  // При явном вызове /generate (не resume после рестарта) — сбрасываем notified
  // чтобы существующие результаты ПЕРЕОТПРАВИЛИСЬ в Bot3, а не молча пропускались
  const notified = isResume ? (existing?.notifiedSections || {}) : {};

  // Shared results — updated by each section as it completes (JS single-thread = no race)
  // Если quality test — обрезаем существующие результаты до maxPerSection
  // чтобы не отправить полный пакет из кэша при повторном запуске
  const truncate = (arr, max) => max ? (arr || []).slice(0, max) : (arr || []);
  const allResults = {
    photos:         truncate(existing?.results?.photos,         maxPerSection),
    stories:        truncate(existing?.results?.stories,        maxPerSection),
    carouselSlides: truncate(existing?.results?.carouselSlides, maxPerSection ? carouselSlideCount : undefined),
    covers:         truncate(existing?.results?.covers,         maxPerSection),
    highlights:     existing?.results?.highlights     || [],
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
    // Apply text overlay on generated images (or save raw if no text — prevents URL expiry)
    const localPaths = await applyAndSaveOverlays(results, overlayTexts, clientChatId, key, overlayPos);
    allResults[`${key}LocalPaths`] = localPaths;
    save();
    if (!notified[key] && results.some(Boolean)) {
      await notifyFn(clientChatId, pkg.clientName, results, localPaths);
      notified[key] = true;
      save();
    }
  }

  await Promise.all([
    runImageSection('photos',         photoPrompts,      p => startImage(p, '1:1'),  'Фото постов',
      (id, name, photos, lp) => notifyBot3SectionPhotos(id, name, photos, prompts.photoCaptions, lp),
      photoTexts, 'bottom'),
    runImageSection('carouselSlides', carouselPrompts,   p => startImage(p, '1:1'),  'Карусели',
      (id, name, slides, lp) => notifyBot3SectionCarousels(id, name, slides, carouselGroups, lp),
      carouselTexts, 'bottom'),
    runImageSection('covers',         coverPrompts,      p => startImage(p, '9:16'), 'Обложки',
      (id, name, covers, lp) => notifyBot3SectionCovers(id, name, covers, lp),
      coverTexts, 'bottom'),
    runImageSection('stories',        storyPrompts,      p => startImage(p, '9:16'), 'Stories',
      (id, name, stories, lp) => notifyBot3SectionStories(id, name, stories, lp),
      storyTexts, 'bottom'),
    runImageSection('highlights',     highlightPrompts,  p => startImage(p, '1:1'),  'Highlights',
      (id, name, highlights, lp) => notifyBot3SectionHighlights(id, name, highlights, lp)),
  ]);

  // ── Фаза 2: видео по одному, уведомление после каждого ────────────────────
  // Если явно передан maxVideos:0 (флаг nv) — помечаем в results.json чтобы
  // resumePendingVisualJobs не запускал Veo3 при следующем рестарте Railway
  if (videoCount === 0 && opts.maxVideos === 0) {
    try {
      const rp = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
      const cur = fs.existsSync(rp) ? JSON.parse(fs.readFileSync(rp, 'utf8')) : {};
      cur.videosSkipped = true;
      fs.writeFileSync(rp, JSON.stringify(cur, null, 2));
      // Помечаем visual.json — resume не будет запускать Veo3 при рестарте
      const vp = path.join(VISUAL_DIR, `${clientChatId}.visual.json`);
      if (fs.existsSync(vp)) {
        const vd = JSON.parse(fs.readFileSync(vp, 'utf8'));
        vd.deliveredAt = Date.now();
        fs.writeFileSync(vp, JSON.stringify(vd, null, 2));
      }
      console.log(`[visual] ${clientChatId}: nv флаг — помечено deliveredAt, resume не запустится`);
    } catch {}
    return;
  }

  if (isProfi || isStandard) {
    const videoScripts = splitVideoScripts(pkg.videoScripts).slice(0, videoCount);
    console.log(`[visual] Генерирую ${videoScripts.length} видео...`);

    // При автовозобновлении после рестарта сервера — пропускаем одобрение
    // (оно уже было дано до прерывания). Одобрение запрашивается только при явном /run_visual
    let approvedVideoScripts = videoScripts;
    if (!isResume) {
      await notifyBot3VideoScriptsPreview(clientChatId, pkg.clientName, videoScripts);
      approvedVideoScripts = await waitForVideoApproval(clientChatId, videoScripts);
    }

    // Штамп генерации: защита от старой генерации продолжающейся после /reset_client
    // Файл удаляется reset_client → проверка перед каждым видео → aborting
    const stampPath = path.join(RESULTS_DIR, `${clientChatId}.gen_stamp.json`);
    const stampValue = `${Date.now()}`;
    fs.writeFileSync(stampPath, JSON.stringify({ stamp: stampValue }));

    for (let i = 0; i < approvedVideoScripts.length; i++) {
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
        const existing = allResults.videoData[i];
        const label = isResume ? 'resume — переотправляем' : 'уже есть — отправляем менеджеру';
        console.log(`[visual] Видео ${i + 1} ${label}`);
        if (existing.fromLibrary) {
          await notifyBot3LibraryVideo(clientChatId, i, videoScripts.length, existing.localPath, existing.subtitleText, { matchCount: '?' });
        } else {
          await notifyBot3SingleVideo(clientChatId, i, videoScripts.length, existing.localPath, existing.subtitleText, null);
        }
        continue;
      }

      const videoScript = approvedVideoScripts[i] || videoScripts[i];

      // При resume не проверяем библиотеку — сразу Veo3 (тихое восстановление)
      // При свежей генерации — сначала библиотека, Veo3 только если нет совпадений
      let result;
      try {
        let usedLibrary = false;
        if (!isResume) {
          const libScenes = await splitScriptToScenes(videoScript).catch(() => []);
          const libPrompt = libScenes[0] || videoScript.slice(0, 300);
          const libTags   = await extractVideoTags(libPrompt).catch(() => []);
          const libMatch  = searchVideoLibrary(libTags, clientChatId, 1)[0];
          if (libMatch && libMatch.matchCount >= 2) {
            result = await applyLibraryVideo(libMatch, videoScript, i, clientChatId, videoCTA);
            allResults.videoData[i] = result;
            save();
            await notifyBot3LibraryVideo(clientChatId, i, videoScripts.length, result?.localPath, result?.subtitleText, libMatch);
            usedLibrary = true;
          }
        }
        if (!usedLibrary) {
          result = await generateOneVideo(videoScript, i, clientChatId, videoCTA);
          allResults.videoData[i] = result;
          save();
          await notifyBot3SingleVideo(clientChatId, i, videoScripts.length, result?.localPath, result?.subtitleText, null);
        }
      } catch (e) {
        console.error(`[visual] Видео ${i + 1} ошибка:`, e.message);
        result = await generateOneVideo(videoScript, i, clientChatId, videoCTA);
        allResults.videoData[i] = result;
        save();
        await notifyBot3SingleVideo(clientChatId, i, videoScripts.length, result?.localPath, result?.subtitleText, null);
      }
    }
  }

  // ── Итоговое уведомление ────────────────────────────────────────────────────
  save();
  console.log(`[visual] Генерация завершена: ${pkg.clientName}`);
  await notifyBot3Final(clientChatId, pkg.clientName, pkg.packageKey, allResults);

  // Помечаем visual.json как выполненный — resume при рестарте Railway пропустит клиента
  try {
    const pkgData = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
    pkgData.deliveredAt = Date.now();
    fs.writeFileSync(pkgPath, JSON.stringify(pkgData, null, 2));
    console.log(`[visual] ${clientChatId}: visual.json помечен deliveredAt`);
  } catch {}
}

// Split videoScripts text into individual video scripts (keeps "ВИДЕО N:" header in each part)
function splitVideoScripts(text) {
  const parts = text.split(/(?=(?:^|\n)ВИДЕО\s+\d+:)/im);
  return parts.map(s => s.trim()).filter(s => s.length > 50).slice(0, 8);
}

// ── Bot3 notifications ─────────────────────────────────────────────────────────

async function bot3Send(chatId, text, replyMarkup) {
  const token = process.env.TELEGRAM_BOT3_TOKEN;
  if (!token || !chatId) return false;
  const { default: fetch } = await import('node-fetch');
  const body = { chat_id: chatId, parse_mode: 'Markdown', text };
  if (replyMarkup) body.reply_markup = replyMarkup;
  const ctrl = new AbortController();
  const tid  = setTimeout(() => ctrl.abort(), 10000); // 10s timeout on send
  let res;
  try {
    res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
      signal:  ctrl.signal,
    });
  } catch (e) {
    clearTimeout(tid);
    console.error(`[bot3Send] fetch error: ${e.message}`);
    return false;
  }
  clearTimeout(tid);
  const data = await Promise.race([
    res.json().catch(() => ({})),
    new Promise(r => setTimeout(() => r({}), 5000))
  ]);
  if (!data.ok) console.error(`[bot3Send] Telegram error: ${data.description || 'unknown'} | text: ${String(text).slice(0, 80)}`);
  return !!data.ok;
}

async function bot3SendVideo(chatId, filePath) {
  const token = process.env.TELEGRAM_BOT3_TOKEN;
  if (!token || !chatId || !filePath || !fs.existsSync(filePath)) return false;
  const { default: fetch } = await import('node-fetch');
  const FormData = (await import('form-data')).default;

  // Helper: fetch with 90-second AbortController timeout
  const fetchWithTimeout = async (url, opts, timeoutMs = 90000) => {
    const ctrl = new AbortController();
    const tid  = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(tid);
    }
  };

  // Try sendVideo first (90s timeout — large files take time)
  const form = new FormData();
  form.append('chat_id', String(chatId));
  form.append('video', fs.createReadStream(filePath));
  let res, data;
  try {
    res  = await fetchWithTimeout(`https://api.telegram.org/bot${token}/sendVideo`, { method: 'POST', body: form }, 90000);
    data = await Promise.race([res.json().catch(() => ({})), new Promise(r => setTimeout(() => r({}), 10000))]);
  } catch (e) {
    console.error(`[bot3SendVideo] sendVideo fetch error: ${e.message}`);
    data = {};
  }
  if (data.ok) return true;

  // Telegram rejected (likely file too large for sendVideo) — fallback to sendDocument
  const sizeMb = Math.round(fs.statSync(filePath).size / 1024 / 1024);
  console.error(`[bot3SendVideo] sendVideo failed (${sizeMb}MB): ${data.description || 'unknown'} — trying sendDocument`);
  const form2 = new FormData();
  form2.append('chat_id', String(chatId));
  form2.append('document', fs.createReadStream(filePath), { filename: path.basename(filePath) });
  let res2, data2;
  try {
    res2  = await fetchWithTimeout(`https://api.telegram.org/bot${token}/sendDocument`, { method: 'POST', body: form2 }, 90000);
    data2 = await Promise.race([res2.json().catch(() => ({})), new Promise(r => setTimeout(() => r({}), 10000))]);
  } catch (e) {
    console.error(`[bot3SendVideo] sendDocument fetch error: ${e.message}`);
    data2 = {};
  }
  if (data2.ok) return true;

  console.error(`[bot3SendVideo] sendDocument also failed: ${data2.description || 'unknown'}`);
  return false;
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

  // Сохраняем сценарии — waitForVideoApproval будет ждать одобрения
  const pendingPath = path.join(RESULTS_DIR, `${clientChatId}.video_scripts_pending.json`);
  fs.writeFileSync(pendingPath, JSON.stringify({ scripts: videoScripts, timestamp: Date.now() }));

  // Отправляем через прямой fetch без parse_mode — иначе Telegram может отклонить Markdown
  // и вернуть сообщение без кнопок (ошибку bot3Send не логирует)
  const { default: fetch } = await import('node-fetch');
  const msg = `🎬 Сценарии видео — ${name}\nЧто будет в каждом ролике:\n\n` +
    videoParts.join('\n\n') +
    `\n\nПроверьте сценарии и нажмите кнопку:`;
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id:      chatId,
      text:         msg,
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Запустить генерацию', callback_data: `va_ok_${clientChatId}` },
          { text: '✏️ Исправить сценарии',  callback_data: `va_edit_${clientChatId}` },
        ]],
      },
    }),
  }).catch(e => console.error('[visual] notifyBot3VideoScriptsPreview fetch error:', e.message));
}

// Ждёт одобрения менеджером видео-сценариев (polling pending/approved файлов)
// Возвращает актуальные сценарии (могут быть переписаны после фидбека)
// Ждёт бесконечно — генерация стартует ТОЛЬКО после нажатия ✅ в Bot3
async function waitForVideoApproval(clientChatId, fallbackScripts) {
  const pendingPath  = path.join(RESULTS_DIR, `${clientChatId}.video_scripts_pending.json`);
  const approvedPath = path.join(RESULTS_DIR, `${clientChatId}.video_scripts_approved.json`);
  const chatId       = process.env.BOT3_MANAGER_CHAT_ID;
  const startedAt    = Date.now();
  const REMINDER_MS  = 24 * 60 * 60 * 1000; // 24 часа
  let reminded       = false;

  // Удаляем старый файл одобрения — мог остаться от предыдущего прогона
  // (Railway restart между нажатием ✅ менеджером и чтением файла visual.js)
  if (fs.existsSync(approvedPath)) {
    fs.unlinkSync(approvedPath);
    console.log(`[visual] Старый approved-файл очищен для ${clientChatId} — ждём нового одобрения`);
  }

  const heartbeatPath = path.join(RESULTS_DIR, `${clientChatId}.veo_heartbeat.json`);

  while (true) {
    // Heartbeat — generate_videos_from_pending проверяет этот файл чтобы не дублировать генерацию
    try { fs.writeFileSync(heartbeatPath, JSON.stringify({ ts: Date.now() })); } catch {}

    if (fs.existsSync(approvedPath)) {
      try { fs.unlinkSync(heartbeatPath); } catch {}
      try {
        const pending = JSON.parse(fs.readFileSync(pendingPath, 'utf8'));
        try { fs.unlinkSync(approvedPath); } catch {}
        return pending.scripts && pending.scripts.length ? pending.scripts : fallbackScripts;
      } catch {
        try { fs.unlinkSync(approvedPath); } catch {}
        return fallbackScripts;
      }
    }
    // Напоминание через 24ч если менеджер не нажал кнопку
    if (!reminded && Date.now() - startedAt >= REMINDER_MS) {
      reminded = true;
      await bot3Send(chatId,
        `⚠️ Сценарии видео для клиента ${clientChatId} ожидают одобрения уже 24 часа.\n\nПрокрутите выше — там сообщение с кнопками ✅ Запустить / ✏️ Исправить.`
      );
    }
    await new Promise(r => setTimeout(r, 5000));
  }
}

async function notifyBot3SingleVideo(clientChatId, videoIndex, totalVideos, localPath, subtitleText, libraryMatches) {
  const chatId = process.env.BOT3_MANAGER_CHAT_ID;
  const token  = process.env.TELEGRAM_BOT3_TOKEN;
  if (!chatId || !token) return;
  const { default: fetch } = await import('node-fetch');

  if (localPath && fs.existsSync(localPath)) {
    let clientLabel = `(${clientChatId})`;
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(VISUAL_DIR, `${clientChatId}.visual.json`), 'utf8'));
      if (pkg.clientName && pkg.clientName !== '—') clientLabel = pkg.clientName;
    } catch {}
    await bot3Send(chatId, `🎬 Видео ${videoIndex + 1}/${totalVideos} готово — ${clientLabel}:`);
    const videoSent = await bot3SendVideo(chatId, localPath).catch(e => {
      console.error(`[bot3SendVideo] exception:`, e.message); return false;
    });
    if (!videoSent) {
      await bot3Send(chatId, `⚠️ Файл видео не удалось отправить (возможно, слишком большой).\nПовторить: /resend_video ${clientChatId} ${videoIndex}`);
    }

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

    // Кнопки управления видео — отдельно по каждому полю
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:      chatId,
        text:         `🎬 Что сделать с видео ${videoIndex + 1}?`,
        reply_markup: {
          inline_keyboard: [
            [
              { text: `✏️ Изменить хук`,  callback_data: `et_hook_${videoIndex}_${clientChatId}` },
              { text: `✏️ Изменить тему`, callback_data: `et_theme_${videoIndex}_${clientChatId}` },
              { text: `✏️ Изменить CTA`,  callback_data: `et_cta_${videoIndex}_${clientChatId}` },
            ],
            [
              { text: `✏️ Изменить всё`,   callback_data: `et_video_${videoIndex}_${clientChatId}` },
              { text: `🔄 Переснять сцену`, callback_data: `rscene_${videoIndex}_${clientChatId}` },
            ],
            [
              { text: `🎬 Версия без текста`, callback_data: `et_notext_${videoIndex}_${clientChatId}` },
            ],
          ],
        },
      }),
    }).catch(() => {});
  } else {
    await bot3Send(chatId, `⚠️ Видео ${videoIndex + 1}/${totalVideos} — не удалось собрать. Перегенерировать: /regen_video_${clientChatId}_${videoIndex}`);
  }
}

// Уведомление: видео из библиотеки с кнопкой "Сгенерировать новое"
async function notifyBot3LibraryVideo(clientChatId, videoIndex, totalVideos, localPath, subtitleText, libMatch) {
  const chatId = process.env.BOT3_MANAGER_CHAT_ID;
  const token  = process.env.TELEGRAM_BOT3_TOKEN;
  if (!chatId || !token) return;

  if (localPath && fs.existsSync(localPath)) {
    await bot3Send(chatId, `📚 Видео ${videoIndex + 1}/${totalVideos} — из библиотеки (совпадение: ${libMatch.matchCount} тегов, Veo3 не запускался):`);
    await bot3SendVideo(chatId, localPath).catch(() => {});
    const { default: fetch } = await import('node-fetch');
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:      chatId,
        text:         `🎬 Что сделать с видео ${videoIndex + 1}?`,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '✏️ Изменить хук',  callback_data: `et_hook_${videoIndex}_${clientChatId}` },
              { text: '✏️ Изменить тему', callback_data: `et_theme_${videoIndex}_${clientChatId}` },
              { text: '✏️ Изменить CTA',  callback_data: `et_cta_${videoIndex}_${clientChatId}` },
            ],
            [
              { text: '✏️ Изменить всё',    callback_data: `et_video_${videoIndex}_${clientChatId}` },
              { text: '🆕 Сгенерировать новое', callback_data: `regen_lib_${videoIndex}_${clientChatId}` },
            ],
            [
              { text: '🎬 Версия без текста', callback_data: `et_notext_${videoIndex}_${clientChatId}` },
            ],
          ],
        },
      }),
    }).catch(() => {});
  } else {
    await bot3Send(chatId, `⚠️ Видео ${videoIndex + 1}: не удалось взять из библиотеки — запускаю Veo3...`);
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
    `✅ Генерация завершена — ${clientName}\n\n` +
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
