# PATCHES.md — Rastreamento de Customizações

Todas as modificações feitas no código do Paperclip upstream são documentadas aqui.
Formato: `[DATA] ARQUIVO — MOTIVO — AUTOR`

## Upstream
- Repositório: https://github.com/paperclipai/paperclip
- Branch padrão upstream: master (não main)

## Customizações Ativas
Nenhuma ainda. Branch recém-criada.

## Processo de Sync com Upstream
```bash
git fetch upstream
git rebase upstream/master
# Resolver conflitos se houver
# Rodar testes de regressão
git push --force-with-lease origin factory/customizations
```
