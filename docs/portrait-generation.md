# Agent Portrait Generation (GLASSHOUSE identity layer)

> Spec for the **runtime/server session**. The design session defined the look,
> the model choice, and the prompt template; the generation pipeline + storage
> touch secrets and the DB, so they belong to the runtime side. UI consumes the
> stored `portraitUrl` via `<AgentPortrait>` (see `ui/src/components/AgentPortrait.tsx`).

## What this is
Every agent has a **generated character portrait** that is its visual identity
across the roster, the org chart, and its office (the direct-chat space). Portraits
are **unique per agent, per tenant company** — a company's roster looks like its own
team. Until a portrait exists, `<AgentPortrait src={null}>` falls back to the
animated eyes face, so generation can be async / best-effort.

## Model decision
**Google Imagen 4.0 Fast** (`imagen-4.0-fast-generate-001`) via the Gemini API.

Why this one, decided empirically against the available keys (2026-06-04):
- The **OpenRouter key in `shared.env` is dead** (401 "User not found") — do not route
  through it until a fresh key is provisioned.
- The Gemini key is **denied for the older `gemini-2.5-flash-image`** model
  specifically (403 PERMISSION_DENIED), but **`imagen-4.0-fast-generate-001` and
  `gemini-3.1-flash-image` both work** on it.
- Imagen 4.0 Fast is purpose-built text-to-image: fast, ~$0.02–0.04/image, clean
  square output, strong at consistent stylized-realistic portraits. Good default.
- Use **`gemini-3.1-flash-image`** instead when you need character *consistency or
  editing* across a roster (it accepts a reference image; Imagen is one-shot).

### Endpoint
```
POST https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-fast-generate-001:predict?key=$GEMINI_API_KEY
Content-Type: application/json

{ "instances": [{ "prompt": "<persona> . <STYLE_SUFFIX>" }],
  "parameters": { "sampleCount": 1, "aspectRatio": "1:1" } }
```
Response: `predictions[0].bytesBase64Encoded` (PNG, base64). Decode → store.

## Prompt template
```
<PERSONA>. 3D rendered stylized-realistic character portrait, Pixar / Unreal-engine
render quality, soft subsurface-scattering skin, head and shoulders, facing camera,
soft cinematic studio lighting with a subtle cool rim light, plain dark charcoal
background, centered square composition, professional, dignified, no text, no logo,
no watermark.
```

`<PERSONA>` is generated per agent from its role + name + a **diversity directive**.

### Diversity default (tenant-configurable)
The default identity pool for ValAdrien.DEV's roster is **people of color —
Caribbean and Latin American**. Bake this into the persona unless the tenant
overrides it in company settings. Vary age, gender, and features across the roster
so the team feels real, not cloned. Example personas actually used for the seed set:

| Agent | Role | Persona seed |
|---|---|---|
| Ti Claude | CEO | Haitian-Caribbean woman, late 40s, deep brown skin, silver-streaked coily hair, charcoal blazer |
| Sol | Founding Engineer | Afro-Latino man, late 20s, warm brown skin, curly black hair, glasses, dark tee |
| Markét | Growth | Dominican Latina woman, early 30s, light brown skin, dark wavy hair, smart-casual blazer |
| Augur | Analyst | Afro-Caribbean man, 50s, dark brown skin, greying beard, glasses, dark sweater |
| Quill | QA | Black woman, late 20s, brown skin, coily hair with a subtle teal streak, dark collared shirt |
| Finch | Bookkeeper | Latino man, early 60s, tan brown skin, grey beard, glasses, charcoal cardigan |

Keep the **STYLE_SUFFIX identical** across a roster so the company reads as one
coherent set. The dark charcoal background is deliberate — portraits drop into the
GLASSHOUSE dark UI without a halo.

## Pipeline
1. **Trigger:** on agent create (and a "regenerate portrait" action). Async job —
   never block agent creation on the image.
2. **Build persona:** role + name + tenant diversity directive → `<PERSONA>`.
3. **Generate:** call Imagen 4.0 Fast (above). Retry once on 5xx; on hard failure
   leave `portraitUrl` null (UI shows the eyes fallback) and log.
4. **Store:** decode base64 → upload to the tenant's asset bucket (Supabase Storage,
   path `companies/<companyId>/agents/<agentId>.png`) → persist the public/signed URL
   on the agent row as `portraitUrl`. Scope by `company_id` like every other row.
5. **Serve:** UI reads `agent.portraitUrl` → `<AgentPortrait src={portraitUrl} … />`.

## Secrets
`GEMINI_API_KEY` (works for Imagen 4.0). Currently only in
`~/.management-os/env/shared.env`; migrate into ValAdrien OS Secrets + the Railway
runtime, and provision a fresh `OPENROUTER_API_KEY` only if you want the OpenRouter
route. **Rotate** the shared keys per the standing security note.

## Cost
~$0.02–0.04 per portrait (Imagen 4.0 Fast). A 6-agent company ≈ $0.12–0.24 one-time,
plus regenerations. Negligible; no batching needed.

## Reference call (bash, verified working 2026-06-04)
```bash
curl -s "https://generativelanguage.googleapis.com/v1beta/models/imagen-4.0-fast-generate-001:predict?key=$GEMINI_API_KEY" \
  -H 'Content-Type: application/json' \
  -d "$(jq -n --arg p "$PERSONA. $STYLE_SUFFIX" \
        '{instances:[{prompt:$p}],parameters:{sampleCount:1,aspectRatio:"1:1"}}')" \
  | jq -r '.predictions[0].bytesBase64Encoded' | base64 -d > agent.png
```
