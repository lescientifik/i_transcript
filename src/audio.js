import { MODELS, isModelAvailable } from './shared/models.js';
import { state } from './shared/state.js';
import { refreshCostStrip, runTranscriptions } from './transcription.js';
import { dom, renderResultsLayout, showToast } from './ui.js';
import { blobToWav, trimWithVAD } from './shared/audio-codec.js';

/* ============================================================ *
 * RECORDING
 * ============================================================ */
let mediaRecorder = null;
let recordedChunks = [];
export let recordedBlob = null;
export let recordedDurationSec = 0;
let recStartedAt = 0;
let timerHandle = null;
export let isRecording = false;
let cancelRequested = false;
// Per-audio result cache so model-selection changes don't wipe paid transcripts.
// Successful entries also gate the Send button (no re-charging on unchanged audio).
export let currentAudioId = null;
export const cachedResults = {}; // modelId -> { audioId, text?, costUsd?, durationSec?, error? }
// Original (pre-VAD) duration so we can show "X → Y" savings in the UI.
let originalDurationSec = 0;

// True if model already has a successful transcript for the current audio.
export function hasFreshSuccess(modelId) {
  const r = cachedResults[modelId];
  return !!(r && r.audioId === currentAudioId && r.text != null);
}

// Models that still need to be transcribed for the current audio.
export function getModelsToRun() {
  return state.selectedModelIds
    .map(id => MODELS.find(m => m.id === id))
    .filter(m => m && isModelAvailable(m) && !hasFreshSuccess(m.id));
}

export async function startRecording() {
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
    if (cancelRequested) {
      cancelRequested = false;
      stream.getTracks().forEach(t => t.stop());
      recordedChunks = [];
      recordedBlob = null;
      recordedDurationSec = 0;
      isRecording = false;
      dom.timer.textContent = '00:00.0';
      updateRecorderUI();
      showToast('Recording cancelled', 'success');
      return;
    }
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

export function stopRecording() {
  if (!isRecording) return;
  mediaRecorder.stop();
  stopTimer();
}

export function cancelRecording() {
  if (!isRecording) return;
  cancelRequested = true;
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

export function updateRecorderUI() {
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
