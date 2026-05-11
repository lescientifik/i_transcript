import { state } from '../src/shared/state.js';
import { decodeTo16kMono } from '../src/shared/audio-codec.js';
import { MODELS } from '../src/shared/models.js';
import { extensionToFormat, EXTENSION_TO_FORMAT } from '../src/shared/openrouter.js';

/* ============================================================ *
 * UPLOAD APP — step 3.b: file selection + cost-strip
 *
 * Pure UI wiring against upload/index.html. No transcription yet
 * (button stub logs a warning — pipeline arrives in step 3.c).
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

// DOM refs
const dropZone     = document.getElementById('drop-zone');
const fileInput    = document.getElementById('file-input');
const modelSelect  = document.getElementById('model-select');
const langSelect   = document.getElementById('lang-select');
const costStrip    = document.getElementById('cost-strip');
const errorBanner  = document.getElementById('error-banner');
const btnTranscribe = document.getElementById('btn-transcribe');

// Module-scoped selected file + computed duration (filled after decode).
let selectedFile = null;
let selectedDurationSec = 0;

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

// Always 4 decimals for the cost-strip — scenario 3 asserts /\$\d+\.\d{4}/.
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
  // state.lang may be '' (auto-detect) — both branches handled.
  langSelect.value = state.lang ?? 'fr';
}

/* ---------- UI helpers ---------- */

function showError(msg) {
  errorBanner.textContent = msg;
  errorBanner.hidden = false;
}

function clearError() {
  errorBanner.textContent = '';
  errorBanner.hidden = true;
}

function refreshTranscribeEnabled() {
  const modelId = modelSelect.value;
  const lang    = langSelect.value;
  const apiKey  = (state.apiKeys?.openrouter || '').trim();
  // Empty lang string = auto-detect, still valid. Only modelId, file, apiKey are gating.
  const enabled = !!selectedFile && !!modelId && lang !== undefined && !!apiKey;
  btnTranscribe.disabled = !enabled;
}

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
    // Decode just to get duration. Sample rate of output doesn't matter for
    // duration math: length / 16000 == originalDurationSec (resampler preserves it).
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
  // Click anywhere on the dropzone (except the actual input) triggers picker.
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

/* ---------- transcribe stub (step 3.c will replace) ---------- */

function wireTranscribeStub() {
  btnTranscribe.addEventListener('click', () => {
    console.warn('[upload] transcribe pipeline arrives in 3.c');
  });
}

/* ---------- init ---------- */

function init() {
  populateModelSelect();
  populateLangSelect();
  wireDropZone();
  wireTranscribeStub();

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
