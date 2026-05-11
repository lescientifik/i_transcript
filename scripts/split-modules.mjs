#!/usr/bin/env bun
// scripts/split-modules.mjs
//
// One-shot refactor: split src/app.js (monolithic) into 6 ES modules
//   models, state, audio, transcription, ui, app
// using ts-morph for AST-driven export/import insertion.
//
// Algorithm:
//   1. Read src/app.js, drop "'use strict';" (modules are strict by default).
//   2. Locate each /* === BANNER === */ section header.
//   3. Map each section to its target module via SECTION_MAP.
//   4. Concatenate sections per module, preserving original order.
//   5. Parse each module with ts-morph to find top-level declarations.
//   6. For each module, walk Identifier nodes to find cross-module refs
//      (skipping property names, declaration names, etc).
//   7. Mark referenced declarations as exported; build import statements.
//   8. Write src/<module>.js for each module.

import { Project, SyntaxKind } from 'ts-morph';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dir, '..');
const SRC = path.join(ROOT, 'src', 'app.js');
const OUT_DIR = path.join(ROOT, 'src');

// Section banner prefix → target module.
// Keys are matched by `name.startsWith(key)` so they tolerate descriptive
// suffixes (e.g. "WAV CONVERSION (webm/opus → 16 kHz mono PCM16 WAV)").
const SECTION_MAP = {
  'MODELS CATALOG': 'models',
  'STATE & LOCAL STORAGE': 'state',
  'DOM REFS': 'ui',
  'RECORDING': 'audio',
  'COST CALCULATION': 'transcription',
  'API CALLS': 'transcription',
  'PROVIDER API CALLS': 'transcription',
  'WAV CONVERSION': 'audio',
  'VAD SILENCE TRIMMING': 'audio',
  'RESULTS RENDERING': 'ui',
  'RUN ALL TRANSCRIPTIONS': 'transcription',
  'SETTINGS DRAWER': 'ui',
  'SHORTCUTS': 'ui',
  'COPY': 'ui',
  'TOAST': 'ui',
  'EVENT WIRING': 'ui',
  'INIT': 'app',
};

const MODULE_ORDER = ['models', 'state', 'audio', 'transcription', 'ui', 'app'];

// ---------- Step 1: read & normalize source ----------
let src = fs.readFileSync(SRC, 'utf8');
src = src.replace(/^'use strict';\n+/, '');

// ---------- Step 2: locate banners ----------
// Banner shape:
//   /* ============================================================ *
//    * NAME (optional parenthetical)
//    * (zero or more comment lines)
//    * ============================================================ */
const bannerRe = /\/\* ={3,}[ ]?\*\n \* ([^\n]+)\n[\s\S]*? \* ={3,} \*\/\n/g;
const sections = [];
for (const m of src.matchAll(bannerRe)) {
  sections.push({
    name: m[1].trim(),
    bannerStart: m.index,
    bannerEnd: m.index + m[0].length,
  });
}
if (sections.length === 0) throw new Error('No section banners found in app.js');

for (let i = 0; i < sections.length; i++) {
  const s = sections[i];
  const codeEnd = (i + 1 < sections.length) ? sections[i + 1].bannerStart : src.length;
  s.body = src.slice(s.bannerStart, codeEnd);
  const key = Object.keys(SECTION_MAP).find(k => s.name.startsWith(k));
  if (!key) throw new Error(`Unknown section: "${s.name}"`);
  s.module = SECTION_MAP[key];
}

console.log(`Found ${sections.length} sections:`);
for (const s of sections) console.log(`  - ${s.name.slice(0, 50).padEnd(52)} → ${s.module}`);

// ---------- Step 3: concatenate sections per module ----------
const moduleBodies = {};
for (const s of sections) {
  moduleBodies[s.module] = (moduleBodies[s.module] || '') + s.body;
}

// ---------- Step 4: parse each module, find top-level declarations ----------
const project = new Project({ useInMemoryFileSystem: true });
const sourceFiles = {};
for (const [mod, body] of Object.entries(moduleBodies)) {
  sourceFiles[mod] = project.createSourceFile(`${mod}.js`, body);
}

function collectDeclaredNames(sf) {
  const names = new Set();
  for (const stmt of sf.getStatements()) {
    const kind = stmt.getKind();
    if (kind === SyntaxKind.FunctionDeclaration || kind === SyntaxKind.ClassDeclaration) {
      const n = stmt.getName();
      if (n) names.add(n);
    } else if (kind === SyntaxKind.VariableStatement) {
      for (const decl of stmt.getDeclarations()) {
        const nameNode = decl.getNameNode();
        if (nameNode.getKind() === SyntaxKind.Identifier) {
          names.add(nameNode.getText());
        } else {
          // destructured binding pattern — walk identifiers within
          nameNode.forEachDescendant(n => {
            if (n.getKind() === SyntaxKind.Identifier) names.add(n.getText());
          });
        }
      }
    }
  }
  return names;
}

const declaredIn = {};
for (const [mod, sf] of Object.entries(sourceFiles)) {
  declaredIn[mod] = collectDeclaredNames(sf);
}

// reverse index: symbol → owner module
const symbolModule = {};
for (const [mod, names] of Object.entries(declaredIn)) {
  for (const n of names) {
    if (symbolModule[n] && symbolModule[n] !== mod) {
      console.warn(`!! symbol "${n}" declared in both ${symbolModule[n]} and ${mod}`);
    }
    symbolModule[n] = mod;
  }
}

console.log('\nDeclared symbols per module:');
for (const mod of MODULE_ORDER) {
  if (declaredIn[mod]) {
    console.log(`  ${mod.padEnd(15)} (${declaredIn[mod].size}): ${[...declaredIn[mod]].join(', ')}`);
  }
}

// ---------- Step 5: detect cross-module references ----------
// Identifiers that DON'T represent free references (only declaration names,
// property names, label names, etc).
function isFreeReference(id) {
  const parent = id.getParent();
  if (!parent) return false;
  const pk = parent.getKind();

  // obj.foo  ─ "foo" is a property name, not a binding reference
  if (pk === SyntaxKind.PropertyAccessExpression && parent.getNameNode() === id) return false;

  // { foo: value }  ─ "foo" is a property key
  if (pk === SyntaxKind.PropertyAssignment && parent.getNameNode() === id) return false;

  // { foo() {} } / get foo() {} / set foo() {}
  if (pk === SyntaxKind.MethodDeclaration && parent.getNameNode() === id) return false;
  if (pk === SyntaxKind.GetAccessor && parent.getNameNode() === id) return false;
  if (pk === SyntaxKind.SetAccessor && parent.getNameNode() === id) return false;

  // function foo() {} / class Foo {} / let foo = ...
  if (pk === SyntaxKind.FunctionDeclaration && parent.getNameNode?.() === id) return false;
  if (pk === SyntaxKind.ClassDeclaration && parent.getNameNode?.() === id) return false;
  if (pk === SyntaxKind.VariableDeclaration && parent.getNameNode() === id) return false;
  if (pk === SyntaxKind.Parameter && parent.getNameNode() === id) return false;

  // const { foo } = x;  or  const { foo: bar } = x;  ─ "foo" before the colon
  // is the property name being destructured, not a free reference.
  if (pk === SyntaxKind.BindingElement) {
    const propNameNode = parent.getPropertyNameNode?.();
    if (propNameNode === id) return false;
    if (!propNameNode && parent.getNameNode() === id) return false; // shorthand: { foo }
  }

  // label: stmt
  if (pk === SyntaxKind.LabeledStatement) return false;

  return true;
}

const importsFor = {};
for (const [mod, sf] of Object.entries(sourceFiles)) {
  importsFor[mod] = {};
  const localNames = declaredIn[mod];
  sf.forEachDescendant(node => {
    if (node.getKind() !== SyntaxKind.Identifier) return;
    if (!isFreeReference(node)) return;
    const name = node.getText();
    if (localNames.has(name)) return;
    const owner = symbolModule[name];
    if (!owner || owner === mod) return;
    (importsFor[mod][owner] = importsFor[mod][owner] || new Set()).add(name);
  });
}

// ---------- Step 6: compute the set of symbols that need an `export` ----------
const exportedSymbols = new Set();
for (const imps of Object.values(importsFor)) {
  for (const names of Object.values(imps)) {
    for (const n of names) exportedSymbols.add(n);
  }
}

console.log(`\nExported symbols (${exportedSymbols.size}):`, [...exportedSymbols].sort().join(', '));

console.log('\nImports per module:');
for (const mod of MODULE_ORDER) {
  const imps = importsFor[mod];
  if (!imps) continue;
  for (const [other, names] of Object.entries(imps)) {
    console.log(`  ${mod} ← ${other}: ${[...names].sort().join(', ')}`);
  }
}

// ---------- Step 7: write modules ----------
function addExportsToBody(body, exports) {
  const tmpProj = new Project({ useInMemoryFileSystem: true });
  const sf = tmpProj.createSourceFile('tmp.js', body);
  for (const stmt of sf.getStatements()) {
    const kind = stmt.getKind();
    let shouldExport = false;
    if (kind === SyntaxKind.FunctionDeclaration || kind === SyntaxKind.ClassDeclaration) {
      if (exports.has(stmt.getName())) shouldExport = true;
    } else if (kind === SyntaxKind.VariableStatement) {
      for (const decl of stmt.getDeclarations()) {
        if (exports.has(decl.getName())) { shouldExport = true; break; }
      }
    }
    if (shouldExport) stmt.setIsExported(true);
  }
  return sf.getFullText();
}

const buildImportLine = (other, names) =>
  `import { ${[...names].sort().join(', ')} } from './${other}.js';`;

for (const mod of MODULE_ORDER) {
  const body = moduleBodies[mod];
  if (!body) { console.warn(`No content for module: ${mod}`); continue; }
  const bodyWithExports = addExportsToBody(body, exportedSymbols);
  const imps = importsFor[mod];
  const importLines = Object.entries(imps)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([other, names]) => buildImportLine(other, names));
  const header = importLines.length > 0 ? importLines.join('\n') + '\n\n' : '';
  const fileText = header + bodyWithExports;
  fs.writeFileSync(path.join(OUT_DIR, `${mod}.js`), fileText);
  console.log(`Wrote src/${mod}.js (${fileText.length} bytes)`);
}

console.log('\nDone. Delete src/app.js?  → no, app.js is the entry point now.');
