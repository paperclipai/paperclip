# TSR-4709 — shadow SOP (additive only)

Parent: TSR-4704. Output never goes to the customer. Do not modify intake/delivery SOP.

## Lane (hired)

- Paperclip agent: **CV-Review-Grok-R2**
- Agent ID: `e73544da-2ff4-4370-8510-79bcefc24ffd`
- adapter: `hermes_local` · model: `grok-4.5` · maxConcurrentRuns: 1
- instructions: managed AGENTS.md sha `fd189e4b279ac47e366984b2ab9f1b8c1b4782cc2433cd91d77ee3c19da0c7bf`
- canonical copy: `/Users/glad0s/paperclip/work-products/TSR-4704/cv-review-agent-file-R2.md`
- **no** skill packs

## Trigger

First real `[PHASE-0-WEDGE]` / paid CV-polish order (and the next 2 after that). Zero fabrication if volume is zero — keep card in `backlog`.

## Per order

1. Capture the same CV + target-role packet the incumbent reviewer sees.
2. Run R2 lane in shadow:
   - Prefer assign/wake Paperclip agent `CV-Review-Grok-R2` (`e73544da-…`) on a **shadow-only** child/comment path, OR
   - Harness: `/Users/glad0s/paperclip/benchmark/` with R2 file + grok-4.5, skills none
3. Comment on **TSR-4709 only**:
   - order id
   - incumbent recommendation + top concerns
   - R2 recommendation + top concerns
   - agreement / divergence one-liner
4. Never attach R2 output to customer delivery.

## Done

3 logged orders + summary (agreement rate, material divergences) → mark TSR-4709 done → wake TSR-4704 for **separate** paid-flip `request_confirmation` (not auto-flip).
