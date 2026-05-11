import { getModelsToRun } from './models.js';
import { state } from './state.js';
import { refreshCostStrip, runTranscriptions } from './transcription.js';
import { dom, renderResultsLayout, showToast } from './ui.js';

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

/* ============================================================ *
 * WAV CONVERSION (webm/opus → 16 kHz mono PCM16 WAV)
 *
 * Why: OpenRouter's dedicated STT endpoint and several providers
 * (notably Mistral/Voxtral) reject webm. WAV 16 kHz mono is the
 * universal format accepted by every transcription API and is
 * also the native input format Whisper-style models train on.
 * ============================================================ */
let _wavCache = { srcBlob: null, wavBlob: null };

export async function blobToWav(srcBlob, targetSampleRate = 16000) {
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

export async function getVad() {
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

