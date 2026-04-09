# Exemplo: Kitchen Sink

Este diretório não deve mais ser tratado como o plugin operacional oficial.

Ele permanece em `examples/` apenas como referência histórica e como base para estudar um plugin Paperclip mais amplo, cobrindo página, widgets, ações, webhooks, jobs, streams e superfícies contextuais.

O plugin first-party real derivado dele agora vive em:

```text
packages/plugins/central-operacoes
```

## Pacote real correspondente

- nome: `@goldneuron/plugin-central-operacoes`
- caminho: `./packages/plugins/central-operacoes`
- função: cockpit operacional para intake, follow-up, automações, diagnósticos e coordenação de agentes

## Quando usar este diretório

- entender uma implementação extensa de plugin
- copiar trechos de manifest, worker e UI para um novo plugin
- comparar o exemplo legado com a versão first-party do produto

## Instalação do plugin real

```sh
pnpm --filter @goldneuron/plugin-central-operacoes build
pnpm paperclipai plugin install ./packages/plugins/central-operacoes
```

## Notas

- Instalações legadas que ainda apontem para este caminho de exemplo são sincronizadas automaticamente pelo host para o pacote real.
- O acesso ao workspace local e os diagnósticos de processo continuam restritos a ambientes confiáveis e usam comandos controlados por padrão.

## Responsável

- Instagram: @monrars
- Site: goldneuron.io
- GitHub: @monrars1995

## Licença

Distribuído sob a licença MIT deste repositório. Veja `/Users/monrars/paperclip/LICENSE`.
