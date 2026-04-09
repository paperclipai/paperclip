# Pulso da Empresa

Pulso da Empresa é um plugin interno de dashboard que entrega um resumo operacional enxuto para a empresa selecionada.

## O que ele adiciona

- widget de dashboard com leitura direta do estado da empresa
- contagem de projetos, issues totais e issues abertas
- visibilidade rápida sobre metas e agentes ativos
- resumo curto para triagem diária do operador

## Superfície de dados

- `getData company-pulse` carrega os totais atuais de:
  - projetos
  - issues e issues abertas
  - metas e metas ativas
  - agentes e agentes ativos
- o widget é descoberto e renderizado pelo host via `GET /api/plugins/ui-contributions`

## Instalação local

```bash
pnpm --filter @goldneuron/plugin-company-pulse build
pnpm paperclipai plugin install ./packages/plugins/company-pulse
```

## Instalação por npm

```bash
pnpm paperclipai plugin install @goldneuron/plugin-company-pulse
```

## Notas

- construa o plugin antes de instalar para garantir que `dist/worker.js` exista
- em produção, prefira publicar o pacote npm em vez de depender do caminho local do monorepo
- se um install antigo ainda apontar para o exemplo legado, reinicie o host para a sincronização automática atualizar package name, manifest e caminho do pacote

## Responsável

- Instagram: @monrars
- Site: goldneuron.io
- GitHub: @monrars1995

## Licença

Distribuído sob a licença MIT do repositório. Veja `/Users/monrars/paperclip/LICENSE`.
