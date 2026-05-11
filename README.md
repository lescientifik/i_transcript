# STT Bench — i_transcript

Webapp 100 % navigateur pour enregistrer la voix et comparer côte à côte les
transcriptions de plusieurs modèles speech-to-text (Whisper, Voxtral, Gemini, GPT-4o…).
L'audio part directement du navigateur vers les APIs choisies ; les clés vivent dans le
`localStorage` local, aucun backend intermédiaire.

Site : https://lescientifik.github.io/i_transcript/

## Clé API OpenRouter

L'app ne contient aucun modèle ; elle relaie l'audio vers un fournisseur d'IA.
OpenRouter agrège la plupart des modèles supportés (Whisper, Voxtral, Gemini, GPT-4o)
sous une seule clé.

1. Créer un compte sur https://openrouter.ai/sign-up. Méthodes proposées : GitHub,
   Google, MetaMask, ou email + mot de passe. La connexion par passkey est dispo
   ensuite depuis l'écran de sign-in.
2. Ouvrir la page de gestion des clés : https://openrouter.ai/settings/keys
   (redirige vers `/workspaces/default/keys` une fois connecté).
3. Créer une nouvelle clé. Lui donner un nom (ex. `stt-bench`). Une limite de crédit
   par clé est proposée en option — pratique pour cloisonner un usage.
4. Copier la clé immédiatement (préfixe `sk-or-v1-…`) : elle n'est plus ré-affichée
   ensuite.
5. Approvisionner le compte sur https://openrouter.ai/settings/credits. Aucun minimum
   officiel et aucune obligation d'engagement sur le pay-as-you-go ; OpenRouter
   prélève 5,5 % de frais de plateforme en plus du prix provider. Cartes, AliPay et
   USDC acceptés. Une petite allocation gratuite est offerte pour tester, mais elle
   est très limitée.
6. Dans l'app, ouvrir les paramètres (touche `,`), section **API Keys**, sélectionner
   le provider **OpenRouter**, coller la clé, **Save**.

À titre indicatif, Whisper Large V3 Turbo tourne autour de 0,04 $/heure d'audio et
GPT-4o Mini Transcribe autour de 0,003 $/minute. Quelques euros couvrent plusieurs
heures.

### Mistral (optionnel)

Pour appeler Voxtral via l'API Mistral directe au lieu d'OpenRouter :

1. Créer un compte sur https://console.mistral.ai/ et activer un moyen de paiement.
2. Générer une clé dans la section **API Keys** de la console.
3. Dans les paramètres de l'app, provider **Mistral**, coller la clé, **Save**.

## Utilisation

1. Ouvrir https://lescientifik.github.io/i_transcript/.
2. Dans les paramètres (`,`), cocher les modèles à comparer. Les modèles sans clé
   API valide restent grisés.
3. Choisir la langue (français par défaut, ou auto-détection).
4. **REC** (ou `F`) pour enregistrer, re-clic pour arrêter.
5. **Transcribe** (ou `Entrée`) lance tous les modèles cochés en parallèle.
6. Clic sur un résultat pour le copier. Avec un seul modèle sélectionné, `K` copie
   directement.

### Mode dictée

Cocher **Auto-transcribe and copy when recording stops** et ne garder qu'un seul
modèle : chaque enregistrement déclenche transcription + copie automatique. Pratique
pour dicter dans une autre application.

### Trim silences (Silero VAD)

L'option **Trim silences** active un VAD local (modèle dans le navigateur, aucun
upload supplémentaire) qui retire les blancs avant l'envoi. Économise quelques
centimes et limite les hallucinations de Whisper sur les passages muets.

## Raccourcis clavier

| Action                                | Touche par défaut |
| ------------------------------------- | ----------------- |
| Démarrer / arrêter l'enregistrement   | `F`               |
| Annuler l'enregistrement en cours     | `Z`               |
| Lancer la transcription               | `Entrée`          |
| Copier le résultat (mono-modèle)      | `K`               |
| Ouvrir les paramètres                 | `,`               |

Tout est rebindable dans **settings → Keyboard shortcuts** : clic sur le champ, puis
frappe de la touche cible.

## Modèles et langues

**Via OpenRouter** : Whisper Large V3 Turbo, Whisper Large V3, Whisper 1,
GPT-4o Transcribe, GPT-4o Mini Transcribe, Voxtral Small 24B, Gemini 3.1 Flash Lite.

**Via Mistral** : Voxtral Mini, Voxtral Small.

Le prix unitaire de chaque modèle figure dans la liste des paramètres ; un coût
estimé apparaît au-dessus du bouton REC dès qu'un audio est prêt.

**Langues** : français, anglais, espagnol, allemand, italien, portugais, plus une
option auto-detect qui laisse le modèle deviner.

## Sécurité

Les clés sont stockées dans le `localStorage` du navigateur (et, si autorisé, dans
le Chrome Password Manager pour synchroniser entre appareils). Le trafic réseau se
limite au navigateur ↔ API du provider choisi — aucun backend `i_transcript`.

## Développement

```bash
git clone https://github.com/lescientifik/i_transcript.git
cd i_transcript && bunx serve .
```

HTML + JS ES modules, aucun build. Le port servi par `bunx serve` s'affiche dans le
terminal.
