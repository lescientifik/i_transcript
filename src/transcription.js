import { blobToWav, recordedBlob, recordedDurationSec } from './audio.js';
import { MODELS, hasFreshSuccess, isModelAvailable } from './models.js';
import { state } from './state.js';
import { dom, setCardError, setCardLoading, setCardResult, showToast } from './ui.js';

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

export function fmtCost(usd) {
  if (usd == null) return '—';
  if (usd < 0.0001) return '<$0.0001';
  if (usd < 0.01)   return '$' + usd.toFixed(5);
  return '$' + usd.toFixed(4);
}

export function refreshCostStrip() {
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

export function refreshSelectedLabel() {
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

export function refreshPromptRowVisibility() {
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
 * PROVIDER API CALLS (transcription endpoints)
 * Functions that hit each provider's HTTP API to transcribe a blob.
 * Each returns `{ text, costUsd }` or throws.
 * ============================================================ */
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
 * RUN ALL TRANSCRIPTIONS
 * ============================================================ */
export async function runTranscriptions() {
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

