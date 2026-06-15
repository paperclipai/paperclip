# Connector and Model Framework

## Purpose

Define how the SINK DINK Media Factory will connect tools, models, and future services without needing a separate automation platform.

## Connector categories

### 1. Internal connectors

- Paperclip tasks
- Paperclip subtasks
- Paperclip routines
- Paperclip artifacts
- Paperclip approvals
- Paperclip activity logs

### 2. Repository connector

- GitHub code and documentation
- renderer files
- skill files
- templates
- version history

### 3. Storage connectors

Future optional targets:

- Google Drive
- local workspace storage
- cloud object storage

### 4. Media connectors

Future optional targets:

- image generation
- voice generation
- subtitle generation
- video rendering
- design template rendering

### 5. Publishing connectors

Publishing should stay manual first.

Future publishing connectors may be added only after approval and testing.

## Model routing policy

### CEO model

Handles:

- planning
- task routing
- quality decisions
- system improvement decisions

### Research model

Handles:

- trend study
- audience questions
- competitor pattern study

### Writing model

Handles:

- hooks
- scripts
- carousel text
- captions

### QA model

Handles:

- factual checks
- brand fit
- mobile readability
- upload readiness

### Coding model

Handles:

- renderer implementation
- workflow scripts
- plugin work

## Routing rule

Use the strongest available model only for high-impact planning, code, or final QA. Use cheaper/faster models for drafts and repetitive formatting.

## Safety rules

- Do not expose private credentials.
- Do not add public publishing without approval.
- Do not connect paid tools without approval.
- Keep every connector replaceable.
- Keep final output reviewable by the user.
