const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);
const { askVision } = require('../claude');

const SESSIONS_DIR  = path.join(os.homedir(), '.marketingdna-client-sessions');
const REFERENCES_DIR = path.join(SESSIONS_DIR, 'references');

if (!fs.existsSync(REFERENCES_DIR)) fs.mkdirSync(REFERENCES_DIR, { recursive: true });

let FFMPEG_BIN = 'ffmpeg';
try {
  const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
  if (ffmpegInstaller.path) FFMPEG_BIN = ffmpegInstaller.path;
} catch (e) {}

// ── Загрузка видео по URL (Telegram getFileLink) ─────────────────────────────

async function downloadFile(url, destPath) {
  const { default: fetch } = await import('node-fetch');
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Download failed: ${resp.status}`);
  const buf = await resp.arrayBuffer();
  fs.writeFileSync(destPath, Buffer.from(buf));
}

// ── ffmpeg: извлечь аудио ─────────────────────────────────────────────────────

async function extractAudio(videoPath, audioPath) {
  try {
    await execFileAsync(FFMPEG_BIN, [
      '-i', videoPath,
      '-t', '90',
      '-vn', '-ar', '16000', '-ac', '1',
      '-y', audioPath,
    ]);
    return fs.existsSync(audioPath) && fs.statSync(audioPath).size > 1000;
  } catch (e) {
    console.error('[reference] ffmpeg audio error:', e.message);
    return false;
  }
}

// ── ffmpeg: извлечь кадры каждые 6 сек (макс 90 сек = ~15 кадров) ────────────

async function extractFrames(videoPath, framePrefix) {
  try {
    await execFileAsync(FFMPEG_BIN, [
      '-i', videoPath,
      '-t', '90',
      '-vf', 'fps=1/6,scale=640:-1',
      '-q:v', '3',
      '-y', `${framePrefix}%02d.jpg`,
    ]);
    const dir  = path.dirname(framePrefix);
    const base = path.basename(framePrefix);
    return fs.readdirSync(dir)
      .filter(f => f.startsWith(base) && f.endsWith('.jpg'))
      .sort()
      .map(f => path.join(dir, f));
  } catch (e) {
    console.error('[reference] ffmpeg frames error:', e.message);
    return [];
  }
}

// ── AssemblyAI: транскрибировать аудио ───────────────────────────────────────

async function transcribeAudio(audioPath) {
  const apiKey = process.env.ASSEMBLYAI_API_KEY;
  if (!apiKey || !fs.existsSync(audioPath)) return '';

  try {
    const { default: fetch } = await import('node-fetch');

    // 1. Загружаем файл на AssemblyAI
    const fileData = fs.readFileSync(audioPath);
    const uploadResp = await fetch('https://api.assemblyai.com/v2/upload', {
      method: 'POST',
      headers: { authorization: apiKey, 'content-type': 'application/octet-stream' },
      body: fileData,
    });
    const { upload_url } = await uploadResp.json();
    if (!upload_url) return '';

    // 2. Отправляем на транскрипцию
    const transcriptResp = await fetch('https://api.assemblyai.com/v2/transcript', {
      method: 'POST',
      headers: { authorization: apiKey, 'content-type': 'application/json' },
      body: JSON.stringify({ audio_url: upload_url, language_detection: true }),
    });
    const { id } = await transcriptResp.json();
    if (!id) return '';

    // 3. Ждём результат (макс 2 минуты)
    for (let i = 0; i < 24; i++) {
      await new Promise(r => setTimeout(r, 5000));
      const poll = await fetch(`https://api.assemblyai.com/v2/transcript/${id}`, {
        headers: { authorization: apiKey },
      }).then(r => r.json());
      if (poll.status === 'completed') return poll.text || '';
      if (poll.status === 'error') { console.error('[reference] AssemblyAI error:', poll.error); return ''; }
    }
    return '';
  } catch (e) {
    console.error('[reference] AssemblyAI exception:', e.message);
    return '';
  }
}

// ── Claude Vision: анализ структуры видео ────────────────────────────────────

async function analyzeStructure(framePaths, transcript) {
  const validFrames = framePaths.slice(0, 15);
  if (validFrames.length === 0) return null;

  const transcriptBlock = transcript
    ? `\nТРАНСКРИПТ РЕЧИ:\n${transcript.slice(0, 2000)}`
    : '\n(Аудио/речь отсутствует — анализируй только визуальную структуру и текст на экране)';

  const prompt = `Ты анализируешь рекламное/промо видео для малого бизнеса (Reels / TikTok / Shorts).
Перед тобой набор кадров из видео + транскрипт речи (если есть).${transcriptBlock}

Определи структуру этого видео. Отвечай СТРОГО в формате JSON (ничего лишнего):
{
  "hook_type": "тип хука первые 3 сек — один из: вопрос / боль / текст_на_экране / удивление / демонстрация / другое",
  "hook_text": "процитируй текст на экране в начале, или опиши что происходит в первые 3 сек",
  "scene_logic": ["сцена 1 — что показано и зачем", "сцена 2 — ...", "сцена 3 — ...", "сцена 4 — ..."],
  "screen_texts": ["все тексты которые написаны на экране в течение видео"],
  "cta_format": "как заканчивается видео — что призывает сделать зрителя",
  "overall_structure": "одна строка — общая логика убеждения от начала до конца"
}`;

  try {
    const result = await askVision(prompt, validFrames, 1000);
    const match = result.match(/\{[\s\S]*\}/);
    if (!match) return null;
    return JSON.parse(match[0]);
  } catch (e) {
    console.error('[reference] Vision analysis error:', e.message);
    return null;
  }
}

// ── Основная функция: анализ референс-видео ──────────────────────────────────

async function analyzeReferenceVideo(videoPath, chatId) {
  const chatStr    = String(chatId);
  const audioPath  = path.join(REFERENCES_DIR, `${chatStr}_audio.mp3`);
  const framePrefix = path.join(REFERENCES_DIR, `${chatStr}_frame_`);

  console.log('[reference] Starting analysis for', chatId);

  // Извлекаем аудио и кадры параллельно
  const [hasAudio, framePaths] = await Promise.all([
    extractAudio(videoPath, audioPath),
    extractFrames(videoPath, framePrefix),
  ]);

  if (framePaths.length === 0) {
    console.error('[reference] No frames extracted for', chatId);
    return null;
  }

  // Транскрибируем звук (если есть AssemblyAI ключ и звук)
  const transcript = hasAudio ? await transcribeAudio(audioPath) : '';

  // Анализируем структуру через Claude Vision
  const pattern = await analyzeStructure(framePaths, transcript);

  // Чистим временные файлы (аудио и кадры) — видео сохраняем для менеджера
  const tempFiles = [audioPath, ...framePaths];
  for (const p of tempFiles) {
    try { if (fs.existsSync(p)) fs.unlinkSync(p); } catch (e) {}
  }

  if (!pattern) return null;

  // Сохраняем паттерн
  const patternPath = path.join(SESSIONS_DIR, `${chatStr}.reference_pattern.json`);
  fs.writeFileSync(patternPath, JSON.stringify(pattern, null, 2));
  console.log('[reference] Pattern saved for', chatId, ':', JSON.stringify(pattern).slice(0, 200));

  return pattern;
}

// ── Вспомогательные функции ───────────────────────────────────────────────────

function loadReferencePattern(chatId) {
  const patternPath = path.join(SESSIONS_DIR, `${String(chatId)}.reference_pattern.json`);
  if (!fs.existsSync(patternPath)) return null;
  try { return JSON.parse(fs.readFileSync(patternPath, 'utf8')); } catch (e) { return null; }
}

function getReferenceVideoPath(chatId) {
  return path.join(REFERENCES_DIR, `${String(chatId)}.reference.mp4`);
}

// Форматирует паттерн для показа менеджеру в Bot3
function formatPatternSummary(pattern) {
  if (!pattern) return '';
  const lines = [
    `Хук: ${pattern.hook_type} — ${pattern.hook_text || ''}`,
    `Структура: ${pattern.overall_structure || ''}`,
  ];
  if (pattern.scene_logic?.length) {
    lines.push('Сцены: ' + pattern.scene_logic.slice(0, 4).join(' → '));
  }
  if (pattern.screen_texts?.length) {
    lines.push('Тексты на экране: ' + pattern.screen_texts.slice(0, 3).join(' / '));
  }
  if (pattern.cta_format) {
    lines.push(`CTA: ${pattern.cta_format}`);
  }
  return lines.join('\n');
}

module.exports = {
  analyzeReferenceVideo,
  loadReferencePattern,
  getReferenceVideoPath,
  downloadFile,
  formatPatternSummary,
  REFERENCES_DIR,
};
