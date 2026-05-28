const Anthropic = require('@anthropic-ai/sdk');
const https = require('https');

const httpsAgent = new https.Agent({ keepAlive: true, family: 4 });

const client = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  maxRetries: 0,
  httpAgent: httpsAgent,
});

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';

async function ask(prompt, { model = HAIKU, maxTokens = 2000, timeoutMs = 150000, label = '' } = {}) {
  const MAX_RETRIES = 3;
  let lastError;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const apiCall = client.messages.create({
        model,
        max_tokens: maxTokens,
        messages: [{ role: 'user', content: prompt }],
      });

      const timeout = new Promise((_, reject) =>
        setTimeout(() => reject(new Error('Claude timeout after ' + timeoutMs + 'ms')), timeoutMs)
      );

      const response = await Promise.race([apiCall, timeout]);
      return response.content[0].text;
    } catch (e) {
      lastError = e;
      const isRetryable = e.message.includes('Connection error') ||
        e.message.includes('ECONNRESET') ||
        e.message.includes('ETIMEDOUT') ||
        e.message.includes('socket hang up') ||
        e.message.includes('Claude timeout') ||
        e.message.includes('rate_limit') ||
        e.status === 529 || e.status === 503 || e.status === 502 || e.status === 429;

      if (isRetryable && attempt < MAX_RETRIES) {
        const isTimeout = e.message.includes('Claude timeout');
        const delay = isTimeout ? attempt * 30000 : attempt * 5000;
        console.warn(`[Claude]${label ? ' [' + label + ']' : ''} Attempt ${attempt} failed: ${e.message}. Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        console.error(`[Claude]${label ? ' [' + label + ']' : ''} All ${attempt} attempts failed. message=${e.message} status=${e.status} code=${e.code} type=${e.type}`);
        throw e;
      }
    }
  }
  throw lastError;
}

async function askSonnet(prompt, maxTokens = 4000, label = '') {
  return ask(prompt, { model: SONNET, maxTokens, timeoutMs: 150000, label });
}

module.exports = { ask, askSonnet, HAIKU, SONNET };
