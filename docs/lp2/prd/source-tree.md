# Source Tree — AIOX Landing Page v2

**Gerado por:** @pax (Document Sharding)
**Data:** 2026-03-28

## Estrutura de Arquivos

```
landing-v2/
├── index.html          # Página principal — todo o conteúdo
├── styles.css          # CSS separado (opcional se inline ficar grande)
└── assets/             # Assets estáticos (se necessário)
    └── (vazio no MVP — usar emoji e CSS puro)
```

## Arquivos a Criar

| Arquivo | Responsável | Story |
|---------|-------------|-------|
| `landing-v2/index.html` | @dex | 1.1 (base) + 1.2-3.1 (conteúdo) |
| `vercel.json` (update) | @gage | 3.1 (routing) |

## Arquivos a NÃO Modificar

- `landing/index.html` — LP1 existente, não tocar
- `landing/vercel.json` — config original
- Qualquer arquivo fora de `landing-v2/`
