require('dotenv').config();
const express = require('express');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');

const app  = express();
app.use(express.json());

const PORT         = process.env.VISUAL_PORT || 3002;
const KIE_API_KEY  = process.env.KIE_API_KEY;
const KIE_BASE     = 'https://api.kie.ai/api/v1';

const BASE_DIR     = path.join(os.homedir(), '.marketingdna-client-sessions');
const VISUAL_DIR   = path.join(BASE_DIR, 'visual_queue');
const RESULTS_DIR  = path.join(BASE_DIR, 'visual_results');
const TRIGGERS_DIR = path.join(BASE_DIR, 'triggers');

for (const d of [VISUAL_DIR, RESULTS_DIR, TRIGGERS_DIR]) {
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// ── HTTP endpoints ─────────────────────────────────────────────────────────────

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/generate', (req, res) => {
  const { clientChatId } = req.body;
  if (!clientChatId) return res.status(400).json({ error: 'clientChatId required' });
  res.json({ ok: true });
  runVisualGeneration(String(clientChatId)).catch(e =>
    console.error('[visual] error for', clientChatId, e.message)
  );
});

// Called by Bot3 when a section needs regeneration
app.post('/regen', (req, res) => {
  const { clientChatId, section } = req.body;
  if (!clientChatId || !section) return res.status(400).json({ error: 'clientChatId + section required' });
  res.json({ ok: true });
  regenSection(String(clientChatId), section).catch(e =>
    console.error('[visual] regen error', clientChatId, section, e.message)
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
  return r.json();
}

async function kieGet(taskId) {
  const { default: fetch } = await import('node-fetch');
  const r = await fetch(`${KIE_BASE}/jobs/recordInfo?taskId=${taskId}`, {
    headers: { Authorization: `Bearer ${KIE_API_KEY}` },
  });
  return r.json();
}

async function startImage(prompt, size = '1:1') {
  const d = await kiePost('/gpt4o-image/generate', { prompt, size });
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
      if (state === 'success') return (d?.data?.resultJson?.resultUrls || [])[0] || null;
      if (state === 'fail')    return null;
    } catch { /* retry */ }
  }
  return null;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Prompt extraction ──────────────────────────────────────────────────────────

function extractByPrefix(text, prefix) {
  return text
    .split('\n')
    .filter(l => l.trim().toLowerCase().startsWith(prefix.toLowerCase()))
    .map(l => l.slice(l.toLowerCase().indexOf(prefix.toLowerCase()) + prefix.length).replace(/^[\s:]+/, '').trim())
    .filter(Boolean);
}

// ── Batched generation ─────────────────────────────────────────────────────────

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

// ── Main generation ────────────────────────────────────────────────────────────

async function runVisualGeneration(clientChatId) {
  const pkgPath = path.join(VISUAL_DIR, `${clientChatId}.visual.json`);
  if (!fs.existsSync(pkgPath)) {
    console.error('[visual] visual.json not found for', clientChatId); return;
  }
  const pkg     = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const isProfi = pkg.packageKey.includes('pkg_v');

  console.log(`[visual] Старт генерации: ${pkg.clientName} (${pkg.packageKey})`);

  const photoPrompts    = extractByPrefix(pkg.photoScripts,    'Промпт для AI-генерации').slice(0, 8);
  const storyPrompts    = extractByPrefix(pkg.storiesScripts,  'Промпт для AI-генерации').slice(0, 15);
  const carouselPrompts = extractByPrefix(pkg.carouselScripts, 'Изображение слайда').slice(0, 56);
  const coverPrompts    = extractByPrefix(pkg.covers,          'Промпт для AI').slice(0, 16);
  const videoPrompts    = isProfi ? extractByPrefix(pkg.videoScripts, 'Промпт для Kling AI').slice(0, 8) : [];

  console.log(`[visual] Промпты: фото=${photoPrompts.length} stories=${storyPrompts.length} карусели=${carouselPrompts.length} обложки=${coverPrompts.length} видео=${videoPrompts.length}`);

  const [photos, stories, carouselSlides, covers] = await Promise.all([
    genBatch(photoPrompts,    p => startImage(p, '1:1'),  'Фото постов'),
    genBatch(storyPrompts,    p => startImage(p, '9:16'), 'Stories'),
    genBatch(carouselPrompts, p => startImage(p, '1:1'),  'Карусели'),
    genBatch(coverPrompts,    p => startImage(p, '9:16'), 'Обложки'),
  ]);

  let videos = [];
  if (isProfi && videoPrompts.length > 0) {
    videos = await genBatch(videoPrompts, startVideo, 'Видео B-roll', 2);
  }

  const results = { photos, stories, carouselSlides, covers, videos };
  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  fs.writeFileSync(resultPath, JSON.stringify({
    clientChatId,
    clientName:  pkg.clientName,
    packageKey:  pkg.packageKey,
    prompts:     { photoPrompts, storyPrompts, carouselPrompts, coverPrompts, videoPrompts },
    results,
    approved:    {},
    timestamp:   Date.now(),
  }, null, 2));

  console.log(`[visual] Сохранено: ${resultPath}`);
  await notifyBot3(clientChatId, pkg.clientName, pkg.packageKey, results);
}

// ── Section regeneration ───────────────────────────────────────────────────────

async function regenSection(clientChatId, section) {
  const resultPath = path.join(RESULTS_DIR, `${clientChatId}.results.json`);
  if (!fs.existsSync(resultPath)) return;
  const data    = JSON.parse(fs.readFileSync(resultPath, 'utf8'));
  const isProfi = data.packageKey.includes('pkg_v');

  console.log(`[visual] Регенерация секции ${section} для ${clientChatId}`);

  let newUrls = [];
  const p = data.prompts;

  if (section === 'photos')   newUrls = await genBatch(p.photoPrompts,    q => startImage(q, '1:1'),  'Фото (regen)');
  if (section === 'stories')  newUrls = await genBatch(p.storyPrompts,    q => startImage(q, '9:16'), 'Stories (regen)');
  if (section === 'carousels') newUrls = await genBatch(p.carouselPrompts, q => startImage(q, '1:1'),  'Карусели (regen)');
  if (section === 'covers')   newUrls = await genBatch(p.coverPrompts,    q => startImage(q, '9:16'), 'Обложки (regen)');
  if (section === 'videos' && isProfi) newUrls = await genBatch(p.videoPrompts, startVideo, 'Видео (regen)', 2);

  data.results[section] = newUrls;
  delete data.approved[section];
  fs.writeFileSync(resultPath, JSON.stringify(data, null, 2));

  await notifyBot3Regen(clientChatId, section);
}

// ── Bot3 notifications ─────────────────────────────────────────────────────────

async function bot3Send(text, extra = {}) {
  const token   = process.env.TELEGRAM_BOT3_TOKEN;
  const chatId  = process.env.BOT3_MANAGER_CHAT_ID;
  if (!token || !chatId) return;
  const { default: fetch } = await import('node-fetch');
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ chat_id: chatId, parse_mode: 'Markdown', text, ...extra }),
  });
}

async function notifyBot3(clientChatId, clientName, packageKey, results) {
  const isProfi = packageKey.includes('pkg_v');
  await bot3Send(
    `🎨 Визуал готов — *${clientName}*\n\n` +
    `📸 Фото постов: ${results.photos.filter(Boolean).length}/8\n` +
    `🎠 Слайды каруселей: ${results.carouselSlides.filter(Boolean).length}\n` +
    `📱 Stories: ${results.stories.filter(Boolean).length}/15\n` +
    `🖼 Обложки: ${results.covers.filter(Boolean).length}\n` +
    (isProfi ? `🎬 Видео B-roll: ${results.videos.filter(Boolean).length}/8\n` : '') +
    `\nНачать проверку: /review_${clientChatId}`
  );
}

async function notifyBot3Regen(clientChatId, section) {
  await bot3Send(
    `✅ Регенерация секции *${section}* завершена.\n\nПродолжите проверку: /review_${clientChatId}`
  );
}

app.listen(PORT, () => console.log(`[visual] Сервис запущен на порту ${PORT}`));
