# Design — Copier le workflow NV Labs vers le workspace Paperclip Eiyo IPTV

**Date** : 2026-06-04
**Statut** : validé (brainstorming), en attente relecture user avant plan d'implémentation

## Objectif

Configurer le workspace Paperclip **Eiyo IPTV** (`76e7c4a8-6dd5-4d14-aa5b-23f78bf74af5`)
pour qu'il reproduise fidèlement le workflow de gouvernance du workspace **NV Labs**
(`03f88baf-4d70-4fd5-8a8a-7fb2c31689a5`), adapté aux spécificités d'Eiyo (préfixe `EIY`,
app iOS/tvOS Swift, repo `eiyo-tv`, PR vers `main`).

## Constat — ce qu'est réellement le « workflow NV Labs »

Le workflow n'est ni une configuration Paperclip spéciale, ni des skills assignés. C'est un
**ensemble de règles de gouvernance company-wide écrites dans les `AGENTS.md`** des agents.

Stockage (bundle managé sur disque, mode `instructionsBundleMode: "managed"`) :

```
~/.paperclip/instances/default/companies/<companyId>/agents/<agentId>/instructions/
  ├── AGENTS.md          ← instructions principales (les règles)
  ├── governance-*.md    ← docs de gouvernance détaillées (CEO uniquement)
  └── HEARTBEAT.md, SOUL.md, TOOLS.md (CEO)
```

Le chemin est exposé dans `agent.adapterConfig.instructionsFilePath` / `instructionsRootPath`.

Faits vérifiés :

- Le skill `brainstorming` est un skill **superpowers global** (déjà disponible partout),
  invoqué par instruction dans l'AGENTS.md du CEO. **Rien à installer côté skills company.**
- NV Labs et Eiyo ont déjà **les 8 mêmes skills paperclip de base** (`attachedAgents=0`). Aucun
  skill company à copier.
- Les AGENTS.md actuels d'Eiyo sont les templates « vanille » par rôle (pas de gouvernance custom).

## Les 4 règles de gouvernance à copier

Origine NV Labs entre parenthèses (à titre informatif ; **aucune référence d'issue ne sera
inscrite dans Eiyo** — règles présentées comme gouvernance company-wide).

| Règle | NV Labs | Adaptation Eiyo |
|---|---|---|
| **Brainstorming gate** (NVL-83) | CEO invoque `brainstorming` avant validation/dispatch | identique |
| **Worktree partagé par issue** (NVL-85) | 1 issue = 1 worktree + 1 branche `feat/NVL-<n>-<slug>` partagés ; `rebase origin/stg` | `.claude/worktrees/<EIY-XX>/<slug>/` + `feat/EIY-<n>-<slug>` ; `rebase origin/main` |
| **Review pre-PR** (NVL-110) | iOSReviewer/BackendReviewer obligatoire (sous-issue bloquante) avant `gh pr create` | iOSReviewer seul (routing simplifié, pas de double full-stack) |
| **Interdiction merge agent** (NVL-84) | Seul le board humain merge ; PR vers `stg` | identique mais PR vers `main` |

## Structure d'équipe cible

**Actuel Eiyo** (plat) :

```
CEO
 ├─ QA               (role qa)
 ├─ iOSEngineer      (role engineer)
 ├─ UXDesigner       (role designer)
 └─ MediaPerfEngineer(role engineer)
```

**Cible** (calquée sur NV Labs, reproduction fidèle) :

```
CEO
 ├─ CTO (NOUVEL agent, role cto)
 │   ├─ iOSEngineer        (reparent → CTO)
 │   ├─ MediaPerfEngineer  (reparent → CTO)
 │   ├─ QA                 (reparent → CTO)
 │   └─ iOSReviewer (NOUVEL agent, role security/reviewer read-only, reportsTo CTO)
 └─ UXDesigner            (reste sous CEO)
```

- **2 nouveaux agents** : CTO, iOSReviewer.
- **3 re-parentages** : iOSEngineer, MediaPerfEngineer, QA → CTO.

IDs agents Eiyo connus :

- CEO `fa46c411-ca56-4d9b-9c35-ae0a839d45e5`
- QA `2486e446-fa23-4ffb-be77-1e4a1c1b3c31`
- iOSEngineer `1aab21d4-fa8a-4987-98a6-eefdde72de22`
- UXDesigner `34c21cb6-0e4d-42be-b791-3b622dbea6f2` (statut `error` — à noter, hors périmètre)
- MediaPerfEngineer `01084ac3-bbb5-46af-a722-647dc9a483da`
- CTO / iOSReviewer : IDs résolus à la création.

## Contenus à écrire

### A. CEO `AGENTS.md` (greffe sur l'existant)

- §Delegation : insérer l'étape **« Brainstorm BEFORE validating or dispatching »** — invoquer
  le skill `brainstorming` (Skill tool, nom exact `brainstorming`) avant de créer des sous-tâches.
  Exception : suivi mécanique d'un parent déjà brainstormé (le noter dans le commentaire de délégation).
- Router « Code/bugs/features/infra/technique → CTO ».
- Ajouter 3 sections de gouvernance (merge interdit, worktree partagé + sync `origin/main`, review pre-PR),
  chacune renvoyant à son doc `governance-*.md`.
- Créer 3 docs de gouvernance dans le bundle CEO :
  - `governance-pr-merge-rule.md` (interdiction merge agent, PR vers `main`)
  - `governance-main-sync-rule.md` (worktree partagé par issue + sync `origin/main`)
  - `governance-coder-review-rule.md` (review pre-PR par iOSReviewer)

### B. CTO `AGENTS.md` (nouvel agent)

- Mission : exécution technique end-to-end de l'app **Eiyo IPTV** (iOS/tvOS Swift, repo `eiyo-tv`).
- Applique ET fait respecter les 4 règles côté CTO (review PR, vérif rebase, vérif unicité branche,
  vérif trace review pre-PR, attente merge board).
- Le CTO suit lui-même la règle review pre-PR quand il code (pas d'auto-approve).
- Definition of Done iOS (build/test verts, pas de skip non justifié, etc.).
- Hiring authority : propose des hires au CEO, ne crée pas d'agents sans accord.

### C. iOSReviewer `AGENTS.md` (nouvel agent, read-only)

- Reviewer read-only : lit le diff sur la branche partagée, poste findings classés par sévérité
  (`critical`, `high`, `medium`, `low`, `info`), **n'écrit jamais dans le code**, clôture la
  sous-issue de review (wake l'engineer via `issue_blockers_resolved`).
- Bloquant sur `critical`/`high`.

### D. iOSEngineer + MediaPerfEngineer `AGENTS.md`

- Règle git/worktree partagé : travailler dans `.claude/worktrees/<EIY-XX>/<slug>/`, branche
  `feat/EIY-<n>-<slug>` partagée, `git fetch origin && git rebase origin/main` avant 1er commit,
  `git pull --rebase` avant chaque commit suivant, coordination inter-agents via commentaires d'issue.
- Règle review pre-PR : avant `gh pr create`, créer sous-issue review assignée à iOSReviewer,
  passer le parent en `blocked`, corriger `critical`/`high`, mentionner la review dans la PR.
- Règle interdiction merge : jamais `gh pr merge` / `git merge` sur `main` ; passer l'issue en
  `in_review` assignée au CTO, qui transmet au board pour merge manuel.
- Done criteria iOS (build/test verts, screenshots si UI, commits atomiques conventional).

## Adaptations transversales NV Labs → Eiyo

| NV Labs | Eiyo |
|---|---|
| Préfixe `NVL` | `EIY` |
| Branche cible `stg` (PR vers stg puis stg→main) | `main` (PR directement vers main) |
| `feat/NVL-<n>-<slug>` | `feat/EIY-<n>-<slug>` |
| sync `git rebase origin/stg` | `git rebase origin/main` |
| iOSReviewer + BackendReviewer (routing auto + double full-stack) | iOSReviewer seul (routing simplifié) |
| Repos `moda-iOS` / `moda-backend` | repo `eiyo-tv` (iOS/tvOS Swift) |
| Liens `/NVL/issues/...` | pas de liens d'issue (gouvernance sans référence) |
| Hook `scripts/hooks/pre-push` bloque push direct | **pas de hook** → règle de conduite agent (pas de blocage mécanique évoqué) |
| IDs agents NV | IDs agents Eiyo (CTO/iOSReviewer résolus à la création) |

## Mécanisme d'application (comment écrire concrètement)

Deux voies possibles, à trancher dans le plan d'implémentation :

1. **Écriture directe des fichiers** dans le bundle managé
   (`~/.paperclip/instances/default/companies/<eiyo>/agents/<agent>/instructions/AGENTS.md` + docs),
   après création des agents. Simple, mais contourne l'API.
2. **Via CLI/API Paperclip** : `paperclip-create-agent` pour les nouveaux agents (qui provisionne
   le bundle), `PATCH /api/agents/:id` pour `reportsTo`, puis écriture des fichiers de bundle.

Recommandation : créer les agents via le skill `paperclip-create-agent` (provisionne proprement le
bundle + adapterConfig), re-parenter via l'API, puis écrire/éditer les fichiers AGENTS.md et
governance dans les bundles. Le re-export `company export` sert de vérification finale.

## Plan d'exécution (haut niveau)

1. Créer le CTO (skill `paperclip-create-agent`) + écrire son AGENTS.md adapté.
2. Créer iOSReviewer (read-only) reportsTo CTO + écrire son AGENTS.md.
3. Re-parenter iOSEngineer, MediaPerfEngineer, QA → CTO.
4. Réécrire l'AGENTS.md du CEO (brainstorming gate + 3 sections gouvernance) + créer les 3 docs `governance-*.md`.
5. Écrire les AGENTS.md des engineers (iOSEngineer, MediaPerfEngineer).
6. Vérifier : re-export d'Eiyo + relecture des bundles, confirmer cohérence (préfixe EIY, main, iOSReviewer, hiérarchie).

## Périmètre exclu (YAGNI)

- **Routines** (cron) : explicitement hors périmètre.
- **BackendReviewer / routing full-stack** : Eiyo est iOS-only, un seul reviewer.
- **Hook git pre-push** : non créé dans le repo (formulé en règle de conduite).
- **UXDesigner en statut `error`** : signalé mais pas réparé ici (hors périmètre du workflow).
- Pas de nouveaux skills company (les 8 paperclip de base suffisent ; brainstorming est global).

## Risques

- Re-parentage de 3 agents (`reportsTo`) : réversible, faible risque.
- Écriture dans le bundle managé : si l'API régénère le bundle, des éditions directes pourraient
  être écrasées — préférer le provisioning via skill puis édition, et vérifier après écriture.
- Les agents Eiyo sont `idle` (sauf UXDesigner `error`) : aucun heartbeat actif ne devrait
  interférer pendant la reconfiguration.
