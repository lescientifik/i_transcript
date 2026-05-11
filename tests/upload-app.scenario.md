---
description: Playwright-cli scenarios (red/green) validating the /upload/ webapp — file picker, cost-strip, transcribe pipeline, persistence, topbar nav.
---

# Upload-app Playwright scenarios

## Conventions

- **Server** : statique sur `http://localhost:8765` (lancé en background avant tout scénario).
  `python3 -m http.server 8765 &` puis `sleep 1`.
- **Browser** : `--browser=chrome`, mode visible (headed). Pas de headless.
- **Sessions playwright-cli nommées** : `-s=s1`, `-s=s2`, etc. — sessions isolées, **une par scénario**, fermées en fin (`playwright-cli -s=sN close`).
- **Refs `eX`** : place-holders. L'agent QA récupère les vrais refs via `playwright-cli -s=sN snapshot` puis substitue.
- **Fixture audio** : `tests/fixtures/short.wav` (5 s, 16 kHz mono, 16-bit PCM, 160 078 bytes — sine 440 Hz). Chemin absolu depuis le repo : `/home/thenry/Projects/i_transcript/tests/fixtures/short.wav`.
- **Reset localStorage** : chaque scénario commence par `playwright-cli -s=sN localstorage-clear` après `goto` (ou avant si la session est ré-utilisée).
- **PASS global** : 9/9 PASS, 0 erreur console JS non-attendue (warnings tolérés).

## Helpers réutilisables (à coller au début de chaque scénario qui en a besoin)

### Seed clé OpenRouter (factice)

```bash
playwright-cli -s=sN eval "localStorage.setItem('sttbench.v1', JSON.stringify({apiKeys:{openrouter:'sk-fake-key',mistral:''},lastKeyProvider:'openrouter',selectedModelIds:['openai/whisper-large-v3-turbo'],lang:'fr'}))"
```

### Seed lastTranscript persisté (utilisé scénarios 7 & 8)

```bash
playwright-cli -s=sN eval "localStorage.setItem('sttbench.upload.v1', JSON.stringify({vadEnabled:false,lastTranscript:{text:'previous transcript content',sourceName:'previous.wav',modelId:'openai/whisper-large-v3-turbo',lang:'fr',durationSec:12.5,costUsd:0.0012,timestamp:1747000000000}}))"
```

### Capture des `<a download>` clicks (scénario 6)

```bash
playwright-cli -s=s6 run-code "async page => {
  await page.addInitScript(() => {
    window.__downloads = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) window.__downloads.push({name: this.download, href: this.href});
      return orig.apply(this, arguments);
    };
  });
}"
```

---

## Scénario 1 — Page /upload/ charge sans erreur, layout présent

**But** : confirme que `/upload/index.html` existe, que CSS est chargé, et que le squelette minimal est présent.

**Préconditions** :
- Serveur up sur :8765.
- Session `s1` fraîche.

**Séquence** :

```bash
playwright-cli -s=s1 open http://localhost:8765/upload/ --browser=chrome
playwright-cli -s=s1 snapshot --filename=screenshots/s1-load.yml
playwright-cli -s=s1 console
playwright-cli -s=s1 screenshot --filename=screenshots/s1-load.png
```

**Assertions** :

1. La page répond 200 (pas 404), titre non vide.
   ```bash
   playwright-cli -s=s1 --raw eval "document.title"
   # → non-vide, non "404"
   ```
2. Le snapshot contient les 5 éléments suivants (texte / role) :
   - une zone "drop" ou "Glisser" ou label équivalent (drop-zone) — élément avec classe `upload-drop-zone` ou role `region` étiqueté Drop
   - un `select` modèle (label : Modèle / Model)
   - un `select` langue (label : Langue / Lang)
   - un bouton settings (titre / aria-label contenant "Paramètres" ou "Settings", visuellement engrenage)
   - un bouton **Transcribe** (texte visible "Transcrire" ou "Transcribe")
3. `playwright-cli -s=s1 console` retourne 0 ligne d'erreur (filtre `console error|level: error`). Warnings autorisés.
4. Aucune requête 404 sur `.js` / `.css` (`playwright-cli -s=s1 requests` → toutes status 200, à part éventuels favicons).

**Critère PASS/FAIL** :
- **PASS** si (1) ET (2 — tous 5 éléments) ET (3) ET (4). Sinon **FAIL**.

```bash
playwright-cli -s=s1 close
```

---

## Scénario 2 — Drop-zone visible, bouton Transcribe disabled au load (no file)

**But** : à l'ouverture sans fichier, Transcribe doit être disabled.

**Préconditions** :
- Serveur up.
- Session `s2` fraîche.

**Séquence** :

```bash
playwright-cli -s=s2 open http://localhost:8765/upload/ --browser=chrome
playwright-cli -s=s2 localstorage-clear
playwright-cli -s=s2 reload
playwright-cli -s=s2 snapshot --filename=screenshots/s2-disabled.yml
```

**Assertions** :

1. Drop-zone visible :
   ```bash
   playwright-cli -s=s2 --raw eval "!!document.querySelector('.upload-drop-zone, [data-role=drop-zone]') && document.querySelector('.upload-drop-zone, [data-role=drop-zone]').offsetParent !== null"
   # → "true"
   ```
2. Bouton Transcribe disabled :
   ```bash
   playwright-cli -s=s2 --raw eval "document.querySelector('button[data-action=transcribe], #btn-transcribe').disabled"
   # → "true"
   ```
3. Aucun fichier sélectionné indiqué dans l'UI (pas de cost-strip rendu — élément `[data-role=cost-strip]` absent ou `display:none` ou `hidden`).
   ```bash
   playwright-cli -s=s2 --raw eval "const c=document.querySelector('[data-role=cost-strip], .upload-cost-strip'); !c || c.hasAttribute('hidden') || getComputedStyle(c).display==='none'"
   # → "true"
   ```

**Critère PASS/FAIL** :
- **PASS** si les 3 assertions retournent "true". Sinon **FAIL**.

```bash
playwright-cli -s=s2 close
```

---

## Scénario 3 — Pick d'un fichier wav → cost-strip apparaît avec estimation $X.YYYY

**But** : sélection du fixture déclenche le décodage et l'affichage du coût estimé.

**Préconditions** :
- Serveur up.
- Session `s3` fraîche.
- Fixture `/home/thenry/Projects/i_transcript/tests/fixtures/short.wav` disponible.

**Séquence** :

```bash
playwright-cli -s=s3 open http://localhost:8765/upload/ --browser=chrome
playwright-cli -s=s3 localstorage-clear
playwright-cli -s=s3 reload
playwright-cli -s=s3 snapshot --filename=screenshots/s3-before.yml
# Récupérer le ref de la drop-zone via le snapshot précédent (place-holder e1).
playwright-cli -s=s3 drop e1 --path=/home/thenry/Projects/i_transcript/tests/fixtures/short.wav
# Décodage est async — attendre l'apparition du cost-strip
playwright-cli -s=s3 run-code "async page => { await page.waitForSelector('[data-role=cost-strip], .upload-cost-strip', {state:'visible', timeout:5000}); }"
playwright-cli -s=s3 snapshot --filename=screenshots/s3-after.yml
playwright-cli -s=s3 screenshot --filename=screenshots/s3-cost-strip.png
```

**Assertions** :

1. Cost-strip présent et visible après drop :
   ```bash
   playwright-cli -s=s3 --raw eval "const c=document.querySelector('[data-role=cost-strip], .upload-cost-strip'); !!c && c.offsetParent !== null"
   # → "true"
   ```
2. Cost-strip contient une estimation matchant `$\d+\.\d{4}` (4 décimales) :
   ```bash
   playwright-cli -s=s3 --raw eval "/\\\$\\d+\\.\\d{4}/.test(document.querySelector('[data-role=cost-strip], .upload-cost-strip').textContent)"
   # → "true"
   ```
3. Durée affichée cohérente (5 s, format `0:05` ou `5s` ou `5.0s` accepté) :
   ```bash
   playwright-cli -s=s3 --raw eval "/(0:0?5|5\\.0?\\s?s|\\b5s)/i.test(document.body.textContent)"
   # → "true"
   ```
4. Bouton Transcribe maintenant **enabled** (clé OpenRouter pas seedée donc peut rester disabled selon impl — si tel est le cas, ce critère devient : bouton enabled SI on seed la clé. Voir variante ci-dessous.)

   Variante stricte (seed clé d'abord) :
   ```bash
   playwright-cli -s=s3 eval "localStorage.setItem('sttbench.v1', JSON.stringify({apiKeys:{openrouter:'sk-fake-key',mistral:''},lastKeyProvider:'openrouter',selectedModelIds:['openai/whisper-large-v3-turbo'],lang:'fr'}))"
   playwright-cli -s=s3 reload
   # re-drop le fichier
   playwright-cli -s=s3 snapshot
   playwright-cli -s=s3 drop e1 --path=/home/thenry/Projects/i_transcript/tests/fixtures/short.wav
   playwright-cli -s=s3 --raw eval "document.querySelector('button[data-action=transcribe], #btn-transcribe').disabled"
   # → "false"
   ```
5. Console clean (`playwright-cli -s=s3 console` → 0 erreur).

**Critère PASS/FAIL** :
- **PASS** si (1) ET (2) ET (3) ET (4 — variante) ET (5). Sinon **FAIL**.

```bash
playwright-cli -s=s3 close
```

---

## Scénario 4 — Click Transcribe avec clé OpenRouter invalide → encart erreur, console clean

**But** : avec une clé bidon, le fetch part vers OpenRouter et reçoit une 401/403. L'erreur doit être affichée dans un encart visible, sans throw uncaught côté JS.

**Préconditions** :
- Serveur up.
- Session `s4` fraîche.
- Clé invalide seedée.

**Séquence** :

```bash
playwright-cli -s=s4 open http://localhost:8765/upload/ --browser=chrome
playwright-cli -s=s4 localstorage-clear
# Seed clé invalide
playwright-cli -s=s4 eval "localStorage.setItem('sttbench.v1', JSON.stringify({apiKeys:{openrouter:'sk-or-INVALID-FAKE',mistral:''},lastKeyProvider:'openrouter',selectedModelIds:['openai/whisper-large-v3-turbo'],lang:'fr'}))"
# Mock fetch côté browser pour répondre 401 (évite la dépendance réseau réelle)
playwright-cli -s=s4 run-code "async page => {
  await page.route('**/openrouter.ai/api/v1/audio/transcriptions', route => {
    route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({error:{message:'Invalid API key', code:401}}) });
  });
}"
playwright-cli -s=s4 reload
playwright-cli -s=s4 snapshot
# place-holder e1 = drop-zone
playwright-cli -s=s4 drop e1 --path=/home/thenry/Projects/i_transcript/tests/fixtures/short.wav
playwright-cli -s=s4 run-code "async page => { await page.waitForSelector('[data-role=cost-strip], .upload-cost-strip', {state:'visible', timeout:5000}); }"
playwright-cli -s=s4 snapshot
# place-holder e2 = bouton Transcribe
playwright-cli -s=s4 click e2
# Attendre l'apparition de l'encart erreur
playwright-cli -s=s4 run-code "async page => { await page.waitForSelector('[data-role=error], .upload-error, .error-banner', {state:'visible', timeout:5000}); }"
playwright-cli -s=s4 snapshot --filename=screenshots/s4-error.yml
playwright-cli -s=s4 screenshot --filename=screenshots/s4-error.png
playwright-cli -s=s4 console
```

**Assertions** :

1. Encart erreur visible et contient un texte d'erreur reconnaissable :
   ```bash
   playwright-cli -s=s4 --raw eval "const e=document.querySelector('[data-role=error], .upload-error, .error-banner'); !!e && e.offsetParent!==null && /401|Invalid|erreur|error/i.test(e.textContent)"
   # → "true"
   ```
2. `<pre>` résultat **vide** OU contient encore le précédent (ici aucun, donc vide) :
   ```bash
   playwright-cli -s=s4 --raw eval "const p=document.querySelector('pre[data-role=transcript], .upload-transcript-pre'); !p || p.textContent.trim()===''"
   # → "true"
   ```
3. `localStorage.sttbench.upload.v1` ne contient PAS de `lastTranscript` (échec ne persiste pas) :
   ```bash
   playwright-cli -s=s4 --raw eval "const r=localStorage.getItem('sttbench.upload.v1'); !r || !JSON.parse(r).lastTranscript"
   # → "true"
   ```
4. Console : pas d'`Uncaught` ni `unhandled` :
   ```bash
   playwright-cli -s=s4 console | grep -iE "uncaught|unhandled" | wc -l
   # → 0
   ```

**Critère PASS/FAIL** :
- **PASS** si (1) ET (2) ET (3) ET (4). Sinon **FAIL**.

```bash
playwright-cli -s=s4 close
```

---

## Scénario 5 — Click Transcribe avec fetch mocké → `<pre>` rempli avec "mock transcript"

**But** : pipeline complet en chemin heureux, fetch interceptée et renvoie `{text:'mock transcript'}`.

**Préconditions** :
- Serveur up.
- Session `s5` fraîche.
- Clé OpenRouter (factice mais non vide) seedée.
- Fetch mockée pour répondre 200.

**Séquence** :

```bash
playwright-cli -s=s5 open http://localhost:8765/upload/ --browser=chrome
playwright-cli -s=s5 localstorage-clear
playwright-cli -s=s5 eval "localStorage.setItem('sttbench.v1', JSON.stringify({apiKeys:{openrouter:'sk-fake-key',mistral:''},lastKeyProvider:'openrouter',selectedModelIds:['openai/whisper-large-v3-turbo'],lang:'fr'}))"
# Mock route OpenRouter — option A (page.route, recommandée)
playwright-cli -s=s5 run-code "async page => {
  await page.route('**/openrouter.ai/api/v1/audio/transcriptions', route => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({text:'mock transcript', usage:{total_tokens:42}}) });
  });
}"
playwright-cli -s=s5 reload
playwright-cli -s=s5 snapshot
# e1 = drop-zone
playwright-cli -s=s5 drop e1 --path=/home/thenry/Projects/i_transcript/tests/fixtures/short.wav
playwright-cli -s=s5 run-code "async page => { await page.waitForSelector('[data-role=cost-strip], .upload-cost-strip', {state:'visible', timeout:5000}); }"
playwright-cli -s=s5 snapshot
# e2 = bouton Transcribe
playwright-cli -s=s5 click e2
# Attendre que le <pre> soit rempli
playwright-cli -s=s5 run-code "async page => { await page.waitForFunction(() => { const p=document.querySelector('pre[data-role=transcript], .upload-transcript-pre'); return p && /mock transcript/.test(p.textContent); }, {timeout:10000}); }"
playwright-cli -s=s5 snapshot --filename=screenshots/s5-success.yml
playwright-cli -s=s5 screenshot --filename=screenshots/s5-success.png
```

**Assertions** :

1. `<pre>` contient "mock transcript" :
   ```bash
   playwright-cli -s=s5 --raw eval "document.querySelector('pre[data-role=transcript], .upload-transcript-pre').textContent.includes('mock transcript')"
   # → "true"
   ```
2. `localStorage.sttbench.upload.v1.lastTranscript.text === 'mock transcript'` :
   ```bash
   playwright-cli -s=s5 --raw eval "JSON.parse(localStorage.getItem('sttbench.upload.v1')).lastTranscript.text"
   # → "mock transcript"
   ```
3. `localStorage.sttbench.upload.v1.lastTranscript.sourceName === 'short.wav'` :
   ```bash
   playwright-cli -s=s5 --raw eval "JSON.parse(localStorage.getItem('sttbench.upload.v1')).lastTranscript.sourceName"
   # → "short.wav"
   ```
4. Pas d'encart erreur visible :
   ```bash
   playwright-cli -s=s5 --raw eval "const e=document.querySelector('[data-role=error], .upload-error, .error-banner'); !e || e.offsetParent===null"
   # → "true"
   ```
5. Console clean (0 erreur JS).

**Critère PASS/FAIL** :
- **PASS** si les 5 assertions sont vérifiées. Sinon **FAIL**.

```bash
playwright-cli -s=s5 close
```

---

## Scénario 6 — Click Télécharger TXT → fichier `<basename>.txt` téléchargé

**But** : après une transcription réussie, le bouton Télécharger TXT déclenche un `<a download>` avec le nom `short.txt` (basename du fichier source).

**Préconditions** :
- Serveur up.
- Session `s6` fraîche.
- Idem scénario 5 (succès préalable) — re-fait la transcription mockée d'abord.

**Séquence** :

```bash
playwright-cli -s=s6 open http://localhost:8765/upload/ --browser=chrome
playwright-cli -s=s6 localstorage-clear
playwright-cli -s=s6 eval "localStorage.setItem('sttbench.v1', JSON.stringify({apiKeys:{openrouter:'sk-fake-key',mistral:''},lastKeyProvider:'openrouter',selectedModelIds:['openai/whisper-large-v3-turbo'],lang:'fr'}))"
# Mock fetch + intercept des <a download> clicks
playwright-cli -s=s6 run-code "async page => {
  await page.addInitScript(() => {
    window.__downloads = [];
    const orig = HTMLAnchorElement.prototype.click;
    HTMLAnchorElement.prototype.click = function () {
      if (this.download) window.__downloads.push({ name: this.download, href: this.href });
      return orig.apply(this, arguments);
    };
  });
  await page.route('**/openrouter.ai/api/v1/audio/transcriptions', route => {
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({text:'mock transcript', usage:null}) });
  });
}"
playwright-cli -s=s6 reload
playwright-cli -s=s6 snapshot
# e1 = drop-zone, e2 = bouton Transcribe
playwright-cli -s=s6 drop e1 --path=/home/thenry/Projects/i_transcript/tests/fixtures/short.wav
playwright-cli -s=s6 run-code "async page => { await page.waitForSelector('[data-role=cost-strip], .upload-cost-strip', {state:'visible', timeout:5000}); }"
playwright-cli -s=s6 click e2
playwright-cli -s=s6 run-code "async page => { await page.waitForFunction(() => { const p=document.querySelector('pre[data-role=transcript], .upload-transcript-pre'); return p && /mock transcript/.test(p.textContent); }, {timeout:10000}); }"
playwright-cli -s=s6 snapshot
# e3 = bouton Télécharger TXT
playwright-cli -s=s6 click e3
playwright-cli -s=s6 screenshot --filename=screenshots/s6-download.png
```

**Assertions** :

1. Au moins un `<a download>` cliqué et son nom est `short.txt` :
   ```bash
   playwright-cli -s=s6 --raw eval "window.__downloads && window.__downloads.length>=1 && window.__downloads[window.__downloads.length-1].name === 'short.txt'"
   # → "true"
   ```
2. Le `href` du download est une `blob:` URL (le payload a été encodé localement) :
   ```bash
   playwright-cli -s=s6 --raw eval "window.__downloads[window.__downloads.length-1].href.startsWith('blob:')"
   # → "true"
   ```
3. Console clean.

**Critère PASS/FAIL** :
- **PASS** si (1) ET (2) ET (3). Sinon **FAIL**.

```bash
playwright-cli -s=s6 close
```

---

## Scénario 7 — Reload → transcript précédent ré-hydraté dans `<pre>` depuis localStorage

**But** : à l'ouverture de la page, si `sttbench.upload.v1.lastTranscript` existe, son `text` apparaît dans le `<pre>`.

**Préconditions** :
- Serveur up.
- Session `s7` fraîche.
- `sttbench.upload.v1` seedé avec un transcript "previous transcript content" / `sourceName: previous.wav`.

**Séquence** :

```bash
playwright-cli -s=s7 open http://localhost:8765/upload/ --browser=chrome
playwright-cli -s=s7 localstorage-clear
playwright-cli -s=s7 eval "localStorage.setItem('sttbench.upload.v1', JSON.stringify({vadEnabled:false,lastTranscript:{text:'previous transcript content',sourceName:'previous.wav',modelId:'openai/whisper-large-v3-turbo',lang:'fr',durationSec:12.5,costUsd:0.0012,timestamp:1747000000000}}))"
playwright-cli -s=s7 reload
playwright-cli -s=s7 run-code "async page => { await page.waitForFunction(() => { const p=document.querySelector('pre[data-role=transcript], .upload-transcript-pre'); return p && p.textContent.includes('previous transcript content'); }, {timeout:5000}); }"
playwright-cli -s=s7 snapshot --filename=screenshots/s7-hydrated.yml
playwright-cli -s=s7 screenshot --filename=screenshots/s7-hydrated.png
```

**Assertions** :

1. `<pre>` contient "previous transcript content" :
   ```bash
   playwright-cli -s=s7 --raw eval "document.querySelector('pre[data-role=transcript], .upload-transcript-pre').textContent.includes('previous transcript content')"
   # → "true"
   ```
2. Un label de contexte est visible quelque part près du `<pre>` mentionnant le `sourceName` "previous.wav" (acceptable : header `Transcript précédent`, attribut `data-source`, ou simplement texte dans la zone).
   ```bash
   playwright-cli -s=s7 --raw eval "/previous\\.wav/.test(document.body.textContent)"
   # → "true"
   ```
3. Console clean.

**Critère PASS/FAIL** :
- **PASS** si (1) ET (2) ET (3). Sinon **FAIL**.

```bash
playwright-cli -s=s7 close
```

---

## Scénario 8 — Sélection nouveau fichier après succès → ancien transcript reste avec label "Transcript précédent (`<sourceName>`)"

**But** : après une transcription réussie sur `previous.wav` (seedée), drop d'un nouveau fichier `short.wav` : la zone garde le texte "previous transcript content" mais s'étiquette "Transcript précédent (previous.wav)" jusqu'à ce qu'une nouvelle transcription réussisse.

**Préconditions** :
- Serveur up.
- Session `s8` fraîche.
- `sttbench.upload.v1` seedé (pareil que scénario 7).

**Séquence** :

```bash
playwright-cli -s=s8 open http://localhost:8765/upload/ --browser=chrome
playwright-cli -s=s8 localstorage-clear
playwright-cli -s=s8 eval "localStorage.setItem('sttbench.upload.v1', JSON.stringify({vadEnabled:false,lastTranscript:{text:'previous transcript content',sourceName:'previous.wav',modelId:'openai/whisper-large-v3-turbo',lang:'fr',durationSec:12.5,costUsd:0.0012,timestamp:1747000000000}}))"
playwright-cli -s=s8 eval "localStorage.setItem('sttbench.v1', JSON.stringify({apiKeys:{openrouter:'sk-fake-key',mistral:''},lastKeyProvider:'openrouter',selectedModelIds:['openai/whisper-large-v3-turbo'],lang:'fr'}))"
playwright-cli -s=s8 reload
playwright-cli -s=s8 run-code "async page => { await page.waitForFunction(() => { const p=document.querySelector('pre[data-role=transcript], .upload-transcript-pre'); return p && p.textContent.includes('previous transcript content'); }, {timeout:5000}); }"
playwright-cli -s=s8 snapshot
# e1 = drop-zone — drop le NOUVEAU fichier
playwright-cli -s=s8 drop e1 --path=/home/thenry/Projects/i_transcript/tests/fixtures/short.wav
playwright-cli -s=s8 run-code "async page => { await page.waitForSelector('[data-role=cost-strip], .upload-cost-strip', {state:'visible', timeout:5000}); }"
playwright-cli -s=s8 snapshot --filename=screenshots/s8-after-pick.yml
playwright-cli -s=s8 screenshot --filename=screenshots/s8-previous-label.png
```

**Assertions** :

1. `<pre>` contient toujours "previous transcript content" (rien d'écrasé) :
   ```bash
   playwright-cli -s=s8 --raw eval "document.querySelector('pre[data-role=transcript], .upload-transcript-pre').textContent.includes('previous transcript content')"
   # → "true"
   ```
2. Un label "Transcript précédent" ou "Previous transcript" mentionnant `previous.wav` est visible :
   ```bash
   playwright-cli -s=s8 --raw eval "/(Transcript précédent|Previous transcript)[^<]*previous\\.wav/i.test(document.body.textContent) || /previous\\.wav/i.test(document.querySelector('[data-role=transcript-label], .upload-transcript-label')?.textContent || '')"
   # → "true"
   ```
3. `localStorage.sttbench.upload.v1.lastTranscript.text` n'a PAS changé (pas de transcription tentée) :
   ```bash
   playwright-cli -s=s8 --raw eval "JSON.parse(localStorage.getItem('sttbench.upload.v1')).lastTranscript.text"
   # → "previous transcript content"
   ```
4. Cost-strip présent pour le nouveau fichier (estimation `$X.YYYY`) :
   ```bash
   playwright-cli -s=s8 --raw eval "/\\\$\\d+\\.\\d{4}/.test(document.querySelector('[data-role=cost-strip], .upload-cost-strip').textContent)"
   # → "true"
   ```
5. Console clean.

**Critère PASS/FAIL** :
- **PASS** si les 5 assertions sont vérifiées. Sinon **FAIL**.

```bash
playwright-cli -s=s8 close
```

---

## Scénario 9 — Click "Record live" topbar → URL = http://localhost:8765/ (ou /index.html)

**But** : la topbar de l'app upload contient un lien de retour vers l'app principale.

**Préconditions** :
- Serveur up.
- Session `s9` fraîche.

**Séquence** :

```bash
playwright-cli -s=s9 open http://localhost:8765/upload/ --browser=chrome
playwright-cli -s=s9 snapshot --filename=screenshots/s9-before-click.yml
# e1 = lien "← Record live" (ou texte équivalent) dans la topbar
playwright-cli -s=s9 click e1
# Attendre la nav
playwright-cli -s=s9 run-code "async page => { await page.waitForLoadState('domcontentloaded'); }"
playwright-cli -s=s9 snapshot --filename=screenshots/s9-after-click.yml
playwright-cli -s=s9 screenshot --filename=screenshots/s9-main-app.png
```

**Assertions** :

1. URL courante = `http://localhost:8765/` ou `http://localhost:8765/index.html` :
   ```bash
   playwright-cli -s=s9 --raw eval "['http://localhost:8765/', 'http://localhost:8765/index.html'].includes(location.href)"
   # → "true"
   ```
2. Page principale chargée : présence du bouton record (sélecteur `#btn-record`, `[data-action=record]`, ou texte "REC") :
   ```bash
   playwright-cli -s=s9 --raw eval "!!document.querySelector('#btn-record, [data-action=record]') || /\\bREC\\b/.test(document.body.textContent)"
   # → "true"
   ```
3. Console clean.

**Critère PASS/FAIL** :
- **PASS** si (1) ET (2) ET (3). Sinon **FAIL**.

```bash
playwright-cli -s=s9 close
```

---

## Récap PASS/FAIL global

| # | Scénario | Critère succinct |
|---|---|---|
| 1 | Page charge, layout présent | 5 éléments + 0 erreur console + 0 404 |
| 2 | Transcribe disabled au load | drop-zone visible + bouton disabled + pas de cost-strip |
| 3 | Pick wav → cost-strip | cost matchant `$X.YYYY` + durée 5 s + transcribe enabled si clé seedée |
| 4 | Clé invalide → encart erreur | erreur visible + pas de throw + lastTranscript absent |
| 5 | Fetch mocké → pre rempli | `<pre>=mock transcript` + lastTranscript persisté + 0 erreur |
| 6 | Download TXT | `<a download="short.txt" href="blob:…">` cliqué |
| 7 | Reload → hydratation | `<pre>` contient le texte seedé + sourceName visible |
| 8 | Nouveau fichier → précédent conservé | label "Transcript précédent (previous.wav)" + texte intact |
| 9 | Lien topbar "Record live" | URL `/` ou `/index.html` + bouton record visible |

**GREEN gate complet** : 9/9 PASS, 0 erreur console JS non-attendue.

**RED gate (avant Étape 3.a)** : `/upload/` retourne 404 ou page vide → tous les scénarios **FAIL** sur l'assertion 1 dès le chargement.
