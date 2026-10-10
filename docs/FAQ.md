# Comment fonctionne kopt : les questions difficiles

Cette FAQ répond aux questions sceptiques qu'un développeur expérimenté pose avant d'installer kopt sur de grosses
bases de code : sur quoi repose le gain annoncé, ce qui a vraiment été mesuré, ce qui ne l'a pas été, et ce qui peut
mal tourner. Chaque réponse distingue ce qui est **mesuré** (avec le fichier de résultats), ce qui est **lu dans le
code ou la documentation**, et ce qui n'est **pas mesuré**.

État : kopt v0.2.0 (étiquette git `v0.2.0`), au 2026-10-10. Les chiffres
viennent des fichiers de `bench/results` ; la source tenue à jour est [BENCHMARKS.md](BENCHMARKS.md) (en anglais),
avec une version HTML à graphiques, [benchmarks.html](benchmarks.html), qui sera publiée à l'adresse
<https://dorian-richard.github.io/kiro-optimizer/benchmarks.html> une fois la v0.2 sur `main` et GitHub Pages activé
(pas encore). Pour tester kopt vous-même : [TESTING.md](TESTING.md).

En une phrase : sur l'exploration de code, des agents réels équipés de kopt ont coûté environ un cinquième de moins
(-23 % [IC 95 % : -38 %, -8 %], 15 tâches) sans perte d'exactitude ; sur le diagnostic de tests, aucun gain mesurable ;
et aucun crédit Kiro n'a été mesuré par nous.

## Sommaire

1. [Ce que fait kopt et sur quoi il repose](#ce-que-fait-kopt-et-sur-quoi-il-repose)
2. [Preuves et mesures](#preuves-et-mesures)
3. [L'agent utilise-t-il kopt ?](#lagent-utilise-t-il-kopt-)
4. [Exactitude et langages](#exactitude-et-langages)
5. [Intégration à Kiro](#intégration-à-kiro)
6. [Sécurité, installation, désinstallation](#sécurité-installation-désinstallation)
7. [Plateformes](#plateformes)
8. [Comparaison avec KiroGraph et CodeGraph](#comparaison-avec-kirograph-et-codegraph)
9. [Limites et feuille de route](#limites-et-feuille-de-route)

## Ce que fait kopt et sur quoi il repose

### 1. Que fait kopt, concrètement ?

kopt est un outil local (un paquet npm, aucun serveur, aucun compte cloud, aucun appel réseau à l'exécution) qui agit
là où Kiro le permet :

- **4 outils MCP** au budget de tokens plafonné : `kopt_find` (recherche classée, et mode `pack` qui renvoie en un
  appel les corps des meilleurs symboles, leurs appelants et leurs appelés), `kopt_read` (code exact par `#handle`,
  `Classe.méthode`, chemin ou plage ; plan d'un fichier ou d'un dossier ; journaux de `kopt_run`), `kopt_refs`
  (appelants et appelés, avec une ligne finale « complete » ou « incomplete ») et `kopt_run` (lance tests, builds et
  linters et ne renvoie que le verdict, les échecs et les erreurs ; le journal complet reste sur disque).
- **Des hooks `command`** (gratuits côté crédits) qui servent de gouverneur de session : ils bloquent une fois
  quelques motifs coûteux (lecture complète d'un gros fichier, commande de test verbeuse hors `kopt_run`, relance
  identique sans changement) et coupent les boucles au-delà de 200 appels d'outils par session.
- **Un steering de moins de 50 mots** chargé en permanence, qui dit quel outil utiliser pour quelle question.
- **Un index local** par projet (tree-sitter en WASM, SQLite `node:sqlite`) dans le dossier de cache de l'utilisateur,
  jamais dans le dépôt.

Kiro ne permet pas de faire passer son trafic LLM par un proxy et ses hooks ne peuvent pas réécrire la sortie des
outils natifs : kopt ne compresse donc que ce que ses propres outils renvoient.

### 2. Sur quel modèle de coût kopt repose-t-il, et est-il confirmé ?

**C'est une hypothèse, non confirmée.** Aucun crédit Kiro n'a été mesuré par nous, ni avec ni sans kopt.

- Kiro documente qu'il facture **par requête** (au centième de crédit, multiplié par un facteur de modèle). Il ne
  publie pas comment la taille de la requête, la sortie, l'effort de raisonnement et le cache de prompt pèsent dans le
  prix.
- kopt est conçu sur l'hypothèse que le prix d'une requête croît avec sa taille, de sorte qu'un token entré dans le
  contexte est repayé à chaque requête suivante. La seule observation qui la soutient est une sonde tierce, sur un
  compte gratuit, avec un petit échantillon et très probablement un modèle qui n'était pas Claude ; elle a aussi vu
  le même prix pour un préfixe déjà en cache. Rien ne dit que cela vaut pour Claude ou pour les offres payantes.
- **Si Kiro répercute la remise du cache de prompt**, le terme « historique re-facturé à chaque tour » rétrécit
  fortement (borne haute : le cache expire après quelques minutes d'inactivité et se réécrit plus cher). Restent : les
  tokens qui entrent pour la première fois (gros journaux, lectures de fichiers entiers), la sortie, et le coût de
  chaque requête supplémentaire. Dans l'A/B avec agents (question 8), une bonne partie du gain vient justement de
  requêtes en moins (-18 %) et de tokens lus en moins (-23 %).
- La mesure qui tranche est l'A/B en ligne `kopt bench ab` sur votre propre compte (question 11). Une régression
  « crédits ~ entrée + entrée en cache + sortie » demanderait des dizaines de requêtes automatisées, à faire sur un
  modèle épinglé (Sonnet ou Haiku, pas Auto qui route vers plusieurs modèles), sans outils, avec des tailles de prompt
  contrôlées — et seulement sur un compte payant, en respectant les précautions de la question 40.

### 3. Qu'ajoute kopt à chaque requête, et quand est-ce rentable ?

- **Préfixe fixe** : les spécifications des 4 outils telles que Kiro les envoie, plus le steering permanent, font
  348 tokens (caractères / 3), contre 852 pour les 6 outils de la v0.1 ; un test les maintient sous 350. Mesuré avec le
  tokenizer du modèle dans l'A/B : **+282 tokens par requête** (médiane, contexte de la première requête, bras kopt
  moins bras témoin), contre +469 au tour 2 et +956 au tour 1. Il n'y a plus d'instructions de serveur MCP.
- **Une fois par session** : une ligne de démarrage (250 caractères au plus) sur Kiro IDE 1.x et Kiro CLI.
- **Pointeurs de prompt** : désactivés par défaut depuis la v0.2 (question 20).

Le seuil de rentabilité n'est pas une durée de session. Le préfixe coûte P × R (R requêtes) ; un appel kopt à la
requête k qui évite s tokens en économise environ s × (R - k + 1). kopt est rentable s'il évite tôt plus de
P × R / (R - k + 1) tokens, quelques centaines de tokens en pratique. **Si l'agent n'appelle jamais kopt, kopt coûte
environ 282 tokens par requête, en pure perte** : la tâche webpack de l'A/B, où l'agent n'a jamais appelé kopt, a
coûté +7 %. Sur l'ensemble des 15 tâches d'exploration, le prompt de kopt représente 1,3 % du coût du bras kopt, et
le gain net reste de -23 %.

### 4. Les hooks de kopt coûtent-ils des crédits ?

Les hooks `command` de Kiro ne coûtent aucun crédit (contrairement aux hooks `agent`, qui lancent une boucle
d'agent). En revanche, **un blocage coûte un tour** : le hook sort avec le code 2, Kiro envoie son message au modèle, et
le modèle doit relancer. kopt ne bloque donc que là où le gain attendu dépasse nettement ce tour : une fois par
fichier pour une grosse lecture, une fois par commande et par dossier (3 au plus par session) pour une commande
verbeuse, une fois pour une relance identique. Quand il laisse passer un appel, le hook n'écrit rien. Dans l'A/B
final, aucun blocage n'a eu lieu : leur rentabilité réelle n'est pas mesurée.

### 5. kopt réduit-il les tokens de sortie ?

Pas de façon mesurée. Le steering `kopt-specs.md` (chargé à la demande pour les modifications de code) demande de ne
pas répéter le code ni le plan, de faire des remplacements minimaux et de s'arrêter aux critères d'acceptation. La
littérature mesure environ -8 % de tokens de sortie pour ce genre de consigne, pas les -65 % que certains outils
annoncent. Les tâches de l'A/B étaient en lecture seule : l'effet sur la sortie n'a pas été isolé.

## Preuves et mesures

### 6. Quelles économies ont réellement été mesurées ?

| Mesure | Résultat | Ce que ce n'est pas |
|---|---|---|
| Benchmark hors ligne, une étape d'exploration, 138 tâches, 11 langages | kopt trouve 108/138 (78 %) des tâches, médiane 1 299 tokens ; recherche native disciplinée 54/138 (39 %) à 6 675 | pas une session, pas des crédits |
| A/B avec agents réels, exploration (15 tâches, 2 passages par bras) | coût de session mesuré -23 % [-38 %, -8 %], 13 tâches sur 15 moins chères, toutes les réponses justes | pas Kiro, pas des crédits |
| A/B avec agents réels, diagnostic de tests (6 tâches) | +16 % [-31 %, +67 %] : pas de gain mesurable | idem |
| Compression de sortie, 50 sorties de commandes commitées (45 générées au format de chaque outil, 5 vraies exécutions) | 96,4 % des tokens retirés ; dans l'A/B, 152,2k tokens de sortie de tests réduits à 15,2k | pas un taux de conservation de l'information |
| Gros dépôts (elasticsearch, VS Code) | recherche disponible 32 s après le premier démarrage sur 33 090 fichiers, index de 941 Mo | macOS seulement |
| Crédits Kiro | **non mesurés** | — |

Non mesurés de bout en bout : le gouverneur dans une vraie session Kiro, le sous-agent `kopt-explorer`, le
steering de sortie, les pointeurs de prompt dans une session, et tout ce qui est propre à Kiro IDE 0.12.

### 7. Que montre le benchmark hors ligne, et que ne montre-t-il pas ?

`kopt bench all` donne à chaque stratégie la même phrase de recherche et mesure une seule étape : les tokens renvoyés
au modèle et la présence des fichiers et symboles attendus (vérifiés en lisant le code, puis re-vérifiés
mécaniquement). Une tâche est « trouvée » si tous les fichiers et tous les symboles attendus apparaissent.

| Stratégie | Trouvées | Tokens médians par tâche | Tokens par tâche trouvée |
|---|---|---|---|
| kopt, un appel `kopt_find` en mode pack | 108/138 (78 %) | 1 299 | 1 512 |
| CodeGraph 1.6.2 | 79/138 (57 %) | 8 315 | 13 982 |
| Kiro natif discipliné (grep puis plages de lignes) | 54/138 (39 %) | 6 675 | 31 485 |
| Kiro natif naïf (grep puis fichiers entiers) | 65/138 (47 %) | 25 055 | 64 638 |
| KiroGraph 1.4.0 | 4/138 (3 %) | 1 085 | 43 774 |

Ce qu'il ne montre pas :

- **Ces tâches ne sont pas « held-out ».** Le travail de la v0.2 a été guidé par l'analyse des échecs de ce même
  corpus : les 78 % sont optimistes. Sur 22 tâches écrites et commitées avant toute mesure, kopt trouve 19/22 (86 %),
  la recherche native disciplinée 5/22 ; avec la question brute au lieu de la phrase de recherche, 15/22 contre 4/22.
- **Une étape n'est pas une session** : ni le nombre de tours, ni la sortie, ni le contexte re-facturé, ni un agent
  qui ignore kopt. Un autre outil de graphe de code a publié des gains hors ligne qui se sont inversés dans ses propres
  essais en conditions réelles.
- **« Trouvé » est généreux** pour les sorties qui listent des noms sans montrer le code.
- **Tokens = caractères / 3** pour tout le monde, faute de tokenizer local : les valeurs absolues peuvent être fausses
  de 25 à 45 %, les rapports entre stratégies sont plus fiables.

### 8. L'A/B avec agents est-il valide ?

**Celui de la v0.1 ne l'était pas ; ceux de la v0.2 le sont, avec des limites claires.**

- **v0.1 (`ab2`)** : les 11 appels kopt du bras kopt ont tous échoué (un Node 20 en tête du `PATH` faisait répondre
  « kopt needs Node.js 22.13 »). Les réponses avaient bien été notées (14/15 dans chaque bras), mais les -15 % de
  tokens lus venaient très probablement des consignes différentes des deux prompts, pas de kopt (et le coût modélisé
  ne baissait que de 3 %). Ces conclusions sont retirées.
- **v0.2** : Node appelé par chemin absolu, préparation qui refuse de démarrer tant que chaque commande kopt ne
  fonctionne pas à travers le wrapper, répétitions entrelacées dans un ordre tiré au hasard avec graine, deux
  correcteurs (sous-chaîne et mots entiers), contexte réellement traité par le modèle relevé dans les transcriptions,
  IC bootstrap appariés par tâche et test du signe.
- **Passage final** (84 agents, build kopt 983e221) : les 84 transcriptions ont été auditées (667 appels d'outils,
  tous passés par le wrapper, aucun pour la mauvaise tâche) ; toutes les réponses sont justes dans les deux bras
  (30/30 et 12/12) ; les 106 appels kopt ont réussi. Exploration : coût de session -23 % [-38 %, -8 %], 13/15 tâches
  moins chères, test du signe p = 0,007 ; requêtes -18 %, appels d'outils -24 %, tokens lus -23 %. Tous les passages
  v0.2 réunis : -18 % [-31 %, -5 %].
- **Limites** : ce n'est pas Kiro (des sous-agents pilotant un wrapper shell, sur un seul modèle ; le préfixe de
  34k tokens du harnais est remplacé par 12k tokens pour approcher Kiro) ; ce ne sont pas des crédits ; les tâches sont
  en lecture seule ; le bras témoin a coûté 26 % de plus qu'au tour 1 avec le même prompt et le même modèle, pour une
  raison inconnue — seule la comparaison au sein d'un même passage est valide.

Détails : [`bench/results/agent-ab-final.md`](../bench/results/agent-ab-final.md).

### 9. Pourquoi aucun gain sur le diagnostic de tests ?

Sur les 6 tâches (un bug injecté dans une copie de ce dépôt, trouver la cause à partir de la suite en échec), le coût
de session est +16 % [-31 %, +67 %], non significatif ; kopt est moins cher dans 4 tâches sur 6. Deux facteurs, les
mêmes pour les deux bras, expliquent l'essentiel :

- **Des tests instables sous charge** : 24 agents lançaient la suite de 813 tests en même temps, et les tests
  sensibles au temps de kopt ont échoué dans 9 passages sur 24. Le bras kopt a passé 16 appels sur ces faux échecs (le
  bras témoin 4), parce que `kopt run` nomme chaque test en échec.
- **Le harnais d'agents, pas Kiro**, tronquait la sortie de toute commande en échec à environ 10 000 caractères : le
  bras témoin n'a reçu que 90k des 192,6k tokens que le wrapper a journalisés.

À règles de retrait identiques pour les deux bras : appels +2 %, tokens reçus -40 % [-65 %, +11 %], coût -11 %
[-30 %, +14 %]. Jusqu'au premier appel qui montre la ligne fautive : 18,5 appels dans chaque bras, tokens reçus -48 %
[-65 %, -22 %]. kopt réduit ce que l'agent lit, pas le nombre d'appels. Un défaut est aussi apparu : une relance de
`kopt run` après un délai dépassé ne répond que « same as run X », et l'agent a dû paginer le journal en 4 lectures.

### 10. `kopt stats` donne-t-il une économie nette ?

**Non, brute, et ce sont des bornes hautes.** Pour chaque appel, `kopt stats` compare les tokens renvoyés à une
référence calculable : le fichier entier pour un squelette ou un plan de fichier, le journal brut pour `kopt_run`. Il
ne retranche pas le préfixe fixe, ni le tour coûté par chaque blocage du gouverneur, ni les lectures de suivi
provoquées par une sortie résumée ; un résultat rejoué depuis le cache est compté comme si la commande avait été
relancée. Différences avec la comptabilité de KiroGraph : la référence est mesurée appel par appel (pas une constante
de 1 500 tokens par fichier), aucune économie n'est revendiquée pour `kopt_find` ni `kopt_refs`, et les économies
négatives ne sont pas écrêtées. Le défaut commun reste réel : une borne haute est affichée comme « saved ». Un chiffre
net exige un bras témoin : c'est `kopt bench ab`.

### 11. Comment une économie de crédits sera-t-elle prouvée ?

Par `kopt bench ab`, sur votre dépôt, avec votre compte : les mêmes questions passent par le vrai Kiro CLI en mode
headless, dans un bras Kiro d'origine et un bras avec kopt (et un bras optionnel « serveur MCP seul »), chacun dans
son propre worktree git et son propre `KIRO_HOME`, dans un ordre contrebalancé, avec un budget de crédits. Les
crédits sont lus dans les fichiers de session de Kiro et dans le flux ; l'usage de kopt est prouvé par sa propre
télémétrie.

Règle de décision, fixée avant les passages : kopt vaut d'être déployé si, sur les paires que les deux bras ont
réussies, il économise **au moins 20 % des crédits avec un IC 95 % qui exclut 0**, sur au moins 5 tâches et 10 paires
(ou un test du signe sous 0,05 sur au moins 3 tâches), sans être moins souvent juste ni moins fiable que Kiro d'origine.

État : le contrôle préalable (`--check`) a été vérifié en réel contre kiro-cli 2.28. La première requête headless a
été refusée : les contrôles anti-abus de Kiro venaient de suspendre le compte (gratuit) utilisé, 0 crédit dépensé.
Nous n'avons lancé aucune session Kiro automatisée depuis. Le mode d'emploi pas à pas est dans
[TESTING.md](TESTING.md#6-mesurer-les-vrais-crédits-avec-kopt-bench-ab).

## L'agent utilise-t-il kopt ?

### 12. L'agent appelle-t-il les outils kopt de lui-même ?

Dans l'A/B (pas dans Kiro) : le premier appel était un appel kopt dans 27 des 30 passages d'exploration et dans les
12 passages de diagnostic. Mais l'usage a **diminué de moitié** quand le prompt raccourci a perdu la ligne « pas de
grep ni de lecture de fichier entier » : 2,2 appels kopt par passage d'exploration contre 4,6 au tour 2, et kopt ne
fournit plus que 34 % des tokens lus (68 % au tour 2) ; 3 passages sur 30 n'ont appelé kopt à aucun moment. Le gain a
tenu malgré cela ; rétablir la ligne n'a pas été testé. Dans une vraie session Kiro, l'usage dépend du steering, des
descriptions d'outils et, sur Kiro CLI, de Tool Search (question 13) : il n'est pas mesuré. Le tableau « context
intake by tool » de `kopt stats` le montre sur votre machine.

### 13. kopt détourne-t-il l'agent d'outils natifs meilleurs ?

Ce n'est pas mesuré, et c'est une vraie question. Kiro a ses propres outils d'intelligence de code : `read_code` dans
l'IDE, l'outil `code` du CLI (tree-sitter, et LSP en option : références, définitions). Le benchmark ne compare kopt
qu'à grep plus lectures, à CodeGraph et à KiroGraph, pas à ces outils.

- Sur les références, kopt résout de 28 % (Ruby) à 73 % des références dont le nom existe dans le dépôt, et laisse
  non résolue une référence ambiguë plutôt que de deviner ; la précision des références résolues n'est pas mesurée
  (l'échantillon de 97 à 100 % porte sur l'extraction des symboles : nom, lignes de début et de fin, signature). Un
  serveur LSP configuré est probablement plus complet ; sa disponibilité (optionnelle, à configurer par espace de
  travail), son coût en tokens (pas de budget) et son résultat face à `kopt_refs` ne sont pas mesurés.
- Le steering dit « fais confiance à `kopt_refs`, grep seulement ce qu'il marque non résolu » ; il ne mentionne ni LSP
  ni `read_code`.
- **Tool Search** (Kiro CLI seulement, désactivé par défaut) diffère les schémas MCP quand ils dépassent 5 % du
  contexte ou 50 000 tokens. Les 4 outils de kopt pèsent quelques centaines de tokens : cela n'arrive que si d'autres
  serveurs font passer le seuil, et l'agent doit alors charger l'outil avant de l'appeler.

### 14. Le sous-agent `kopt-explorer` est-il utilisé ?

Rien n'est mesuré. Il est installé (modèle `claude-haiku-4.5` par défaut, `--explorer-model` pour en changer) mais :

- **Kiro IDE ne le charge pas** : d'après la lecture des bundles 0.12.318 et 1.2.56, l'IDE ignore les fichiers d'agent
  qui contiennent des champs propres au CLI comme `allowedTools`, et celui-ci en contient. Il n'y a donc rien vers
  quoi déléguer dans l'IDE.
- **Kiro CLI 2.x le charge** ; la fréquence de délégation, les relectures par l'agent parent et le coût ne sont pas
  mesurés. Si l'organisation n'autorise pas Haiku, la documentation de CLI 2.x dit que l'agent repasse au modèle par
  défaut avec un avertissement ; CLI V3 garde le modèle choisi et les requêtes échouent.
- grep et glob, que son prompt mentionne, font bien partie de ses outils (`tools` et `allowedTools` de
  `templates/agents/kopt-explorer.json`), avec `read` et les trois outils de lecture de kopt.

## Exactitude et langages

### 15. kopt trouve-t-il le bon code aussi souvent que grep ?

Hors ligne, en une étape, oui et plus souvent : 108/138 contre 65/138 (grep puis fichiers entiers) et 54/138 (grep
puis plages). Par type de tâche, kopt est le plus faible sur les explications « comment fonctionne Y » (17/35, 49 %),
qui demandent souvent plusieurs étapes. Dans l'A/B, l'exactitude n'a pas baissé : toutes les réponses sont justes
dans les deux bras. Ce qui reste fragile : la dépendance aux mots de la question (15/22 avec la question brute sur les
tâches held-out, contre 19/22 avec la phrase de recherche).

### 16. Quels langages fonctionnent bien ?

Tâches trouvées par kopt en une étape (un dépôt de 12 à 15 tâches par langage ; un écart d'une ou deux tâches est du
bruit) :

| Langage | kopt | CodeGraph | Kiro natif, plages |
|---|---|---|---|
| Python (django) | 13/15 | 8/15 | 8/15 |
| Java (spring-framework) | 11/15 | 8/15 | 8/15 |
| JavaScript (webpack), Go (gitea), Ruby (discourse) | 11/12 chacun | 5, 6 et 8 /12 | 5, 3 et 6 /12 |
| C# (jellyfin) | 10/12 | 8/12 | 5/12 |
| TypeScript (medusa), PHP (laravel) | 9/12 chacun | 7 et 5 /12 | 3 et 4 /12 |
| Kotlin (exposed), Scala (playframework) | 8/12 chacun | 9 et 10 /12 | 4 et 5 /12 |
| Rust (meilisearch) | 7/12 | 5/12 | 3/12 |

Les points faibles sont Rust, Kotlin et Scala. Dans le langage principal de chaque dépôt, les erreurs d'analyse
syntaxique touchent au plus 1,9 % des fichiers (webpack) ; ailleurs, elles atteignent 4,4 % des 45 fichiers
JavaScript de django ; les grammaires Scala et Rust sont désormais embarquées dans le paquet et vérifiées par leur SHA-256. Le
taux de références résolues parmi les noms du dépôt va de 28 % (Ruby) à 73 % (C#, Go, Kotlin). Détail :
[BENCHMARKS.md](BENCHMARKS.md#per-language).

### 17. Peut-on faire confiance à `kopt_refs`, par exemple « 0 usages » ?

Lisez la dernière ligne. Depuis la v0.2, `kopt_refs` dit si la liste est **complete** (chaque référence au nom dans
l'index est résolue, et chaque fonction dont le code nomme la cible est listée) ou **incomplete**, et liste sous
`possible` les références de même nom non résolues. Chaque appelant vient avec la ligne d'appel, son `#handle` et ses
lignes de définition ; les lectures et écritures d'un champ sont marquées `read` / `write` ; les appelants d'un petit
wrapper qui ne fait que transmettre suivent sous `via wrapper` ; une méthode d'interface et ses implémentations comptent
comme une seule cible.

Ce qui manque encore (constaté dans l'A/B, où 6 réponses `kopt refs` sur 21 disaient « incomplete ») :

- les appels sur une variable locale TypeScript ou JavaScript initialisée par `new X(...)`, et les appels Rust
  `self.méthode(...)` dans un `impl`, ne sont pas résolus : `LocalWorkflow.cancel` répondait « 0 usages ·
  incomplete » ;
- la vérification de complétude compte les mentions dans les commentaires, et dit « incomplete » à tort.

Règle pratique : « complete », faites confiance ; « incomplete » ou « 0 usages » avec des `possible`, vérifiez avec
grep avant de modifier une méthode.

### 18. Que se passe-t-il quand des fichiers changent en dehors de l'agent ?

- Les fichiers que l'agent écrit sont signalés par les hooks et réindexés avant la réponse suivante (attente de 2 s au
  plus).
- Toutes les 30 s (à l'occasion d'un appel d'outil, il n'y a pas de minuterie), le serveur compare quelques fichiers
  git (HEAD, la référence de branche, `.git/index`) et lance la vérification complète quand ils ont changé, et toutes
  les 2 minutes dans tous les cas : un `git pull` ou un `checkout` est rattrapé. Sur Kiro IDE 1.x et le CLI, le début
  de session déclenche aussi un rafraîchissement en arrière-plan.
- Un fichier modifié depuis l'indexation est détecté (taille et date, puis empreinte). Au premier appel, kopt retrouve
  le symbole par une relocalisation heuristique (les surcharges sont distinguées par leur signature) avec une note
  « lines may be off » ; il relance l'analyse en arrière-plan et les appels suivants ont les lignes exactes.
- Les `#handles` restent valables pour un symbole qui garde son nom qualifié ; un symbole renommé reçoit un nouvel
  identifiant.
- Sur Kiro IDE 0.12, il n'y a aucun hook : seul le contrôle périodique s'applique. `kopt index --refresh` met l'index à
  jour immédiatement.

### 19. « unchanged (shown in call N) » peut-il désigner du code qui n'est plus dans le contexte ?

Oui. kopt ne renvoie pas un code déjà montré dans la session : il répond par une ligne « unchanged » qui porte le
chemin, la plage de lignes et le `#handle`. Le registre vit dans le processus du serveur MCP, par dépôt, et une
entrée expire après 40 appels kopt **ou** 30 minutes. Kiro ne signale pas la compaction de contexte, et l'on ne sait
pas si l'IDE partage un même processus entre plusieurs onglets de chat. L'agent récupère le code avec `fresh: true`,
une plage plus large ou l'outil de lecture natif : un aller-retour de plus. La fréquence de ces cas n'est pas mesurée.
Pour couper la déduplication : `"dedup": {"enabled": false}` dans `~/.kopt/config.json`.

### 20. Les pointeurs de prompt sont-ils fiables ? Fonctionnent-ils avec des prompts en français ?

Ils sont **désactivés par défaut depuis la v0.2**, justement parce qu'ils ne l'étaient pas assez : sur 175 questions
du benchmark, ils se déclenchaient dans 55 % des prompts (environ 126 tokens chacun, re-facturés à chaque requête
suivante) et seuls 21 % des pointeurs nommaient un symbole attendu (`bench/results/frontload.json`). Le premier
`kopt_find` de l'agent renvoie le même genre de pointeurs, classés pour sa propre requête. Si vous les activez
(`budgets.frontload`, par exemple 200) : ils ne vérifient pas la fraîcheur des fichiers avant de les injecter, et la
recherche est lexicale — un prompt en français sur du code et des commentaires en anglais ne trouve presque rien, sauf
s'il cite des identifiants.

### 21. `kopt_run` peut-il renvoyer un résultat périmé ?

Une commande « cachable » (test, build, lint, commande git en lecture) relancée à l'identique sans changement dans
l'espace de travail n'est pas réexécutée : kopt renvoie le résultat stocké, avec la mention « no file changed since »
et l'indication que `fresh: true` relance. L'empreinte de la v0.2 couvre, avant et après chaque exécution : HEAD, l'état
`git status` avec les fichiers non suivis, la taille et la date des chemins modifiés, les fichiers `.env*`, les
dépendances installées (`node_modules`, environnements virtuels, `vendor`), les lockfiles et manifestes ignorés, et
l'état des sorties de build ignorées.

Elle ne voit pas : les variables d'environnement, les bases de données, conteneurs et services, les caches hors du
dépôt (`~/.m2` et ses SNAPSHOT), l'heure, ni l'instabilité d'un test. Après un changement de ce genre, relancez avec
`fresh: true` (`--fresh` en ligne de commande). Le cache est toujours actif : il n'y a pas de réglage pour l'éteindre.

### 22. La compression peut-elle faire disparaître l'assertion en échec ?

Sur les 50 sorties commitées (45 générées au format de chaque outil, 5 vraies exécutions de ce dépôt), les filtres
retirent 96,4 % des tokens, et `test/compress.filters.test.ts` vérifie, sortie par sortie, que le test en échec,
l'assertion, les valeurs attendues et reçues et les cadres de pile du dépôt survivent. Dans l'A/B, le bras kopt a
trouvé la cause racine dans les 12 passages de diagnostic, avec 15,2k tokens de sortie de tests au lieu de 152,2k.

Les trous connus : pas de filtre pour la sortie TAP de `node --test` (le filtre générique peut perdre le nom du test
et les valeurs comparées) ; un build Maven ou Gradle qui réussit est réduit à son verdict, si bien qu'un goal dont la
sortie est le contenu (`mvn dependency:tree`) demande un second appel. Le journal complet reste lisible avec
`kopt_read <handle>`, filtrable par `grep`. Il n'existe pas de corpus de vrais journaux de CI pour mesurer un taux de
perte.

### 23. `kopt_run` est-il « la même exécution » que la commande lancée à la main ?

Non, malgré le message de redirection du gouverneur, qui dit « same execution » et doit être corrigé. Différences :

- **Environnement** : `CI=1`, `TERM=dumb`, `NO_COLOR=1`, `FORCE_COLOR=0`, `MAVEN_ARGS=--batch-mode
  --no-transfer-progress` (si non défini), `GIT_TERMINAL_PROMPT=0`, des variables qui coupent les barres de
  progression de pip, npm, cargo, dotnet et MSBuild, `PYTHONIOENCODING=utf-8` (si non défini). `CI=1` change des
  comportements : Jest et Vitest ne créent plus les snapshots manquants, Create React App traite les warnings comme
  des erreurs, les configurations Playwright changent souvent de retries et de workers, pnpm passe en
  `--frozen-lockfile`, et des scripts du projet peuvent changer de profil. Le retirer n'est pas simple :
  `react-scripts test` partirait alors en mode watch.
- **Shell** : `bash -c` (sinon `sh`) sur Linux et macOS ; PowerShell 7, sinon Windows PowerShell 5.1, sinon cmd.exe sur
  Windows. Pas de TTY, stdin fermé, groupe de processus à part, délai de 600 s par défaut qui tue tout l'arbre.
- **Cache** : une relance identique peut ne pas s'exécuter du tout (question 21).
- Depuis la v0.2, les commandes lancées par `kopt_run` ne reçoivent plus aucune variable `KOPT_*`.

## Intégration à Kiro

### 24. Qu'est-ce qui est actif sur chaque surface Kiro ?

| | Kiro IDE 1.x | Kiro IDE 0.12 | Kiro CLI V3 | Kiro CLI 2.x |
|---|---|---|---|---|
| 4 outils MCP | oui | oui | oui | oui (agent `kopt`) |
| Gouverneur (hooks d'appels d'outils) | oui | **non** | oui | oui |
| Steering permanent | oui | oui | oui | oui |
| `.kiroignore` global et du projet | oui | oui | celui du projet | non |
| Sous-agent `kopt-explorer` | non chargé | non chargé | à vérifier | oui |
| Crédits lus par `kopt stats` / `kopt credits` | oui | non | oui | oui |

Sur Kiro CLI 2.x, `kopt setup` définit l'agent `kopt` comme agent par défaut seulement s'il n'y en avait pas ; sinon
lancez `kiro-cli chat --agent kopt`.

### 25. Pourquoi pas de gouverneur sur Kiro IDE 0.12, et qu'y reste-t-il ?

Vérifié dans le bundle 0.12.318 : l'IDE ne charge les hooks que depuis `<espace de travail>/.kiro/hooks`, et tout hook
`preToolUse` de type commande intercepte l'appel d'outil même s'il n'écrit rien, ce qui coûterait un tour par appel.
kopt n'installe donc aucun hook d'appel d'outil sur 0.12.

Ce qui reste : les 4 outils MCP (les trois outils en lecture sont approuvés automatiquement ; `kopt_run` demande une approbation à
chaque appel tant que vous ne lui faites pas confiance), le steering global, le `kiroignore` global et le réglage
`kiroAgent.agentIgnoreFiles`. Le hook de prompt par espace de travail n'est écrit que si les pointeurs de prompt sont
activés (désactivés par défaut) : par défaut, kopt n'écrit rien dans vos dépôts sur 0.12. `kopt_run` n'est utilisé que
si le modèle le choisit. kopt ne lit pas les crédits de 0.12 (le chat affiche sa propre estimation par tour). Pour
évaluer kopt complètement, utilisez Kiro IDE 1.x ou Kiro CLI.

### 26. kopt écrit-il quelque chose dans mes dépôts ?

Par défaut, non : `kopt setup` n'écrit que dans `~/.kiro`, `~/.kopt` et un réglage utilisateur de l'IDE, et l'index vit
dans le dossier de cache de l'utilisateur. Exceptions, toutes explicites : sur Kiro IDE 0.x avec les pointeurs de
prompt activés, un fichier `.kiro/hooks/kopt-prompt.kiro.hook` par espace de travail, listé dans `.git/info/exclude` ;
`kopt init`, si vous le lancez, écrit les fichiers Kiro du projet ; un dossier `.kopt/` déjà présent à la racine fait
passer le projet en mode « par projet » (index dans ce dossier). `kopt bench ab` travaille dans des worktrees hors du
dépôt.

### 27. Quand le gouverneur redirige-t-il une commande vers `kopt_run`, et cela peut-il coûter plus que ça ne rapporte ?

Règles de la v0.2 : seulement une commande de test ou de build dont la sortie est prévisiblement longue (suite
complète, Maven et Gradle sans `-q`, MSBuild, cargo, make…) ; jamais une commande silencieuse ou ciblée (`tsc`,
`go vet`, un seul fichier ou identifiant de test, `mvn -q`), jamais une commande qui ne se termine pas seule (watch,
serveur de dev, goals `run`) ; seulement si `kopt_run` est appelable (serveur configuré, non désactivé, absent de
`disabledTools`) ; une fois par commande et par dossier, 3 fois au plus par session ; une seconde tentative identique
passe.

Un blocage coûte une requête à la taille de contexte du moment ; `kopt_run` économise (brut - compressé) × les
requêtes restantes. Sur la sortie d'un build Maven réussi, la référence passe de 8 418 à 39 tokens : c'est une sortie
générée au format de Maven (`test/fixtures/compress/maven-pass.txt`), pas un vrai build, mais à cette échelle la
redirection se rembourse vite. Elle ne rapporte presque rien sur une sortie déjà courte. Cas encore discutables :
Maven et Gradle sans `-q` sont redirigés même pour un seul test (ils journalisent chaque plugin) ;
`mvn dependency:tree` est redirigé et réduit à son verdict ; et comme `kopt_run` n'est pas approuvé automatiquement,
la redirection remplace une commande peut-être déjà approuvée par une nouvelle demande d'approbation. Rien de cela n'est
mesuré dans une vraie session Kiro. Pour couper : `"governor": {"enforceRunForVerbose": false}`.

### 28. Le blocage des relances identiques peut-il se tromper ?

Moins qu'en v0.1. Il ne bloque qu'une commande de test ou de build identique, dans le même dossier, sans écriture de
l'agent, sans nouveau prompt **et** avec la même empreinte git de l'espace de travail (les modifications faites hors de
Kiro, un `sed -i` ou un `git checkout` comptent donc), une seule fois : la tentative suivante passe. Restent : la
commande est enregistrée avant son exécution (une commande refusée ou interrompue compte comme lancée), l'empreinte a
les mêmes angles morts que celle de `kopt_run` (environnement, services), et le message affirme « no file changed
since », plus que ce que kopt sait. Pour couper : `"governor": {"blockDuplicateRuns": false}`.

### 29. kopt gêne-t-il les specs Kiro et les longues exécutions en autopilot ?

Possiblement, et ce n'est pas mesuré : aucune spec à plusieurs tâches n'a été exécutée de bout en bout avec kopt.

- Le steering `kopt-specs.md` dit « une tâche à la fois, ne pas commencer la suivante sans qu'on le demande » et
  « seulement les tests concernés ». « Run all tasks » envoie bien une demande explicite, mais la formulation reste
  ambiguë et peut faire s'arrêter le modèle trop tôt ; « seulement les tests concernés » entre en concurrence avec des
  critères d'acceptation qui exigent la suite complète.
- Le budget de 200 appels d'outils par session est cumulatif ; un nouveau prompt ne le réarme qu'une fois atteint.
  Un ticket Kiro décrit un sous-agent de spec qui a fait 592 appels : un « Run all tasks » le déclencherait très
  probablement. Réglage : `"governor": {"maxToolCallsPerSession": 500}` (0 désactive).

### 30. Quels comportements globaux `kopt setup` modifie-t-il ?

- **`~/.kiro/settings/kiroignore`** : un bloc marqué d'artefacts que personne n'édite (fichiers minifiés, source maps,
  `*.bundle.js`, `*.chunk.js`). L'IDE refuse lectures et écritures de ces fichiers dans tous les projets. Depuis la
  v0.2, lockfiles et snapshots n'y sont plus : `kopt init` les propose projet par projet.
- **Réglage IDE `kiroAgent.agentIgnoreFiles`** += `.kiroignore` : l'IDE respecte désormais les `.kiroignore` des
  projets, y compris ceux qui existaient déjà.
- **Kiro CLI 2.x** : `chat.defaultAgent = kopt`, seulement si aucun agent par défaut n'était défini (ou avec
  `--force`).
- **Steering** permanent (5 lignes de routage) et steering de code à la demande ; **sous-agent** `kopt-explorer`.
- `kopt uninstall` retire tout cela, et seulement cela.

L'effet de ces changements sur la réussite des tâches n'a été mesuré que dans l'A/B (lecture seule, 100 % de réponses
justes avec kopt).

### 31. Que coûtent les hooks en latence, et que se passe-t-il si l'un échoue ou si son binaire disparaît ?

- **Latence** (macOS, sur elasticsearch) : 45 à 55 ms par hook, deux hooks par appel d'outil sur Kiro IDE 1.x et le
  CLI ; 171 ms pour le hook de prompt quand les pointeurs sont activés. Sous Windows, seule une estimation tirée des
  journaux de CI existe (environ 110 ms par hook, 2 mesures) ; rien sur un poste géré avec antivirus ou EDR.
- **Échec** : chaque hook passe par un petit lanceur, `~/.kopt/bin/kopt` (`kopt.cmd` sous Windows), qui contient les
  chemins absolus de Node et de kopt. Si Node ou le paquet a disparu, il sort en silence avec 0 ; tout autre code que 2
  (blocage) devient 0. Une erreur interne de kopt est journalisée dans `~/.kopt/hook-errors.log` et laisse passer
  l'appel. Sur Kiro IDE 1.x, seul le code 2 bloque ; un autre code non nul est une erreur, pas un blocage. Le
  revers : un gouverneur cassé s'arrête sans signe visible. `kopt doctor` vérifie que les hooks tournent en silence et
  signale un Node ou un kopt configuré qui n'existe plus ; relancez `kopt setup` après un changement de version de Node.

## Sécurité, installation, désinstallation

### 32. `kopt_read` peut-il exposer des secrets ou des fichiers hors du dépôt ?

**Corrigé en v0.2, et revérifié le 2026-10-10.** Les outils en lecture sont approuvés automatiquement ; `kopt_read` et
le plan de fichiers refusent donc, en une ligne, tout chemin qui sort du projet (`..`, chemin absolu ailleurs, lien
symbolique qui pointe dehors), tout ce qui est sous `.git`, et ce qu'excluent `.gitignore` et `.kiroignore` (fichiers
imbriqués et `kiroignore` global compris). Essai : un `.env` ignoré par git, un dossier `secrets/` listé dans
`.kiroignore` et un lien vers `/etc/hosts` ont tous été refusés. L'indexeur ne suit pas les liens symboliques. kopt est
ainsi plus strict que les outils de lecture de Kiro, qui ne respectent pas `.gitignore` par défaut. Attention en
revanche à ce que l'index stocke (question suivante).

### 33. `kopt_run` contourne-t-il les permissions shell de Kiro ?

Oui, en partie. `kopt_run` est un outil MCP : les listes d'autorisation et d'interdiction de commandes de Kiro
s'appliquent à son outil shell intégré, pas aux outils MCP. kopt ne l'approuve pas automatiquement, donc Kiro demande
à chaque appel ; mais une fois que l'utilisateur lui fait confiance, il exécute n'importe quelle commande, y compris
une commande que la politique de l'organisation interdit pour le shell intégré, et une commande composée passe telle
quelle. Contrôles disponibles : d'après la documentation de Kiro, une règle MCP `deny` (ou `ask`) sur
`kopt/kopt_run` dans les réglages gérés de Kiro (IDE 1.x, CLI V3) ; ou `"disabledTools": ["kopt_run"]` dans l'entrée `kopt` de `mcp.json` (le gouverneur cesse alors de
rediriger vers lui). Le steering continue de mentionner `kopt_run`. Faire respecter par `kopt_run` la politique de
permissions de Kiro est à faire.

### 34. Que stocke kopt sur disque, et combien de temps ?

- **Index** (`index.db`, un par projet et par worktree, dans le cache de l'utilisateur) : symboles, lignes de
  déclaration **telles quelles**, commentaires de documentation, références et index plein texte. Le texte des
  fichiers n'y est pas copié, il est relu sur disque. Conséquence revérifiée le 2026-10-10 : une constante
  `export const OUTSIDE_SECRET = "s3cr3t"` est stockée et renvoyée par `kopt_find`, et l'index est interrogeable par la
  valeur. Gardez les fichiers de secrets hors de l'index (`.gitignore`, `.kiroignore` ou `exclude`). L'index n'est
  jamais supprimé automatiquement ; il prend les droits par défaut de l'utilisateur (sur macOS, `~/Library/Caches` est
  déjà réservé à son propriétaire ; sur Linux, cela dépend des droits du dossier personnel).
- **Journaux de `kopt_run`** : 200 journaux ou 200 Mo par projet au plus, les plus anciens supprimés d'abord, sans
  limite de durée ; ils contiennent les commandes et leurs sorties, avec des droits réservés au propriétaire.
- **`~/.kopt`** : journal d'usage local (90 jours ; ni commandes, ni prompts, ni code), état des sessions du
  gouverneur (clés des commandes de test et de build), état d'installation ; dossiers 0700 et fichiers 0600 sur Linux
  et macOS. `KOPT_TELEMETRY=0` coupe le journal d'usage.

### 35. Un dépôt cloné peut-il reconfigurer kopt ?

**Oui, et c'est un problème de sécurité ouvert.** `<racine>/kopt.config.json` (et `<racine>/.kopt/config.json` quand le
dépôt commite un dossier `.kopt/`) est fusionné après votre `~/.kopt/config.json`. Il peut changer les budgets, mais
aussi désactiver le gouverneur et le journal d'usage, déplacer l'index (`dataDir`, chemin absolu accepté), déplacer le
dossier utilisateur (`userDir`, sauf si `KOPT_HOME` est défini) et surtout **la racine du projet** (`root`). Revérifié
le 2026-10-10 : un `kopt.config.json` commité avec `{"root": "<un autre dossier>"}` a fait indexer ce dossier, et
`kopt find` / `kopt read` ont renvoyé ses fichiers. En attendant le correctif (une liste blanche de clés pour les
fichiers du dépôt, `root` venant toujours de Kiro), regardez si un dépôt que vous n'avez pas écrit contient
`kopt.config.json` ou `.kopt/` avant de l'ouvrir dans Kiro avec kopt.

### 36. kopt envoie-t-il quelque chose sur le réseau ?

Non, à l'exécution : pas de télémétrie envoyée, pas de serveur, pas de compte, aucune dépendance AWS ou cloud. Le
journal d'usage reste dans `~/.kopt`. Le réseau ne sert qu'à l'installation (npm récupère kopt sur GitHub et ses
dépendances sur le registre npm) et à `kopt bench all --clone`. Kiro lui-même envoie bien sûr vos prompts, et ce que
les outils de kopt lui renvoient, à son service : c'est hors du périmètre de kopt.

### 37. Comment l'installation est-elle épinglée, vérifiée, mise à jour et annulée ?

Pas encore comme il faudrait :

- `npx -y github:dorian-richard/kiro-optimizer setup` prend la tête de la branche principale : pas d'étiquette, pas de
  release, pas de somme de contrôle. Le paquet est `private` et n'est pas sur npm.
- **Le nom `kiro-optimizer` n'est pas réservé sur le registre npm** (404 le 2026-10-10) : si quelqu'un le publiait, un
  `npm update -g` de routine pourrait remplacer kopt, hooks compris.
- `kopt --version` affiche 0.2.0 : pour savoir exactement quel commit est installé, épinglez l'étiquette `v0.2.0` ou un SHA.
- Les dépendances sont en plages `^` et npm n'applique pas le lockfile d'une dépendance git.
- **Épingler** : `npx -y github:dorian-richard/kiro-optimizer#<SHA complet de 40 caractères> setup`. **Revenir en
  arrière** : la même commande avec un SHA plus ancien. **Retirer** : `kopt uninstall`, puis
  `npm uninstall -g kiro-optimizer`.

Prévu avant un déploiement en équipe : releases étiquetées avec une archive précompilée et sa somme SHA-256, nom npm
réservé (ou portée dédiée), arbre de dépendances figé.

### 38. `kopt uninstall` supprime-t-il tout, et seulement ce qui appartient à kopt ?

Oui en v0.2 : il ne retire que les entrées de kopt (le serveur `kopt` de `mcp.json`, ses fichiers de hooks, d'agents et
de steering, son bloc dans `kiroignore`, `chat.defaultAgent` s'il vaut encore `kopt`, le réglage `.kiroignore` s'il l'a
ajouté, les hooks d'espace de travail de l'IDE 0.x, le lanceur et la copie privée de kopt). Un fichier de kopt que vous
avez modifié est conservé et listé (`--force` le retire). Dans le dossier de cache, seuls les dossiers par projet de
kopt sont supprimés, et le dossier lui-même seulement s'il est vide : un `KOPT_CACHE_DIR` partagé garde le reste.
`--purge` supprime aussi `~/.kopt`. La copie laissée dans le cache npx n'est pas supprimée.

### 39. Combien de disque et de CPU kopt utilise-t-il ?

Mesuré sur macOS : elasticsearch (33 090 fichiers indexés) donne un index de 941 Mo, un premier build de 79,5 s en ligne
de commande avec un pic à 2,04 Go de mémoire ; VS Code (14 713 fichiers) 338 Mo et 27,9 s. Le premier build tourne dans
un thread de travail : la recherche répond après 32 s sur elasticsearch, les références après 87 s, et les appels
reçus entre-temps ont la progression tout de suite. Les workers d'analyse sont au plus 4 (2 sous 12 Go de mémoire ;
`KOPT_INDEX_WORKERS` pour en changer). Un seul processus indexe un projet à la fois.

Points d'attention : un index par checkout et par worktree, aucune éviction automatique, aucun plafond de fichiers.
Seuls le dossier personnel et la racine du système de fichiers sont refusés comme racine de projet (un dossier sans
dépôt git comme `~/Downloads` serait parcouru, mais seuls les fichiers source des langages pris en charge sont
indexés). Un serveur inactif ne consomme pas de CPU : le contrôle de fraîcheur n'a lieu qu'à l'occasion d'un appel.
`KOPT_INDEX_ON_START=0` reporte le premier build au premier appel d'outil.

### 40. Mon compte Kiro risque-t-il quelque chose ?

Utilisé normalement dans Kiro, kopt n'envoie aucune requête à Kiro : il répond aux outils que l'agent appelle. Le
risque concerne **les sessions automatisées**, donc `kopt bench ab`. Les contrôles anti-abus de Kiro peuvent suspendre
un compte qui paraît automatisé : c'est arrivé pendant la construction du harnais, sur un compte gratuit, dès la
première requête headless, peu après qu'un script lancé dans un dossier personnel temporaire eut déclenché tout seul
une connexion par navigateur. Kiro a répondu « Your User ID is temporarily suspended » ; aucun crédit dépensé, le
rétablissement passe par le support (<https://support.aws.amazon.com/#/contacts/kiro>).

Règles : connectez-vous vous-même (`kiro-cli login`, puis `kiro-cli whoami`) ; ne laissez jamais un script ou un agent
se connecter à votre place ; ne lancez pas `kiro-cli` depuis des scripts dans un dossier personnel temporaire ; évitez
les connexions et déconnexions répétées et les rafales de sessions headless ; commencez par une seule sonde ; préférez
un compte payant pour une campagne A/B ; en cas de suspension, arrêtez tout et contactez le support.

## Plateformes

### 41. kopt fonctionne-t-il sous Windows ?

La CI est verte sous Windows : les tests unitaires sur Node 22 et 24 (qui lancent aussi `kopt setup`, `doctor` et
`uninstall` dans un dossier personnel temporaire) et un job de fumée qui fait passer `kopt run` par PowerShell 7,
Windows PowerShell 5.1 et cmd.exe, et les hooks par cmd.exe et PowerShell. Mais kopt n'a **jamais tourné sur un poste
Windows géré, ni avec un vrai Kiro sous Windows**.

Point d'attention pour un poste avec EDR : `kopt_run` lance `powershell -NoProfile -NonInteractive -ExecutionPolicy
Bypass -EncodedCommand <base64>` comme enfant de `node.exe` sous l'IDE, un motif que Defender for Endpoint ou
CrowdStrike peuvent signaler ; et une stratégie de groupe qui fixe la politique d'exécution l'emporte sur `Bypass`.
Sur un poste verrouillé, utilisez `KOPT_SHELL=cmd`, défini dans l'environnement système ou dans le champ `env` de
l'entrée `kopt` de `mcp.json`, pour que le serveur MCP le voie. Les hooks passent par `kopt.cmd` ; un chemin de profil
avec des espaces est écrit sous sa forme courte 8.3.

### 42. Quels Node, macOS et Linux fonctionnent ?

Node 22.13 ou plus (kopt utilise `node:sqlite`), aucun module natif, aucun compilateur. La CI tourne sur
ubuntu-latest, macos-latest et windows-latest avec Node 22 et 24. Les mesures de performance n'ont été faites que sur
macOS (Apple silicon). Avec plusieurs versions de Node (nvm, volta, fnm), lancez `kopt setup` avec la bonne version
active : Kiro l'utilisera par chemin absolu ; relancez `kopt setup` après l'avoir désinstallée.

## Comparaison avec KiroGraph et CodeGraph

### 43. Comment kopt se compare-t-il à CodeGraph et KiroGraph ?

Sur le benchmark hors ligne (une étape, mode par défaut de chaque outil, un appel de son outil de contexte principal,
une session MCP neuve par tâche, conteneurs sans réseau) : kopt trouve 108/138 tâches à 1 299 tokens médians, CodeGraph
79/138 à 8 315, KiroGraph 4/138 à 1 085.

- **CodeGraph** fait mieux que kopt sur Kotlin (9 contre 8) et Scala (10 contre 8), n'expose qu'un outil (575 tokens
  de schéma, mais 2 240 tokens d'instructions de serveur, que Kiro transmet ou non au modèle : ce n'est pas documenté)
  et a un démon de mise à jour. Sa sortie atteint 8 200 tokens ou plus, près de son plafond d'environ 8 300 tokens
  (25 000 caractères) de code source numéroté, sur 109 des 138 tâches. Sur les 68 tâches que les deux trouvent,
  CodeGraph renvoie en médiane 6,5 fois plus de tokens que kopt.
- **KiroGraph** 1.4.0 a une recherche lexicale cassée (lu dans son code : la jointure FTS5 renvoie toujours 0 ligne).
  Dans son mode par défaut il expose 7 outils (environ 1 500 tokens de schémas par requête), jusqu'à 127 avec toutes
  ses options, et il compte un échec comme 100 % d'économie dans ses propres chiffres.
- Aucun A/B en session n'a comparé kopt à ces outils ; leurs temps d'indexation, mesurés dans une VM chargée, ne sont
  pas comparés à ceux de kopt. Protocole : [`bench/competitors/README.md`](../bench/competitors/README.md).

### 44. Est-il vrai que les outils de graphe de code « économisent peu » ?

Ce n'est pas mesuré en session, et la documentation ne l'affirme plus comme un fait. Ce qui est établi : le code de
KiroGraph et de CodeGraph a été lu (voir [ARCHITECTURE.md](ARCHITECTURE.md)), et le benchmark hors ligne montre que
CodeGraph trouve plus que les outils natifs (57 % contre 39 à 47 %) mais en renvoyant environ 8 300 tokens par étape,
et que KiroGraph ne trouve presque rien. Le propre A/B de CodeGraph porte sur peu de questions, sans vérification des
réponses, et mesure lui-même 82 % de contexte résident en plus. L'hypothèse de conception de kopt est que la recherche
de code n'est qu'une partie de la dépense (journaux de tests, lectures entières, relances, préfixe fixe, boucles) ;
l'A/B le confirme en partie : sur l'exploration, le préfixe fixe représente la moitié du coût re-basé du bras témoin.

## Limites et feuille de route

### 45. Qu'est-ce qui doit être corrigé avant un déploiement en équipe ?

Par ordre de gravité :

1. **Configuration de dépôt** : un `kopt.config.json` commité peut changer la racine du projet et couper le gouverneur
   (question 35).
2. **Secrets dans l'index** : les lignes de déclaration sont stockées telles quelles (question 34).
3. **`kopt_run` hors politique de permissions** de Kiro (question 33).
4. **Releases** : pas d'étiquette, pas de somme de contrôle, nom npm non réservé (question 37).
5. **Environnement de `kopt_run`** : `CI=1` et le message « same execution » (question 23).
6. **Résolution** des appels sur des receveurs TypeScript, JavaScript et Rust, et vérification de complétude qui compte
   les commentaires (question 17).
7. **Relance après délai dépassé** qui ne redonne que « same as run X » (question 9).
8. **Steering des specs** et budget de 200 appels face à « Run all tasks » (question 29).
9. **`kopt-explorer`** non chargé par l'IDE (question 14).
10. **Mesure des crédits** sur un compte payant, avec `kopt bench ab` (question 11).

### 46. Et ensuite ?

- Corriger la liste ci-dessus, en commençant par la sécurité de la configuration et l'index.
- Rétablir une ligne de routage dans le steering (« lis le code avec `kopt read #id|chemin:a-b`, pas cat/sed ») et
  l'évaluer en A/B, puisque l'usage de kopt a baissé de moitié sans elle.
- Rendre les tests de kopt indépendants du temps, et regrouper dans `kopt run` les échecs qui partagent une même
  assertion.
- Plus de tâches d'exploration (l'IC regroupé est de ±13 points avec 15 tâches) et une campagne `kopt bench ab` sur un
  vrai dépôt d'entreprise.
- Plus tard : indexeurs SCIP locaux (Java, TypeScript, .NET) pour une résolution exacte, recherche sur plusieurs dépôts,
  embeddings locaux si un écart de rappel sur le langage naturel le justifie.
