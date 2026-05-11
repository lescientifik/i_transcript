import { cachedResults, currentAudioId } from '../audio.js';
import { state } from './state.js';

/* ============================================================ *
 * MODELS CATALOG
 * ============================================================ */
// Each model carries `requiredKey` — the API key that must be present
// in localStorage for the model to be usable. UI greys out models whose
// key is missing.
//
// Note on duplicates: Voxtral Small is available via BOTH providers.
// We list the OpenRouter version first (preferred default).
export const MODELS = [
  // ---- OpenRouter — dedicated STT (audio->transcription endpoint) ----
  {
    id: 'openai/whisper-large-v3-turbo',
    provider: 'openrouter', requiredKey: 'openrouter',
    endpoint: 'transcription',
    name: 'Whisper Large V3 Turbo',
    priceLabel: '$0.04 / hour',
    pricing: { type: 'per_hour', perHour: 0.04 },
    tags: ['STT dédié', 'Groq']
  },
  {
    id: 'openai/whisper-large-v3',
    provider: 'openrouter', requiredKey: 'openrouter',
    endpoint: 'transcription',
    name: 'Whisper Large V3',
    priceLabel: '$0.111 / hour',
    pricing: { type: 'per_hour', perHour: 0.111 },
    tags: ['STT dédié', 'Groq']
  },
  {
    id: 'openai/whisper-1',
    provider: 'openrouter', requiredKey: 'openrouter',
    endpoint: 'transcription',
    name: 'Whisper 1',
    priceLabel: '$0.006 / minute',
    pricing: { type: 'per_minute', perMin: 0.006 },
    tags: ['STT dédié']
  },
  {
    id: 'openai/gpt-4o-mini-transcribe',
    provider: 'openrouter', requiredKey: 'openrouter',
    endpoint: 'transcription',
    name: 'GPT-4o Mini Transcribe',
    priceLabel: '$0.003 / minute',
    pricing: { type: 'per_minute', perMin: 0.003 },
    tags: ['STT dédié']
  },
  {
    id: 'openai/gpt-4o-transcribe',
    provider: 'openrouter', requiredKey: 'openrouter',
    endpoint: 'transcription',
    name: 'GPT-4o Transcribe',
    priceLabel: '$0.006 / minute',
    pricing: { type: 'per_minute', perMin: 0.006 },
    tags: ['STT dédié']
  },

  // ---- OpenRouter — multimodal chat completions ----
  {
    id: 'mistralai/voxtral-small-24b-2507',
    provider: 'openrouter', requiredKey: 'openrouter',
    endpoint: 'chat',
    name: 'Voxtral Small 24B (via OR)',
    priceLabel: '~$0.006/min ($100/M sec audio + text out)',
    pricing: {
      type: 'multimodal',
      audioPerSec: 0.0001,        // $100 / 1M sec
      textOutPerToken: 0.0000003  // $0.30 / 1M tokens
    },
    tags: ['multimodal', 'preferred']
  },
  {
    id: 'google/gemini-3.1-flash-lite',
    provider: 'openrouter', requiredKey: 'openrouter',
    endpoint: 'chat',
    name: 'Gemini 3.1 Flash Lite',
    priceLabel: '~$0.00125/min (audio: $0.50/M tok, text: $1.50/M tok)',
    pricing: {
      type: 'multimodal',
      audioPerToken: 0.0000005,   // $0.50 / 1M tokens
      audioTokensPerSec: 32,      // Google docs: 32 tok/sec
      textOutPerToken: 0.0000015  // $1.50 / 1M tokens
    },
    tags: ['multimodal']
  },

  // ---- Mistral direct API ----
  {
    id: 'voxtral-mini-latest',
    provider: 'mistral', requiredKey: 'mistral',
    endpoint: 'transcription',
    name: 'Voxtral Mini Transcribe V2',
    priceLabel: '$0.003 / minute',
    pricing: { type: 'per_minute', perMin: 0.003 },
    tags: ['STT dédié', 'Mistral only']
  },
  {
    // Voxtral Small is also available via Mistral directly (alternative).
    // Same model as the OpenRouter entry above; OR version is preferred by default.
    id: 'voxtral-small-latest',
    provider: 'mistral', requiredKey: 'mistral',
    endpoint: 'transcription',
    name: 'Voxtral Small (via Mistral)',
    priceLabel: '$100/M sec audio (≈ $0.006/min)',
    pricing: { type: 'per_minute', perMin: 0.006 },
    tags: ['STT dédié', 'alternative']
  }
];

export function isModelAvailable(model) {
  if (!model) return false;
  return !!(state.apiKeys[model.requiredKey] || '').trim();
}

function getAvailableSelectedModels() {
  return state.selectedModelIds
    .map(id => MODELS.find(m => m.id === id))
    .filter(m => m && isModelAvailable(m));
}

// True if model already has a successful transcript for the current audio.
export function hasFreshSuccess(modelId) {
  const r = cachedResults[modelId];
  return !!(r && r.audioId === currentAudioId && r.text != null);
}

// Models that still need to be transcribed for the current audio.
export function getModelsToRun() {
  return getAvailableSelectedModels().filter(m => !hasFreshSuccess(m.id));
}

