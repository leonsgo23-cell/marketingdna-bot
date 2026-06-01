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
const LIBRARY_DIR   = path.join(BASE_DIR, 'video_library');
const SLIDES_PER_CAROUSEL_FALLBACK = 7;

for (const d of [VISUAL_DIR, RESULTS_DIR, TRIGGERS_DIR, TMP_DIR, PENDING_TASKS, LIBRARY_DIR]) {
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

  const resultFile = path.join(RESULTS_DIR, `${meta.clientId}.${meta.type}.json`);
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch {}

  if (meta.type === 'free_photo') {
    fs.writeFileSync(resultFile, JSON.stringify({ url, generatedAt: Date.now() }, null, 2));
    console.log(`[kie] free_photo saved: ${url.slice(0, 80)}`);
  } else if (meta.type === 'free_visuals') {
    const slot = meta.slot; // 'carousel_0'..'carousel_4' or 'cover_0'
    existing[slot] = url;
    fs.writeFileSync(resultFile, JSON.stringify(existing, null, 2));
    console.log(`[kie] free_visuals[${slot}] saved: ${url.slice(0, 80)}`);
    // Если все слоты заполнены — пересобираем итоговый free_visuals.json
    rebuildFreeVisuals(meta.clientId);
  }
}

function rebuildFreeVisuals(clientId) {
  const resultFile = path.join(RESULTS_DIR, `${clientId}.free_visuals.json`);
  let data = {};
  try { data = JSON.parse(fs.readFileSync(resultFile, 'utf8')); } catch { return; }

  // Merge: top-level slot keys written by pollAndSave + carouselUrls array from previous rebuild
  const prevCarousel = Array.isArray(data.carouselUrls) ? data.carouselUrls : [];
  const prevCover    = Array.isArray(data.coverUrls)    ? data.coverUrls    : [];
  const carouselUrls = [0,1,2,3,4].map(i => data[`carousel_${i}`] || prevCarousel[i] || null);
  const coverUrls    = [data['cover_0'] || prevCover[0] || null];

  const done = carouselUrls.filter(Boolean).length + coverUrls.filter(Boolean).length;
  const photoReady = fs.existsSync(path.join(RESULTS_DIR, `${clientId}.free_photo.json`));
  console.log(`[kie] rebuildFreeVisuals: ${done}/6 карусель+обложка, фото=${photoReady ? '✅' : '⏳'}`);

  fs.writeFileSync(resultFile, JSON.stringify({ carouselUrls, coverUrls, generatedAt: Date.now() }, null, 2));

  if (done === 6) {
    if (photoReady) {
      notifyFreeVisualsReady(clientId, carouselUrls, coverUrls).catch(() => {});
    } else {
      // Карусель+обложка готовы, ждём фото — сохраняем флаг
      fs.writeFileSync(path.join(RESULTS_DIR, `${clientId}.visuals_6done`), '1');
      console.log(`[kie] карусель+обложка готовы, ждём AI-фото для ${clientId}`);
    }
  }
}

async function notifyFreeVisualsReady(clientId, carouselUrls, coverUrls) {
  const adminChatId = process.env.BOT3_MANAGER_CHAT_ID;
  const botToken    = process.env.TELEGRAM_BOT3_TOKEN;
  if (!adminChatId || !botToken) return;

  // Guard against double-notification (e.g. resumed tasks + generateFreeVisuals)
  const flagFile = path.join(RESULTS_DIR, `${clientId}.free_visuals_notified`);
  if (fs.existsSync(flagFile)) return;
  fs.writeFileSync(flagFile, String(Date.now()));

  // Встраиваем изображения в HTML-страницу клиента
  try {
    const { updatePackPageCover, updatePackPageCarousel } = require('./src/site_builder');
    if (coverUrls[0]) updatePackPageCover(clientId, coverUrls[0]);
    updatePackPageCarousel(clientId, carouselUrls);
  } catch (e) {
    console.error('[visual] updatePackPage error:', e.message);
  }

  const { default: fetch } = await import('node-fetch');

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: adminChatId,
      text: `🎠 Карусель + обложка для бесплатного пакета готовы (chatId: ${clientId})\n\nКарусель: ${carouselUrls.filter(Boolean).length}/5 слайдов\nОбложка: ${coverUrls.filter(Boolean).length}/1`,
    }),
  }).catch(() => {});

  const validCarousel = carouselUrls.filter(Boolean);
  for (let i = 0; i < validCarousel.length; i += 10) {
    const group = validCarousel.slice(i, i + 10);
    if (group.length > 1) {
      await fetch(`https://api.telegram.org/bot${botToken}/sendMediaGroup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          chat_id: adminChatId,
          media: group.map((url, idx) => ({ type: 'photo', media: url, caption: idx === 0 ? `Карусель — слайды 1-${group.length}` : undefined })),
        }),
      }).catch(() => {});
    } else {
      await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: adminChatId, photo: group[0], caption: 'Карусель — слайд 1' }),
      }).catch(() => {});
    }
  }

  if (coverUrls[0]) {
    await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: adminChatId, photo: coverUrls[0], caption: '🖼 Обложка (thumbnail)' }),
    }).catch(() => {});
  }

  const carouselCount = carouselUrls.filter(Boolean).length;
  const coverCount    = coverUrls.filter(Boolean).length;
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: adminChatId,
      text: `✅ Все изображения готовы!\n\nКарусель: ${carouselCount}/5 слайдов\nОбложка: ${coverCount}/1\n\nПерегенерировать отдельно — или отправляйте клиенту.`,
      reply_markup: JSON.stringify({
        inline_keyboard: [
          [
            { text: 'Слайд 1', callback_data: `regen_fs_c0_${clientId}` },
            { text: 'Слайд 2', callback_data: `regen_fs_c1_${clientId}` },
            { text: 'Слайд 3', callback_data: `regen_fs_c2_${clientId}` },
            { text: 'Слайд 4', callback_data: `regen_fs_c3_${clientId}` },
            { text: 'Слайд 5', callback_data: `regen_fs_c4_${clientId}` },
          ],
          [
            { text: '🖼 Обложка',  callback_data: `regen_fs_cv_${clientId}` },
            { text: '📸 AI-фото',  callback_data: `regen_fs_ph_${clientId}` },
          ],
          [{ text: '📤 Отправить клиенту', callback_data: `send_free_${clientId}` }],
          [{ text: '🔄 Перегенерировать всё', callback_data: `retry_free_${clientId}` }],
        ]
      }),
    }),
  }).catch(() => {});
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

// Раздаём HTML-страницы бесплатного пакета
app.get('/pack/:clientId', (req, res) => {
  const htmlFile = path.join(PACK_PAGES_DIR, `${req.params.clientId}.html`);
  if (!fs.existsSync(htmlFile)) return res.status(404).send('Страница не найдена');
  res.sendFile(htmlFile);
});

app.post('/generate', (req, res) => {
  const { clientChatId, maxVideos } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  runVisualGeneration(String(clientChatId), { maxVideos }).catch(e =>
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
  const { clientChatId, carouselScript, coverExample } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  generateFreeVisuals(String(clientChatId), carouselScript || '', coverExample || '').catch(e =>
    console.error('[visual] generate_free_visuals error', e.message)
  );
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
    await bot3Send(clientChatId, `❌ Нет кэша результатов для ${clientChatId}. Сначала запусти /test_paid.`);
    return;
  }
  const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const results = data.results || data;

  // Берём первый доступный URL из любой секции
  const allUrls = [
    ...(results.photos || []),
    ...(results.carouselSlides || []),
    ...(results.stories || []),
    ...(results.covers || []),
  ].filter(Boolean);

  if (allUrls.length === 0) {
    await bot3Send(clientChatId, `❌ В кэше нет URL изображений для ${clientChatId}.`);
    return;
  }

  const { createCanvas, loadImage } = require('@napi-rs/canvas');
  const sharp = require('sharp');
  ensureFont();

  // Берём только первый URL для многосторонней диагностики
  const url = allUrls[0];
  const resp = await fetch(url);
  const buf = await resp.buffer();

  await bot3Send(clientChatId, `📊 Диагностика overlay\nURL: ${url.slice(0, 60)}...\nBuffer: ${buf.length} bytes`);

  // Гипотеза 1: loadImage работает?
  let img, imgW = 0, imgH = 0;
  try {
    img = await loadImage(buf);
    imgW = img.width; imgH = img.height;
    await bot3Send(clientChatId, `H1 loadImage: ✅ ${imgW}x${imgH}`);
  } catch (e) {
    await bot3Send(clientChatId, `H1 loadImage: ❌ ${e.message}`);
    img = null;
  }

  // Гипотеза 2: canvas.toBuffer vs canvas.encode
  if (img) {
    try {
      const c = createCanvas(imgW, imgH);
      const ctx = c.getContext('2d');
      ctx.drawImage(img, 0, 0);
      // Рисуем яркую красную полосу внизу — проверяем что drawImage+fillRect работают
      ctx.fillStyle = 'rgba(255,0,0,0.8)';
      ctx.fillRect(0, imgH - 80, imgW, 80);
      ctx.fillStyle = 'white';
      const ff = _fontRegistered ? 'OverlayFont' : 'sans-serif';
      ctx.font = `bold ${Math.floor(imgW / 18)}px "${ff}"`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillText('ТЕСТ ТЕКСТА', imgW / 2, imgH - 70);

      // H2a: toBuffer
      const outA = path.join(RESULTS_DIR, `${clientChatId}_diag_tobuffer.jpg`);
      const bufA = c.toBuffer('image/jpeg', 90);
      fs.writeFileSync(outA, bufA);
      await bot3SendPhotoFile(clientChatId, outA, `H2a toBuffer (${bufA.length}b) — видна красная полоса?`);

      // H2b: encode (async)
      const outB = path.join(RESULTS_DIR, `${clientChatId}_diag_encode.jpg`);
      const bufB = await c.encode('jpeg');
      fs.writeFileSync(outB, bufB);
      await bot3SendPhotoFile(clientChatId, outB, `H2b encode() (${bufB.length}b) — видна красная полоса?`);
    } catch (e) {
      await bot3Send(clientChatId, `H2 draw+save: ❌ ${e.message}`);
    }
  }

  // Гипотеза 3: sharp metadata — может изображение необычного формата?
  try {
    const meta = await sharp(buf).metadata();
    await bot3Send(clientChatId, `H3 sharp meta: format=${meta.format} ${meta.width}x${meta.height} channels=${meta.channels}`);
  } catch (e) {
    await bot3Send(clientChatId, `H3 sharp meta: ❌ ${e.message}`);
  }

  // Гипотеза 4: может buf это не прямой JPEG а webp/png?
  // Проверяем первые байты (magic bytes)
  const magic = buf.slice(0, 4).toString('hex');
  const fmt = magic.startsWith('ffd8ff') ? 'JPEG' : magic.startsWith('89504e47') ? 'PNG' : magic.startsWith('52494646') ? 'WEBP' : `unknown(${magic})`;
  await bot3Send(clientChatId, `H4 magic bytes: ${fmt}`);
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
  const { clientChatId, section, index } = req.body;
  if (!clientChatId || !section || index === undefined) return res.status(400).json({ error: 'missing params' });
  res.json({ ok: true });
  regenItem(String(clientChatId), section, Number(index)).catch(e =>
    console.error('[visual] regen_item error', e.message)
  );
});

app.get('/library_stats', (req, res) => {
  res.json(libraryStats());
});

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

async function startImage(prompt, size = '1:1') {
  const d = await kiePost('/gpt4o-image/generate', { prompt, size: kieSize(size) });
  return d?.data?.taskId || d?.taskId || null;
}

async function startVideo(prompt) {
  // Always enforce vertical format and no on-screen text
  const enforcedPrompt = `${prompt}. Vertical 9:16 portrait format. No text, no words, no watermarks inside the video. People only as background silhouettes or hands if needed.`;
  const d = await kiePost('/veo/generate', {
    prompt:         enforcedPrompt,
    model:          'veo3_fast',
    generationType: 'TEXT_2_VIDEO',
    aspectRatio:    '9:16',
    duration:       8,
  });
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
      const count = (parts[i].match(/(?:^|\n)\s*(?:Изображение слайда|slide image)/gim) || []).length;
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

// ── Text overlay on images via @napi-rs/canvas (Skia, no fontconfig needed) ───

let _fontRegistered = false;
function ensureFont() {
  if (_fontRegistered) return;
  try {
    const { GlobalFonts } = require('@napi-rs/canvas');
    const fontPath = path.join(__dirname, 'assets', 'Inter-Bold.ttf');
    if (fs.existsSync(fontPath)) {
      GlobalFonts.registerFromPath(fontPath, 'OverlayFont');
      _fontRegistered = true;
      console.log('[visual] font registered:', fontPath);
    } else {
      console.error('[visual] WARNING: assets/Inter-Bold.ttf not found');
    }
  } catch (e) {
    console.error('[visual] font init error:', e.message);
  }
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

async function overlayTextOnImage(imageBuffer, text, position = 'bottom') {
  if (!text || text === 'без текста' || text === 'no text') return imageBuffer;
  ensureFont();
  try {
    const { createCanvas, loadImage } = require('@napi-rs/canvas');
    const img = await loadImage(imageBuffer);
    const w = img.width;
    const h = img.height;

    const canvas = createCanvas(w, h);
    const ctx = canvas.getContext('2d');
    ctx.drawImage(img, 0, 0, w, h);

    const fontSize = Math.max(20, Math.floor(w / 18));
    const maxChars = Math.floor(w / (fontSize * 0.55));
    const lines = wrapText(text.slice(0, 120), maxChars);
    const lineH = Math.floor(fontSize * 1.4);
    const barH = lineH * lines.length + 24;
    const barY = position === 'center' ? Math.floor((h - barH) / 2) : h - barH;

    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(0, barY, w, barH);

    const fontFam = _fontRegistered ? 'OverlayFont' : 'sans-serif';
    ctx.font = `bold ${fontSize}px "${fontFam}"`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';

    for (let i = 0; i < lines.length; i++) {
      ctx.fillText(lines[i], w / 2, barY + 12 + i * lineH);
    }

    return canvas.toBuffer('image/jpeg', 92);
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
    // Extract "Слайд N: [text]" but NOT "Изображение слайда N:"
    for (const line of lines) {
      const m = line.match(/^Слайд\s+(\d+)(?:\s*\([^)]*\))?:\s*(.+)/i);
      if (m && !line.toLowerCase().includes('изображение')) {
        result[Number(m[1]) - 1] = m[2].trim().slice(0, 100);
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
  const { ask } = require('./src/claude'); // eslint-disable-line
  const scenes = await ask(`
You are a video director. Split this video script into 4-5 short scene descriptions for AI video generation.
Each scene = one visual shot, 5-8 seconds, B-roll atmospheric style.

MANDATORY requirements for EVERY scene prompt:
- Vertical 9:16 portrait orientation, smartphone format (Instagram Reels / TikTok / YouTube Shorts)
- NO text, NO words, NO letters, NO watermarks, NO captions inside the video frame
- NO talking head, NO direct face close-ups — people only as background silhouettes, hands, or softly blurred figures in the background, never as the main subject
- Focus on: product details, space/environment, hands, textures, atmosphere, movement

Return ONLY a JSON array of English prompts, nothing else.
Example: ["cinematic close-up of coffee beans falling into cup, vertical 9:16 portrait, warm golden lighting, no text, no people", "hands pouring latte art slow motion, vertical format, steam rising, blurred cafe background, no text"]

SCRIPT:
${videoScript.slice(0, 800)}
`, { model: HAIKU, maxTokens: 800 });

  try {
    const match = scenes.match(/\[[\s\S]*\]/);
    if (match) return JSON.parse(match[0]);
  } catch { /* fallback */ }

  // Fallback: use the Kling AI prompt directly split into 4 parts
  const klingPrompt = extractByPrefix(videoScript, 'Промпт для Kling AI')[0] || videoScript.slice(0, 200);
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

function buildTimedSrt(hookText, ctaText, duration) {
  const entries = [];
  let idx = 1;
  // Hook: first 4 seconds
  if (hookText) {
    entries.push(`${idx++}\n${srtTime(0)} --> ${srtTime(Math.min(4, duration))}\n${hookText}`);
  }
  // CTA: last 8 seconds (or from 60% of video if very short)
  if (ctaText) {
    const ctaStart = Math.max(hookText ? 5 : 0, duration - 8);
    entries.push(`${idx++}\n${srtTime(ctaStart)} --> ${srtTime(duration)}\n${ctaText}`);
  }
  return entries.join('\n\n');
}

function extractTimedTexts(videoScript, ctaText) {
  const hookMatch = videoScript.match(/ВИДЕО\s*\d+[:\s]+([^\n]+)/i);
  const hook = hookMatch
    ? hookMatch[1].trim().slice(0, 50)
    : (videoScript.match(/^\s*(.+)/)?.[1]?.trim().slice(0, 50) || '');
  const cta  = (ctaText || '').slice(0, 60);
  return { hook, cta };
}

function addSubtitles(videoPath, subtitleText, outputPath) {
  // Legacy single-subtitle — used for regen/translate flows
  const srtPath = videoPath + '.srt';
  const srt = `1\n00:00:00,000 --> 00:00:30,000\n${subtitleText}\n`;
  fs.writeFileSync(srtPath, srt, 'utf8');
  const escapedSrt = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  execSync(`"${FFMPEG_BIN}" -y -i "${videoPath}" -vf "subtitles='${escapedSrt}':force_style='FontSize=18,Alignment=2,MarginV=20'" -c:a copy "${outputPath}"`, { stdio: 'pipe' });
  fs.unlinkSync(srtPath);
}

function addTimedSubtitles(videoPath, srtContent, outputPath) {
  if (!srtContent.trim()) { fs.copyFileSync(videoPath, outputPath); return; }
  const srtPath = videoPath + '_timed.srt';
  fs.writeFileSync(srtPath, srtContent, 'utf8');
  const escapedSrt = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  execSync(`"${FFMPEG_BIN}" -y -i "${videoPath}" -vf "subtitles='${escapedSrt}':force_style='FontSize=20,Alignment=2,MarginV=30,Bold=1'" -c:a copy "${outputPath}"`, { stdio: 'pipe' });
  fs.unlinkSync(srtPath);
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

  // Add timed text overlay (hook at start + CTA at end)
  const { hook, cta } = extractTimedTexts(videoScript, ctaOverride);
  const subtitleText = hook || extractSubtitleFromScript(videoScript);
  const finalPath = `${tmpBase}_final.mp4`;
  try {
    const duration = getVideoDuration(mergedPath);
    const srtContent = buildTimedSrt(hook, cta, duration);
    if (srtContent.trim()) {
      addTimedSubtitles(mergedPath, srtContent, finalPath);
      console.log(`[visual] Видео ${videoIndex + 1}: тайминги хук(0-4s) + CTA(${Math.round(Math.max(5, duration-8))}-${Math.round(duration)}s), длина=${Math.round(duration)}s`);
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

// ── Regen one video based on manager feedback ──────────────────────────────────

async function regenVideo(clientChatId, videoIndex, feedback) {
  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  if (!fs.existsSync(resultPath)) return;
  const data = JSON.parse(fs.readFileSync(resultPath, 'utf8'));

  const videoData = data.results.videoData?.[videoIndex];
  if (!videoData) return;

  console.log(`[visual] Регенерация видео ${videoIndex + 1} для ${clientChatId}. Фидбек: ${feedback}`);

  // Ask Claude which scene(s) to fix
  const { ask } = require('./src/claude');
  const scenes = videoData.scenes || [];
  let scenesToRegen = [];

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
  const videoData = data.results?.videoData?.[videoIndex];
  if (!videoData?.rawPath || !fs.existsSync(videoData.rawPath)) {
    console.error(`[visual] regenSubtitle: rawPath не найден для видео ${videoIndex}`);
    return;
  }
  const tmpBase  = path.join(TMP_DIR, `${clientChatId}_v${videoIndex}`);
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

async function applyAndSaveOverlays(urls, texts, clientChatId, sectionKey, position = 'bottom') {
  const { default: fetch } = await import('node-fetch');
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
      const processed = await overlayTextOnImage(buf, text, position);
      const outPath   = path.join(RESULTS_DIR, `${clientChatId}_${sectionKey}_${i}_ov.jpg`);
      fs.writeFileSync(outPath, processed);
      localPaths.push(outPath);
      console.log(`[visual] overlay ${sectionKey}[${i}]: "${text.slice(0, 50)}"`);
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

async function generateFreeVisuals(clientChatId, carouselScript, coverExample) {
  console.log(`[visual] generateFreeVisuals: ${clientChatId}`);

  // Очищаем флаги от предыдущих запусков
  for (const flag of ['free_visuals_notified', 'visuals_6done']) {
    const f = path.join(RESULTS_DIR, `${clientChatId}.${flag}`);
    if (fs.existsSync(f)) fs.unlinkSync(f);
  }

  const [carouselPrompts, coverPrompts] = await Promise.all([
    getImagePrompts(carouselScript, 'carousel', 5),
    getImagePrompts(coverExample,   'cover',    1),
  ]);

  console.log(`[visual] freeVisuals: карусель=${carouselPrompts.length} обложка=${coverPrompts.length}`);

  // Сохраняем промпты — используются при перегенерации отдельных слотов
  fs.writeFileSync(
    path.join(RESULTS_DIR, `${clientChatId}.free_prompts.json`),
    JSON.stringify({ carousel: carouselPrompts, cover: coverPrompts, savedAt: Date.now() }, null, 2)
  );

  // Инициализируем файл результатов
  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.free_visuals.json`);
  fs.writeFileSync(resultPath, JSON.stringify({ carouselUrls: [], coverUrls: [], generatedAt: Date.now() }, null, 2));

  // Запускаем все задания и сохраняем taskId на диск сразу
  const allPromises = [];

  for (let i = 0; i < carouselPrompts.length; i++) {
    const taskId = await startImage(carouselPrompts[i], '1:1').catch(() => null);
    if (taskId) {
      saveImageTask(taskId, { clientId: clientChatId, type: 'free_visuals', slot: `carousel_${i}` });
      allPromises.push(pollAndSave(taskId, { clientId: clientChatId, type: 'free_visuals', slot: `carousel_${i}`, taskId }));
    }
  }
  for (let i = 0; i < coverPrompts.length; i++) {
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

  // Если карусель+обложка уже были готовы — теперь все 7, отправляем уведомление
  const visualsDoneFlag = path.join(RESULTS_DIR, `${clientChatId}.visuals_6done`);
  if (fs.existsSync(visualsDoneFlag)) {
    fs.unlinkSync(visualsDoneFlag);
    try {
      const v = JSON.parse(fs.readFileSync(path.join(RESULTS_DIR, `${clientChatId}.free_visuals.json`), 'utf8'));
      notifyFreeVisualsReady(clientChatId, v.carouselUrls || [], v.coverUrls || []).catch(() => {});
    } catch (e) {
      console.error('[visual] notifyFreeVisualsReady after photo error:', e.message);
    }
  }

  // Notify manager in Bot3 so they see the photo before approving
  const adminChatId = process.env.BOT3_MANAGER_CHAT_ID;
  const botToken    = process.env.TELEGRAM_BOT3_TOKEN;
  if (!adminChatId || !botToken) return;

  const { default: fetch } = await import('node-fetch');
  await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({
      chat_id: adminChatId,
      photo:   url,
      caption: `🖼 AI-фото для бесплатного пакета (chatId: ${clientChatId})\nБудет отправлено клиенту вместе с пакетом.`,
    }),
  }).catch(e => console.error('[visual] admin photo notify error:', e.message));
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

  // Send images one by one — use local file (with text overlay) if available, else URL
  for (let i = 0; i < urls.length; i += 10) {
    const batch = urls.slice(i, i + 10);
    const batchLocal = localPaths.slice(i, i + 10);

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
  // Each item: [🔄 N] [✏️ N] — regen + edit text side by side
  const rows = [];
  for (let i = 0; i < urls.length; i += 2) {
    const row = [];
    for (let j = i; j < Math.min(i + 2, urls.length); j++) {
      const ok = !!urls[j];
      row.push({ text: `${ok ? '🔄' : '❌'} ${j + 1}`, callback_data: `ri_${sectionCode}_${j}_${clientChatId}` });
      row.push({ text: `✏️ ${j + 1}`, callback_data: `et_${sectionCode}_${j}_${clientChatId}` });
    }
    rows.push(row);
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
    for (let j = 0; j < slides.length; j += 2) {
      const row = [];
      for (let k = j; k < Math.min(j + 2, slides.length); k++) {
        const ok = !!slides[k];
        row.push({ text: `${ok ? '🔄' : '❌'} Сл.${start + k + 1}`, callback_data: `ri_ca_${start + k}_${clientChatId}` });
        row.push({ text: `✏️ Сл.${start + k + 1}`, callback_data: `et_ca_${start + k}_${clientChatId}` });
      }
      rows.push(row);
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

async function regenItem(clientChatId, section, index) {
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

  const prompt    = (info.prompts || [])[index];
  const itemLabel = `${info.label} ${index + 1}`;
  if (!prompt) { await notify(`⚠️ Промпт для ${itemLabel} не найден`); return; }

  console.log(`[visual] regenItem: ${clientChatId} section=${section} index=${index}`);
  await notify(`🔄 Перегенерирую ${itemLabel}...`);

  const taskId = await startImage(prompt, info.ratio).catch(() => null);
  if (!taskId) { await notify(`❌ Ошибка запуска для ${itemLabel}`); return; }

  const url = await pollTask(taskId, 900000, 'image');
  if (!url) { await notify(`❌ Генерация не удалась для ${itemLabel}`); return; }

  data.results[info.key] = data.results[info.key] || [];
  data.results[info.key][index] = url;
  fs.writeFileSync(resultPath, JSON.stringify(data, null, 2));

  if (chatId && token) {
    await fetch(`https://api.telegram.org/bot${token}/sendPhoto`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        photo: url,
        caption: `✅ ${itemLabel} перегенерирован`,
        reply_markup: JSON.stringify({ inline_keyboard: [[
          { text: '🔄 Переделать ещё раз', callback_data: `ri_${section}_${index}_${clientChatId}` },
        ]] }),
      }),
    }).catch(() => {});
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
    : 'Ссылка в bio ↑';

  const photoPrompts    = extractByPrefix(pkg.photoScripts,    'Промпт для AI-генерации').slice(0, 8);
  const photoCaptions   = extractByPrefix(pkg.photoScripts,    'Подпись к посту').slice(0, 8);
  const storyPrompts    = extractByPrefix(pkg.storiesScripts,  'Промпт для AI-генерации').slice(0, 15);
  const carouselPrompts = extractByPrefix(pkg.carouselScripts, 'Изображение слайда').slice(0, 56);
  const maxCovers       = isStandard ? 4 : 8;
  const coverPrompts    = extractByPrefix(pkg.covers,          'Промпт для AI').slice(0, maxCovers);
  const carouselGroups  = getCarouselGroups(pkg.carouselScripts, carouselPrompts.length);
  const prompts = { photoPrompts, photoCaptions, storyPrompts, carouselPrompts, coverPrompts, carouselGroups };

  // Extract overlay texts for each section
  const photoTexts  = extractSlideTexts(pkg.photoScripts   || '', 'photos');
  const storyTexts  = extractSlideTexts(pkg.storiesScripts || '', 'stories');
  const coverTexts  = extractSlideTexts(pkg.covers         || '', 'covers');
  // Carousel texts: flat array across ALL carousels in order
  // Each carousel has slides 1-7, so split by carousel header first
  const carouselTexts = (() => {
    const result = [];
    const parts = (pkg.carouselScripts || '').split(/(?:^|\n)(?:КАРУСЕЛЬ|CAROUSEL)\s+\d+[:\s]/im);
    for (let c = 1; c < parts.length; c++) {
      const slideMap = {};
      for (const line of parts[c].split('\n')) {
        const m = line.match(/^Слайд\s+(\d+)(?:\s*\([^)]*\))?:\s*(.+)/i);
        if (m && !line.toLowerCase().includes('изображение')) {
          slideMap[Number(m[1])] = m[2].trim().slice(0, 100);
        }
      }
      const maxSlide = Math.max(0, ...Object.keys(slideMap).map(Number));
      for (let s = 1; s <= maxSlide; s++) result.push(slideMap[s] || '');
    }
    return result;
  })();

  console.log(`[visual] Карусели: ${carouselGroups.length} каруселей, слайды: [${carouselGroups.join(',')}]`);

  console.log(`[visual] Промпты: фото=${photoPrompts.length} stories=${storyPrompts.length} карусели=${carouselPrompts.length} обложки=${coverPrompts.length}`);

  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  let existing = null;
  try { existing = JSON.parse(fs.readFileSync(resultPath, 'utf8')); } catch {}

  const notified = existing?.notifiedSections || {};

  // Shared results — updated by each section as it completes (JS single-thread = no race)
  const allResults = {
    photos:         existing?.results?.photos         || [],
    stories:        existing?.results?.stories        || [],
    carouselSlides: existing?.results?.carouselSlides || [],
    covers:         existing?.results?.covers         || [],
    videoData:      existing?.results?.videoData      || [],
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

    for (let i = 0; i < videoScripts.length; i++) {
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

// Split videoScripts text into individual video scripts
function splitVideoScripts(text) {
  const parts = text.split(/ВИДЕО\s+\d+:/i).filter(s => s.trim().length > 50);
  return parts.slice(0, 8);
}

// ── Bot3 notifications ─────────────────────────────────────────────────────────

async function bot3Send(chatId, text) {
  const token = process.env.TELEGRAM_BOT3_TOKEN;
  if (!token || !chatId) return;
  const { default: fetch } = await import('node-fetch');
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, parse_mode: 'Markdown', text }),
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
  const maxVideos  = isProfi ? 8 : 4;
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
  const maxVideos  = isProfi ? 8 : 4;
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
  await bot3Send(chatId, `Продолжите проверку: /review_${clientChatId}`);
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
