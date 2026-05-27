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

// Verify ffmpeg is available at startup
try {
  execSync('ffmpeg -version', { stdio: 'ignore' });
} catch {
  console.error('[visual] WARNING: ffmpeg не найден — видео-генерация работать не будет');
}

const BASE_DIR     = path.join(os.homedir(), '.marketingdna-client-sessions');
const VISUAL_DIR   = path.join(BASE_DIR, 'visual_queue');
const RESULTS_DIR  = path.join(BASE_DIR, 'visual_results');
const TRIGGERS_DIR = path.join(BASE_DIR, 'triggers');
const TMP_DIR      = path.join(BASE_DIR, 'tmp_video');

for (const d of [VISUAL_DIR, RESULTS_DIR, TRIGGERS_DIR, TMP_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ── HTTP endpoints ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true }));

// Раздаём HTML-страницы бесплатного пакета
app.get('/pack/:clientId', (req, res) => {
  const htmlFile = path.join(PACK_PAGES_DIR, `${req.params.clientId}.html`);
  if (!fs.existsSync(htmlFile)) return res.status(404).send('Страница не найдена');
  res.sendFile(htmlFile);
});

app.post('/generate', (req, res) => {
  const { clientChatId } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  runVisualGeneration(String(clientChatId)).catch(e =>
    console.error('[visual] error for', clientChatId, e.message)
  );
});

// Called by Bot3: regenerate one video based on manager feedback
app.post('/regen_video', (req, res) => {
  const { clientChatId, videoIndex, feedback } = req.body;
  if (!clientChatId || videoIndex === undefined) return res.status(400).json({ error: 'missing params' });
  res.json({ ok: true });
  regenVideo(String(clientChatId), Number(videoIndex), feedback || '').catch(e =>
    console.error('[visual] regen_video error', e.message)
  );
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

// Generate one real photo for free package
app.post('/generate_free_photo', (req, res) => {
  const { clientChatId, prompt } = req.body;
  if (!clientChatId || !prompt) return res.status(400).json({ error: 'clientChatId and prompt required' });
  res.json({ ok: true });
  generateFreePhoto(String(clientChatId), prompt).catch(e =>
    console.error('[visual] generate_free_photo error', e.message)
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

async function kieGet(taskId) {
  const { default: fetch } = await import('node-fetch');
  const r = await fetch(`${KIE_BASE}/jobs/recordInfo?taskId=${taskId}`, {
    headers: { Authorization: `Bearer ${KIE_API_KEY}` },
  });
  return r.json();
}

// Генерация изображений через gpt4o-image (Kie.ai)
// Размеры: '1:1' → '1024x1024', '9:16' → '1024x1792'
function kieSize(ratio) {
  if (ratio === '9:16') return '1024x1792';
  if (ratio === '16:9') return '1792x1024';
  return '1024x1024'; // по умолчанию квадрат
}

async function startImage(prompt, size = '1:1') {
  const d = await kiePost('/gpt4o-image/generate', { prompt, size: kieSize(size) });
  return d?.data?.taskId || d?.taskId || null;
}

async function startVideo(prompt) {
  const d = await kiePost('/veo/generate', {
    prompt,
    model:          'veo3_fast',
    generationType: 'TEXT_2_VIDEO',
    aspect_ratio:   '9:16',
  });
  return d?.data?.taskId || d?.taskId || null;
}

async function pollTask(taskId, maxMs = 420000) {
  if (!taskId) return null;
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    await sleep(12000);
    try {
      const d     = await kieGet(taskId);
      const state = d?.data?.state || d?.state;
      if (state === 'success') {
        // Пробуем разные пути к URL (API может отличаться)
        const url = (d?.data?.resultJson?.resultUrls || [])[0]
          || (d?.data?.resultUrls || [])[0]
          || d?.data?.resultUrl
          || d?.resultUrl
          || null;
        console.log(`[kie] pollTask ${taskId}: success, url=${url ? url.slice(0, 80) : 'null'}`);
        return url;
      }
      if (state === 'fail') {
        console.log(`[kie] pollTask ${taskId}: fail`);
        return null;
      }
    } catch (e) { console.log(`[kie] pollTask ${taskId}: poll error ${e.message}`); }
  }
  console.log(`[kie] pollTask ${taskId}: timeout`);
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

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

// ── Split video script into 4-5 scene prompts via Claude ──────────────────────

async function splitScriptToScenes(videoScript) {
  const { ask } = require('./src/claude'); // eslint-disable-line
  const scenes = await ask(`
You are a video director. Split this video script into 4-5 short scene descriptions for AI video generation.
Each scene = one visual shot, 5-7 seconds, B-roll style (no talking head).
Return ONLY a JSON array of English prompts, nothing else.
Example: ["cinematic close-up of coffee beans falling, warm lighting", "barista hands pouring latte art, slow motion"]

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
  execSync(`ffmpeg -y -f concat -safe 0 -i "${listFile}" -c copy "${outputPath}"`, { stdio: 'pipe' });
  fs.unlinkSync(listFile);
}

function addSubtitles(videoPath, subtitleText, outputPath) {
  const srtPath = videoPath + '.srt';
  const srt = `1\n00:00:00,000 --> 00:00:30,000\n${subtitleText}\n`;
  fs.writeFileSync(srtPath, srt, 'utf8');
  const escapedSrt = srtPath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
  execSync(`ffmpeg -y -i "${videoPath}" -vf "subtitles='${escapedSrt}':force_style='FontSize=18,Alignment=2,MarginV=20'" -c:a copy "${outputPath}"`, { stdio: 'pipe' });
  fs.unlinkSync(srtPath);
}

function extractSubtitleFromScript(videoScript) {
  const match = videoScript.match(/ВИДЕО\s*\d+[:\s]+([^\n]+)/i);
  return match ? match[1].trim().slice(0, 60) : '';
}

// ── Generate one complete video (fragments → merge → subtitles) ───────────────

async function generateOneVideo(videoScript, videoIndex, clientChatId) {
  const scenes = await splitScriptToScenes(videoScript);
  console.log(`[visual] Видео ${videoIndex + 1}: ${scenes.length} сцен`);

  // Generate all fragments in parallel (batches of 2 - videos are heavy)
  const fragmentUrls = [];
  for (let i = 0; i < scenes.length; i += 2) {
    const batch = scenes.slice(i, i + 2);
    const taskIds = await Promise.all(batch.map(p => startVideo(p).catch(() => null)));
    const urls    = await Promise.all(taskIds.map(id => pollTask(id, 600000)));
    fragmentUrls.push(...urls);
  }

  const validUrls = fragmentUrls.filter(Boolean);
  if (!validUrls.length) return { finalUrl: null, scenes, fragmentUrls };

  // Download fragments
  const tmpBase = path.join(TMP_DIR, `${clientChatId}_v${videoIndex}`);
  const fragPaths = [];
  for (let i = 0; i < validUrls.length; i++) {
    const p = `${tmpBase}_frag${i}.mp4`;
    await downloadFile(validUrls[i], p);
    fragPaths.push(p);
  }

  // Merge
  const mergedPath = `${tmpBase}_merged.mp4`;
  try {
    if (fragPaths.length > 1) {
      mergeVideoFragments(fragPaths, mergedPath);
    } else {
      fs.copyFileSync(fragPaths[0], mergedPath);
    }
  } catch (e) {
    console.error('[visual] ffmpeg merge error:', e.message);
    return { finalUrl: null, scenes, fragmentUrls };
  }

  // Cleanup fragments
  fragPaths.forEach(p => fs.existsSync(p) && fs.unlinkSync(p));

  // Add subtitle overlay
  const subtitleText = extractSubtitleFromScript(videoScript);
  const finalPath = `${tmpBase}_final.mp4`;
  if (subtitleText) {
    try {
      addSubtitles(mergedPath, subtitleText, finalPath);
    } catch (e) {
      console.error('[visual] subtitle error:', e.message);
      fs.copyFileSync(mergedPath, finalPath);
    }
  } else {
    fs.copyFileSync(mergedPath, finalPath);
  }

  return { localPath: finalPath, rawPath: mergedPath, subtitleText, scenes, fragmentUrls, validCount: validUrls.length };
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
    const url     = await pollTask(taskId, 600000);
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

// ── Batched image generation ───────────────────────────────────────────────────

async function genBatch(prompts, startFn, label, batchSize = 5) {
  const out = [];
  for (let i = 0; i < prompts.length; i += batchSize) {
    const slice = prompts.slice(i, i + batchSize);
    console.log(`[visual] ${label}: ${i + 1}–${Math.min(i + batchSize, prompts.length)}/${prompts.length}`);
    const taskIds = await Promise.all(slice.map(p => startFn(p).catch(() => null)));
    const urls    = await Promise.all(taskIds.map(id => pollTask(id)));
    out.push(...urls);
  }
  return out;
}

// ── Free package: carousel slides + cover ─────────────────────────────────────

async function generateFreeVisuals(clientChatId, carouselScript, coverExample) {
  console.log(`[visual] generateFreeVisuals: ${clientChatId}`);

  const [carouselPrompts, coverPrompts] = await Promise.all([
    getImagePrompts(carouselScript, 'carousel', 5),
    getImagePrompts(coverExample,   'cover',    1),
  ]);

  console.log(`[visual] freeVisuals: карусель=${carouselPrompts.length} обложка=${coverPrompts.length}`);

  const [carouselUrls, coverUrls] = await Promise.all([
    genBatch(carouselPrompts, p => startImage(p, '1:1'),  'Карусель (free)'),
    genBatch(coverPrompts,    p => startImage(p, '9:16'), 'Обложка (free)'),
  ]);

  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.free_visuals.json`);
  fs.writeFileSync(resultPath, JSON.stringify({
    carouselUrls,
    coverUrls,
    generatedAt: Date.now(),
  }, null, 2));

  console.log(`[visual] generateFreeVisuals done: carousel=${carouselUrls.filter(Boolean).length} cover=${coverUrls.filter(Boolean).length}`);

  // Уведомляем менеджера в Bot3
  const adminChatId = process.env.BOT3_MANAGER_CHAT_ID;
  const botToken    = process.env.TELEGRAM_BOT3_TOKEN;
  if (!adminChatId || !botToken) return;

  const { default: fetch } = await import('node-fetch');

  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: adminChatId,
      text: `🎠 Карусель + обложка для бесплатного пакета готовы (chatId: ${clientChatId})\n\nКарусель: ${carouselUrls.filter(Boolean).length}/5 слайдов\nОбложка: ${coverUrls.filter(Boolean).length}/1`,
    }),
  }).catch(() => {});

  // Отправляем слайды карусели
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
    } else if (group.length === 1) {
      await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: adminChatId, photo: group[0], caption: 'Карусель — слайд 1' }),
      }).catch(() => {});
    }
  }

  // Отправляем обложку
  if (coverUrls[0]) {
    await fetch(`https://api.telegram.org/bot${botToken}/sendPhoto`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: adminChatId, photo: coverUrls[0], caption: '🖼 Обложка (thumbnail)' }),
    }).catch(() => {});
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
  const url = taskId ? await pollTask(taskId) : null;
  if (!url) {
    console.error('[visual] generateFreePhoto: no URL returned');
    return;
  }

  // Save result so send_free handler can attach to client delivery
  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.free_photo.json`);
  fs.writeFileSync(resultPath, JSON.stringify({ url, prompt, generatedAt: Date.now() }, null, 2));
  console.log(`[visual] generateFreePhoto done: ${url}`);

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

// ── Main generation ────────────────────────────────────────────────────────────

async function runVisualGeneration(clientChatId) {
  const pkgPath = path.join(VISUAL_DIR, `${clientChatId}.visual.json`);
  if (!fs.existsSync(pkgPath)) {
    console.error('[visual] visual.json not found for', clientChatId); return;
  }
  const pkg        = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const isProfi    = pkg.packageKey.includes('pkg_v');
  const isStandard = pkg.packageKey.includes('pkg_standard');
  const videoCount = isProfi ? 8 : 4;

  console.log(`[visual] Старт: ${pkg.clientName} (${pkg.packageKey})`);

  const photoPrompts    = extractByPrefix(pkg.photoScripts,    'Промпт для AI-генерации').slice(0, 8);
  const storyPrompts    = extractByPrefix(pkg.storiesScripts,  'Промпт для AI-генерации').slice(0, 15);
  const carouselPrompts = extractByPrefix(pkg.carouselScripts, 'Изображение слайда').slice(0, 56);
  const coverPrompts    = extractByPrefix(pkg.covers,          'Промпт для AI').slice(0, 16);

  console.log(`[visual] Промпты: фото=${photoPrompts.length} stories=${storyPrompts.length} карусели=${carouselPrompts.length} обложки=${coverPrompts.length}`);

  // Generate images in parallel
  const [photos, stories, carouselSlides, covers] = await Promise.all([
    genBatch(photoPrompts,    p => startImage(p, '1:1'),  'Фото постов'),
    genBatch(storyPrompts,    p => startImage(p, '9:16'), 'Stories'),
    genBatch(carouselPrompts, p => startImage(p, '1:1'),  'Карусели'),
    genBatch(coverPrompts,    p => startImage(p, '9:16'), 'Обложки'),
  ]);

  // Generate videos (each split into fragments → merged)
  const videoData = [];
  if (isProfi || isStandard) {
    const videoScripts = splitVideoScripts(pkg.videoScripts).slice(0, videoCount);
    console.log(`[visual] Генерирую ${videoScripts.length} видео по фрагментам...`);
    for (let i = 0; i < videoScripts.length; i++) {
      const result = await generateOneVideo(videoScripts[i], i, clientChatId);
      videoData.push(result);
    }
  }

  const results = { photos, stories, carouselSlides, covers, videoData };

  fs.writeFileSync(
    path.join(RESULTS_DIR, `${clientChatId}.results.json`),
    JSON.stringify({
      clientChatId,
      clientName:  pkg.clientName,
      packageKey:  pkg.packageKey,
      prompts:     { photoPrompts, storyPrompts, carouselPrompts, coverPrompts },
      results,
      approved:    {},
      timestamp:   Date.now(),
    }, null, 2)
  );

  console.log(`[visual] Генерация завершена: ${pkg.clientName}`);
  await notifyBot3(clientChatId, pkg.clientName, pkg.packageKey, results);
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

async function notifyBot3(clientChatId, clientName, packageKey, results) {
  const chatId     = process.env.BOT3_MANAGER_CHAT_ID;
  const isProfi    = packageKey.includes('pkg_v');
  const isStandard = packageKey.includes('pkg_standard');
  const maxVideos  = isProfi ? 8 : 4;
  const validVideos = (results.videoData || []).filter(v => v?.localPath).length;
  await bot3Send(chatId,
    `🎨 Визуал готов — *${clientName}*\n\n` +
    `📸 Фото: ${results.photos.filter(Boolean).length}/8\n` +
    `🎠 Карусели: ${results.carouselSlides.filter(Boolean).length} слайдов\n` +
    `📱 Stories: ${results.stories.filter(Boolean).length}/15\n` +
    `🖼 Обложки: ${results.covers.filter(Boolean).length}\n` +
    ((isProfi || isStandard) ? `🎬 Видео: ${validVideos}/${maxVideos}\n` : '') +
    `\nНачать проверку: /review_${clientChatId}`
  );
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

app.listen(PORT, () => console.log(`[visual] Сервис запущен на порту ${PORT}`));
