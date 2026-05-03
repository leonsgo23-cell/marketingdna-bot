// Jina AI Reader — бесплатное чтение любых веб-страниц
async function fetchPage(url) {
  try {
    const jinaUrl = `https://r.jina.ai/${url}`;
    const response = await fetch(jinaUrl, {
      headers: { Accept: 'text/plain' },
    });
    if (!response.ok) return '';
    const text = await response.text();
    return text.slice(0, 10000);
  } catch {
    return '';
  }
}

module.exports = { fetchPage };
