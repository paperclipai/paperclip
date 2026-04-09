# Central de Operações

A Central de Operações é um plugin interno de primeira parte construído como cockpit operacional real para operadores do Paperclip.

Hoje ele entrega:

- rota operacional dedicada
- shell principal com guias por contexto operacional
- seções colapsáveis com ícones de expandir e recolher para abrir e fechar blocos densos sob demanda
- iconografia consistente aplicada aos botões, ações rápidas, toggles e controles contextuais do plugin
- hero e visão geral limpos, sem metadados internos expostos ao operador
- submenu `AGhouse` dentro da Central na sidebar para abrir direto a vista espacial
- aba `AGhouse` redesenhada com HUD compacto, mapa dominante e avatares mais fortes
- widget de dashboard e superfícies na barra lateral
- visões operacionais de projeto e issue
- superfícies de captura de comentários
- diagnósticos, estado, métricas, atividade e streams
- intake e follow-up de issues via ações, ferramentas e webhooks
- notas de workspace e diagnósticos locais controlados para projetos selecionados

O pacote agora vive em `packages/plugins/central-operacoes` e usa o nome `@goldneuron/plugin-central-operacoes`. O identificador técnico do plugin continua compatível com instalações já existentes para evitar reinstalações manuais.

## Instalação

```sh
pnpm --filter @goldneuron/plugin-central-operacoes build
pnpm paperclipai plugin install ./packages/plugins/central-operacoes
```

Ou instale a versão publicada por npm:

```sh
pnpm paperclipai plugin install @goldneuron/plugin-central-operacoes
```

Ou instale pelo gerenciador de plugins do produto para consumir o pacote npm da Goldneuron.

## Notas

- O acesso ao workspace local e os diagnósticos de processo são restritos a ambientes confiáveis e usam comandos controlados por padrão.
- O intake por webhook pode criar uma issue de follow-up quando o payload inclui `companyId` e `title`, com `projectId` e `description` opcionais.
- A página de configurações controla quais superfícies operacionais ficam visíveis e se os diagnósticos locais ficam habilitados.
- Installs legados que ainda apontem para `packages/plugins/examples/plugin-kitchen-sink-example` passam a ser sincronizados automaticamente na inicialização do host.

## Responsável

- Instagram: @monrars
- Site: goldneuron.io
- GitHub: @monrars1995

## Licença

Distribuído sob a licença MIT deste repositório. Veja `/Users/monrars/paperclip/LICENSE`.
