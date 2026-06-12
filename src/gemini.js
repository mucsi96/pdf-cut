/**
 * Minimal REST client for Gemini (generativelanguage.googleapis.com,
 * generateContent): image generation for the cover stage and vision→text
 * transcription for the markdown stage.
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

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

async function postWithRetry({ url, apiKey, body, log }) {
  const maxAttempts = 4;
  let lastErr;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify(body),
    });
    if (res.status === 429 || res.status >= 500) {
      const wait = 2000 * 2 ** (attempt - 1);
      lastErr = new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 500)}`);
      log(`  gemini: ${res.status}, retrying in ${wait / 1000}s (attempt ${attempt}/${maxAttempts})`);
      await new Promise((r) => setTimeout(r, wait));
      continue;
    }
    if (!res.ok) {
      throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 2000)}`);
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
    throw new Error(`Gemini returned no text. finishReason=${candidate?.finishReason}`);
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
        (textPart ? ` text="${textPart.text.slice(0, 300)}"` : ''),
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
