# Exemplo: Hello World Widget

Este pacote permanece em `examples/` apenas como referência histórica e template mínimo.

O plugin first-party real derivado dele agora vive em:

```text
packages/plugins/company-pulse
```

Se a intenção for usar o widget operacional do produto, instale o pacote real e não este exemplo.

## Pacote real correspondente

- nome: `@goldneuron/plugin-company-pulse`
- caminho: `./packages/plugins/company-pulse`
- função: widget operacional de dashboard com resumo da empresa

## Quando usar este diretório

- estudar a menor estrutura possível de um plugin Paperclip
- copiar como base para criar um plugin novo
- comparar evolução entre scaffold e plugin first-party real

## Instalação do plugin real

```bash
pnpm --filter @goldneuron/plugin-company-pulse build
pnpm paperclipai plugin install ./packages/plugins/company-pulse
```

## Maintainer

- Instagram: @monrars
- Site: goldneuron.io
- GitHub: @monrars1995

## License

Distributed under the repository MIT license. See `/Users/monrars/paperclip/LICENSE`.
