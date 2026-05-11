---
description: Plan de modularisation de index.html monolithique vers index.html + styles.css + 6 modules ES JS, piloté par ts-morph (Bun), validé par Playwright headed dans des agents OPUS dédiés.
---

# Plan de modularisation `i_transcript`

## Contexte

`index.html` actuel = 1990 lignes : `<style>` inline (535 l) + body (188 l) + 2 CDN scripts + `<script>` inline (1253 l). L'app a grossi, on veut découper proprement pour reprendre le contrôle.

**Contraintes dures** :
- Doit continuer à fonctionner sur **GitHub Pages** (site statique, aucun build server).
- **Pas de build step** pour l'app (le navigateur exécute du JS natif).
- **Pas de recopiage manuel de code** (risque d'erreurs de retape) → utiliser des outils de refactor AST (ts-morph) + `sed` byte-exact + `Edit` substitution exacte.

## Décisions actées

| Sujet | Décision |
|---|---|
| Module system | **ES modules natifs** (`<script type="module">`) |
| Granularité | **~6 modules par domaine** (option B) |
| Outil de refactor | **ts-morph** (équivalent JS de `rope`) |
| Typage | JS pur, pas de JSDoc/`@ts-check` pour cette PR |
| Structure | `src/` pour le JS, `styles.css` à la racine |
| CSS | Un seul `styles.css` (535 l acceptable) |
| Tooling | **Bun** + `package.json` + `bun.lock`, `node_modules/` gitignoré |
| credential-field | Reste dans `ui.js` pour cette PR (extraction lib autonome → plus tard) |
| Tests | **`microsoft/playwright-cli` + son skill Claude Code**, headed, lancé dans des **agents OPUS dédiés** (évite de polluer le contexte principal) |
| Script ts-morph | **Committé** dans `scripts/split-modules.mjs` pour traçabilité |

## Architecture cible

```
i_transcript/
  index.html              ← ~190 lignes (HTML squelette uniquement)
  styles.css              ← ~535 lignes (CSS extrait tel quel)
  src/
    app.js                ← entry point : init()
    models.js             ← MODELS CATALOG
    state.js              ← STATE & LOCAL STORAGE (loadState/saveState/state)
    audio.js              ← RECORDING + WAV CONVERSION + VAD
    transcription.js      ← API CALLS + COST + RUN ALL
    ui.js                 ← DOM REFS + RESULTS + SETTINGS DRAWER (avec credential-field) + SHORTCUTS + COPY + TOAST + EVENT WIRING
  scripts/
    split-modules.mjs     ← script ts-morph one-shot, committé
  package.json            ← devDeps: ts-morph, @playwright/cli
  bun.lock                ← lockfile Bun
  .claude/
    skills/
      playwright-cli/     ← skill copié du repo microsoft/playwright-cli, committé
        SKILL.md          ← frontmatter adapté (allowed-tools = bunx playwright-cli)
        references/       ← guides détaillés du skill
  .gitignore              ← node_modules/, screenshots/, *.png debug
  MODULARIZE_PLAN.md      ← ce fichier
```

`index.html` final ne contient qu'un seul `<link>` CSS et un seul `<script type="module">` :

```html
<link rel="stylesheet" href="./styles.css">
<script src="https://cdn.jsdelivr.net/npm/onnxruntime-web@1.22.0/dist/ort.min.js"></script>
<script src="https://cdn.jsdelivr.net/npm/@ricky0123/vad-web@0.0.29/dist/bundle.min.js"></script>
<script type="module" src="./src/app.js"></script>
```

## Mapping sections JS → modules cibles

Identifié via les bannières `/* === XXX === */` existantes :

| Section JS (lignes dans index.html) | Module cible |
|---|---|
| MODELS CATALOG (738-868) | `src/models.js` |
| STATE & LOCAL STORAGE (869-913) | `src/state.js` |
| DOM REFS (914-953) | `src/ui.js` |
| RECORDING (954-1082) | `src/audio.js` |
| COST CALCULATION (1083-1187) | `src/transcription.js` |
| API CALLS (1188-1212) | `src/transcription.js` |
| WAV CONVERSION (1213-1276) | `src/audio.js` |
| VAD SILENCE TRIMMING (1277-1480) | `src/audio.js` |
| RESULTS RENDERING (1481-1618) | `src/ui.js` |
| RUN ALL TRANSCRIPTIONS (1619-1669) | `src/transcription.js` |
| SETTINGS DRAWER (1670-1732) | `src/ui.js` |
| SHORTCUTS (1733-1811) | `src/ui.js` |
| COPY (1812-1839) | `src/ui.js` |
| TOAST (1840-1850) | `src/ui.js` |
| EVENT WIRING (1851-1966) | `src/ui.js` |
| INIT (1967-1987) | `src/app.js` |

## Étapes d'exécution

### Étape 0 — Tooling tout local au projet (refactor + tests)

**Tout est in-repo, versionné, reproductible. Pas d'install globale.**

1. **`.gitignore`** : créer avec `node_modules/`, `screenshots/`, `*.png` (sauf assets dédiés)
2. **`bun init -y`** : génère `package.json` minimal
3. **`bun add -d ts-morph @playwright/cli`** : binaires locaux dans `node_modules/.bin/`
4. **Copier le skill `playwright-cli`** depuis le repo Microsoft dans `.claude/skills/playwright-cli/` du projet :
   ```bash
   # sparse-checkout sans cloner tout le repo
   TMP=$(mktemp -d)
   git clone --depth=1 --filter=blob:none --no-checkout https://github.com/microsoft/playwright-cli "$TMP"
   cd "$TMP" && git sparse-checkout init --cone && git sparse-checkout set skills/playwright-cli && git checkout main
   mkdir -p /home/thenry/Projects/i_transcript/.claude/skills
   cp -r skills/playwright-cli /home/thenry/Projects/i_transcript/.claude/skills/
   rm -rf "$TMP"
   ```
5. **Adapter le frontmatter du skill** copié : éditer `.claude/skills/playwright-cli/SKILL.md` pour que `allowed-tools` autorise aussi l'invocation via `bunx` (binaire local) :
   ```yaml
   allowed-tools: Bash(bunx playwright-cli:*) Bash(playwright-cli:*) Bash(npx:*) Bash(npm:*) Bash(bun:*)
   ```
   (on garde les variantes pour fallback)
6. **Deps système Fedora** (Chromium en headed les requiert) :
   ```bash
   sudo dnf install -y libicu libjpeg-turbo libwebp flite pcre libffi mesa-libgbm \
     libdrm xorg-x11-server-Xvfb atk at-spi2-atk libXcomposite libXdamage \
     libXrandr libXtst cups-libs libxcb libXScrnSaver alsa-lib pango cairo \
     nss gtk3 libnotify liberation-fonts wqy-zenhei-fonts
   ```
   (l'installer auto de Playwright est Debian-only, dnf manuel sur Fedora)
7. **Validation finale** : `bunx playwright-cli open https://example.com --browser=chrome` doit ouvrir Chromium en headed
8. **Commit** : « add local tooling: Bun + ts-morph + playwright-cli + skill »

**Visibilité du skill aux sous-agents** : Claude Code charge automatiquement `.claude/skills/` du cwd au démarrage de la session. Le skill `playwright-cli` sera donc disponible dès l'ouverture d'une nouvelle session Claude Code dans `/home/thenry/Projects/i_transcript/`. Pas besoin de redémarrer dans la session courante — le `/handoff` qui démarre la suite ouvre une session fraîche qui chargera le skill.

### Étape 1 — Split mécanique HTML/CSS/JS (sed, byte-exact)

1. `mkdir -p src scripts`
2. Extraire le CSS : `sed -n '8,541p' index.html > styles.css`
3. Extraire le JS monolithique temporaire : `sed -n '736,1987p' index.html > src/app.js`
4. Edit ciblé sur `index.html` :
   - Remplacer lignes 7-542 (`<style>…</style>`) par `<link rel="stylesheet" href="./styles.css">`
   - Remplacer lignes 735-1988 (`<script>…</script>` inline, sans toucher aux 2 CDN scripts lignes 732-734) par `<script type="module" src="./src/app.js"></script>`
5. **Validation manuelle** : `bun --bun x serve .` (ou `python -m http.server`), ouvrir `http://localhost:3000`
6. **Validation Playwright dans un agent OPUS dédié** (voir section dédiée plus bas)
7. **Commit** : « extract inline CSS and JS to separate files »

### Étape 2 — Découpage JS via ts-morph

1. Écrire `scripts/split-modules.mjs`. Le script :
   - Charge `src/app.js` dans un `Project` ts-morph
   - Identifie chaque section par sa bannière `/* === SECTION_NAME === */`
   - Mappe chaque section → module cible (config table en haut du script, comme dans ce plan)
   - Analyse les références cross-section via l'AST (`getReferencingSymbols` / `findReferences`)
   - Crée `src/models.js`, `src/state.js`, `src/audio.js`, `src/transcription.js`, `src/ui.js`
   - Déplace chaque déclaration (function, const, let, class) vers son module cible
   - Ajoute `export` devant toute déclaration référencée hors de son module
   - Ajoute en haut de chaque module un bloc `import { ... } from './xxx.js'` pour les symboles utilisés depuis d'autres modules
   - Réduit `src/app.js` à l'entry point : imports + appel `init()`
   - Préserve les commentaires originaux dans la mesure du possible
2. **Exécution** : `bun run scripts/split-modules.mjs`
3. **Inspection diff** : `git diff src/`
4. **Itération si besoin** : modifier le script et relancer (ts-morph est idempotent quand bien utilisé, sinon `git restore src/ && relancer`)
5. **Validation Playwright dans un agent OPUS dédié** (voir section dédiée plus bas)
6. **Commit** : « split app.js into domain modules via ts-morph »

### Étape 3 — Vérification finale et PR

1. Test complet par un agent OPUS Playwright (parcours utilisateur exhaustif — voir section)
2. `git diff main..modularize` pour relecture finale (humaine)
3. Décider : merge direct dans main, ou PR ?

## Tests via agents OPUS dédiés + skill `playwright-cli`

**Principe** : on délègue chaque session de test à un sous-agent OPUS séparé. L'agent a accès au skill `playwright-cli` (installé globalement à l'étape 0). Ce skill est **model-invoked** : il s'active automatiquement quand le brief mentionne « test browser », « interact with web page », etc. L'agent exécute des commandes shell via le binaire `playwright-cli`, et **ne renvoie qu'un résumé court** dans le contexte principal (PASS/FAIL + erreurs console + chemin du dernier screenshot/snapshot).

### Pourquoi le skill `playwright-cli` (vs autre approche)

- **Token-efficient** : les sorties de `playwright-cli` (snapshots avec refs d'éléments, console output) sont conçues pour les LLMs. Pas de dumps DOM verbeux.
- **Détection erreurs console** native via `playwright-cli console`
- **Interactions scriptées** (`click`, `fill`, `eval`, `press`) sans avoir à écrire de scripts JS
- **Sessions nommées** (`-s=nom`) → un sous-agent peut maintenir son propre contexte navigateur sans interférer avec d'autres
- **Headed** supporté via `--browser=chrome` (visible à l'écran)

### Commandes principales utiles dans le brief

```bash
playwright-cli open http://localhost:8000 --browser=chrome -s=test-modularize
playwright-cli snapshot -s=test-modularize    # liste les éléments avec leurs refs (e1, e2, …)
playwright-cli click e15 -s=test-modularize
playwright-cli fill e5 "sk-or-v1-fake" --submit -s=test-modularize
playwright-cli console -s=test-modularize     # ← erreurs console détectées
playwright-cli eval "localStorage.length" -s=test-modularize
playwright-cli screenshot --filename=after-step.png -s=test-modularize
playwright-cli close -s=test-modularize
```

### Comment briefer chaque agent de test (template)

Le brief envoyé via `Agent({ subagent_type: "general-purpose", model: "opus", … })` doit inclure :

- L'URL locale à tester (avec instruction de lancer le serveur en background : `bun --bun x serve . &` puis attendre 1s)
- L'instruction d'utiliser le skill `playwright-cli` (le skill s'auto-déclenche, mais la mention rappelle au sous-agent qu'il existe)
- Le scénario de test précis, étape par étape
- L'instruction explicite : « utilise `--browser=chrome` (mode headed) — l'utilisateur veut voir »
- L'instruction de **rapport court** : « rapport en moins de 200 mots : PASS/FAIL + résumé erreurs console + chemin screenshot final »

### Scénarios de test

**Smoke test (après étape 1 — split CSS/JS)** :
1. Lancer serveur statique en background
2. `playwright-cli open http://localhost:8000 --browser=chrome -s=smoke`
3. `playwright-cli snapshot -s=smoke` — vérifier présence : settings button, record button, results zone
4. `playwright-cli console -s=smoke` — doit être vide (zéro erreur)
5. `playwright-cli screenshot --filename=screenshots/smoke.png -s=smoke`
6. `playwright-cli close -s=smoke`
7. Rapport : PASS si console vide ET layout présent ; FAIL sinon

**Test fonctionnel complet (après étape 2 — split modules)** :
1. Ouvrir l'app, snapshot
2. Cliquer sur le bouton settings (ou `playwright-cli press , -s=full` pour le raccourci)
3. `playwright-cli fill <ref-input-key> "sk-or-v1-fake-test-key" --submit -s=full`
4. Vérifier que le toast « OpenRouter key saved » apparaît (snapshot text)
5. `playwright-cli eval "JSON.parse(localStorage.getItem('sttbench.v1')).apiKeys.openrouter" -s=full` — doit retourner la clé
6. Reload, re-ouvrir settings, vérifier que la clé est marquée comme saved
7. Vérifier qu'au moins un modèle OpenRouter est devenu « enabled » dans la liste
8. `playwright-cli console -s=full` doit être vide
9. Screenshot final
10. Rapport : PASS/FAIL avec détails

### Note importante sur la visibilité du skill

Le skill `playwright-cli` est installé globalement via `playwright-cli install --skills`. Pour qu'il soit disponible aux sous-agents :
- Si Claude Code charge les skills au démarrage de la session, il faudra peut-être **redémarrer Claude Code** après installation pour que le skill apparaisse dans la liste système
- Sinon, on peut aussi le mentionner explicitement dans le brief des sous-agents en pointant vers son chemin (`~/.claude/skills/playwright-cli/SKILL.md`)
- À tester à l'étape 0

## Risques et mitigations

| Risque | Mitigation |
|---|---|
| ts-morph génère des imports circulaires (ex: `ui.js` ↔ `transcription.js`) | Le script détecte ces cas et émet un warning. Manuel : extraire les utilitaires partagés vers un module neutre (`util.js`) ou regrouper |
| Bannière de section ne matche pas (pattern différent en fin de fichier) | Vérifier le pattern regex dans le script. Cas connus inspectés ligne par ligne avant exécution |
| Module ES module ne charge pas sur GitHub Pages (MIME ou chemin) | Test Playwright sur la branche déployée avant merge. Chemins relatifs en `./xxx.js` (avec extension) |
| Globaux implicites cassés (ex: code qui s'attendait à `window.saveState`) | ts-morph signale les références non résolues. À chaque déclaration top-level extraite et exportée, vérifier qu'aucun code n'y accède via `window.xxx` |
| Deps Fedora pour Playwright manquantes | Doc dans étape 0 + détection au premier lancement (Chromium remontera une erreur claire au démarrage) |

## Workflow git

- Branche : `modularize` (déjà créée et checkout)
- Commits : 3-4 (tooling, split CSS/JS, split modules, éventuels fixes Playwright)
- Merge / PR à décider à la fin

## État courant

- [x] Branche `modularize` créée et checkout
- [x] Plan rédigé et validé
- [x] Étape 0 : tooling Bun + Playwright (commit `7dfd8ca`)
- [x] Étape 1 : split CSS/JS via sed (commit `c04d989`)
- [x] Étape 2 : split modules via ts-morph (commit `feead8d`)
- [ ] Étape 3 : merge dans `main` (à décider par l'utilisateur)

## Notes post-implémentation

- Avant de lancer `scripts/split-modules.mjs`, le code monolithique a dû recevoir un nouveau banner `PROVIDER API CALLS` juste avant `transcribeOpenRouter` : les fonctions `transcribe*` étaient physiquement à l'intérieur du banner VAD sans en-tête propre, ce qui les rattachait à `audio.js` au lieu de `transcription.js`. Le banner est inséré directement dans le source (commité dans `feead8d`).
- Pas d'imports circulaires bloquants au sens ES modules : tous les croisements (ui↔audio, ui↔transcription, audio↔transcription) sont utilisés à runtime depuis des handlers, donc les bindings live tiennent.
- Tests validés via 2 sous-agents OPUS dédiés (skill `playwright-cli`, mode headed) : smoke après étape 1 (PASS, console clean), smoke + fonctionnel après étape 2 (PASS, save clé OpenRouter → toast → localStorage persistant → reload → 7/9 modèles activés, 0 erreur JS).
