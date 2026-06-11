import Anthropic from '@anthropic-ai/sdk';
import { AnalysisSchema, ANALYSIS_PROMPT } from './schemas.js';

let client;
function getClient() {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY is not set (pass it via podman --env-file .env)');
  }
  client ??= new Anthropic();
  return client;
}

export async function analyzePage(pngBuffer, model) {
  const res = await getClient().messages.create({
    model,
    max_tokens: 2000,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: pngBuffer.toString('base64') }
          },
          { type: 'text', text: `${ANALYSIS_PROMPT}\nRespond with ONLY the JSON object, no markdown fences.` }
        ]
      }
    ]
  });
  const text = res.content.find((b) => b.type === 'text')?.text || '';
  const json = text.replace(/^```(?:json)?\s*/m, '').replace(/```\s*$/m, '').trim();
  return AnalysisSchema.parse(JSON.parse(json));
}
