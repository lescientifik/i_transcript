/* ============================================================ *
 * STATE & LOCAL STORAGE
 * ============================================================ */
const STORAGE_KEY = 'sttbench.v1';

const DEFAULT_STATE = {
  apiKeys: { openrouter: '', mistral: '' },
  lastKeyProvider: 'openrouter',
  selectedModelIds: ['openai/whisper-large-v3-turbo'],
  lang: 'fr',
  defaultPrompt: 'Transcris cet audio mot à mot. Réponds uniquement avec la transcription, sans aucun commentaire.',
  autoRunCopy: false,
  vadEnabled: false,
  shortcuts: {
    record: 'F',
    cancel: 'Z',
    send: 'Enter',
    copy: 'K',
    settings: ','
  }
};

export let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return JSON.parse(JSON.stringify(DEFAULT_STATE));
    const parsed = JSON.parse(raw);
    return {
      ...DEFAULT_STATE,
      ...parsed,
      apiKeys: { ...DEFAULT_STATE.apiKeys, ...(parsed.apiKeys || {}) },
      shortcuts: { ...DEFAULT_STATE.shortcuts, ...(parsed.shortcuts || {}) }
    };
  } catch (e) {
    console.warn('Failed to load state, using defaults', e);
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

export function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { console.warn('Failed to save state', e); }
}

