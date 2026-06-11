// Metricool API integration for bi-weekly analytics

const BASE_URL = 'https://app.metricool.com/api';

function authHeaders() {
  return { 'X-Mc-Auth': process.env.METRICOOL_API_KEY };
}

function ownerParams() {
  return `userId=${process.env.METRICOOL_USER_ID}&blogId=${process.env.METRICOOL_BLOG_ID}`;
}

function dateRange(daysAgo = 14) {
  const end   = new Date();
  const start = new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000);
  const fmt   = d => d.toISOString().slice(0, 19); // yyyy-MM-ddTHH:mm:ss
  return { from: fmt(start), to: fmt(end) };
}

async function apiGet(path) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(`${BASE_URL}${path}`, { headers: authHeaders() });
  const text = await res.text();
  try { return JSON.parse(text); } catch { return { error: text }; }
}

// Create a new brand (client) in Metricool
// Returns new brand object with id (blogId)
async function createClientBrand(clientName) {
  const { default: fetch } = await import('node-fetch');
  const url = `${BASE_URL}/admin/add-profile?userId=${process.env.METRICOOL_USER_ID}&blogId=${process.env.METRICOOL_BLOG_ID}`;
  const res = await fetch(url, { headers: authHeaders() });
  const brand = await res.json();
  // Set the brand name
  if (brand?.id) {
    await fetch(`${BASE_URL}/admin/update-label-blog?userId=${process.env.METRICOOL_USER_ID}&blogId=${brand.id}`, {
      method:  'POST',
      headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body:    JSON.stringify({ label: clientName }),
    }).catch(() => {});
  }
  return brand;
}

// Check if Instagram is connected for a given clientBlogId
// Returns { connected: bool, followers: number|null }
// Считаем подключённым только если есть username — иначе ложная тревога
async function isInstagramConnected(clientBlogId) {
  const brands = await apiGet(`/admin/simpleProfiles?userId=${process.env.METRICOOL_USER_ID}&blogId=${process.env.METRICOOL_BLOG_ID}`);
  if (!Array.isArray(brands)) return { connected: false, followers: null };
  const brand = brands.find(b => b.id === Number(clientBlogId));
  const ig = brand?.instagram;
  if (!ig) return { connected: false, followers: null };
  // Только если есть username или userId — значит реально подключён
  const hasRealConnection = !!(ig.username || ig.userId || ig.socialNetworkId);
  if (!hasRealConnection) return { connected: false, followers: null };
  const followers = ig.followers ?? ig.followersCount ?? null;
  return { connected: true, followers };
}

// Get all brands (clients) in the account
async function listBrands() {
  return apiGet(`/admin/simpleProfiles?${ownerParams()}`);
}

// Pull Instagram analytics for a specific client blogId
// Returns { posts, reels, stories } or { error }
async function getInstagramAnalytics(clientBlogId, daysAgo = 15) {
  const { from, to } = dateRange(daysAgo);
  const params = `userId=${process.env.METRICOOL_USER_ID}&blogId=${clientBlogId}&from=${from}&to=${to}`;

  const [posts, reels, stories] = await Promise.all([
    apiGet(`/v2/analytics/posts/instagram?${params}`),
    apiGet(`/v2/analytics/reels/instagram?${params}`),
    apiGet(`/v2/analytics/stories/instagram?${params}`),
  ]);

  if (posts.code === '403' || reels.code === '403') {
    return { connected: false };
  }

  return { connected: true, posts, reels, stories, from, to };
}

// Format analytics data as text for buildAnalyticsPrompt()
function formatAnalyticsText(data) {
  if (!data.connected) return 'Instagram не подключён к Metricool.';

  const lines = [`Период: ${data.from} — ${data.to}`, ''];

  if (Array.isArray(data.posts?.data)) {
    lines.push('ПОСТЫ:');
    data.posts.data.slice(0, 10).forEach((p, i) => {
      lines.push(
        `${i + 1}. "${p.text?.slice(0, 60) || 'без текста'}"` +
        ` | Охват: ${p.reach || 0}` +
        ` | Лайки: ${p.likes || 0}` +
        ` | Сохранения: ${p.saved || 0}` +
        ` | Переходы в профиль: ${p.profileVisits || 0}`
      );
    });
    lines.push('');
  }

  if (Array.isArray(data.reels?.data)) {
    lines.push('REELS:');
    data.reels.data.slice(0, 8).forEach((r, i) => {
      lines.push(
        `${i + 1}. "${r.text?.slice(0, 60) || 'без текста'}"` +
        ` | Просмотры: ${r.plays || 0}` +
        ` | % досмотра: ${r.videoViewPercentage || 0}%` +
        ` | Сохранения: ${r.saved || 0}` +
        ` | Поделились: ${r.shares || 0}`
      );
    });
    lines.push('');
  }

  if (Array.isArray(data.stories?.data)) {
    lines.push('STORIES:');
    data.stories.data.slice(0, 15).forEach((s, i) => {
      lines.push(
        `${i + 1}. Просмотры: ${s.views || 0}` +
        ` | Ответы: ${s.replies || 0}` +
        ` | Выходы: ${s.exits || 0}` +
        ` | Переходы по ссылке: ${s.linkTaps || 0}`
      );
    });
  }

  return lines.join('\n');
}

// Extract numeric summary from analytics data — saved to session.analyticsHistory
function extractMetricsSummary(data, followersCount) {
  const avg = (arr, key) => {
    const vals = arr.map(x => x[key] || 0).filter(v => v > 0);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : 0;
  };
  const sum = (arr, key) => arr.reduce((a, x) => a + (x[key] || 0), 0);

  const posts   = Array.isArray(data.posts?.data)   ? data.posts.data   : [];
  const reels   = Array.isArray(data.reels?.data)   ? data.reels.data   : [];
  const stories = Array.isArray(data.stories?.data) ? data.stories.data : [];

  const totalEngagements = sum(posts, 'likes') + sum(posts, 'saved') + sum(posts, 'comments') +
                           sum(reels, 'likes') + sum(reels, 'saved') + sum(reels, 'comments');
  const totalReach       = sum(posts, 'reach') + sum(reels, 'reach');
  const engagementRate   = totalReach > 0 ? +((totalEngagements / totalReach) * 100).toFixed(1) : 0;

  return {
    followersCount:     followersCount || null,
    avgReelsViews:      avg(reels, 'plays'),
    avgReelsWatchPct:   avg(reels, 'videoViewPercentage'),
    avgPostSaves:       avg(posts, 'saved'),
    avgStoryViews:      avg(stories, 'views'),
    avgStoryExitRate:   stories.length
      ? +(stories.reduce((a, s) => a + (s.views > 0 ? (s.exits || 0) / s.views : 0), 0) / stories.length * 100).toFixed(1)
      : 0,
    engagementRate,
    totalPosts:         posts.length,
    totalReels:         reels.length,
    totalStories:       stories.length,
  };
}

// ── Публикация через аккаунт клиента ─────────────────────────────────────────

// Нормализует URL изображения в Metricool mediaId
async function normalizeImageUrl(apiKey, imageUrl) {
  const { default: fetch } = await import('node-fetch');
  const res = await fetch(
    `${BASE_URL}/actions/normalize/image/url?url=${encodeURIComponent(imageUrl)}`,
    { headers: { 'X-Mc-Auth': apiKey } }
  );
  const data = await res.json();
  return data?.mediaId || data?.id || null;
}

// Планирует один пост через Metricool аккаунт клиента
// credentials: { apiKey, userId, blogId }
// post: { text, imageUrl, networks, scheduledAt, timezone }
async function scheduleClientPost(credentials, post) {
  const { apiKey, userId, blogId } = credentials;
  const { text, imageUrl, networks = ['instagram'], scheduledAt, timezone = 'Europe/Riga' } = post;

  const { default: fetch } = await import('node-fetch');

  // Шаг 1: нормализуем URL изображения → получаем mediaId
  let mediaId = null;
  if (imageUrl) {
    try {
      mediaId = await normalizeImageUrl(apiKey, imageUrl);
    } catch (e) {
      console.error('[metricool] normalizeImageUrl error:', e.message);
    }
  }

  // Шаг 2: создаём запланированный пост
  const body = {
    text,
    publicationDate: {
      dateTime: scheduledAt, // формат: "2026-06-15T10:00:00"
      timezone,
    },
    providers: networks.map(n => ({ network: n })),
    autoPublish: true,
    ...(mediaId ? { media: { mediaId } } : {}),
  };

  const res = await fetch(
    `${BASE_URL}/v2/scheduler/posts?userId=${userId}&blogId=${blogId}`,
    {
      method: 'POST',
      headers: { 'X-Mc-Auth': apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  const result = await res.json();
  console.log(`[metricool] schedulePost → status=${res.status} result=${JSON.stringify(result).slice(0, 200)}`);
  return { ok: res.ok, status: res.status, result };
}

// Получить аналитику используя КЛИЕНТСКИЕ ключи (не мастер-аккаунт)
async function getClientAnalytics(credentials, daysAgo = 15) {
  const { apiKey, userId, blogId } = credentials;
  const { from, to } = dateRange(daysAgo);
  const params = `userId=${userId}&blogId=${blogId}&from=${from}&to=${to}`;

  const { default: fetch } = await import('node-fetch');
  const headers = { 'X-Mc-Auth': apiKey };

  const [posts, reels, stories] = await Promise.all([
    fetch(`${BASE_URL}/v2/analytics/posts/instagram?${params}`, { headers }).then(r => r.json()).catch(() => ({})),
    fetch(`${BASE_URL}/v2/analytics/reels/instagram?${params}`, { headers }).then(r => r.json()).catch(() => ({})),
    fetch(`${BASE_URL}/v2/analytics/stories/instagram?${params}`, { headers }).then(r => r.json()).catch(() => ({})),
  ]);

  if (posts.code === '403' || reels.code === '403') return { connected: false };
  return { connected: true, posts, reels, stories, from, to };
}

// Generate a one-time anonymous connection link (no Metricool account required)
// Valid for ~71 hours. Client just opens it and connects Instagram directly.
async function generateAnonymousLink(clientBlogId) {
  const { default: fetch } = await import('node-fetch');
  const url = `${BASE_URL}/v2/settings/brands/connections/anonymous-link?userId=${process.env.METRICOOL_USER_ID}&blogId=${clientBlogId}`;
  const res = await fetch(url, { method: 'POST', headers: authHeaders() });
  const data = await res.json();
  return data?.data?.link || null;
}

module.exports = {
  getInstagramAnalytics, formatAnalyticsText, extractMetricsSummary,
  createClientBrand, listBrands, isInstagramConnected,
  scheduleClientPost, normalizeImageUrl, getClientAnalytics,
  generateAnonymousLink,
};
