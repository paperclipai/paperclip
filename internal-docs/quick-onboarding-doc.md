  Project: Cortex — the orchestration/brain layer of the WBIT platform. Manages task queues, agent harnesses, budgets, and audit trails. Sibling layers: AgencyOS (face), WorkPipe (hands/CRM), Drive (file storage). Stack: TypeScript,
  pnpm workspaces, server/src/services/*.ts.                                                                                                                                                                                             
                                                            
  Repos:                                                                                                                                                                                                                                 
  - Upstream: github.com/paperclipai/paperclip (Cortex is a hard fork)
  - Fork: github.com/Cov12/cortex (private, WBIT-owned)                                                                                                                                                                                  
  - Forked on 2026-04-27.
                                                                                                                                                                                                                                         
  Branch strategy (3-branch + master, inherited from AgencyOS/OpenWebUI pattern):

  paperclip → master → upstream-sync → integration (CI) → wbit-cortex-prod (deploys)
                                                                                                                                                                                                                                         
  ┌──────────────────┬──────────────────────────────────────────────────────────────┐
  │      Branch      │                             Role                             │                                                                                                                                                    
  ├──────────────────┼──────────────────────────────────────────────────────────────┤
  │ master           │ Tracks paperclip upstream — git fetch upstream target        │
  ├──────────────────┼──────────────────────────────────────────────────────────────┤
  │ upstream-sync    │ Pure mirror of master, zero custom code                      │                                                                                                                                                    
  ├──────────────────┼──────────────────────────────────────────────────────────────┤
  │ integration      │ Custom WBIT code + CI; where upstream conflicts get resolved │                                                                                                                                                    
  ├──────────────────┼──────────────────────────────────────────────────────────────┤
  │ wbit-cortex-prod │ Production, auto-deploys, tagged cortex@vX.Y.Z               │
  └──────────────────┴──────────────────────────────────────────────────────────────┘

  Hard rules:
  - Upstream changes flow master → upstream-sync → integration → wbit-cortex-prod. Never skip a hop.
  - upstream-sync carries zero custom code so upstream conflicts stay clean.                        
  - wbit-cortex-prod only receives merges from integration, fast-forward only.
  - Hotfixes land on wbit-cortex-prod first, then must back-port to integration in the same session.                                                                                                                                     
  - Merge, never rebase shared branches — preserves upstream provenance.                            
                                                                                                                                                                                                                                         
  Why 3 branches: conflicts get resolved exactly once on integration (not repeatedly on prod); CI gates promotion; upstream-sync stays diff-clean against paperclip for security-patch tracking.                                         
                                                                                                                                                                                                                                         
  Planned major feature (not yet on roadmap): Bayesian Decision Engine — replaces deterministic keyword routing with belief-driven decisions (Bayesian inference + simulation scoring + outcome learning). Spec exists; impl will        
  translate Python pseudocode → TypeScript at server/src/services/*.ts.                                                                                                                                                                  
                                                                                                                                                                                                                                         
  Today's status: repo is forked, all four branches pushed, deploy key works. No local clone yet on this machine.                                                                                                                        
   
  Reference docs in repo (planned location):                                                                                                                                                                                             
  - internal-docs/branch-strategy.md — full workflow recipes (sync, promote, hotfix)
  - internal-docs/bayesian-engine-spec.md — future-feature architecture       