// Система самообучения промптов — анализирует фидбек менеджера
// и улучшает промпты для Kie.ai Veo3 и GPT-4o-image

const fs   = require('fs');
const path = require('path');
const os   = require('os');

const BASE_DIR     = path.join(os.homedir(), '.marketingdna-client-sessions');
const LEARNING_DIR = path.join(BASE_DIR, 'prompt_learning');

const FEEDBACK_LOG  = path.join(LEARNING_DIR, 'feedback_log.json');
const LESSONS_FILE  = path.join(LEARNING_DIR, 'global_lessons.json');

const THRESHOLD = parseInt(process.env.LEARNING_THRESHOLD || '30', 10);

if (!fs.existsSync(LEARNING_DIR)) fs.mkdirSync(LEARNING_DIR, { recursive: true });

function loadFeedbackLog() {
  try {
    if (fs.existsSync(FEEDBACK_LOG)) return JSON.parse(fs.readFileSync(FEEDBACK_LOG, 'utf8'));
  } catch {}
  return { count: 0, lastAnalysisAt: 0, cyclesCount: 0, entries: [] };
}

function saveFeedbackLog(log) {
  fs.writeFileSync(FEEDBACK_LOG, JSON.stringify(log, null, 2));
}

function loadLessons() {
  try {
    if (fs.existsSync(LESSONS_FILE)) return JSON.parse(fs.readFileSync(LESSONS_FILE, 'utf8'));
  } catch {}
  return { videoLessons: [], imageLessons: [], updatedAt: null, cyclesCount: 0 };
}

// Логирует одну переделку с фидбеком
function logFeedback(type, prompt, feedback) {
  if (!feedback || feedback.trim().length < 3) return; // игнорируем пустой фидбек
  const log = loadFeedbackLog();
  log.entries.push({
    type,   // 'video' | 'image'
    prompt: (prompt || '').slice(0, 400),
    feedback: feedback.trim().slice(0, 300),
    ts: Date.now(),
  });
  log.count++;
  saveFeedbackLog(log);

  // Проверяем порог
  if (log.count >= THRESHOLD) {
    runLearningCycle(log).catch(e => console.error('[learning] runLearningCycle error:', e.message));
  }
}

// Запускает анализ накопленного фидбека
async function runLearningCycle(log) {
  try {
    const { ask } = require('./claude');
    const HAIKU = 'claude-haiku-4-5-20251001';

    const entries = log.entries.slice(-log.count); // берём только новые
    const feedbackText = entries.map((e, i) =>
      `${i + 1}. [${e.type}] Промпт: "${e.prompt.slice(0, 150)}..." → Правка: "${e.feedback}"`
    ).join('\n');

    const result = await ask(
      `You are analyzing feedback from a content manager who reviews AI-generated images and videos for social media.

Here are ${entries.length} recent regeneration requests with the manager's feedback on what was wrong:

${feedbackText}

Analyze these patterns and extract SPECIFIC technical instructions that should be added to ALL future prompts for Kie.ai Veo3 (video) and GPT-4o-image (photo) to prevent these issues.

Focus on: composition errors, technical issues with objects, lighting problems, unwanted elements, perspective issues.
Do NOT focus on niche/business-specific content — only on universal visual/technical quality.

Return ONLY valid JSON, no other text:
{
  "videoLessons": ["instruction 1", "instruction 2"],
  "imageLessons": ["instruction 1", "instruction 2"]
}

Each lesson: 1 clear technical instruction in English, max 20 words. Be specific, not generic.
Example good: "laptop screens must face toward camera, screen open 90 degrees, keyboard visible"
Example bad: "make images better quality"`,
      { model: HAIKU, maxTokens: 600 }
    );

    const match = result.match(/\{[\s\S]*?\}/);
    if (!match) throw new Error('No JSON in response');
    const parsed = JSON.parse(match[0]);

    const current = loadLessons();

    // Мержим новые уроки с существующими (без дублей)
    const mergeUnique = (existing, newItems) => {
      const all = [...existing, ...(newItems || [])];
      // Убираем семантически близкие дубли (упрощённо: по первым словам)
      const seen = new Set();
      return all.filter(l => {
        const key = l.split(' ').slice(0, 3).join(' ').toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }).slice(0, 15); // максимум 15 уроков каждого типа
    };

    const updated = {
      videoLessons:  mergeUnique(current.videoLessons,  parsed.videoLessons),
      imageLessons:  mergeUnique(current.imageLessons,  parsed.imageLessons),
      updatedAt:     new Date().toISOString(),
      cyclesCount:   (current.cyclesCount || 0) + 1,
    };
    fs.writeFileSync(LESSONS_FILE, JSON.stringify(updated, null, 2));

    // Сбрасываем счётчик, оставляем старые записи для истории
    log.count = 0;
    log.lastAnalysisAt = Date.now();
    log.cyclesCount    = (log.cyclesCount || 0) + 1;
    // Оставляем только последние 200 записей
    if (log.entries.length > 200) log.entries = log.entries.slice(-200);
    saveFeedbackLog(log);

    console.log(`[learning] Цикл ${updated.cyclesCount}: video=${updated.videoLessons.length} уроков, image=${updated.imageLessons.length} уроков`);
  } catch (e) {
    console.error('[learning] runLearningCycle failed:', e.message);
  }
}

// Возвращает строку уроков для вставки в промпт
function getVideoLessons() {
  const lessons = loadLessons().videoLessons || [];
  if (!lessons.length) return '';
  return 'LEARNED QUALITY RULES (apply strictly): ' + lessons.join('. ') + '.';
}

function getImageLessons() {
  const lessons = loadLessons().imageLessons || [];
  if (!lessons.length) return '';
  return 'LEARNED QUALITY RULES (apply strictly): ' + lessons.join('. ') + '.';
}

function getLearningStats() {
  const log     = loadFeedbackLog();
  const lessons = loadLessons();
  return {
    totalFeedback:   (log.cyclesCount || 0) * THRESHOLD + (log.count || 0),
    pendingFeedback: log.count || 0,
    threshold:       THRESHOLD,
    cyclesDone:      lessons.cyclesCount || 0,
    videoLessons:    lessons.videoLessons?.length || 0,
    imageLessons:    lessons.imageLessons?.length || 0,
    lastUpdated:     lessons.updatedAt || 'никогда',
  };
}

module.exports = { logFeedback, getVideoLessons, getImageLessons, getLearningStats };
