function parseKeys() {
  const raw =
    process.env.GEMINI_API_KEYS || process.env.GEMINI_API_KEY || '';
  return raw
    .split(/[,;\n]/g)
    .map((s) => s.trim())
    .filter(Boolean);
}

const KEYS = parseKeys();
let keyIndex = 0;

function shouldRotate(error) {
  const msg =
    typeof error === 'object' && error && 'message' in error
      ? String(error.message)
      : String(error);
  return (
    /429|resource_exhausted|quota|rate|limit|api key not valid|permission|unauth/i.test(
      msg
    )
  );
}

exports.handler = async (event) => {
  // Allow preflight for browsers calling cross-origin.
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      },
      body: '',
    };
  }

  if (event.httpMethod !== 'POST') {
    return {
      statusCode: 405,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: 'Method Not Allowed' }),
    };
  }

  try {
    const { contents } = JSON.parse(event.body || '{}');
    if (!contents || !Array.isArray(contents)) {
      return {
        statusCode: 400,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Missing contents array' }),
      };
    }
    if (KEYS.length === 0) {
      return {
        statusCode: 500,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ error: 'Server not configured' }),
      };
    }

    let lastError;
    const attempts = Math.max(1, KEYS.length);

    for (let i = 0; i < attempts; i++) {
      const key = KEYS[keyIndex % KEYS.length];
      const url =
        'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=' +
        encodeURIComponent(key);
      try {
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ contents }),
        });

        if (!response.ok) {
          const body = await response.text().catch(() => '');
          throw new Error(
            `Gemini API returned ${response.status}: ${body || response.statusText}`
          );
        }

        const data = await response.json();
        const text =
          data.candidates && data.candidates[0]
            ? data.candidates[0].content.parts[0].text
            : '';
        return {
          statusCode: 200,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
          body: JSON.stringify({ text }),
        };
      } catch (err) {
        lastError = err;
        if (KEYS.length > 1 && shouldRotate(err)) {
          keyIndex = (keyIndex + 1) % KEYS.length;
          continue;
        }
        throw err;
      }
    }

    throw lastError;
  } catch (error) {
    return {
      statusCode: 500,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ error: error.message }),
    };
  }
};
