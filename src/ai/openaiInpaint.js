import OpenAI, { toFile } from 'openai';

let client;
function getClient() {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not set (pass it via podman --env-file .env)');
  }
  client ??= new OpenAI();
  return client;
}

// Mask semantics: pixels with alpha = 0 (transparent) are regenerated, opaque
// pixels are kept as guidance. Mask must match the image dimensions.
export async function inpaintPatch({ imagePng, maskPng, prompt, model, size, quality }) {
  const res = await getClient().images.edit({
    model,
    image: await toFile(imagePng, 'patch.png', { type: 'image/png' }),
    mask: await toFile(maskPng, 'mask.png', { type: 'image/png' }),
    prompt,
    size,
    quality,
    input_fidelity: 'high'
  });
  const b64 = res.data?.[0]?.b64_json;
  if (!b64) throw new Error('images.edit returned no image data');
  return Buffer.from(b64, 'base64');
}
