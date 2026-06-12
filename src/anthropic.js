import Anthropic from '@anthropic-ai/sdk';

/**
 * Build the Messages API request params for one page transcription
 * (image + prompt). Exported so the dry-run mode can write it to debug/.
 * Note: no `temperature` — sampling parameters are rejected by Opus 4.7+.
 */
export function buildTranscriptionRequest({ model, prompt, imageBase64, mimeType }) {
  return {
    model,
    max_tokens: 16000,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: mimeType, data: imageBase64 } },
          { type: 'text', text: prompt },
        ],
      },
    ],
  };
}

/** Send one image + prompt, return the model's text answer. */
export async function generateText({ apiKey, model, prompt, imageBase64, mimeType }) {
  const client = new Anthropic({ apiKey, maxRetries: 4 });
  const response = await client.messages.create(buildTranscriptionRequest({ model, prompt, imageBase64, mimeType }));
  if (response.stop_reason === 'refusal') {
    throw new Error('Anthropic API declined the request (stop_reason=refusal)');
  }
  const text = response.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');
  if (!text) {
    throw new Error(`Anthropic returned no text. stop_reason=${response.stop_reason}`);
  }
  const meta = { model: response.model, stopReason: response.stop_reason, usage: response.usage };
  return { text, meta };
}
