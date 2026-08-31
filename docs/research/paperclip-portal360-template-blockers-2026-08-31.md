# Paperclip / Portal360 — template e blocker

**Data:** 31 agosto 2026
**Ambito:** Paperclip, OpenClaw gateway, flotta Repair360 e passaggio a SaaS multi-tenant.
**Metodo:** confronto tra il candidato `codex/openclaw-token-secret-ref-fix`, il master upstream corrente, la documentazione/spec ufficiale e le task Codex collegate. Nessuna modifica live e nessun segreto incluso.

## Verificato

### Che cos’è davvero un template Paperclip

Un template non è una tabella “dipartimenti” già attiva nel database. È un pacchetto portabile Git/Markdown conforme a `agentcompanies/v1`, con `TEAM.md` come radice, `AGENTS.md` per le istruzioni degli agenti, `PROJECT.md`, `TASK.md` e l’eventuale `.paperclip.yaml` per estensioni runtime. La spec separa volutamente istruzioni portabili, configurazione adapter e segreti: i segreti non devono entrare nel pacchetto.

Paperclip espone il ciclo `browse → search → inspect → preview → install`. `preview` è non mutante; `install` importa il pacchetto nella company esistente, con collision strategy e target manager. Il grafo deve essere visibile e le dipendenze/subtree selezionabili prima dell’installazione.

### Catalogo upstream osservato

Nel master upstream corrente risultano quattro pacchetti pubblicati:

| Categoria | Template | Uso corretto |
|---|---|---|
| company-defaults | `core-exec-team` | nucleo minimo CEO/CTO/QA e prima routine |
| product | `product-design` | design/prodotto |
| software-development | `product-engineering` | engineering |
| content | `content-machine` | contenuti, opzionale |

Non risulta un template ufficiale già specializzato per Repair360, Portal360 o OpenClaw fleet. Il candidato aggiunge `repair360-fleet` come pacchetto bundled non installato automaticamente: sei ruoli, un progetto e un task tenant-boundary, con OpenClaw dichiarato come executor e Core360 come SSOT.

### Struttura Repair360 proposta

La flotta completa è già modellata nel candidato, senza creare un secondo Core:

1. Fleet Director / PMO
2. Sonia — Customer Success & Intake
3. Chiara — Tenant Operations
4. Giorgia — Voice & WhatsApp Operations
5. OpenClaw Engineering — executor unico
6. QA & Audit — test, isolamento tenant, secret handling e receipt

L’installazione deve restare esplicita e sotto un manager scelto. Il pacchetto non contiene token, path macchina, provider OAuth o traffico cliente reale.

## Portal360 blocker matrix

| Priorità | Stato | Evidenza | Impatto | Prossima azione sicura | Gate umano |
|---|---|---|---|---|---|
| P0 | BLOCCATO live | Il live usa `portal360/paperclip:v2026.722.0-e55d702`; la build live classifica `hermes_gateway.apiKey`, non `openclaw_gateway.authToken`. | Un edit legacy può perdere la credenziale o richiedere plaintext. | Promuovere solo una build con schema/fix verificati e receipt. | Deploy/restart esplicito. |
| P0 | IN CORSO | Pairing OpenClaw richiede approvazione iniziale e persistenza della device key; l’E2E live non è stato eseguito. | Non è provato che task, chat e `/new` funzionino dopo il primo pairing. | Eseguire Case A/B/C in ambiente sintetico dopo cutover. | Deploy/restart e traffico sintetico autorizzato. |
| P0 | NON VERIFICATO | L’issue upstream #5015 segnala l’assenza di un operator token realmente company-scoped; workaround con board key e company id non è adatto a tenant non fidati. | Un token operativo può oltrepassare il confine tra company. | Introdurre/verificare auth company-scoped prima di SaaS pubblico. | Decisione sicurezza/architettura. |
| P1 | NON VERIFICATO | L’advisory upstream sul token API cross-tenant documenta un rischio storico di IDOR; il live è autenticato ma la configurazione signup/ACL completa non è stata provata in questo passaggio. | Rischio di lettura/modifica cross-tenant. | Test negativo con due company e token distinti; fail closed. | Traffico solo sintetico. |
| P1 | VERIFICATO | Nel live Sonia e Giorgia non risultano create; esiste una Chiara Hermes e c’è conflitto d’identità rispetto a Chiara Merli. | Installare la flotta senza risolvere il mapping produce ownership e audit ambigui. | Preview/import con mapping esplicito; non creare agenti live ora. | Approvazione del mapping e deploy. |
| P1 | VERIFICATO | Il master upstream è più avanti del candidato; il gateway corrente usa protocollo v4 e device key persistente. | Rebase cieco può riaprire conflitti su secret handling/runner. | Confronto/cherry-pick minimo e suite rilevante prima del merge. | Gate tecnico interno, non live. |
| P2 | NON VERIFICATO | La CI/release lane Portal360 non è ancora una prova corrente di build + smoke multi-tenant. | Regressioni possono arrivare al VPS senza receipt sufficiente. | Aggiungere la suite minima alla lane di release. | Approvazione release. |

## Decisione operativa

La strada minima è: usare `core-exec-team` come riferimento di governance, importare `repair360-fleet` come estensione specializzata e tenere `product-design`/`product-engineering` come subtree opzionali. Non serve inventare sei template separati né un nuovo concetto di dipartimento.

Ordine sicuro:

1. chiudere il fix di preservazione/migrazione del token nel normalizzatore centrale;
2. validare catalogo e preview/import offline;
3. confrontare il candidato con master e testare protocollo v4/pairing;
4. risolvere company-scoped auth e mapping Chiara;
5. chiedere un solo gate per deploy/restart, poi eseguire Case A/B/C e receipt di rollback.

## Case sintetici da provare dopo il gate

- **A — task:** Paperclip assegna un micro-task sintetico a Sonia/Chiara; OpenClaw lo esegue; audit e tenant id restano coerenti.
- **B — chat:** un messaggio su canale sintetico produce risposta dell’agente corretto, senza Hermes nel percorso OpenClaw.
- **C — nuova attività:** `/new` crea un task Paperclip con company/tenant espliciti; un token dell’altra company non può leggerlo né modificarlo.

## Fonti primarie

- Paperclip repository e architettura: https://github.com/PaperclipAI/paperclip
- Catalogo `core-exec-team`: https://github.com/paperclipai/paperclip/blob/master/packages/teams-catalog/catalog/bundled/company-defaults/core-exec-team/TEAM.md
- CLI catalogo/import: https://github.com/paperclipai/paperclip/blob/master/doc/CLI.md
- Agent Companies spec: https://github.com/paperclipai/paperclip/blob/master/docs/companies/companies-spec.md
- OpenClaw onboarding e test plan: https://github.com/paperclipai/paperclip/blob/master/packages/adapters/openclaw-gateway/doc/ONBOARDING_AND_TEST_PLAN.md
- Implementation spec: https://github.com/paperclipai/paperclip/blob/master/doc/SPEC-implementation.md
- Company-scoped operator token: https://github.com/paperclipai/paperclip/issues/5015
- Cross-tenant API token advisory: https://github.com/paperclipai/paperclip/security/advisories/GHSA-47wq-cj9q-wpmp
- Mention/grant isolation: https://github.com/paperclipai/paperclip/issues/8367

## Limiti della ricerca

La ricerca non dimostra che il candidato sia live, che i sei agenti siano già installati o che il SaaS sia pronto per tenant non fidati. Questi punti restano `NON VERIFICATO` finché non esistono build, test E2E, isolamento negativo, SHA e receipt correnti.
