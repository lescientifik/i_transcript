import { cachedResults, currentAudioId, getVad, isRecording, recordedBlob, startRecording, stopRecording, updateRecorderUI } from './audio.js';
import { MODELS, getModelsToRun, isModelAvailable } from './models.js';
import { saveState, state } from './state.js';
import { fmtCost, refreshCostStrip, refreshPromptRowVisibility, refreshSelectedLabel, runTranscriptions } from './transcription.js';

/* ============================================================ *
 * DOM REFS
 * ============================================================ */
const $ = (id) => document.getElementById(id);
export const dom = {
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
 * RESULTS RENDERING
 * ============================================================ */
export function renderResultsLayout() {
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

export function setCardLoading(modelId) {
  const card = dom.resultsContainer.querySelector(`.card[data-model-id="${CSS.escape(modelId)}"]`);
  if (!card) return;
  const body = card.querySelector('[data-body-slot]');
  body.contentEditable = 'false';
  body.className = 'card-body loading';
  body.innerHTML = '<div class="spinner"></div>';
  card.querySelector('[data-copy-btn]').disabled = true;
}

export function setCardResult(modelId, text, costUsd, durationSec) {
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

export function setCardError(modelId, message) {
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
 * SETTINGS DRAWER
 * ============================================================ */
export function openDrawer() {
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

export function refreshShortcutsUI() {
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
export function showToast(msg, kind = 'info') {
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

