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
export const ORT_VERSION = '1.22.0'; // must match the ORT version bundled in vad-web@0.0.29
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
export async function decodeTo16kMono(srcBlob) {
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

export function float32ToWavBlob(samples, sampleRate) {
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
export async function trimWithVAD(srcBlob) {
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

