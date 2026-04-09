# Central de Operações

A Central de Operações é um plugin interno de primeira parte construído sobre o antigo pacote `kitchen-sink`.

Hoje ele funciona como um cockpit operacional prático para operadores do Paperclip:

- rota operacional dedicada
- widget de dashboard e superfícies na barra lateral
- visões operacionais de projeto e issue
- superfícies de captura de comentários
- diagnósticos, estado, métricas, atividade e streams
- intake de issues via ações, ferramentas e webhooks
- notas de workspace e diagnósticos locais controlados

O pacote agora usa o nome `@paperclipai/plugin-central-operacoes`, enquanto o identificador técnico do plugin permanece compatível com instalações existentes. A UI e o worker agora atendem fluxos operacionais reais em vez de um demo genérico.

## Instalação

```sh
pnpm --filter @paperclipai/plugin-central-operacoes build
pnpm paperclipai plugin install ./packages/plugins/examples/plugin-kitchen-sink-example
```

Ou instale pelo gerenciador de plugins do Paperclip como exemplo embutido depois que este repositório estiver compilado.

## Notas

- O acesso ao workspace local e os diagnósticos de processo são restritos a ambientes confiáveis e usam comandos controlados por padrão.
- O intake por webhook pode criar uma issue de follow-up quando o payload inclui `companyId` e `title`, com `projectId` e `description` opcionais.
- A página de configurações controla quais superfícies operacionais ficam visíveis e se os diagnósticos locais ficam habilitados.

## Responsável

- Instagram: @monrars
- Site: goldneuron.io
- GitHub: @monrars1995

## Licença

Distribuído sob a licença MIT deste repositório. Veja `/Users/monrars/paperclip/LICENSE`.
