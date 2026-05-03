const Anthropic = require('@anthropic-ai/sdk');

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const HAIKU = 'claude-haiku-4-5-20251001';
const SONNET = 'claude-sonnet-4-6';

async function ask(prompt, { model = HAIKU, maxTokens = 2000, timeoutMs = 150000 } = {}) {
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
}

async function askSonnet(prompt, maxTokens = 4000) {
  return ask(prompt, { model: SONNET, maxTokens, timeoutMs: 150000 });
}

module.exports = { ask, askSonnet, HAIKU, SONNET };
