/**
 * Minimal REST client for Gemini (generativelanguage.googleapis.com,
 * generateContent): image generation for the cover stage and vision→text
 * transcription for the markdown stage.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

// Image generation (4K Nano Banana Pro) can keep the connection open for
// minutes before the first response header arrives — Node's default headers
// timeout then aborts the request as UND_ERR_HEADERS_TIMEOUT. Use an undici
// dispatcher with a generous headers/body timeout (override via
// GEMINI_HTTP_TIMEOUT_MS). Loaded lazily so a missing undici just falls back
// to the default fetch timeouts.
const HTTP_TIMEOUT_MS = Number(process.env.GEMINI_HTTP_TIMEOUT_MS) || 15 * 60 * 1000;
let dispatcherPromise;
async function getDispatcher() {
  if (dispatcherPromise === undefined) {
    dispatcherPromise = import('undici')
      .then(({ Agent }) => new Agent({ headersTimeout: HTTP_TIMEOUT_MS, bodyTimeout: HTTP_TIMEOUT_MS, connectTimeout: 30_000 }))
      .catch(() => null);
  }
  return dispatcherPromise;
}

export const SUPPORTED_ASPECT_RATIOS = ['21:9', '16:9', '3:2', '4:3', '5:4', '1:1', '4:5', '3:4', '2:3', '9:16'];

export function closestAspectRatio(actual) {
  let best = SUPPORTED_ASPECT_RATIOS[0];
  let bestDiff = Infinity;
  for (const r of SUPPORTED_ASPECT_RATIOS) {
    const [w, h] = r.split(':').map(Number);
    const diff = Math.abs(w / h - actual);
    if (diff < bestDiff) {
      bestDiff = diff;
      best = r;
    }
  }
  return best;
}

/** Flatten an error's cause/aggregate chain into a short, readable string. */
function describeError(err) {
  const parts = [];
  const seen = new Set();
  const walk = (e) => {
    if (!e || seen.has(e)) return;
    seen.add(e);
    if (e.code) parts.push(e.code);
    else if (e.message) parts.push(e.message);
    for (const sub of e.errors || []) walk(sub);
    walk(e.cause);
  };
  walk(err);
  return [...new Set(parts)].join(' → ') || String(err);
}

async function postWithRetry({ url, apiKey, body, log }) {
  const maxAttempts = 5;
  const dispatcher = await getDispatcher();
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const wait = 2000 * 2 ** (attempt - 1);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify(body),
        ...(dispatcher ? { dispatcher } : {}),
      });
    } catch (err) {
      // Network-level failure (DNS, connection reset, timeout). fetch throws a
      // bare "fetch failed"; the real reason hides in err.cause — surface it.
      lastErr = new Error(`Gemini API request failed: ${describeError(err)}`, { cause: err });
      if (attempt < maxAttempts) {
        log(`  gemini: network error (${describeError(err)}), retrying in ${wait / 1000}s (attempt ${attempt}/${maxAttempts})`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw lastErr;
    }
    // Print the full response body verbatim — the model often explains a
    // failure (quota, safety block, bad request) in the body, so never truncate.
    if (res.status === 429 || res.status >= 500) {
      lastErr = new Error(`Gemini API ${res.status} ${res.statusText}: ${await res.text()}`);
      if (attempt < maxAttempts) {
        log(`  gemini: ${res.status}, retrying in ${wait / 1000}s (attempt ${attempt}/${maxAttempts})`);
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      throw lastErr;
    }
    if (!res.ok) {
      throw new Error(`Gemini API ${res.status} ${res.statusText}: ${await res.text()}`);
    }
    return res.json();
  }
  throw lastErr;
}

export function buildTextRequestBody({ prompt, imageBase64, mimeType, temperature }) {
  return {
    contents: [
      {
        role: 'user',
        parts: [
          { inline_data: { mime_type: mimeType, data: imageBase64 } },
          { text: prompt },
        ],
      },
    ],
    generationConfig: {
      ...(temperature != null ? { temperature } : {}),
    },
  };
}

/** Send one image + prompt, return the model's text answer. */
export async function generateText({ apiKey, model, prompt, imageBase64, mimeType, temperature, log = () => {} }) {
  const url = `${API_BASE}/${model}:generateContent`;
  const body = buildTextRequestBody({ prompt, imageBase64, mimeType, temperature });
  const json = await postWithRetry({ url, apiKey, body, log });
  const candidate = json?.candidates?.[0];
  const text = (candidate?.content?.parts || [])
    .filter((p) => p.text && !p.thought)
    .map((p) => p.text)
    .join('');
  if (!text) {
    throw new Error(`Gemini returned no text. finishReason=${candidate?.finishReason}. Response: ${JSON.stringify(json)}`);
  }
  const meta = { model, finishReason: candidate?.finishReason, usageMetadata: json?.usageMetadata };
  return { text, meta };
}

export function buildRequestBody({ prompt, imageBase64, mimeType, aspectRatio, imageSize }) {
  return {
    contents: [
      {
        role: 'user',
        parts: [
          { inline_data: { mime_type: mimeType, data: imageBase64 } },
          { text: prompt },
        ],
      },
    ],
    generationConfig: {
      responseModalities: ['IMAGE'],
      imageConfig: {
        ...(imageSize ? { imageSize } : {}),
        ...(aspectRatio ? { aspectRatio } : {}),
      },
    },
  };
}

export async function generateImage({ apiKey, model, prompt, imageBase64, mimeType, aspectRatio, imageSize, log = () => {} }) {
  const url = `${API_BASE}/${model}:generateContent`;
  const body = buildRequestBody({ prompt, imageBase64, mimeType, aspectRatio, imageSize });
  const json = await postWithRetry({ url, apiKey, body, log });
  const parts = json?.candidates?.[0]?.content?.parts || [];
  const imagePart = parts.find((p) => p.inlineData?.data || p.inline_data?.data);
  if (!imagePart) {
    const textPart = parts.find((p) => p.text);
    throw new Error(
      `Gemini returned no image. finishReason=${json?.candidates?.[0]?.finishReason}` +
        (textPart ? ` text="${textPart.text}"` : '') +
        ` promptFeedback=${JSON.stringify(json?.promptFeedback)}`,
    );
  }
  const data = imagePart.inlineData?.data || imagePart.inline_data?.data;
  const meta = {
    model,
    finishReason: json?.candidates?.[0]?.finishReason,
    usageMetadata: json?.usageMetadata,
  };
  return { buffer: Buffer.from(data, 'base64'), meta };
}
