async function fetchPage(url) {
  try {
    const response = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        urls: [url],
      }),
    });
    const data = await response.json();
    if (data.results && data.results[0]) {
      return data.results[0].raw_content || data.results[0].content || '';
    }
    return '';
  } catch {
    return '';
  }
}

async function search(query, maxResults = 5) {
  try {
    const response = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        api_key: process.env.TAVILY_API_KEY,
        query,
        max_results: maxResults,
        include_raw_content: false,
      }),
    });
    const data = await response.json();
    return (data.results || []).map(r => `${r.title}\n${r.url}\n${r.content}`).join('\n\n');
  } catch {
    return '';
  }
}

module.exports = { fetchPage, search };
