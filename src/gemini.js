/**
 * Minimal REST client for Gemini image generation
 * (generativelanguage.googleapis.com, generateContent with IMAGE modality).
 */

const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models';

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
    const json = await res.json();
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
  throw lastErr;
}
