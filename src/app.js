'use strict';

/* ============================================================ *
 * MODELS CATALOG
 * ============================================================ */
// Each model carries `requiredKey` — the API key that must be present
// in localStorage for the model to be usable. UI greys out models whose
// key is missing.
//
// Note on duplicates: Voxtral Small is available via BOTH providers.
// We list the OpenRouter version first (preferred default).
const MODELS = [
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

function isModelAvailable(model) {
  if (!model) return false;
  return !!(state.apiKeys[model.requiredKey] || '').trim();
}

function getAvailableSelectedModels() {
  return state.selectedModelIds
    .map(id => MODELS.find(m => m.id === id))
    .filter(m => m && isModelAvailable(m));
}

// True if model already has a successful transcript for the current audio.
function hasFreshSuccess(modelId) {
  const r = cachedResults[modelId];
  return !!(r && r.audioId === currentAudioId && r.text != null);
}

// Models that still need to be transcribed for the current audio.
function getModelsToRun() {
  return getAvailableSelectedModels().filter(m => !hasFreshSuccess(m.id));
}

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
    send: 'Enter',
    copy: 'K',
    settings: ','
  }
};

let state = loadState();

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

function saveState() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); }
  catch (e) { console.warn('Failed to save state', e); }
}

/* ============================================================ *
 * DOM REFS
 * ============================================================ */
const $ = (id) => document.getElementById(id);
const dom = {
  selectedLabel: $('selected-label'),
  costStrip: $('cost-strip'),
  recBtn: $('rec-btn'),
  recBtnLabel: $('rec-btn-label'),
  timer: $('timer'),
  recStatus: $('rec-status'),
  langSelect: $('lang-select'),
  sendBtn: $('send-btn'),
  sendKbd: $('send-kbd'),
  promptRow: $('prompt-row'),
  promptText: $('prompt-text'),
  resultsContainer: $('results-container'),
  drawerBackdrop: $('drawer-backdrop'),
  drawer: $('drawer'),
  drawerClose: $('drawer-close'),
  settingsBtn: $('settings-btn'),
  keyProvider: $('key-provider'),
  keyForm: $('key-form'),
  keyUsername: $('key-username'),
  keyInput: $('key-input'),
  keySaved: $('key-saved'),
  keySavedLabel: $('key-saved-label'),
  keyEditBtn: $('key-edit-btn'),
  keyClearBtn: $('key-clear-btn'),
  modelList: $('model-list'),
  defaultPrompt: $('default-prompt'),
  autoRunCopy: $('auto-run-copy'),
  vadEnabled: $('vad-enabled'),
  scRecord: $('sc-record'),
  scSend: $('sc-send'),
  scCopy: $('sc-copy'),
  scSettings: $('sc-settings'),
  toast: $('toast')
};

/* ============================================================ *
 * RECORDING
 * ============================================================ */
let mediaRecorder = null;
let recordedChunks = [];
let recordedBlob = null;
let recordedDurationSec = 0;
let recStartedAt = 0;
let timerHandle = null;
let isRecording = false;
// Per-audio result cache so model-selection changes don't wipe paid transcripts.
// Successful entries also gate the Send button (no re-charging on unchanged audio).
let currentAudioId = null;
const cachedResults = {}; // modelId -> { audioId, text?, costUsd?, durationSec?, error? }
// Original (pre-VAD) duration so we can show "X → Y" savings in the UI.
let originalDurationSec = 0;

async function startRecording() {
  if (isRecording) return;
  recordedChunks = [];
  recordedBlob = null;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    showToast('Microphone access denied: ' + err.message, 'error');
    return;
  }

  // Prefer webm/opus
  const mimeCandidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus'];
  let mimeType = '';
  for (const m of mimeCandidates) {
    if (MediaRecorder.isTypeSupported(m)) { mimeType = m; break; }
  }

  mediaRecorder = new MediaRecorder(stream, mimeType ? { mimeType } : {});
  mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
  mediaRecorder.onstop = async () => {
    recordedDurationSec = (Date.now() - recStartedAt) / 1000;
    recordedBlob = new Blob(recordedChunks, { type: mediaRecorder.mimeType || 'audio/webm' });
    stream.getTracks().forEach(t => t.stop());
    isRecording = false;
    currentAudioId = Date.now(); // invalidates cached results from prior audio
    originalDurationSec = recordedDurationSec;

    if (state.vadEnabled) {
      dom.recStatus.innerHTML = '<span class="live">⏳ trimming silence…</span>';
      dom.sendBtn.disabled = true;
      try {
        const { blob, originalSec, trimmedSec } = await trimWithVAD(recordedBlob);
        recordedBlob = blob;
        originalDurationSec = originalSec;
        recordedDurationSec = trimmedSec;
      } catch (err) {
        console.warn('VAD trim failed, using original audio', err);
        showToast('VAD trim failed: ' + err.message, 'error');
      }
    }

    updateRecorderUI();
    refreshCostStrip();
    renderResultsLayout(); // clear stale result cards from previous audio
    // Auto-flow (mono mode): kick off transcription right away
    if (state.autoRunCopy && state.selectedModelIds.length === 1 && getModelsToRun().length > 0) {
      runTranscriptions();
    }
  };
  mediaRecorder.start();
  recStartedAt = Date.now();
  isRecording = true;
  updateRecorderUI();
  startTimer();
}

function stopRecording() {
  if (!isRecording) return;
  mediaRecorder.stop();
  stopTimer();
}

function startTimer() {
  if (timerHandle) clearInterval(timerHandle);
  const tick = () => {
    const ms = Date.now() - recStartedAt;
    dom.timer.textContent = formatTimer(ms);
  };
  tick();
  timerHandle = setInterval(tick, 100);
}

function stopTimer() {
  if (timerHandle) { clearInterval(timerHandle); timerHandle = null; }
}

function formatTimer(ms) {
  const totalSec = ms / 1000;
  const m = Math.floor(totalSec / 60).toString().padStart(2, '0');
  const s = (totalSec % 60).toFixed(1).padStart(4, '0');
  return `${m}:${s}`;
}

function updateRecorderUI() {
  if (isRecording) {
    dom.recBtn.classList.add('recording');
    dom.recBtnLabel.textContent = 'STOP';
    dom.recStatus.innerHTML = '<span class="live">● recording</span>';
    dom.sendBtn.disabled = true;
  } else {
    dom.recBtn.classList.remove('recording');
    dom.recBtnLabel.textContent = 'REC';
    if (recordedBlob) {
      const sizeKB = (recordedBlob.size / 1024).toFixed(1);
      const trimmed = state.vadEnabled
        && originalDurationSec > 0
        && Math.abs(originalDurationSec - recordedDurationSec) > 0.05;
      const durLabel = trimmed
        ? `${originalDurationSec.toFixed(1)}s → <b>${recordedDurationSec.toFixed(1)}s</b> (−${(100 * (1 - recordedDurationSec / originalDurationSec)).toFixed(0)}%)`
        : `${recordedDurationSec.toFixed(1)}s`;
      dom.recStatus.innerHTML = `ready · ${durLabel} · ${sizeKB} KB`;
      dom.timer.textContent = formatTimer(recordedDurationSec * 1000);
      dom.sendBtn.disabled = getModelsToRun().length === 0;
    } else {
      dom.recStatus.textContent = '— idle —';
      dom.sendBtn.disabled = true;
    }
  }
}

/* ============================================================ *
 * COST CALCULATION
 * ============================================================ */
function estimateCost(model, durationSec, completionTokens = null) {
  const p = model.pricing;
  const durMin = durationSec / 60;
  switch (p.type) {
    case 'per_minute': return p.perMin * durMin;
    case 'per_hour':   return p.perHour * (durationSec / 3600);
    case 'multimodal': {
      let audioCost = 0;
      if (p.audioPerSec)        audioCost = p.audioPerSec * durationSec;
      else if (p.audioPerToken) audioCost = p.audioPerToken * (p.audioTokensPerSec || 1500) * durationSec;
      const outTokens = completionTokens != null ? completionTokens : 195 * durMin; // fallback estimate
      const textCost = (p.textOutPerToken || 0) * outTokens;
      return audioCost + textCost;
    }
  }
  return 0;
}

function fmtCost(usd) {
  if (usd == null) return '—';
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 0.01)   return '$' + usd.toFixed(5);
  return '$' + usd.toFixed(4);
}

function refreshCostStrip() {
  const dur = recordedDurationSec || 0;
  dom.costStrip.innerHTML = '';
  const sel = state.selectedModelIds.map(id => MODELS.find(m => m.id === id)).filter(Boolean);
  const available = sel.filter(isModelAvailable);
  const blocked = sel.filter(m => !isModelAvailable(m));

  if (sel.length === 0 || dur === 0) {
    dom.costStrip.innerHTML = dur === 0
      ? '<span style="color: var(--text-3)">record audio to see cost estimates</span>'
      : '<span style="color: var(--text-3)">no model selected</span>';
    if (blocked.length > 0) {
      const warn = document.createElement('span');
      warn.style.color = 'var(--accent-2)';
      warn.textContent = ` · ${blocked.length} model(s) need API key`;
      dom.costStrip.appendChild(warn);
    }
    return;
  }
  for (const m of available) {
    const cost = estimateCost(m, dur);
    const item = document.createElement('span');
    item.className = 'cost-item';
    item.innerHTML = `<span>${shortName(m)}</span><span class="mid">·</span><b>${fmtCost(cost)}</b>`;
    dom.costStrip.appendChild(item);
  }
  if (blocked.length > 0) {
    const warn = document.createElement('span');
    warn.className = 'cost-item';
    warn.style.color = 'var(--accent-2)';
    warn.innerHTML = `<span>⚠ ${blocked.length} model(s) disabled — missing API key</span>`;
    dom.costStrip.appendChild(warn);
  }
}

function shortName(m) {
  return m.id.split('/').pop().replace('-preview', '').replace(/-\d{4}$/, '');
}

function refreshSelectedLabel() {
  const sel = state.selectedModelIds.map(id => MODELS.find(m => m.id === id)).filter(Boolean);
  if (sel.length === 0) {
    dom.selectedLabel.textContent = '— No model selected —';
    return;
  }
  if (sel.length === 1) {
    const m = sel[0];
    const blocked = !isModelAvailable(m);
    const blockedTag = blocked ? ` · <span style="color: var(--accent-2)">⚠ missing ${m.requiredKey} key</span>` : '';
    dom.selectedLabel.innerHTML =
      `<span style="color: var(--text-2)">${m.name}</span>` +
      ` · <span style="color: var(--text-3)">${m.id}</span>` +
      ` · <span style="color: var(--accent-2)">${m.priceLabel}</span>` +
      ` · <span style="color: var(--text-3)">${m.provider}</span>` +
      blockedTag;
  } else {
    const blockedCount = sel.filter(m => !isModelAvailable(m)).length;
    const tail = blockedCount > 0
      ? ` · <span style="color: var(--accent-2)">⚠ ${blockedCount} disabled</span>`
      : '';
    dom.selectedLabel.innerHTML =
      `<span style="color: var(--text-2)">${sel.length} models selected</span>` +
      ` · ${sel.map(m => {
        const dim = !isModelAvailable(m) ? 'opacity:0.45;text-decoration:line-through' : '';
        return `<span style="color: var(--text-3); ${dim}">${shortName(m)}</span>`;
      }).join(' · ')}` + tail;
  }
}

function refreshPromptRowVisibility() {
  const hasMultimodal = state.selectedModelIds
    .map(id => MODELS.find(m => m.id === id))
    .filter(Boolean)
    .some(m => m.endpoint === 'chat');
  dom.promptRow.classList.toggle('show', hasMultimodal);
}

/* ============================================================ *
 * API CALLS
 * ============================================================ */
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

function blobExtension(blob) {
  const t = (blob.type || '').toLowerCase();
  if (t.includes('webm')) return 'webm';
  if (t.includes('ogg'))  return 'ogg';
  if (t.includes('mp4'))  return 'mp4';
  if (t.includes('wav'))  return 'wav';
  return 'webm';
}

/* ============================================================ *
 * WAV CONVERSION (webm/opus → 16 kHz mono PCM16 WAV)
 *
 * Why: OpenRouter's dedicated STT endpoint and several providers
 * (notably Mistral/Voxtral) reject webm. WAV 16 kHz mono is the
 * universal format accepted by every transcription API and is
 * also the native input format Whisper-style models train on.
 * ============================================================ */
let _wavCache = { srcBlob: null, wavBlob: null };

async function blobToWav(srcBlob, targetSampleRate = 16000) {
  // Cache: avoid re-encoding if the same recording is sent again
  if (_wavCache.srcBlob === srcBlob && _wavCache.wavBlob) return _wavCache.wavBlob;

  const arrayBuffer = await srcBlob.arrayBuffer();
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  let decoded;
  try {
    decoded = await ac.decodeAudioData(arrayBuffer.slice(0));
  } finally {
    ac.close();
  }

  // Resample to targetSampleRate, mix down to mono via OfflineAudioContext
  const offline = new OfflineAudioContext(
    1, Math.ceil(decoded.duration * targetSampleRate), targetSampleRate
  );
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();

  const samples = rendered.getChannelData(0);
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const writeString = (off, s) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };
  writeString(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);                        // PCM chunk size
  view.setUint16(20, 1, true);                         // PCM
  view.setUint16(22, 1, true);                         // mono
  view.setUint32(24, targetSampleRate, true);
  view.setUint32(28, targetSampleRate * 2, true);      // byte rate
  view.setUint16(32, 2, true);                         // block align
  view.setUint16(34, 16, true);                        // bits per sample
  writeString(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let offset = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    offset += 2;
  }
  const wavBlob = new Blob([buffer], { type: 'audio/wav' });
  _wavCache = { srcBlob, wavBlob };
  return wavBlob;
}

/* ============================================================ *
 * VAD SILENCE TRIMMING (Silero VAD via @ricky0123/vad-web)
 * Loads a ~1.8MB ONNX model lazily, decodes the recorded blob to
 * 16 kHz mono PCM, runs VAD to extract speech segments, and stitches
 * them back into a compact WAV. Reduces Whisper hallucinations and
 * trims API cost when the user pauses mid-recording.
 * ============================================================ */
const ORT_VERSION = '1.22.0'; // must match the ORT version bundled in vad-web@0.0.29
let _vadInstance = null;
let _vadLoadingPromise = null;

async function getVad() {
  if (_vadInstance) return _vadInstance;
  if (_vadLoadingPromise) return _vadLoadingPromise;
  if (!window.vad) throw new Error('VAD library not loaded (network or adblock?)');
  _vadLoadingPromise = window.vad.NonRealTimeVAD.new({
    ortConfig: (ort) => {
      ort.env.wasm.wasmPaths = `https://cdn.jsdelivr.net/npm/onnxruntime-web@${ORT_VERSION}/dist/`;
      ort.env.wasm.numThreads = 1; // GH Pages can't enable cross-origin isolation; threading is moot anyway
    },
    // Tuned to remove substantial mid-pauses while preserving natural speech.
    positiveSpeechThreshold: 0.5,
    negativeSpeechThreshold: 0.35,
    preSpeechPadMs: 200,
    redemptionMs: 500,
    minSpeechMs: 250,
  }).then(v => { _vadInstance = v; return v; });
  return _vadLoadingPromise;
}

// Decode the recorded blob to 16kHz mono Float32 PCM.
async function decodeTo16kMono(srcBlob) {
  const AC = window.AudioContext || window.webkitAudioContext;
  const ac = new AC();
  let decoded;
  try {
    decoded = await ac.decodeAudioData((await srcBlob.arrayBuffer()).slice(0));
  } finally {
    ac.close();
  }
  const offline = new OfflineAudioContext(1, Math.ceil(decoded.duration * 16000), 16000);
  const src = offline.createBufferSource();
  src.buffer = decoded;
  src.connect(offline.destination);
  src.start(0);
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
}

function float32ToWavBlob(samples, sampleRate) {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);
  const ws = (off, s) => { for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i)); };
  ws(0, 'RIFF');
  view.setUint32(4, 36 + samples.length * 2, true);
  ws(8, 'WAVE'); ws(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ws(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  let off = 44;
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
    off += 2;
  }
  return new Blob([buffer], { type: 'audio/wav' });
}

// Returns { blob, originalSec, trimmedSec, trimmed }. Falls back to original if no speech.
async function trimWithVAD(srcBlob) {
  const samples = await decodeTo16kMono(srcBlob);
  const originalSec = samples.length / 16000;

  const v = await getVad();
  const segments = [];
  for await (const seg of v.run(samples, 16000)) segments.push(seg.audio);

  if (segments.length === 0) {
    return { blob: srcBlob, originalSec, trimmedSec: originalSec, trimmed: false };
  }

  // 100ms zero-pad between segments to avoid abrupt boundary clicks.
  const padSamples = Math.round(0.1 * 16000);
  let totalLen = 0;
  for (let i = 0; i < segments.length; i++) {
    totalLen += segments[i].length + (i < segments.length - 1 ? padSamples : 0);
  }
  const merged = new Float32Array(totalLen);
  let offset = 0;
  for (let i = 0; i < segments.length; i++) {
    merged.set(segments[i], offset);
    offset += segments[i].length;
    if (i < segments.length - 1) offset += padSamples; // gap is left as zeros
  }
  return {
    blob: float32ToWavBlob(merged, 16000),
    originalSec,
    trimmedSec: merged.length / 16000,
    trimmed: true,
  };
}

/* OpenRouter STT dedicated endpoint
 * Schema discovered from API: { model, input_audio: { data, format }, language? }
 * Body is JSON, NOT multipart form-data. */
async function transcribeOpenRouter(model, blob, lang) {
  if (!state.apiKeys.openrouter) throw new Error('OpenRouter API key missing (Settings)');
  // Convert to WAV — webm is NOT in OpenRouter's supported format list
  const wavBlob = await blobToWav(blob);
  const b64 = await blobToBase64(wavBlob);
  const body = {
    model: model.id,
    input_audio: { data: b64, format: 'wav' }
  };
  if (lang) body.language = lang;
  const res = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${state.apiKeys.openrouter}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://lescientifik.github.io/i_transcript/',
      'X-OpenRouter-Title': 'i_transcript'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${errText.substring(0, 250)}`);
  }
  const json = await res.json();
  return { text: json.text || '', usage: json.usage || null };
}

/* OpenRouter chat completions (multimodal audio) */
async function transcribeOpenRouterChat(model, blob, lang, prompt) {
  if (!state.apiKeys.openrouter) throw new Error('OpenRouter API key missing (Settings)');
  // Convert to WAV — Voxtral provider rejects webm; Gemini accepts both but WAV is safer
  const wavBlob = await blobToWav(blob);
  const b64 = await blobToBase64(wavBlob);
  const userContent = [
    { type: 'input_audio', input_audio: { data: b64, format: 'wav' } },
    { type: 'text', text: prompt + (lang ? `\n\n(Audio language: ${lang})` : '') }
  ];
  const body = {
    model: model.id,
    messages: [{ role: 'user', content: userContent }]
  };
  const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${state.apiKeys.openrouter}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': 'https://lescientifik.github.io/i_transcript/',
      'X-OpenRouter-Title': 'i_transcript'
    },
    body: JSON.stringify(body)
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`OpenRouter ${res.status}: ${errText.substring(0, 250)}`);
  }
  const json = await res.json();
  const text = json?.choices?.[0]?.message?.content || '';
  return { text, usage: json.usage || null };
}

/* Mistral STT dedicated endpoint (multipart form-data, OpenAI-compatible) */
async function transcribeMistral(model, blob, lang) {
  if (!state.apiKeys.mistral) throw new Error('Mistral API key missing (Settings)');
  // WAV is universally accepted; webm support varies
  const wavBlob = await blobToWav(blob);
  const fd = new FormData();
  fd.append('file', wavBlob, 'audio.wav');
  fd.append('model', model.id);
  if (lang) fd.append('language', lang);
  const res = await fetch('https://api.mistral.ai/v1/audio/transcriptions', {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${state.apiKeys.mistral}` },
    body: fd
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`Mistral ${res.status}: ${errText.substring(0, 250)}`);
  }
  const json = await res.json();
  return { text: json.text || '', usage: json.usage || null };
}

async function transcribeWith(model, blob, lang, prompt) {
  if (model.provider === 'openrouter' && model.endpoint === 'transcription')
    return transcribeOpenRouter(model, blob, lang);
  if (model.provider === 'openrouter' && model.endpoint === 'chat')
    return transcribeOpenRouterChat(model, blob, lang, prompt);
  if (model.provider === 'mistral' && model.endpoint === 'transcription')
    return transcribeMistral(model, blob, lang);
  throw new Error(`Unknown provider/endpoint combo for ${model.id}`);
}

/* ============================================================ *
 * RESULTS RENDERING
 * ============================================================ */
function renderResultsLayout() {
  dom.resultsContainer.className = '';
  dom.resultsContainer.innerHTML = '';
  const sel = state.selectedModelIds.map(id => MODELS.find(m => m.id === id)).filter(Boolean);

  if (sel.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'empty-state';
    empty.innerHTML = `
      <div class="big">No model selected</div>
      <div class="small">open settings (,) to pick at least one</div>`;
    dom.resultsContainer.appendChild(empty);
    return;
  }

  const grid = document.createElement('div');
  grid.className = 'results';
  grid.classList.add(sel.length === 1 ? 'cols-1' : sel.length === 2 ? 'cols-2' : 'cols-3');

  for (const m of sel) {
    grid.appendChild(makeCard(m));
  }
  dom.resultsContainer.appendChild(grid);

  // Replay cached results so model-selection changes don't wipe paid transcripts.
  for (const m of sel) {
    const cached = cachedResults[m.id];
    if (!cached || cached.audioId !== currentAudioId) continue;
    if (cached.text != null) setCardResult(m.id, cached.text, cached.costUsd, cached.durationSec);
    else if (cached.error) setCardError(m.id, cached.error);
  }
}

function makeCard(model) {
  const card = document.createElement('div');
  card.className = 'card';
  card.dataset.modelId = model.id;
  const available = isModelAvailable(model);
  if (!available) card.classList.add('unavailable');

  const head = document.createElement('div');
  head.className = 'card-head';
  head.innerHTML = `
    <div>
      <div class="card-name">${model.name}</div>
      <div class="card-meta">
        <span class="provider-tag ${model.provider}">${model.provider}</span>
        <span style="font-family: var(--mono); color: var(--text-3)">${model.id}</span>
      </div>
    </div>
    <div class="card-cost" data-cost-slot>
      <b>${model.priceLabel}</b>
      <span class="duration"></span>
    </div>`;
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'card-body empty';
  body.dataset.bodySlot = '';
  if (!available) {
    const keyName = model.requiredKey === 'openrouter' ? 'OpenRouter' : 'Mistral';
    body.textContent = `⚠ Disabled — missing ${keyName} API key`;
  } else {
    body.textContent = '— no result yet —';
  }
  card.appendChild(body);

  const isMono = state.selectedModelIds.length === 1;
  const foot = document.createElement('div');
  foot.className = 'card-foot';
  foot.innerHTML = `
    <button data-copy-btn disabled>copy text${isMono ? ` <span class="kbd">${shortcutLabel('copy')}</span>` : ''}</button>
  `;
  card.appendChild(foot);

  // Wire copy
  foot.querySelector('[data-copy-btn]').addEventListener('click', () => {
    const txt = body.textContent || '';
    if (txt && !txt.startsWith('⚠') && !txt.startsWith('—')) {
      copyToClipboard(txt, foot.querySelector('[data-copy-btn]'));
    }
  });

  // Persist user edits to the cache so re-renders (e.g. toggling models) keep them.
  body.addEventListener('input', () => {
    const cached = cachedResults[model.id];
    if (cached && cached.audioId === currentAudioId && body.isContentEditable) {
      cached.text = body.textContent || '';
    }
  });

  return card;
}

function setCardLoading(modelId) {
  const card = dom.resultsContainer.querySelector(`.card[data-model-id="${CSS.escape(modelId)}"]`);
  if (!card) return;
  const body = card.querySelector('[data-body-slot]');
  body.contentEditable = 'false';
  body.className = 'card-body loading';
  body.innerHTML = '<div class="spinner"></div>';
  card.querySelector('[data-copy-btn]').disabled = true;
}

function setCardResult(modelId, text, costUsd, durationSec) {
  cachedResults[modelId] = { audioId: currentAudioId, text, costUsd, durationSec };
  const card = dom.resultsContainer.querySelector(`.card[data-model-id="${CSS.escape(modelId)}"]`);
  if (!card) return;
  const body = card.querySelector('[data-body-slot]');
  body.className = 'card-body';
  body.textContent = text;
  body.contentEditable = 'true';
  body.spellcheck = false;
  const slot = card.querySelector('[data-cost-slot]');
  slot.innerHTML = `<b>${fmtCost(costUsd)}</b><span class="duration">${durationSec.toFixed(1)}s audio</span>`;
  const copyBtn = card.querySelector('[data-copy-btn]');
  copyBtn.disabled = !text;
  updateRecorderUI(); // refresh Send button (may now be disabled)
  // Auto-copy in mono mode when the option is on
  if (state.autoRunCopy && state.selectedModelIds.length === 1 && text) {
    copyToClipboard(text, copyBtn);
  }
}

function setCardError(modelId, message) {
  cachedResults[modelId] = { audioId: currentAudioId, error: message };
  const card = dom.resultsContainer.querySelector(`.card[data-model-id="${CSS.escape(modelId)}"]`);
  if (!card) return;
  const body = card.querySelector('[data-body-slot]');
  body.contentEditable = 'false';
  body.className = 'card-body error';
  body.textContent = message;
  card.querySelector('[data-copy-btn]').disabled = true;
}

/* ============================================================ *
 * RUN ALL TRANSCRIPTIONS
 * ============================================================ */
async function runTranscriptions() {
  if (!recordedBlob) { showToast('No audio recorded', 'error'); return; }
  const sel = state.selectedModelIds.map(id => MODELS.find(m => m.id === id)).filter(Boolean);
  if (sel.length === 0) { showToast('No model selected', 'error'); return; }

  const lang = state.lang;
  const prompt = (dom.promptText.value || state.defaultPrompt).trim();
  const dur = recordedDurationSec;

  // Mark blocked models with a clear error; skip models already transcribed for
  // the current audio (no re-charging on unchanged audio); only run the rest.
  const runnable = [];
  for (const m of sel) {
    if (!isModelAvailable(m)) {
      const keyName = m.requiredKey === 'openrouter' ? 'OpenRouter' : 'Mistral';
      setCardError(m.id, `Disabled — missing ${keyName} API key. Open settings (,) to add it.`);
      continue;
    }
    if (hasFreshSuccess(m.id)) continue; // already done for this audio
    setCardLoading(m.id);
    runnable.push(m);
  }
  if (runnable.length === 0) {
    const allDone = sel.every(m => isModelAvailable(m) && hasFreshSuccess(m.id));
    if (allDone) showToast('Already transcribed for this audio', 'info');
    else showToast('All selected models are disabled — add API keys', 'error');
    return;
  }

  // Run available ones in parallel
  await Promise.all(runnable.map(async (m) => {
    try {
      const { text, usage } = await transcribeWith(m, recordedBlob, lang, prompt);
      let cost;
      if (m.pricing.type === 'multimodal') {
        const completionTokens = usage?.completion_tokens ?? null;
        cost = estimateCost(m, dur, completionTokens);
      } else {
        cost = estimateCost(m, dur);
      }
      setCardResult(m.id, text || '— empty result —', cost, dur);
    } catch (err) {
      console.error(err);
      setCardError(m.id, err.message || String(err));
    }
  }));
}

/* ============================================================ *
 * SETTINGS DRAWER
 * ============================================================ */
function openDrawer() {
  dom.drawerBackdrop.classList.add('open');
  dom.drawer.classList.add('open');
  dom.keyProvider.value = state.lastKeyProvider;
  syncKeyUI(state.lastKeyProvider);
  dom.defaultPrompt.value = state.defaultPrompt;
  dom.autoRunCopy.checked = !!state.autoRunCopy;
  dom.vadEnabled.checked = !!state.vadEnabled;
  dom.scRecord.value = state.shortcuts.record;
  dom.scSend.value = state.shortcuts.send;
  dom.scCopy.value = state.shortcuts.copy;
  dom.scSettings.value = state.shortcuts.settings;
  refreshModelList();
}
function closeDrawer() {
  dom.drawerBackdrop.classList.remove('open');
  dom.drawer.classList.remove('open');
}

function refreshModelList() {
  dom.modelList.innerHTML = '';
  for (const m of MODELS) {
    const isSel = state.selectedModelIds.includes(m.id);
    const available = isModelAvailable(m);
    const item = document.createElement('label');
    item.className = 'model-item' + (isSel ? ' selected' : '') + (available ? '' : ' disabled');
    const keyName = m.requiredKey === 'openrouter' ? 'OpenRouter' : 'Mistral';
    const disabledHint = available ? '' :
      `<div class="model-item-disabled-hint">⚠ Add ${keyName} API key to enable</div>`;
    item.innerHTML = `
      <input type="checkbox" ${isSel ? 'checked' : ''} ${available ? '' : 'disabled'} data-mid="${m.id}">
      <div class="model-item-info">
        <div class="model-item-name">${m.name}</div>
        <div class="model-item-id">${m.id}</div>
        <div class="model-item-price">${m.priceLabel}</div>
        <div class="model-item-tags">
          <span class="model-item-tag ${m.provider}">${m.provider}</span>
          ${m.tags.map(t => `<span class="model-item-tag">${t}</span>`).join('')}
        </div>
        ${disabledHint}
      </div>`;
    item.querySelector('input').addEventListener('change', (e) => {
      if (!available) { e.preventDefault(); e.target.checked = false; return; }
      const checked = e.target.checked;
      if (checked) {
        if (!state.selectedModelIds.includes(m.id)) state.selectedModelIds.push(m.id);
      } else {
        state.selectedModelIds = state.selectedModelIds.filter(x => x !== m.id);
      }
      saveState();
      item.classList.toggle('selected', checked);
      refreshSelectedLabel();
      refreshPromptRowVisibility();
      refreshCostStrip();
      renderResultsLayout();
    });
    dom.modelList.appendChild(item);
  }
}

/* ============================================================ *
 * SHORTCUTS
 * ============================================================ */
function shortcutLabel(action) { return state.shortcuts[action] || ''; }

function keyMatches(e, target) {
  if (!target) return false;
  if (target === 'Enter')  return e.key === 'Enter';
  if (target === 'Space')  return e.code === 'Space';
  if (target === 'Escape') return e.key === 'Escape';
  // Single character match (case-insensitive)
  if (target.length === 1) return e.key.toLowerCase() === target.toLowerCase();
  return false;
}

function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

document.addEventListener('keydown', (e) => {
  // Capture mode for shortcut inputs
  const capturing = document.querySelector('.shortcut-input.capturing');
  if (capturing) {
    e.preventDefault();
    if (e.key === 'Escape') {
      capturing.classList.remove('capturing');
      return;
    }
    let val = e.key;
    if (e.code === 'Space') val = 'Space';
    capturing.value = val;
    state.shortcuts[capturing.dataset.action] = val;
    saveState();
    capturing.classList.remove('capturing');
    refreshShortcutsUI();
    return;
  }

  if (isTypingTarget(e.target)) {
    // Allow Enter to send when focus is on lang select
    if (e.target === dom.langSelect && keyMatches(e, state.shortcuts.send)) {
      e.preventDefault();
      if (!dom.sendBtn.disabled) runTranscriptions();
    }
    // Escape blurs an editable card body so the global shortcuts (K, F, …) work again.
    if (e.key === 'Escape' && e.target.classList?.contains('card-body')) {
      e.target.blur();
    }
    return;
  }

  if (keyMatches(e, state.shortcuts.record)) {
    e.preventDefault();
    isRecording ? stopRecording() : startRecording();
  } else if (keyMatches(e, state.shortcuts.send)) {
    e.preventDefault();
    if (!dom.sendBtn.disabled) runTranscriptions();
  } else if (keyMatches(e, state.shortcuts.copy)) {
    if (state.selectedModelIds.length === 1) {
      e.preventDefault();
      copyMonoResult();
    }
  } else if (keyMatches(e, state.shortcuts.settings)) {
    e.preventDefault();
    if (dom.drawer.classList.contains('open')) closeDrawer();
    else openDrawer();
  }
});

function refreshShortcutsUI() {
  dom.sendKbd.textContent = state.shortcuts.send;
  // Re-render result cards so the copy button shows the right shortcut
  renderResultsLayout();
}

/* ============================================================ *
 * COPY
 * ============================================================ */
async function copyToClipboard(text, btn) {
  try {
    await navigator.clipboard.writeText(text);
    if (btn) {
      const orig = btn.innerHTML;
      btn.innerHTML = '✓ copied';
      btn.classList.add('copied');
      setTimeout(() => { btn.innerHTML = orig; btn.classList.remove('copied'); }, 1400);
    } else {
      showToast('Copied to clipboard', 'success');
    }
  } catch (err) {
    showToast('Copy failed: ' + err.message, 'error');
  }
}

function copyMonoResult() {
  if (state.selectedModelIds.length !== 1) return;
  const card = dom.resultsContainer.querySelector('.card');
  if (!card) return;
  const text = card.querySelector('[data-body-slot]').textContent || '';
  if (!text || text.startsWith('—')) { showToast('Nothing to copy', 'error'); return; }
  copyToClipboard(text, card.querySelector('[data-copy-btn]'));
}

/* ============================================================ *
 * TOAST
 * ============================================================ */
let toastHandle = null;
function showToast(msg, kind = 'info') {
  dom.toast.textContent = msg;
  dom.toast.className = 'toast show ' + kind;
  if (toastHandle) clearTimeout(toastHandle);
  toastHandle = setTimeout(() => { dom.toast.classList.remove('show'); }, 2600);
}

/* ============================================================ *
 * EVENT WIRING
 * ============================================================ */
dom.recBtn.addEventListener('click', () => {
  isRecording ? stopRecording() : startRecording();
});
dom.sendBtn.addEventListener('click', () => runTranscriptions());

dom.settingsBtn.addEventListener('click', openDrawer);
dom.drawerClose.addEventListener('click', closeDrawer);
dom.drawerBackdrop.addEventListener('click', closeDrawer);

/* API key single-form UX — one <form> at a time avoids Chrome's cross-form
   autofill confusion. The provider <select> mutates the (hidden) username
   value, so Chrome sees each provider as a distinct credential on submit. */
const PROVIDER_META = {
  openrouter: { label: 'OpenRouter', placeholder: 'sk-or-v1-…' },
  mistral:    { label: 'Mistral',    placeholder: '…' }
};

function syncKeyUI(provider) {
  const meta = PROVIDER_META[provider];
  const value = state.apiKeys[provider] || '';
  dom.keyUsername.value = `${provider}-api-key`;
  dom.keyInput.value = value;
  dom.keyInput.placeholder = meta.placeholder;
  dom.keySavedLabel.textContent = `✓ ${meta.label} key saved`;
  const isSaved = !!value;
  dom.keyForm.style.display = isSaved ? 'none' : '';
  dom.keySaved.hidden = !isSaved;
}

dom.keyProvider.addEventListener('change', () => {
  state.lastKeyProvider = dom.keyProvider.value;
  saveState();
  syncKeyUI(state.lastKeyProvider);
});

dom.keyForm.addEventListener('submit', (e) => {
  e.preventDefault();
  const provider = dom.keyProvider.value;
  const label = PROVIDER_META[provider].label;
  const value = dom.keyInput.value.trim();
  state.apiKeys[provider] = value;
  saveState();
  refreshAvailabilityUI();
  if (value) {
    // Signal to Chrome that submission succeeded: navigation + form hidden.
    history.pushState({}, '', location.pathname);
    syncKeyUI(provider);
    showToast(`${label} key saved`, 'success');
  } else {
    syncKeyUI(provider);
    showToast(`${label} key cleared`, 'info');
  }
});

dom.keyEditBtn.addEventListener('click', () => {
  dom.keyForm.style.display = '';
  dom.keySaved.hidden = true;
  dom.keyInput.focus();
  dom.keyInput.select();
});

dom.keyClearBtn.addEventListener('click', () => {
  const provider = dom.keyProvider.value;
  const label = PROVIDER_META[provider].label;
  state.apiKeys[provider] = '';
  saveState();
  refreshAvailabilityUI();
  syncKeyUI(provider);
  showToast(`${label} key cleared`, 'info');
});

function refreshAvailabilityUI() {
  refreshModelList();
  refreshSelectedLabel();
  refreshCostStrip();
  renderResultsLayout();
  // Make sure send button reflects state (consider cached results)
  if (!isRecording) {
    dom.sendBtn.disabled = !(recordedBlob && getModelsToRun().length > 0);
  }
}
dom.defaultPrompt.addEventListener('input', (e) => {
  state.defaultPrompt = e.target.value;
  if (!dom.promptText.value) dom.promptText.value = state.defaultPrompt;
  saveState();
});
dom.autoRunCopy.addEventListener('change', (e) => {
  state.autoRunCopy = e.target.checked;
  saveState();
});
dom.vadEnabled.addEventListener('change', (e) => {
  state.vadEnabled = e.target.checked;
  saveState();
  // Warm up the model in the background so the first real use is instant.
  if (state.vadEnabled) getVad().catch(err => console.warn('VAD preload failed', err));
});
dom.langSelect.addEventListener('change', (e) => { state.lang = e.target.value; saveState(); });

// Shortcut capture
[dom.scRecord, dom.scSend, dom.scCopy, dom.scSettings].forEach(input => {
  input.addEventListener('focus', () => {
    document.querySelectorAll('.shortcut-input.capturing').forEach(x => x.classList.remove('capturing'));
    input.classList.add('capturing');
    input.value = '— press a key (Esc to cancel) —';
  });
  input.addEventListener('blur', () => {
    if (input.classList.contains('capturing')) {
      input.classList.remove('capturing');
      input.value = state.shortcuts[input.dataset.action] || '';
    }
  });
});

/* ============================================================ *
 * INIT
 * ============================================================ */
function init() {
  // Apply state to UI
  dom.langSelect.value = state.lang;
  dom.promptText.value = state.defaultPrompt;
  refreshSelectedLabel();
  refreshPromptRowVisibility();
  refreshCostStrip();
  renderResultsLayout();
  refreshShortcutsUI();
  updateRecorderUI();

  // Open settings on first run if no API keys
  if (!state.apiKeys.openrouter && !state.apiKeys.mistral) {
    setTimeout(openDrawer, 300);
  }
}
init();

