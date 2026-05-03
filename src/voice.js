const fs = require('fs');
const path = require('path');
const https = require('https');

async function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file = fs.createWriteStream(destPath);
    https.get(url, res => {
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
    }).on('error', reject);
  });
}

async function transcribeVoice(bot, fileId) {
  const tmpPath = path.join('/tmp', `voice_${fileId}.ogg`);

  try {
    const fileLink = await bot.telegram.getFileLink(fileId);
    await downloadFile(fileLink.href, tmpPath);

    const formData = new FormData();
    const fileBuffer = fs.readFileSync(tmpPath);
    const blob = new Blob([fileBuffer], { type: 'audio/ogg' });
    formData.append('file', blob, 'voice.ogg');
    formData.append('model', 'whisper-large-v3-turbo');
    formData.append('response_format', 'text');
    formData.append('language', 'ru');

    const response = await fetch('https://api.groq.com/openai/v1/audio/transcriptions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.GROQ_API_KEY}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Groq error: ${err}`);
    }

    const text = await response.text();
    return text.trim();
  } finally {
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

module.exports = { transcribeVoice };
