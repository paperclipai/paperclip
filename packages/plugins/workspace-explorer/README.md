# Explorador de Workspace

Explorador de Workspace transforma o antigo file-browser em uma superfície real de trabalho para projetos com workspace conectado.

## O que ele adiciona

- link opcional de `Workspace` na navegação lateral do projeto
- aba de detalhe para explorar arquivos, editar conteúdo e criar pastas ou arquivos
- integração com comentários para abrir referências de arquivo direto no workspace

## Slots

| Slot | Tipo | Descrição |
|---|---|---|
| Workspace lateral | `projectSidebarItem` | Atalho opcional sob cada projeto |
| Workspace em aba | `detailTab` | Árvore de arquivos com editor responsivo |
| Links em comentário | `commentAnnotation` | Mostra links de arquivo extraídos do comentário |
| Ação em comentário | `commentContextMenuItem` | Abre o arquivo citado no workspace |

## Instalação local

```bash
pnpm --filter @goldneuron/plugin-workspace-explorer build
pnpm paperclipai plugin install ./packages/plugins/workspace-explorer
```

## Instalação por npm

```bash
pnpm paperclipai plugin install @goldneuron/plugin-workspace-explorer
```

## Notas

- construa o plugin antes do install para gerar `dist/worker.js`
- em produção, publique o pacote npm em vez de depender do caminho local do monorepo
- installs legados apontando para `packages/plugins/examples/...` passam a ser sincronizados para este pacote real na inicialização do host
- você ainda pode usar `paperclip-plugin-dev-server` para hot reload de UI durante desenvolvimento local

## Responsável

- Instagram: @monrars
- Site: goldneuron.io
- GitHub: @monrars1995

## Licença

Distribuído sob a licença MIT do repositório. Veja `/Users/monrars/paperclip/LICENSE`.
