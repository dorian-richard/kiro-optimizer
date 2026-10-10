# Tester kopt sur de gros dépôts avec Kiro

Ce guide s'adresse à un développeur qui teste kopt sur de vraies bases de code d'entreprise, avec Kiro IDE ou Kiro
CLI : installer, vérifier, essayer des scénarios précis en sachant ce qui doit se passer, mesurer les vrais crédits
sur son propre dépôt, et rendre un retour exploitable. Les questions de fond (sur quoi repose le gain, ce qui est
mesuré ou non) sont dans la [FAQ](FAQ.md) ; les chiffres dans [BENCHMARKS.md](BENCHMARKS.md).

> **Avant tout : votre compte Kiro.** Utiliser kopt dans Kiro ne déclenche aucune requête automatique. En revanche,
> la mesure des crédits (`kopt bench ab`, section 6) lance des sessions Kiro headless, et les contrôles anti-abus de
> Kiro peuvent suspendre un compte qui paraît automatisé. Lisez la [section 6.1](#61-votre-compte-kiro-dabord) avant
> de la lancer.

## Ce qu'il faut savoir avant de commencer

- kopt est **local** : un paquet npm, aucun serveur, aucun compte, aucun appel réseau à l'exécution. L'index de chaque
  projet est dans votre dossier de cache, rien n'est écrit dans vos dépôts.
- Ce qui est mesuré (voir [BENCHMARKS.md](BENCHMARKS.md)) : sur l'exploration de code, des agents réels équipés de kopt
  coûtent environ un cinquième de moins (-23 % [IC 95 % : -38 %, -8 %], 15 tâches) sans perte d'exactitude ; sur le
  diagnostic de tests, pas de gain mesurable. Ces mesures ont été faites **hors de Kiro**, et **aucun crédit Kiro n'a
  été mesuré**. Votre test est donc utile justement là : vrai Kiro, vrais dépôts, vrais crédits.
- Le gain attendu se trouve dans le nombre de tours d'exploration et dans la sortie des outils, pas dans le préfixe
  fixe.

## 1. Prérequis

| | |
|---|---|
| Node.js | 22.13 ou plus (`node --version`) |
| git | requis (npm récupère kopt sur GitHub) |
| Kiro | Kiro IDE 0.12 ou 1.x, et/ou Kiro CLI 2.x ou V3 |
| Windows | PowerShell 7 recommandé (`winget install Microsoft.PowerShell`) ; sur un poste verrouillé, voir la section 4 |
| Disque | environ la taille du code source par dépôt et par worktree pour l'index (941 Mo mesurés sur elasticsearch, 33 090 fichiers) |
| Mémoire | jusqu'à environ 2 Go pendant le premier build d'un dépôt Java de 30 000 fichiers |

## 2. Installation

Une seule commande, sous Linux, macOS ou Windows :

```bash
npx -y github:dorian-richard/kiro-optimizer setup
```

Puis **redémarrez Kiro** (dans l'IDE : recharger la fenêtre). kopt démarre alors tout seul dans chaque projet ouvert.

> **Tant que la v0.2 n'est pas fusionnée dans `main`**, cette commande installe la v0.1 (la tête de `main`). Pour
> tester la version que décrit ce guide, lancez setup depuis un checkout de celle-ci :
> `npm ci && npm run build && node dist/bin.js setup --global`.

Pour tester une version précise et pouvoir dire laquelle (`kopt --version` affiche 0.2.0), épinglez l'étiquette
de la version, ou un commit précis :

```bash
npx -y github:dorian-richard/kiro-optimizer#v0.2.0 setup
npx -y github:dorian-richard/kiro-optimizer#<SHA complet> setup
```

Sur un gros dépôt, construisez l'index **avant** d'ouvrir Kiro, pour ne pas mesurer le premier build pendant la session :

```bash
kopt index --root ~/code/mon-gros-depot
# indexed 33090 files (...) · 572554 symbols · 3801212 refs · 80.0s
```

Avant d'ouvrir un dépôt que vous n'avez pas écrit, vérifiez qu'il ne contient ni `kopt.config.json` ni dossier
`.kopt/` : ces fichiers peuvent aujourd'hui reconfigurer kopt (voir la [FAQ, question 35](FAQ.md#35-un-dépôt-cloné-peut-il-reconfigurer-kopt-)).

## 3. Vérifier l'installation : `kopt doctor`

```bash
kopt doctor
kopt doctor --root ~/code/mon-gros-depot     # avec l'état de l'index de ce dépôt
```

Une ligne `ok` / `warn` / `fail` par contrôle, avec la correction à appliquer. Doctor lance les hooks et le serveur
MCP exactement comme Kiro, avec le `PATH` minimal d'un Kiro lancé depuis le Dock ou le menu Démarrer, dans un dossier
temporaire. À vérifier :

- les surfaces Kiro détectées (version de l'IDE, version et moteur du CLI) ;
- le serveur MCP démarre et liste **4 outils** (`kopt_find`, `kopt_read`, `kopt_refs`, `kopt_run`) ;
- les hooks sont **silencieux** quand ils laissent passer un appel, sortent avec 2 quand ils bloquent ;
- l'index du dépôt : nombre de fichiers, taille, dernière erreur éventuelle.

Dans Kiro, le panneau MCP doit montrer le serveur `kopt` avec ses 4 outils. Sinon : redémarrer Kiro, vérifier que le
support MCP est activé dans les réglages de l'IDE, relancer `kopt doctor`.

## 4. Scénarios à essayer

Pour chaque scénario : ce que vous faites, ce qui doit se passer, et ce qu'il faut signaler si ce n'est pas le cas.
Les blocages et redirections des scénarios 4.4, 4.5 et 4.8 n'existent que là où le gouverneur est installé (Kiro IDE
1.x et Kiro CLI, pas l'IDE 0.12).

### 4.1 Premier démarrage sur un gros dépôt (sans `kopt index` préalable)

Ouvrez un gros dépôt jamais indexé et posez tout de suite une question de code.

- **Attendu** : les outils kopt répondent aussitôt par la progression, par exemple `index building: 12000/33090 files
  parsed, ~2 min left – use built-in search/read tools until then`, et l'agent continue avec les outils natifs. La
  recherche répond dès que les fichiers sont analysés (32 s mesurées sur elasticsearch), les appelants (`kopt_refs`)
  une fois les références résolues (87 s). Un `kopt index` lancé pendant ce temps attend la fin du build, puis
  rattrape.
- **À signaler** : un outil qui bloque plus de 15 s, `index unavailable: …`, une mémoire qui dépasse nettement 2 Go.

### 4.2 « Où est X ? » et « Comment fonctionne Y ? »

Exemples : « Où est calculé le montant d'un remboursement, et qu'est-ce qui le plafonne ? », « Comment fonctionne la
reprise des webhooks de paiement ? ».

- **Attendu** : un `kopt_find` (en mode `pack` pour « comment fonctionne… ») qui renvoie en un appel les corps des
  meilleurs symboles avec leurs appelants (`path: L<ligne> in <appelant>`) et leurs appelés, autour de 1 300 tokens,
  puis éventuellement un `kopt_read "#id"`. Moins de grep et de lectures de fichiers entiers qu'avant.
- **À signaler** : l'agent qui ignore kopt et enchaîne les grep ; un pack qui manque la bonne réponse alors que les mots
  de la question sont dans le code (notez la question exacte et le `kopt_find` émis).

### 4.3 « Qui appelle X ? » et « Que faut-il changer si je renomme X ? »

- **Attendu** : un `kopt_refs`, une ligne par appelant (ligne d'appel, `#handle`, lignes de définition), puis une
  dernière ligne `complete` ou `incomplete` ; les appelants d'un petit wrapper suivent sous `via wrapper`.
- **À vérifier** : comparez la liste avec un grep ou avec votre IDE. Si la réponse dit `complete` et qu'il manque un
  appelant, c'est un bug à signaler en priorité. Faiblesses connues : appels sur une variable locale TypeScript ou
  JavaScript créée par `new X(...)`, appels Rust `self.methode(...)`, et un `incomplete` dû à des mentions dans des
  commentaires.

### 4.4 Lecture d'un gros fichier

Demandez « lis entièrement <un fichier de plus de 8 000 tokens, environ 24 000 caractères> ».

- **Attendu** (IDE 1.x et CLI) : la première tentative de lecture complète est bloquée une fois par une seule ligne,
  `kopt: <fichier> is ~12k tokens (1200 lines). Use kopt_read <fichier> mode=outline or kopt_read <fichier>:<a>-<b>, or
  read with offset/limit.` ; une seconde tentative identique passe.
- **À signaler** : un blocage en boucle, ou un blocage sur un petit fichier.

### 4.5 Lancer les tests ou le build

Demandez « lance les tests » (Maven, Gradle, npm, pytest, go test, dotnet…).

- **Attendu** (IDE 1.x et CLI) : la commande shell verbeuse est redirigée une fois : `kopt: use kopt_run with
  command="..."`. Kiro demande alors d'approuver `kopt_run` (il n'est pas approuvé automatiquement, puisqu'il exécute des
  commandes). La réponse de `kopt_run` tient en une ligne d'en-tête (`exit 1 · 8.2s · raw ~4562 tok`), la liste des
  tests en échec, le détail d'autant d'échecs que le budget le permet, `full output: kopt_read <handle>`, et quand
  l'index est prêt quelques lignes `source (kopt index):` qui pointent la fonction en cause.
- **Pas de redirection attendue** pour une commande déjà courte : `tsc`, `go vet`, un seul fichier ou un seul test,
  `mvn -q`. Ni pour une commande qui ne se termine pas seule (mode watch, serveur de dev, goals `run`).
- **À vérifier** : que l'information nécessaire (nom du test, assertion, valeurs attendues et reçues, ligne du dépôt)
  est bien dans la réponse ; sinon notez la commande et l'outil de test, et récupérez le journal avec
  `kopt read <handle>`.
- **Cas connus** : pas de filtre pour la sortie TAP de `node --test` ; `mvn dependency:tree` est réduit à
  `BUILD SUCCESS` (le contenu reste dans le journal) ; `kopt_run` pose `CI=1`, ce qui change le comportement de certains
  outils (snapshots Jest, Playwright, pnpm).

### 4.6 Relancer la même commande

Relancez la même commande de test sans rien modifier, puis modifiez un fichier et relancez.

- **Attendu** : sans modification, `kopt_run` renvoie le résultat stocké sans réexécuter (`same as run <handle> …, no
  file changed since`) ; après une modification, la commande est réellement relancée. `fresh: true` force une relance.
- **À vérifier** : changez un fichier ignoré par git qui influe sur les tests (un `.env`, une configuration locale) ;
  kopt doit relancer. Changez une variable d'environnement ou un service (base de données) : kopt **ne le voit pas**,
  c'est connu ; il faut `fresh: true`.

### 4.7 Fichiers modifiés hors de l'agent

Faites un `git pull`, un `git checkout` d'une autre branche ou modifiez un fichier dans un autre éditeur, puis posez
une question sur le code modifié.

- **Attendu** : un fichier écrit par l'agent est réindexé avant la réponse suivante ; un changement fait hors de Kiro
  est rattrapé par le contrôle qui a lieu, au plus toutes les 30 s, à l'occasion d'un appel d'outil. Juste après un
  changement, un `kopt_read` peut répondre avec la note `lines may be off` ; l'appel suivant a les bonnes lignes.
- **À signaler** : du code périmé renvoyé plus d'une minute après le changement.

### 4.8 Session longue

Une longue tâche, une spec avec « Run all tasks », ou un mode autopilot.

- **Attendu** : au-delà de 200 appels d'outils dans la session, kopt bloque chaque appel avec `kopt governor: session
  tool-call budget (200) reached. Stop here: …` jusqu'au prompt suivant. C'est voulu (coupe-circuit), mais une spec
  longue peut l'atteindre : réglez `"governor": {"maxToolCallsPerSession": 500}` dans `~/.kopt/config.json` (0
  désactive).
- **À signaler** : un arrêt prématuré d'une spec (le steering dit « une tâche à la fois, sauf demande ») ou des tests
  de critères d'acceptation non lancés (« seulement les tests concernés »).

### 4.9 Le bilan après une journée

```bash
kopt stats --days 1
kopt credits
```

- `kopt stats` : appels et tokens par outil kopt, blocages du gouverneur, et surtout le tableau « context intake by
  tool », qui montre ce que chaque outil, natif ou kopt, a fait entrer dans le contexte. Les économies affichées sont
  **brutes** (bornes hautes), pas nettes.
- `kopt credits` : les crédits par requête trouvés dans les fichiers de session de Kiro (Kiro CLI, Kiro IDE 1.x) ; rien
  sur l'IDE 0.12.

### 4.10 Les commandes en terminal

Les mêmes outils existent en ligne de commande, avec la même sortie, pour vérifier une réponse ou comparer :

```bash
kopt find "where is the refund amount computed" --pack
kopt refs OrderService.place --depth 2
kopt read src/billing --focus refund
kopt run -- mvn -q test
```

### 4.11 Désinstaller

```bash
kopt uninstall --dry-run      # ce qui serait supprimé
kopt uninstall --purge && npm uninstall -g kiro-optimizer
```

- **Attendu** : seules les entrées de kopt disparaissent de `~/.kiro` (vos autres serveurs MCP, hooks et agents
  restent), les dossiers d'index de kopt sont supprimés, `--purge` supprime `~/.kopt`.

## 5. Ce qu'il faut surveiller selon la surface

| | Kiro IDE 0.12 | Kiro IDE 1.x | Kiro CLI 2.x | Kiro CLI V3 |
|---|---|---|---|---|
| Outils kopt | oui | oui | oui, via l'agent `kopt` | oui |
| Gouverneur (scénarios 4.4, 4.5 et 4.8) | **non** | oui | oui | oui |
| Steering permanent | oui | oui | oui | oui |
| `.kiroignore` | oui | oui | non | celui du projet |
| Sous-agent `kopt-explorer` | non chargé | non chargé | oui | à vérifier |
| Crédits dans `kopt stats` / `kopt credits` | non | oui | oui | oui |

- **Kiro IDE 0.12** : l'IDE ne charge les hooks que depuis chaque espace de travail, et tout hook d'appel d'outil
  coûterait un tour par appel : kopt n'y installe donc **aucun** gouverneur. Vous testez les outils seuls, `kopt_run`
  seulement quand le modèle le choisit, avec une approbation à chaque appel. Les crédits ne sont visibles que dans
  l'estimation par tour affichée par le chat. Pour une évaluation complète, préférez l'IDE 1.x ou le CLI.
- **Kiro IDE 1.x** : tout est actif. Vérifiez qu'aucun hook ne fait apparaître de texte dans le chat quand il laisse
  passer un appel (ce serait un bug : dans l'IDE, toute sortie d'un hook `preToolUse` intercepte l'appel).
- **Kiro CLI 2.x** : `kiro-cli chat` doit démarrer l'agent `kopt` ; si vous gardez un autre agent par défaut,
  `kiro-cli chat --agent kopt`. Seul le steering `always` se charge automatiquement.
- **Kiro CLI V3** (`kiro-cli settings chat.agentEngine v3`) : lit les hooks globaux `~/.kiro/hooks/kopt.json` comme
  l'IDE 1.x. Si le moteur propose de mettre à jour la configuration des agents, notez-le.
- **Windows** : jamais testé avec un vrai Kiro ni sur un poste géré. `kopt_run` utilise PowerShell avec
  `-ExecutionPolicy Bypass -EncodedCommand`, un motif que certains EDR signalent : sur un poste verrouillé, définissez
  `KOPT_SHELL=cmd` dans le champ `env` de l'entrée `kopt` de `~/.kiro/settings/mcp.json`. Notez toute alerte de
  sécurité.

## 6. Mesurer les vrais crédits avec `kopt bench ab`

`kopt bench ab` lance les mêmes questions sur votre dépôt à travers le vrai Kiro CLI, dans un bras Kiro d'origine (A)
et un bras avec kopt (B), en option un bras « serveur MCP seul » (C), puis compare les crédits facturés par Kiro sur
les tâches que les deux bras ont réussies. Chaque bras a son propre worktree git et son propre `KIRO_HOME` ; votre
connexion est réutilisée, jamais remplacée. Guide complet (en anglais) : [bench/ab/README.md](../bench/ab/README.md).

### 6.1 Votre compte Kiro d'abord

Les contrôles anti-abus de Kiro **peuvent suspendre un compte** qui paraît automatisé. C'est arrivé pendant la
construction de ce harnais : un compte gratuit a été suspendu dès sa première requête headless, peu après qu'une
commande `kiro-cli` lancée par un script dans un dossier personnel temporaire eut ouvert toute seule une connexion par
navigateur. Kiro a répondu « Your User ID is temporarily suspended » ; 0 crédit dépensé ; le rétablissement passe par
le support.

- **Connectez-vous vous-même** : `kiro-cli login` dans votre terminal, puis `kiro-cli whoami`. Ne laissez jamais un
  script ou un agent se connecter pour vous.
- **Ne lancez pas `kiro-cli` depuis des scripts dans un dossier personnel temporaire** : déconnecté, un `kiro-cli chat`
  (même `--list-models`) peut ouvrir une connexion par navigateur. `kopt bench ab` ne se connecte jamais : il lit votre
  connexion avec `kiro-cli whoami` et s'arrête s'il n'y en a pas.
- **Évitez les connexions et déconnexions répétées et les rafales de sessions headless.** Commencez par une seule
  sonde, gardez des campagnes petites, jamais deux à la fois, pas de relance en boucle après une erreur.
- **Si Kiro suspend ou verrouille le compte** : arrêtez, ne relancez pas, contactez le support
  (<https://support.aws.amazon.com/#/contacts/kiro>). Le harnais s'arrête à la première erreur de ce type
  (`account_blocked`) et n'envoie plus rien depuis ce dossier de sortie jusqu'à `--resume --account-restored`.
- **Préférez un compte payant** (Pro ou plus) : la documentation headless de Kiro est écrite pour des clés d'API
  (`KIRO_API_KEY`), réservées aux offres payantes, et une campagne est par construction une série de sessions
  automatisées.

### 6.2 Écrire les tâches (5 ou plus)

Copiez [`bench/ab/tasks.example.json`](../bench/ab/tasks.example.json) et remplacez ses tâches par de vraies questions
sur votre dépôt, **écrites avant de voir un seul résultat**, et dont vous avez vérifié la réponse dans le code :

```json
{
  "tasks": [
    {
      "id": "montant-remboursement",
      "kind": "locate",
      "prompt": "Where is the amount of a refund computed, and what caps it?",
      "gold": { "files": ["src/billing/refunds.py"], "symbols": ["compute_refund", "RefundPolicy"] }
    },
    {
      "id": "annulation-commande",
      "kind": "usage",
      "prompt": "When a customer cancels an order, which functions run, in which order, until the refund is issued?",
      "gold": { "files": ["src/orders/service.py", "src/billing/refunds.py"], "symbols": ["cancel_order", "issue_refund"] }
    },
    { "id": "impact-renommage", "kind": "impact", "prompt": "If I rename the field Order.total_amount, which modules and tests would have to change?" }
  ]
}
```

- `id` : lettres, chiffres, `.`, `_`, `-`. `prompt` : la question telle que vous la taperiez dans Kiro. `kind`
  (optionnel) : un libellé pour regrouper les résultats.
- `gold` (optionnel) : les fichiers (chemins relatifs au dépôt) et les symboles qu'une bonne réponse doit nommer. Une
  réponse passe si elle nomme au moins 60 % des fichiers et 60 % des symboles (`--pass-ratio`). Sans `gold`, vous notez
  les réponses vous-même (section 6.5), et la tâche reste hors de la vue principale tant qu'elle n'est pas notée.
- Bonnes tâches : de vraies questions de l'équipe, qui demandent plusieurs fichiers, en majorité des questions
  d'exploration (où kopt a montré un gain) plus quelques diagnostics d'échec de test.
- Il faut **5 tâches et 10 paires** (tâches × répétitions) pour un verdict concluant.

### 6.3 Contrôler sans envoyer de prompt : `--check`

```bash
kopt bench ab --check --repo ~/code/mon-depot --tasks mes-taches.json
```

`--check` prépare les bras et vérifie, dans l'environnement exact des passages : le Node utilisé, kiro-cli (version,
moteur, mise à jour automatique coupée), votre connexion (un seul `kiro-cli whoami`), les agents de chaque bras
(`kiro-cli agent validate`), les serveurs MCP vus par chaque bras (kopt dans B, rien de kopt dans A), la taille de
l'index kopt, les hooks silencieux, les tâches (fichiers et symboles du `gold` présents) et le coût estimé. Il
n'envoie **aucun** prompt. Il sort avec 1 si un contrôle échoue.

### 6.4 Une sonde, puis la campagne

1. Choisissez le modèle le moins cher de votre offre (liste : <https://kiro.dev/docs/models/> ; `--list-models` la lit
   sur votre compte, c'est une requête à Kiro). N'utilisez pas Auto, qui route vers plusieurs modèles.
2. Une sonde d'une tâche, une répétition, les deux bras, dans un dossier à part :

   ```bash
   kopt bench ab --repo ~/code/mon-depot --tasks mes-taches.json --out /tmp/kopt-ab-sonde \
     --only montant-remboursement --reps 1 --model <id le moins cher> --timeout 120 \
     --credits-per-run 1 --max-credits 4
   ```

3. Lisez les crédits mesurés dans `/tmp/kopt-ab-sonde/runs.csv`, puis lancez la campagne dans son propre dossier, avec
   `--credits-per-run` réglé sur ce que vous avez mesuré :

   ```bash
   kopt bench ab --repo ~/code/mon-depot --tasks mes-taches.json --max-credits 60 --credits-per-run 2 --reps 2
   ```

   Par défaut : bras `A,B`, 2 répétitions, modèle `claude-sonnet-4.5`, moteur `v2`. Exemple de coût : 5 tâches × 2 bras
   × 2 répétitions = 20 passages, soit 10 à 60 crédits selon le multiplicateur du modèle ; `--check` affiche
   l'estimation. `--max-credits` est un budget : un passage peut le dépasser d'au plus la requête qui le franchit (ou
   d'un passage entier si Kiro ne diffuse pas sa facturation en continu).
4. Ctrl-C arrête proprement et écrit le rapport ; `--resume` reprend avec les mêmes réglages. Ne mettez pas kiro-cli à
   jour pendant une campagne.

### 6.5 Lire le rapport

`report.md` commence par le verdict, puis donne par bras les crédits (médiane, moyenne, total), les réponses justes,
les appels d'outils et les appels kopt par passage ; par comparaison, l'écart relatif de crédits
(`somme(B) / somme(A) - 1`, négatif = kopt moins cher) avec son IC 95 % bootstrap, le test du signe, et deux vues : les
paires que les deux bras ont réussies (vue principale) et tous les passages valides.

Pour noter à la main : ouvrez `runs/<passage>/answer.md`, mettez `1` (juste) ou `0` (faux) dans la colonne
`manual_grade` de `runs.csv`, puis :

```bash
kopt bench ab report --out ~/code/mon-depot-kopt-ab
```

### 6.6 La règle de décision

Fixée avant les passages : kopt **vaut d'être déployé** si, sur les paires que les deux bras ont réussies,

- il économise **au moins 20 %** des crédits, l'IC 95 % de cette économie exclut 0, et il est moins cher sur plus de
  paires que l'inverse ;
- la preuve est assez grande : 5 tâches et 10 paires, ou un test du signe sous 0,05 sur au moins 3 tâches ;
- il n'est pas moins souvent juste que Kiro d'origine (une marge d'un passage), délais dépassés et erreurs comptés
  comme des réponses fausses ;
- il n'échoue pas plus souvent que Kiro d'origine (même marge).

Sinon, le verdict dit quelle condition a échoué : baisse d'exactitude, baisse de fiabilité, plus cher, « mixed » (le
gain vient d'une minorité de paires), « prometteur mais non concluant » ou « non concluant ». Un IC qui traverse 0
signifie « pas assez de preuves », pas « aucun effet » : ajoutez des tâches ou des répétitions.

### 6.7 Nettoyer

```bash
kopt bench ab clean --out ~/code/mon-depot-kopt-ab
```

Supprime les worktrees, les `KIRO_HOME` des bras et les index kopt ; garde les résultats et les rapports.

## 7. Retour d'expérience

Copiez ce modèle dans un ticket ou un message, un par dépôt testé :

```markdown
### Environnement
- Surface Kiro et version : (IDE 0.12 / IDE 1.x / CLI 2.x / CLI V3, version exacte)
- Modèle Kiro : (Auto, Sonnet, Haiku…)
- OS, version de Node : 
- Commit de kopt (SHA) : 
- Sortie de `kopt doctor` : (coller)

### Dépôt
- Langages principaux, nombre de fichiers, monorepo ou non :
- Index : temps du premier build, taille (`kopt doctor --root …`), pic mémoire si connu :

### Scénarios (section 4)
| Scénario | Résultat attendu obtenu ? | Détail (question exacte, appel kopt, sortie) |
|---|---|---|
| 4.1 premier démarrage | oui / non | |
| 4.2 où est / comment marche | | |
| 4.3 qui appelle | | |
| 4.4 gros fichier | | |
| 4.5 tests et build | | |
| 4.6 relance | | |
| 4.7 changements hors agent | | |
| 4.8 session longue | | |

### Usage réel (après quelques jours)
- `kopt stats --days 7` : (coller le tableau « context intake by tool » et les blocages)
- L'agent utilise-t-il kopt de lui-même ? Quand ne l'utilise-t-il pas ?
- Réponses fausses ou incomplètes attribuables à kopt :

### Crédits (si `kopt bench ab` a été lancé)
- Tâches (nombre, types), répétitions, modèle, moteur :
- Verdict du rapport et lignes de comparaison (coller `report.md`) :
- Incidents (compte, quotas, passages invalides) :

### Le plus gênant / le plus utile
- 
```

Joignez si possible le `kopt_read <handle>` d'une sortie de `kopt_run` qui a perdu une information, la commande exacte
d'un blocage du gouverneur jugé injustifié, et `~/.kopt/hook-errors.log` s'il existe. Ne joignez pas de code
confidentiel : décrivez la structure du problème.
