import { GoogleGenAI } from '@google/genai';
import { AnalysisSchema, analysisResponseSchema, ANALYSIS_PROMPT } from './schemas.js';

let client;
function getClient() {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set (pass it via podman --env-file .env)');
  }
  client ??= new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  return client;
}

export async function analyzePage(pngBuffer, model) {
  const res = await getClient().models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: pngBuffer.toString('base64') } },
          { text: ANALYSIS_PROMPT }
        ]
      }
    ],
    config: {
      responseMimeType: 'application/json',
      responseSchema: analysisResponseSchema
    }
  });
  return AnalysisSchema.parse(JSON.parse(res.text));
}

export async function generateCoverImage(refPngBuffer, { model, prompt, aspectRatio, imageSize }) {
  const res = await getClient().models.generateContent({
    model,
    contents: [
      {
        role: 'user',
        parts: [
          { inlineData: { mimeType: 'image/png', data: refPngBuffer.toString('base64') } },
          { text: prompt }
        ]
      }
    ],
    config: {
      imageConfig: { aspectRatio, imageSize }
    }
  });
  for (const part of res.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData?.data) return Buffer.from(part.inlineData.data, 'base64');
  }
  throw new Error(`Cover model "${model}" returned no image. Text: ${res.text || '(none)'}`);
}
