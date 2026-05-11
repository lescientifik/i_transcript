#!/usr/bin/env bun
// scripts/extract-shared.mjs
//
// One-shot refactor (idempotent): carve out pure modules from src/ into
// src/shared/ as foundation for the upload-app feature.
//
//   src/state.js              → src/shared/state.js (full move)
//   src/models.js             → src/shared/models.js (full move)
//   src/audio.js (excerpts)   → src/shared/audio-codec.js
//                                  blobToWav, getVad, decodeTo16kMono,
//                                  float32ToWavBlob, trimWithVAD, ORT_VERSION
//                                  (+ private caches _wavCache, _vadInstance,
//                                  _vadLoadingPromise)
//   src/transcription.js      → src/shared/openrouter.js
//                                  postOpenRouterTranscription(...),
//                                  EXTENSION_TO_FORMAT, extensionToFormat
//                                  transcribeOpenRouter becomes a 5-line
//                                  wrapper over postOpenRouterTranscription
//
// Strategy:
//   - For state/models full moves: ts-morph `SourceFile.move()` so all import
//     specifiers in the rest of the project are rewritten automatically.
//   - For audio-codec extraction: slice the WAV CONVERSION and VAD SILENCE
//     TRIMMING banner-delimited sections out of src/audio.js (preserving
//     banners), add the missing `export` keywords, and write to
//     src/shared/audio-codec.js. Replace the cut text in audio.js with an
//     import line.
//   - For openrouter extraction: synthesise src/shared/openrouter.js from a
//     template that hosts `postOpenRouterTranscription` + EXTENSION_TO_FORMAT
//     helpers. Replace the body of transcribeOpenRouter (in transcription.js)
//     with a thin wrapper. Public signature of transcribeOpenRouter is
//     preserved so runTranscriptions keeps working.
//
// The script is idempotent: each phase first checks whether the target file
// already exists, and skips its work if so.

import { Project, SyntaxKind, IndentationText, QuoteKind } from 'ts-morph';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const SRC = path.join(ROOT, 'src');
const SHARED = path.join(SRC, 'shared');

// ---------------------------------------------------------------------------
// Boot the ts-morph project — load every JS module we may touch.
// ---------------------------------------------------------------------------
const project = new Project({
  // ts-morph needs allowJs so the JS source graph is type-checked and
  // SourceFile.move() can find + rewrite every import specifier referring to
  // the moved file. Without allowJs ts-morph silently no-ops on JS imports.
  compilerOptions: {
    allowJs: true,
    checkJs: false,
    module: 99 /* ESNext */,
    target: 99 /* ESNext */,
  },
  manipulationSettings: {
    indentationText: IndentationText.TwoSpaces,
    quoteKind: QuoteKind.Single,
  },
});

const PROJECT_FILES = [
  'src/state.js',
  'src/models.js',
  'src/audio.js',
  'src/transcription.js',
  'src/ui.js',
  'src/app.js',
];

// Also load shared/* if present (idempotent re-runs).
for (const rel of PROJECT_FILES) {
  const abs = path.join(ROOT, rel);
  if (fs.existsSync(abs)) project.addSourceFileAtPath(abs);
}
const SHARED_FILES = [
  'src/shared/state.js',
  'src/shared/models.js',
  'src/shared/audio-codec.js',
  'src/shared/openrouter.js',
];
for (const rel of SHARED_FILES) {
  const abs = path.join(ROOT, rel);
  if (fs.existsSync(abs)) project.addSourceFileAtPath(abs);
}

if (!fs.existsSync(SHARED)) fs.mkdirSync(SHARED, { recursive: true });

// ---------------------------------------------------------------------------
// Phase 1 — Move src/state.js → src/shared/state.js
// ---------------------------------------------------------------------------
{
  const targetAbs = path.join(SHARED, 'state.js');
  const sourceAbs = path.join(SRC, 'state.js');
  if (fs.existsSync(targetAbs)) {
    console.log('[state] already at src/shared/state.js — skipping move.');
  } else if (!fs.existsSync(sourceAbs)) {
    console.log('[state] src/state.js missing AND src/shared/state.js missing — abort.');
    process.exit(1);
  } else {
    const sf = project.getSourceFile(sourceAbs);
    if (!sf) throw new Error('state.js not loaded in project');
    sf.move(targetAbs); // ts-morph rewrites every import specifier referencing it.
    console.log('[state] moved to src/shared/state.js');
  }
}

// ---------------------------------------------------------------------------
// Phase 2 — Move src/models.js → src/shared/models.js
// ---------------------------------------------------------------------------
{
  const targetAbs = path.join(SHARED, 'models.js');
  const sourceAbs = path.join(SRC, 'models.js');
  if (fs.existsSync(targetAbs)) {
    console.log('[models] already at src/shared/models.js — skipping move.');
  } else if (!fs.existsSync(sourceAbs)) {
    console.log('[models] src/models.js missing AND src/shared/models.js missing — abort.');
    process.exit(1);
  } else {
    const sf = project.getSourceFile(sourceAbs);
    if (!sf) throw new Error('models.js not loaded in project');
    sf.move(targetAbs);
    console.log('[models] moved to src/shared/models.js');
  }
}

// Defensive pass: ts-morph's automatic specifier rewrite on JS files can
// silently no-op when the symbol resolution doesn't bind through. Walk every
// remaining src/*.js and explicitly rewrite './state.js' → './shared/state.js'
// and './models.js' → './shared/models.js' import specifiers. Idempotent:
// already-correct specifiers stay as-is.
const CONSUMER_REWRITES = [
  { from: './state.js', to: './shared/state.js' },
  { from: './models.js', to: './shared/models.js' },
];
for (const rel of ['src/audio.js', 'src/transcription.js', 'src/ui.js', 'src/app.js']) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  const sf = project.getSourceFile(abs);
  if (!sf) continue;
  for (const decl of sf.getImportDeclarations()) {
    const spec = decl.getModuleSpecifierValue();
    for (const { from, to } of CONSUMER_REWRITES) {
      if (spec === from) decl.setModuleSpecifier(to);
    }
  }
}

// Persist Phases 1+2 to disk now so the rest of the script can rely on the
// updated import graph in audio.js / transcription.js / ui.js / app.js.
await project.save();

// ts-morph's TS-aware specifier rewrite strips `.js` extensions because the
// resolver accepts extensionless paths. GitHub Pages serves no build step and
// browsers REQUIRE explicit `.js` extensions for ES modules. Final on-disk
// normalization pass: re-append `.js` to every relative import specifier that
// lacks an extension. Idempotent (already-correct specifiers are untouched).
function normalizeExtensions(absPath) {
  if (!fs.existsSync(absPath)) return;
  const before = fs.readFileSync(absPath, 'utf8');
  const after = before.replace(
    /from\s+(['"])(\.\.?\/[^'"\n]+?)\1/g,
    (full, q, spec) => {
      if (/\.(?:m?js|json)$/.test(spec)) return full; // already extensioned
      return `from ${q}${spec}.js${q}`;
    }
  );
  if (after !== before) fs.writeFileSync(absPath, after);
}
for (const rel of [
  'src/audio.js', 'src/transcription.js', 'src/ui.js', 'src/app.js',
  'src/shared/state.js', 'src/shared/models.js',
  'src/shared/audio-codec.js', 'src/shared/openrouter.js',
]) {
  normalizeExtensions(path.join(ROOT, rel));
}

// ---------------------------------------------------------------------------
// Phase 3 — Extract audio-codec.js from audio.js
// ---------------------------------------------------------------------------
{
  const codecPath = path.join(SHARED, 'audio-codec.js');
  const audioPath = path.join(SRC, 'audio.js');
  if (fs.existsSync(codecPath)) {
    console.log('[audio-codec] already extracted — skipping.');
  } else {
    const audioSrc = fs.readFileSync(audioPath, 'utf8');

    // Locate the two banner blocks that mark the start of pure code.
    // Pattern matches:
    //   /* ============================================================ *
    //    * NAME ...
    //    * ============================================================ */
    const wavBannerRe = /\/\* ={3,}[ ]?\*\n \* WAV CONVERSION[\s\S]*? \* ={3,} \*\/\n/m;
    const wavBannerMatch = audioSrc.match(wavBannerRe);
    if (!wavBannerMatch) throw new Error('WAV CONVERSION banner not found in audio.js');
    const wavStart = wavBannerMatch.index;
    // Everything from wavStart to EOF is pure codec code (WAV + VAD sections).
    let codecBody = audioSrc.slice(wavStart);
    const audioBefore = audioSrc.slice(0, wavStart).replace(/\s+$/, '\n');

    // Add missing `export` keywords: trimWithVAD and decodeTo16kMono and
    // float32ToWavBlob were originally module-private in audio.js.
    // trimWithVAD MUST be exported (consumed by upload.js in step 3.c).
    codecBody = codecBody.replace(
      /^async function trimWithVAD\(/m,
      'export async function trimWithVAD('
    );
    // decodeTo16kMono and float32ToWavBlob are not consumed outside today, but
    // the codec module is the canonical home for them — export so upload.js
    // can read the duration cheaply via decodeTo16kMono (step 3.b cost-strip).
    codecBody = codecBody.replace(
      /^async function decodeTo16kMono\(/m,
      'export async function decodeTo16kMono('
    );
    codecBody = codecBody.replace(
      /^function float32ToWavBlob\(/m,
      'export function float32ToWavBlob('
    );
    // ORT_VERSION is a private const today; the brief asks for it in the
    // codec module surface so the upload app can read the same ORT version
    // pin if it ever needs to. Export the `const` declaration.
    codecBody = codecBody.replace(
      /^const ORT_VERSION = /m,
      'export const ORT_VERSION = '
    );

    fs.writeFileSync(codecPath, codecBody);
    console.log('[audio-codec] wrote src/shared/audio-codec.js (' + codecBody.length + ' bytes)');

    // Rewrite audio.js: keep everything before the WAV banner; append a single
    // import line that pulls back the symbols audio.js still uses (blobToWav
    // for now — the brief says ONLY DOM-bound code remains in audio.js).
    // audio.js currently consumes only blobToWav (line "await blobToWav...")
    // and trimWithVAD (line "await trimWithVAD..."). Re-introduce them.
    const codecImport =
      "import { blobToWav, trimWithVAD } from './shared/audio-codec.js';\n";

    // Splice the import after the last existing import line of audio.js.
    const audioSf = project.getSourceFile(audioPath);
    if (!audioSf) throw new Error('audio.js not loaded in project');
    // We rebuild audio.js text from scratch with the codec block removed and
    // the new import inserted in the import block.
    const lines = audioBefore.split('\n');
    let lastImportLineIdx = -1;
    for (let i = 0; i < lines.length; i++) {
      if (/^import .* from /.test(lines[i])) lastImportLineIdx = i;
    }
    if (lastImportLineIdx < 0) {
      // No imports — prepend
      lines.unshift(codecImport.trimEnd());
    } else {
      lines.splice(lastImportLineIdx + 1, 0, codecImport.trimEnd());
    }
    const newAudio = lines.join('\n');
    fs.writeFileSync(audioPath, newAudio);
    console.log('[audio.js] rewritten without codec sections (' + newAudio.length + ' bytes)');

    // Refresh in project so subsequent phases see the new content.
    audioSf.replaceWithText(newAudio);
  }
}

// ---------------------------------------------------------------------------
// Phase 4 — Extract openrouter.js + rewrite transcribeOpenRouter wrapper
// ---------------------------------------------------------------------------
{
  const orPath = path.join(SHARED, 'openrouter.js');
  const transPath = path.join(SRC, 'transcription.js');
  if (fs.existsSync(orPath)) {
    console.log('[openrouter] already extracted — skipping.');
  } else {
    const ORIGIN = 'https://lescientifik.github.io/i_transcript/';
    const APP_TITLE = 'i_transcript';

    const openrouterText =
`/* ============================================================ *
 * OPENROUTER TRANSCRIPTION (pure, no DOM, no state)
 *
 * Single entry point used by both the main recorder app and the
 * upload app. Caller owns:
 *   - blob format (caller must pass a blob already in one of
 *     OpenRouter's accepted formats; main app encodes to WAV first
 *     via shared/audio-codec.js, upload app may pass natively).
 *   - apiKey retrieval (kept out of this module so it stays pure).
 *   - language hint (optional).
 *   - AbortController (caller passes signal for upload app cancel).
 *
 * Returns { text, usage } — same shape transcribeOpenRouter used to
 * return so runTranscriptions doesn't need any rewrite at the call
 * site.
 * ============================================================ */

export const EXTENSION_TO_FORMAT = {
  '.wav':  'wav',
  '.mp3':  'mp3',
  '.flac': 'flac',
  '.m4a':  'm4a',
  '.mp4':  'm4a',   // mp4 audio container → format m4a side OpenRouter
  '.ogg':  'ogg',
  '.oga':  'ogg',
  '.opus': 'ogg',   // .opus is typically OGG-encapsulated
  '.webm': 'webm',
  '.aac':  'aac',
};

export function extensionToFormat(filename) {
  const ext = filename.toLowerCase().match(/\\.[a-z0-9]+$/)?.[0];
  return EXTENSION_TO_FORMAT[ext] ?? null;
}

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

/* Schema discovered from API: { model, input_audio: { data, format }, language? }
 * Body is JSON, NOT multipart form-data. */
export async function postOpenRouterTranscription({ blob, modelId, language, apiKey, format, signal }) {
  if (!apiKey) throw new Error('OpenRouter API key missing');
  const b64 = await blobToBase64(blob);
  const body = {
    model: modelId,
    input_audio: { data: b64, format }
  };
  if (language) body.language = language;
  const res = await fetch('https://openrouter.ai/api/v1/audio/transcriptions', {
    method: 'POST',
    headers: {
      'Authorization': \`Bearer \${apiKey}\`,
      'Content-Type': 'application/json',
      'HTTP-Referer': '${ORIGIN}',
      'X-OpenRouter-Title': '${APP_TITLE}'
    },
    body: JSON.stringify(body),
    signal
  });
  if (!res.ok) {
    const errText = await res.text();
    throw new Error(\`OpenRouter \${res.status}: \${errText.substring(0, 250)}\`);
  }
  const json = await res.json();
  return { text: json.text || '', usage: json.usage || null };
}
`;

    fs.writeFileSync(orPath, openrouterText);
    console.log('[openrouter] wrote src/shared/openrouter.js (' + openrouterText.length + ' bytes)');

    // Now collapse transcribeOpenRouter in transcription.js into a wrapper.
    let trans = fs.readFileSync(transPath, 'utf8');

    // 1) Add the openrouter import line at the top (after existing imports).
    if (!trans.includes("from './shared/openrouter.js'")) {
      // Insert after the last existing top import line.
      const lines = trans.split('\n');
      let lastImportLineIdx = -1;
      for (let i = 0; i < lines.length; i++) {
        if (/^import .* from /.test(lines[i])) lastImportLineIdx = i;
      }
      if (lastImportLineIdx < 0) {
        lines.unshift("import { postOpenRouterTranscription } from './shared/openrouter.js';");
      } else {
        lines.splice(
          lastImportLineIdx + 1,
          0,
          "import { postOpenRouterTranscription } from './shared/openrouter.js';"
        );
      }
      trans = lines.join('\n');
    }

    // 2) Replace the transcribeOpenRouter function body with a wrapper.
    // Match the FULL declaration including its leading /* comment block */.
    const transcribeOpenRouterRe =
      /\/\* OpenRouter STT dedicated endpoint[\s\S]*?async function transcribeOpenRouter\([^)]*\)\s*{[\s\S]*?\n}\n/m;
    const wrapper =
`/* OpenRouter STT dedicated endpoint — thin wrapper over
 * shared/openrouter.js. Kept on this signature so runTranscriptions
 * and the test surface stay unchanged. */
async function transcribeOpenRouter(model, blob, lang) {
  if (!state.apiKeys.openrouter) throw new Error('OpenRouter API key missing (Settings)');
  // OpenRouter dedicated STT endpoint accepts a fixed list of formats and
  // does NOT include webm. Encode the recorder's webm blob to WAV first.
  const wavBlob = await blobToWav(blob);
  return postOpenRouterTranscription({
    blob: wavBlob,
    modelId: model.id,
    language: lang,
    apiKey: state.apiKeys.openrouter,
    format: 'wav',
  });
}
`;
    if (!transcribeOpenRouterRe.test(trans)) {
      throw new Error('Failed to locate transcribeOpenRouter declaration block in transcription.js');
    }
    trans = trans.replace(transcribeOpenRouterRe, wrapper);

    // 3) Remove the now-orphan helpers (blobToBase64, blobExtension) IF they
    // are no longer referenced. blobToBase64 is still referenced by
    // transcribeOpenRouterChat → keep it. blobExtension is unreferenced (was
    // already dead). Leave both untouched to keep this script minimal — dead
    // code cleanup is out of scope for this refactor.

    fs.writeFileSync(transPath, trans);
    const transSf = project.getSourceFile(transPath);
    transSf.replaceWithText(trans);
  }
}

// ---------------------------------------------------------------------------
// Phase 5 — Migrate every consumer's import of symbols that moved out of
// src/audio.js into src/shared/audio-codec.js. Any named import of a codec
// symbol from './audio.js' is rerouted to './shared/audio-codec.js'. This
// covers both the transcription.js blobToWav reroute and the ui.js getVad
// reroute (and any future codec symbol consumed across the app).
// ---------------------------------------------------------------------------
const CODEC_SYMBOLS = new Set([
  'blobToWav', 'getVad', 'decodeTo16kMono',
  'float32ToWavBlob', 'trimWithVAD', 'ORT_VERSION',
]);
for (const rel of ['src/transcription.js', 'src/ui.js', 'src/app.js']) {
  const abs = path.join(ROOT, rel);
  const sf = project.getSourceFile(abs);
  if (!sf) continue;
  const audioImport = sf.getImportDeclaration(d =>
    d.getModuleSpecifierValue() === './audio.js'
  );
  if (!audioImport) continue;
  const named = audioImport.getNamedImports().map(n => n.getName());
  const moved = named.filter(n => CODEC_SYMBOLS.has(n));
  if (moved.length === 0) continue;
  const remaining = named.filter(n => !CODEC_SYMBOLS.has(n));
  // Surgical rebuild: remove the moved names from the audio.js import.
  audioImport.removeNamedImports();
  if (remaining.length > 0) {
    audioImport.addNamedImports(remaining.map(name => ({ name })));
  } else {
    audioImport.remove();
  }
  // Attach (or extend) the shared/audio-codec.js import with the moved names.
  let codecImport = sf.getImportDeclaration(d =>
    d.getModuleSpecifierValue() === './shared/audio-codec.js'
  );
  if (!codecImport) {
    sf.addImportDeclaration({
      moduleSpecifier: './shared/audio-codec.js',
      namedImports: moved.map(name => ({ name })),
    });
  } else {
    const have = new Set(codecImport.getNamedImports().map(n => n.getName()));
    for (const name of moved) {
      if (!have.has(name)) codecImport.addNamedImport(name);
    }
  }
}

// ---------------------------------------------------------------------------
// Persist everything still in-flight via ts-morph (transcription.js import
// reshuffle from phase 4).
// ---------------------------------------------------------------------------
await project.save();

// Final normalization pass to re-append `.js` extensions stripped by ts-morph
// during phase 4 import surgery on transcription.js.
for (const rel of [
  'src/audio.js', 'src/transcription.js', 'src/ui.js', 'src/app.js',
  'src/shared/state.js', 'src/shared/models.js',
  'src/shared/audio-codec.js', 'src/shared/openrouter.js',
]) {
  normalizeExtensions(path.join(ROOT, rel));
}

console.log('\nDone. src/shared/ extraction complete.');
console.log('Next: bun smoke-test the main app to confirm no regression.');
