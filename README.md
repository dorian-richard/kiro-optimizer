# kiro-optimizer (`kopt`)

> **EN.** Token optimizer for [Kiro](https://kiro.dev) (IDE and CLI). It combines budgeted code-intelligence MCP
> tools, command-output compression, session-governor hooks and an optional centralized deployment on AWS. It cuts
> both input and output tokens on large codebases without proxying Kiro's LLM traffic, which Kiro does not allow.

**Statut : prototype en cours de développement (v0.1).** Les interfaces peuvent encore changer.

## Pourquoi un nouvel outil

Sur de gros dépôts, les outils de « code graph » existants (KiroGraph, CodeGraph) économisent peu. Le fait central :
Kiro facture des crédits par requête, proportionnels à la taille totale de la requête. Or chaque token entré dans
le contexte est **refacturé à chaque tour suivant**.

La dépense vient donc surtout :
- de l'historique résident multiplié par le nombre de tours ;
- des logs de build et de test, verbeux et souvent relancés ;
- des lectures de fichiers entiers ;
- du préfixe fixe (steering, schémas d'outils) ;
- des boucles d'agent qui s'emballent.

Un graphe de code ne traite qu'une petite part de ces postes. L'analyse détaillée, vérifiée dans le code des
outils existants et dans la documentation Kiro, est dans [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Les cinq leviers

1. **`kopt_run` / `kopt_expand`** : les tests, builds et linters ne renvoient que le verdict, les échecs et les
   erreurs. Le log complet reste accessible par handle. Une commande identique, relancée sans modification de
   fichier, n'est pas réexécutée.
2. **Gouverneur de session** (hooks `command` Kiro, qui ne consomment aucun crédit) :
   - disjoncteur sur le nombre d'appels d'outils ;
   - redirection, une seule fois, des lectures de fichiers entiers trop gros ;
   - redirection, une seule fois, des commandes verbeuses vers `kopt_run` ;
   - blocage des relances identiques ;
   - mesure de la taille des sorties des outils natifs.
3. **Navigation de code budgétée** (`kopt_find`, `kopt_read`, `kopt_outline`, `kopt_refs`) :
   - plafond dur en tokens, sortie compacte (jamais de JSON), handles courts `#3mv` ;
   - déduplication par session ;
   - mode `pack`, qui fournit le contexte d'une tâche en un seul appel ;
   - recherche lexicale « code-aware » combinée à la centralité (PageRank).
4. **Préfixe fixe minimal** : 6 outils, steering `always` de moins de 140 mots, `.kiroignore` généré.
5. **Leviers de sortie** : steering de concision et d'édition minimale, et sous-agent d'exploration sur un modèle
   économique.

## Architecture

- **Local** : `kopt mcp` (MCP stdio), `kopt hook` (gouverneur) et un index SQLite local (`node:sqlite`, FTS5)
  alimenté par tree-sitter (WASM). Aucune dépendance native.
- **Centralisé (AWS, chez le client)** :
  - indexation par commit en CI (CodeBuild), avec des snapshots stockés dans S3 (KMS) ;
  - serveur MCP Streamable HTTP multi-dépôts sur ECS Fargate, authentifié en OAuth (Cognito ou IdP) ;
  - télémétrie CloudWatch avec dashboard des économies ;
  - infrastructure en AWS CDK.

Voir [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) et [docs/CONTRACTS.md](docs/CONTRACTS.md).

## Démarrage rapide (cible v0.1)

```bash
nvm use 22            # Node >= 22.13
npm install && npm run build
npx kopt index        # indexe le dépôt courant dans .kopt/index.db
npx kopt init         # configure Kiro : mcp.json, steering, hooks, agent explorer, .kiroignore
npx kopt stats        # tokens renvoyés, économies mesurées, blocages du gouverneur
```

## Mesure

Aucun chiffre d'économie n'est annoncé sans mesure. Deux outils sont prévus :
- `kopt bench` : un banc hors ligne sur de grands dépôts open source, avec des tâches dont les réponses de
  référence sont vérifiées.
- `bench/ab/` : un A/B en ligne avec `kiro-cli` en mode non interactif. Il compare les crédits sur des tâches
  appariées et ne retient que celles réussies par les deux bras.

## Licence

[MIT](LICENSE)
