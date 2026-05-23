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
// Returns { blogId } for the new brand
async function createClientBrand(clientName) {
  const { default: fetch } = await import('node-fetch');
  const url = `${BASE_URL}/admin/simpleProfiles?${ownerParams()}`;
  const res = await fetch(url, {
    method:  'POST',
    headers: { ...authHeaders(), 'Content-Type': 'application/json' },
    body:    JSON.stringify({ title: clientName }),
  });
  const data = await res.json();
  return data;
}

// Get all brands (clients) in the account
async function listBrands() {
  return apiGet(`/admin/simpleProfiles?${ownerParams()}`);
}

// Pull Instagram analytics for a specific client blogId
// Returns { posts, reels, stories } or { error }
async function getInstagramAnalytics(clientBlogId, daysAgo = 14) {
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

module.exports = { getInstagramAnalytics, formatAnalyticsText, createClientBrand, listBrands };
