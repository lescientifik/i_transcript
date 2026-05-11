import { state } from '../src/shared/state.js';
import { decodeTo16kMono, trimWithVAD } from '../src/shared/audio-codec.js';
import { MODELS } from '../src/shared/models.js';
import {
  extensionToFormat,
  EXTENSION_TO_FORMAT,
  postOpenRouterTranscription
} from '../src/shared/openrouter.js';

/* ============================================================ *
 * UPLOAD APP — step 3.c: transcription pipeline + breadcrumb +
 * chrono + result rendering.
 *
 * Persistence (sttbench.upload.v1.lastTranscript) + download/copy
 * land in step 3.d — here we only display in the <pre>.
 * ============================================================ */

const LANG_OPTIONS = [
  { value: 'fr', label: 'Français (par défaut)' },
  { value: 'en', label: 'English' },
  { value: 'es', label: 'Español' },
  { value: 'de', label: 'Deutsch' },
  { value: 'it', label: 'Italiano' },
  { value: 'pt', label: 'Português' },
  { value: '',   label: '— auto-detect —' }
];

const DEFAULT_WHISPER_ID = 'openai/whisper-large-v3-turbo';
const UPLOAD_STORAGE_KEY = 'sttbench.upload.v1';
const MAX_BYTES = 18 * 1024 * 1024;

// DOM refs
const dropZone        = document.getElementById('drop-zone');
const fileInput       = document.getElementById('file-input');
const modelSelect     = document.getElementById('model-select');
const langSelect      = document.getElementById('lang-select');
const costStrip       = document.getElementById('cost-strip');
const errorBanner     = document.getElementById('error-banner');
const btnTranscribe   = document.getElementById('btn-transcribe');
const btnCancel       = document.getElementById('btn-cancel');
const breadcrumb      = document.getElementById('phase-breadcrumb');
const chrono          = document.getElementById('chrono');
const transcriptPre   = document.getElementById('transcript-output');
const resultActions   = document.getElementById('result-actions');

// Module-scoped state
let selectedFile = null;
let selectedDurationSec = 0;
let abortCtrl = null;
let chronoTimer = null;
let chronoStart = 0;
let inFlight = false;

/* ---------- upload-state (localStorage sttbench.upload.v1) ---------- */

function loadUploadState() {
  try {
    const raw = localStorage.getItem(UPLOAD_STORAGE_KEY);
    if (!raw) return { vadEnabled: false, lastTranscript: null };
    const parsed = JSON.parse(raw);
    return {
      vadEnabled: !!parsed.vadEnabled,
      lastTranscript: parsed.lastTranscript ?? null
    };
  } catch {
    return { vadEnabled: false, lastTranscript: null };
  }
}

/* ---------- cost helpers (mirrored from src/transcription.js) ---------- */

function estimateCost(model, durationSec) {
  const p = model?.pricing;
  if (!p) return 0;
  const durMin = durationSec / 60;
  switch (p.type) {
    case 'per_minute': return p.perMin * durMin;
    case 'per_hour':   return p.perHour * (durationSec / 3600);
    case 'multimodal': {
      let audioCost = 0;
      if (p.audioPerSec)        audioCost = p.audioPerSec * durationSec;
      else if (p.audioPerToken) audioCost = p.audioPerToken * (p.audioTokensPerSec || 1500) * durationSec;
      const outTokens = 195 * durMin;
      const textCost = (p.textOutPerToken || 0) * outTokens;
      return audioCost + textCost;
    }
  }
  return 0;
}

function fmtCost4(usd) {
  return '$' + (usd || 0).toFixed(4);
}

function fmtDuration(sec) {
  if (sec < 60) return `${sec.toFixed(1)} s`;
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/* ---------- populate selects ---------- */

function populateModelSelect() {
  const whispers = MODELS.filter(m =>
    m.provider === 'openrouter' && m.id.toLowerCase().includes('whisper')
  );
  modelSelect.innerHTML = '';
  for (const m of whispers) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = `${m.name} — ${m.priceLabel}`;
    modelSelect.appendChild(opt);
  }
  if (whispers.some(m => m.id === DEFAULT_WHISPER_ID)) {
    modelSelect.value = DEFAULT_WHISPER_ID;
  }
}

function populateLangSelect() {
  langSelect.innerHTML = '';
  for (const { value, label } of LANG_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    langSelect.appendChild(opt);
  }
  langSelect.value = state.lang ?? 'fr';
}

/* ---------- error encart ---------- */

function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.hidden = false;
}

function clearError() {
  errorBanner.textContent = '';
  errorBanner.hidden = true;
}

/* ---------- transcribe-button gating ---------- */

function refreshTranscribeEnabled() {
  if (inFlight) {
    btnTranscribe.disabled = true;
    return;
  }
  const modelId = modelSelect.value;
  const apiKey  = (state.apiKeys?.openrouter || '').trim();
  const enabled = !!selectedFile && !!modelId && !!apiKey;
  btnTranscribe.disabled = !enabled;
}

/* ---------- cost-strip ---------- */

function renderCostStrip() {
  const model = MODELS.find(m => m.id === modelSelect.value);
  if (!model || !selectedDurationSec) {
    costStrip.hidden = true;
    costStrip.textContent = '';
    return;
  }
  const cost = estimateCost(model, selectedDurationSec);
  costStrip.textContent =
    `Coût estimé : ${fmtCost4(cost)} (${fmtDuration(selectedDurationSec)} · ${model.priceLabel})`;
  costStrip.hidden = false;
}

/* ---------- file handling ---------- */

async function onFileSelected(file) {
  clearError();
  if (!file) return;

  const format = extensionToFormat(file.name);
  if (!format) {
    selectedFile = null;
    selectedDurationSec = 0;
    costStrip.hidden = true;
    const exts = Object.keys(EXTENSION_TO_FORMAT).join('/');
    showError(`Format non supporté (${exts} uniquement)`);
    refreshTranscribeEnabled();
    return;
  }

  selectedFile = file;

  try {
    const samples = await decodeTo16kMono(file);
    selectedDurationSec = samples.length / 16000;
  } catch (err) {
    console.error('[upload] decode failed', err);
    selectedFile = null;
    selectedDurationSec = 0;
    costStrip.hidden = true;
    showError(`Impossible de décoder ce fichier audio: ${err.message || err}`);
    refreshTranscribeEnabled();
    return;
  }

  renderCostStrip();
  refreshTranscribeEnabled();
}

/* ---------- drop-zone wiring ---------- */

function wireDropZone() {
  dropZone.addEventListener('click', (e) => {
    if (e.target === fileInput) return;
    fileInput.click();
  });

  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  fileInput.addEventListener('change', () => {
    const f = fileInput.files?.[0];
    if (f) onFileSelected(f);
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });
  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    const f = e.dataTransfer?.files?.[0];
    if (f) onFileSelected(f);
  });
}

/* ---------- breadcrumb (3-phase visual indicator) ---------- */

const PHASE_ORDER = ['encoding', 'uploading', 'transcribing'];

function setPhase(phase) {
  breadcrumb.hidden = false;
  const idx = PHASE_ORDER.indexOf(phase);
  for (const step of breadcrumb.querySelectorAll('.upload-step')) {
    const p = step.dataset.phase;
    const i = PHASE_ORDER.indexOf(p);
    step.classList.remove('active', 'done');
    if (i < idx) step.classList.add('done');
    else if (i === idx) step.classList.add('active');
  }
}

function resetBreadcrumb() {
  breadcrumb.hidden = true;
  for (const step of breadcrumb.querySelectorAll('.upload-step')) {
    step.classList.remove('active', 'done');
  }
}

/* ---------- chrono mm:ss (100 ms tick) ---------- */

function fmtChrono(ms) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function startChrono() {
  chronoStart = performance.now();
  chrono.textContent = '0:00';
  chrono.hidden = false;
  chronoTimer = setInterval(() => {
    chrono.textContent = fmtChrono(performance.now() - chronoStart);
  }, 100);
}

function stopChrono() {
  if (chronoTimer) {
    clearInterval(chronoTimer);
    chronoTimer = null;
  }
  chrono.hidden = true;
}

/* ---------- run UI state ---------- */

function enterRunning() {
  inFlight = true;
  clearError();
  btnTranscribe.disabled = true;
  btnCancel.hidden = false;
  resultActions.hidden = true;
  startChrono();
}

function exitRunning() {
  inFlight = false;
  btnCancel.hidden = true;
  resetBreadcrumb();
  stopChrono();
  refreshTranscribeEnabled();
}

/* ---------- transcribe pipeline ---------- */

async function onTranscribeClick() {
  if (inFlight) return;
  const file = selectedFile;
  if (!file) return;
  const modelId = modelSelect.value;
  const lang    = langSelect.value;
  const apiKey  = (state.apiKeys?.openrouter || '').trim();
  if (!modelId || !apiKey) return;

  const uploadState = loadUploadState();
  const vadOn = !!uploadState.vadEnabled;

  abortCtrl = new AbortController();
  enterRunning();

  try {
    /* Phase 1 — encoding */
    setPhase('encoding');

    let blob;
    let format;
    if (vadOn) {
      const result = await trimWithVAD(file);
      blob = result.blob;
      format = 'wav';
    } else {
      blob = file;
      format = extensionToFormat(file.name);
    }

    if (!format) {
      throw new Error('Format non supporté');
    }
    if (blob.size > MAX_BYTES) {
      const mb = (blob.size / (1024 * 1024)).toFixed(1);
      const msg = vadOn
        ? `Fichier post-VAD > 18 MB (${mb} MB, limite OpenAI/OpenRouter). Désactivez le VAD ou utilisez un extrait plus court.`
        : `Fichier > 18 MB (${mb} MB).`;
      throw new Error(msg);
    }

    /* Phase 2 — uploading (base64 + fetch start) */
    setPhase('uploading');

    /* Phase 3 — transcribing (waiting on response).
     * postOpenRouterTranscription's blob→base64 happens before the fetch,
     * but visually we want the user to see we've moved past upload as soon
     * as the request is in flight. Flip the phase right before the call. */
    setPhase('transcribing');

    const result = await postOpenRouterTranscription({
      blob, modelId, language: lang, apiKey, format,
      signal: abortCtrl.signal
    });

    transcriptPre.textContent = result.text || '';
    resultActions.hidden = false;
  } catch (err) {
    const isAbort = err?.name === 'AbortError'
      || /aborted/i.test(err?.message || '');
    const msg = isAbort
      ? 'Transcription annulée.'
      : `Erreur de transcription : ${err?.message || err}`;
    showError(msg);
  } finally {
    abortCtrl = null;
    exitRunning();
  }
}

function onCancelClick() {
  if (abortCtrl) abortCtrl.abort();
}

/* ---------- init ---------- */

function init() {
  populateModelSelect();
  populateLangSelect();
  wireDropZone();

  btnTranscribe.addEventListener('click', onTranscribeClick);
  btnCancel.addEventListener('click', onCancelClick);

  modelSelect.addEventListener('change', () => {
    renderCostStrip();
    refreshTranscribeEnabled();
  });
  langSelect.addEventListener('change', () => {
    refreshTranscribeEnabled();
  });

  refreshTranscribeEnabled();
}

init();
