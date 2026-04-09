# Exemplo: File Browser

Este pacote em `examples/` deve ser usado como base de aprendizado e scaffold.

O plugin operacional first-party correspondente agora vive em:

```text
packages/plugins/workspace-explorer
```

Se a intenção for habilitar exploração e edição de arquivos no produto, use o pacote real.

## Pacote real correspondente

- nome: `@goldneuron/plugin-workspace-explorer`
- caminho: `./packages/plugins/workspace-explorer`
- função: navegar workspaces, editar arquivos e abrir referências vindas de comentários

## Quando usar este diretório

- estudar como um plugin integra tabs, sidebar e ações contextuais
- copiar como ponto de partida para um explorador de arquivos customizado
- comparar o exemplo com a implementação operacional real

## Instalação do plugin real

```bash
pnpm --filter @goldneuron/plugin-workspace-explorer build
pnpm paperclipai plugin install ./packages/plugins/workspace-explorer
```

## Maintainer

- Instagram: @monrars
- Site: goldneuron.io
- GitHub: @monrars1995

## License

Distributed under the repository MIT license. See `/Users/monrars/paperclip/LICENSE`.
