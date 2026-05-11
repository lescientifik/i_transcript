/* ============================================================ *
 * OPENROUTER TRANSCRIPTION (pure, no DOM, no state)
 *
 * Single entry point used by both the main recorder app and the
 * upload app. Caller owns:
 *   - blob format (caller must pass a blob already in one of
 *     OpenRouter's accepted formats; main app encodes to WAV first
 *     via shared/audio-codec.js, upload app may pass natively).
 *   - apiKey retrieval (kept out of this module so it stays pure).
 *   - language hint (optional).
 *   - AbortController (caller passes signal for upload app cancel).
 *
 * Returns { text, usage } — same shape transcribeOpenRouter used to
 * return so runTranscriptions doesn't need any rewrite at the call
 * site.
 * ============================================================ */

export const EXTENSION_TO_FORMAT = {
  '.wav':  'wav',
  '.mp3':  'mp3',
  '.flac': 'flac',
  '.m4a':  'm4a',
  '.mp4':  'm4a',   // mp4 audio container → format m4a side OpenRouter
  '.ogg':  'ogg',
  '.oga':  'ogg',
  '.opus': 'ogg',   // .opus is typically OGG-encapsulated
  '.webm': 'webm',
  '.aac':  'aac',
};

export function extensionToFormat(filename) {
  const ext = filename.toLowerCase().match(/\.[a-z0-9]+$/)?.[0];
  return EXTENSION_TO_FORMAT[ext] ?? null;
}

async function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => {
      const dataUrl = r.result;
      const idx = dataUrl.indexOf(',');
      resolve(dataUrl.substring(idx + 1));
    };
    r.onerror = reject;
    r.readAsDataURL(blob);
  });
}

/* Schema discovered from API: { model, input_audio: { data, format }, language? }
 * Body is JSON, NOT multipart form-data. */
export async function postOpenRouterTranscription({ blob, modelId, language, apiKey, format, signal }) {
  if (!apiKey) throw new Error('OpenRouter API key missing');
  const b64 = await blobToBase64(blob);
  const body = {
    model: modelId,
    input_audio: { data: b64, format }
  };
  if (language) body.language = language;
  const res = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://lescientifik.github.io/i_transcript/',
      'X-OpenRouter-Title': 'i_transcript'
    },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${errText.substring(0, 250)}`);
  }
  const json = await res.json();
  return { text: json.text || '', usage: json.usage || null };
}
