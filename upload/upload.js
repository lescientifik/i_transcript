import { state, saveState } from '../src/shared/state.js';
import { decodeTo16kMono, trimWithVAD } from '../src/shared/audio-codec.js';
import { MODELS } from '../src/shared/models.js';
import {
  extensionToFormat,
  EXTENSION_TO_FORMAT,
  postOpenRouterTranscription
} from '../src/shared/openrouter.js';

/* ============================================================ *
 * UPLOAD APP — steps 3.c + 3.d + 3.e:
 *   3.c — transcription pipeline + breadcrumb + chrono + render
 *   3.d — localStorage persistence (sttbench.upload.v1) +
 *         hydratation au load + "Transcript précédent" label +
 *         download TXT + copier (avec toast feedback)
 *   3.e — settings drawer : API key OpenRouter (shared sttbench.v1),
 *         langue (shared, bidirectionnelle topbar↔drawer), VAD toggle
 *         (séparé sttbench.upload.v1.vadEnabled) + warning amber
 * ============================================================ */

const LANG_OPTIONS = [
  { value: 'fr', label: 'Français (default)' },
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
const transcriptLabel = document.getElementById('transcript-label');
const resultActions   = document.getElementById('result-actions');
const btnDownload     = document.getElementById('btn-download');
const btnCopy         = document.getElementById('btn-copy');
const toastEl         = document.getElementById('toast');

// Settings drawer DOM refs (step 3.e)
const settingsBtn     = document.getElementById('settings-btn');
const drawer          = document.getElementById('drawer');
const drawerBackdrop  = document.getElementById('drawer-backdrop');
const drawerClose     = document.getElementById('drawer-close');
const keyForm         = document.getElementById('key-form');
const keyInput        = document.getElementById('key-input');
const drawerLangSelect = document.getElementById('drawer-lang-select');
const vadCheckbox     = document.getElementById('vad-enabled');
const vadWarning      = document.getElementById('vad-warning');

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

function saveUploadState(next) {
  try {
    localStorage.setItem(UPLOAD_STORAGE_KEY, JSON.stringify(next));
  } catch (err) {
    console.error('[upload] saveUploadState failed', err);
  }
}

function persistLastTranscript(entry) {
  const current = loadUploadState();
  current.lastTranscript = entry;
  saveUploadState(current);
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

/* ---------- toast (local replica of src/ui.js showToast) ---------- */

let toastHandle = null;
function showToast(msg, kind = 'info') {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.className = 'toast show ' + kind;
  if (toastHandle) clearTimeout(toastHandle);
  toastHandle = setTimeout(() => { toastEl.classList.remove('show'); }, 1500);
}

/* ---------- "Previous transcript (<sourceName>)" label ---------- */

function showPreviousLabel(sourceName) {
  if (!transcriptLabel) return;
  transcriptLabel.textContent = `Previous transcript (${sourceName})`;
  transcriptLabel.hidden = false;
}

function clearPreviousLabel() {
  if (!transcriptLabel) return;
  transcriptLabel.textContent = '';
  transcriptLabel.hidden = true;
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
    `Estimated cost: ${fmtCost4(cost)} (${fmtDuration(selectedDurationSec)} · ${model.priceLabel})`;
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
    showError(`Unsupported format (${exts} only)`);
    refreshTranscribeEnabled();
    return;
  }

  selectedFile = file;

  /* Reset behavior (plan point fin 2) : si un précédent transcript existe,
   * on le LAISSE affiché dans le <pre> et on étiquette la zone
   * « Transcript précédent (<sourceName>) ». Remplacement atomique
   * uniquement à la réussite d'une NOUVELLE transcription. */
  const prev = loadUploadState().lastTranscript;
  if (prev && prev.sourceName) {
    showPreviousLabel(prev.sourceName);
  }

  try {
    const samples = await decodeTo16kMono(file);
    selectedDurationSec = samples.length / 16000;
  } catch (err) {
    console.error('[upload] decode failed', err);
    selectedFile = null;
    selectedDurationSec = 0;
    costStrip.hidden = true;
    showError(`Could not decode this audio file: ${err.message || err}`);
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
      throw new Error('Unsupported format');
    }
    if (blob.size > MAX_BYTES) {
      const mb = (blob.size / (1024 * 1024)).toFixed(1);
      const msg = vadOn
        ? `Post-VAD file > 18 MB (${mb} MB, OpenAI/OpenRouter limit). Disable VAD or use a shorter excerpt.`
        : `File > 18 MB (${mb} MB).`;
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

    const text = result.text || '';
    /* Atomic replace : <pre> ← new text, label cleared,
     * localStorage écrit en dernier. */
    transcriptPre.textContent = text;
    clearPreviousLabel();
    resultActions.hidden = false;

    const model = MODELS.find(m => m.id === modelId);
    const estimatedCostUsd = model ? estimateCost(model, selectedDurationSec) : 0;
    persistLastTranscript({
      text,
      sourceName: file.name,
      modelId,
      lang,
      durationSec: selectedDurationSec,
      costUsd: estimatedCostUsd,
      timestamp: Date.now()
    });
  } catch (err) {
    const isAbort = err?.name === 'AbortError'
      || /aborted/i.test(err?.message || '');
    const msg = isAbort
      ? 'Transcription cancelled.'
      : `Transcription error: ${err?.message || err}`;
    showError(msg);
  } finally {
    abortCtrl = null;
    exitRunning();
  }
}

function onCancelClick() {
  if (abortCtrl) abortCtrl.abort();
}

/* ---------- download TXT ---------- */

function currentTranscriptText() {
  /* Source de vérité : le <pre> (qui reflète soit le dernier rendu réussi
   * en mémoire, soit l'hydratation localStorage au load). */
  return transcriptPre.textContent || '';
}

function currentSourceName() {
  /* Pour le nom de fichier, on privilégie lastTranscript.sourceName
   * (persisté), sinon le fichier courant. */
  const last = loadUploadState().lastTranscript;
  if (last && last.sourceName) return last.sourceName;
  if (selectedFile) return selectedFile.name;
  return 'transcript';
}

function basenameToTxt(sourceName) {
  return sourceName.replace(/\.[^.]+$/, '') + '.txt';
}

function onDownloadClick() {
  const text = currentTranscriptText();
  if (!text) {
    showToast('No transcript to download', 'error');
    return;
  }
  const filename = basenameToTxt(currentSourceName());
  const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  /* Anchor doesn't need to be in the DOM for .click() to work in modern
   * browsers, but Firefox historically required it. Append + remove pour
   * être safe. */
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  /* Revoke after a tick to let the browser pick up the blob. */
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/* ---------- copy to clipboard ---------- */

async function onCopyClick() {
  const text = currentTranscriptText();
  if (!text) {
    showToast('No transcript to copy', 'error');
    return;
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast('Copied ✓', 'success');
  } catch (err) {
    showToast('Copy failed: ' + (err?.message || err), 'error');
  }
}

/* ---------- hydratation au load ---------- */

function hydrateFromLastTranscript() {
  const { lastTranscript } = loadUploadState();
  if (!lastTranscript || !lastTranscript.text) return;
  transcriptPre.textContent = lastTranscript.text;
  resultActions.hidden = false;
  if (lastTranscript.sourceName) {
    showPreviousLabel(lastTranscript.sourceName);
  }
}

/* ---------- settings drawer (step 3.e) ---------- */

function openDrawer() {
  drawer.classList.add('open');
  drawerBackdrop.classList.add('open');
}

function closeDrawer() {
  drawer.classList.remove('open');
  drawerBackdrop.classList.remove('open');
}

function toggleDrawer() {
  if (drawer.classList.contains('open')) closeDrawer();
  else openDrawer();
}

/* API key OpenRouter — partagée avec l'app principale via sttbench.v1.
 * Lecture initiale, écriture en live à chaque input (trim) + via submit
 * pour donner un feedback explicite (toast). Le bouton Transcribe est
 * recalculé après save. */
function hydrateApiKey() {
  if (!keyInput) return;
  keyInput.value = state.apiKeys?.openrouter || '';
}

function persistApiKey(rawValue) {
  if (!state.apiKeys) state.apiKeys = {};
  state.apiKeys.openrouter = (rawValue || '').trim();
  saveState();
  refreshTranscribeEnabled();
}

function wireApiKey() {
  if (!keyInput) return;
  // Live save : `input` couvre la frappe, `change` couvre l'autofill.
  keyInput.addEventListener('input', () => persistApiKey(keyInput.value));
  keyInput.addEventListener('change', () => persistApiKey(keyInput.value));
  // Le form a un bouton Save explicite ; on l'intercepte pour éviter
  // une navigation. La valeur est déjà saved via input/change, on ajoute
  // juste un feedback toast.
  if (keyForm) {
    keyForm.addEventListener('submit', (e) => {
      e.preventDefault();
      persistApiKey(keyInput.value);
      showToast(
        state.apiKeys.openrouter ? 'OpenRouter key saved' : 'OpenRouter key cleared',
        state.apiKeys.openrouter ? 'success' : 'info'
      );
    });
  }
}

/* Langue — un sélecteur en topbar (lang-select), un autre dans le drawer
 * (drawer-lang-select). Source de vérité : state.lang (sttbench.v1).
 * Synchronisation bidirectionnelle. */
function populateDrawerLangSelect() {
  if (!drawerLangSelect) return;
  drawerLangSelect.innerHTML = '';
  for (const { value, label } of LANG_OPTIONS) {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    drawerLangSelect.appendChild(opt);
  }
  drawerLangSelect.value = state.lang ?? 'fr';
}

function syncLangFromValue(value) {
  state.lang = value ?? 'fr';
  saveState();
  if (langSelect && langSelect.value !== state.lang) langSelect.value = state.lang;
  if (drawerLangSelect && drawerLangSelect.value !== state.lang) drawerLangSelect.value = state.lang;
  refreshTranscribeEnabled();
}

function wireLangSelectors() {
  if (langSelect) {
    langSelect.addEventListener('change', () => syncLangFromValue(langSelect.value));
  }
  if (drawerLangSelect) {
    drawerLangSelect.addEventListener('change', () => syncLangFromValue(drawerLangSelect.value));
  }
}

/* VAD toggle — séparé : sttbench.upload.v1.vadEnabled (cf. plan Q4).
 * Default false. Warning amber visible UNIQUEMENT quand le toggle est on. */
function refreshVadWarning() {
  if (!vadWarning || !vadCheckbox) return;
  vadWarning.hidden = !vadCheckbox.checked;
}

function hydrateVadToggle() {
  if (!vadCheckbox) return;
  const { vadEnabled } = loadUploadState();
  vadCheckbox.checked = !!vadEnabled;
  refreshVadWarning();
}

function wireVadToggle() {
  if (!vadCheckbox) return;
  vadCheckbox.addEventListener('change', () => {
    const current = loadUploadState();
    current.vadEnabled = !!vadCheckbox.checked;
    saveUploadState(current);
    refreshVadWarning();
  });
}

/* Settings button + close + backdrop + auto-open si aucune clé.
 * Global keydown shortcut `,` toggles the drawer (parity with the main app).
 * Ignored when focus is in an editable target (input/textarea/select/
 * contenteditable) or when a modifier key is pressed. */
function isTypingTarget(el) {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (el.isContentEditable) return true;
  return false;
}

function wireDrawer() {
  if (settingsBtn) settingsBtn.addEventListener('click', toggleDrawer);
  if (drawerClose) drawerClose.addEventListener('click', closeDrawer);
  if (drawerBackdrop) drawerBackdrop.addEventListener('click', closeDrawer);

  document.addEventListener('keydown', (e) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (isTypingTarget(e.target)) return;
    if (e.key === ',') {
      e.preventDefault();
      toggleDrawer();
    }
  });
}

function maybeAutoOpenDrawer() {
  const key = (state.apiKeys?.openrouter || '').trim();
  if (!key) openDrawer();
}

/* ---------- init ---------- */

function init() {
  populateModelSelect();
  populateLangSelect();
  populateDrawerLangSelect();
  wireDropZone();
  wireDrawer();
  wireApiKey();
  wireLangSelectors();
  wireVadToggle();

  hydrateApiKey();
  hydrateVadToggle();

  btnTranscribe.addEventListener('click', onTranscribeClick);
  btnCancel.addEventListener('click', onCancelClick);
  btnDownload.addEventListener('click', onDownloadClick);
  btnCopy.addEventListener('click', onCopyClick);

  modelSelect.addEventListener('change', () => {
    renderCostStrip();
    refreshTranscribeEnabled();
  });

  hydrateFromLastTranscript();
  refreshTranscribeEnabled();
  maybeAutoOpenDrawer();
}

init();
