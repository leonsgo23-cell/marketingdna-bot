const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';

async function ask(prompt, { model = HAIKU, maxTokens = 2000, timeoutMs = 150000 } = {}) {
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
        e.status === 529 || e.status === 503 || e.status === 502;

      if (isRetryable && attempt < MAX_RETRIES) {
        const delay = attempt * 5000;
        console.warn(`[Claude] Attempt ${attempt} failed: ${e.message}. Retrying in ${delay}ms...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw e;
      }
    }
  }
  throw lastError;
}

async function askSonnet(prompt, maxTokens = 4000) {
  return ask(prompt, { model: SONNET, maxTokens, timeoutMs: 300000 });
}

module.exports = { ask, askSonnet, HAIKU, SONNET };
