# Auto-hospedagem do papermarketing

Preparação para testes nos próprios projetos. Nenhum comando de deploy é
executado pela aplicação ou pela CI deste fork. Esta composição usa o estágio
`production` do Dockerfile upstream, PostgreSQL separado e volumes persistentes.
O núcleo não exige conta Paperclip Cloud, WordPress, GA4 ou Composio.

## Pré-requisitos

- Host Linux x64, Docker Engine e plugin Docker Compose v2.
- O build usa Node 24 e compila o Runner em Rust dentro do contêiner Debian
  Trixie, compatível com a exigência de glibc do Runner.
- Reservar inicialmente 4 CPUs, 8 GB de RAM e 20 GB de disco para o build;
  esta é uma estimativa de partida, não uma medição de capacidade.
- Acesso à internet para dependências de build e, quando configurados,
  provedores LLM e conectores.

## Preparar sem iniciar serviços

Na raiz do repositório, com Node 24 disponível:

```sh
node docker/papermarketing/init-env.mjs
docker compose --env-file docker/papermarketing/.env -f docker/papermarketing/compose.yaml config --quiet
docker compose --env-file docker/papermarketing/.env -f docker/papermarketing/compose.yaml build app
```

O gerador cria três segredos independentes e não sobrescreve `.env` existente.
Não publicar esse arquivo. O Compose não recebe chaves LLM globais. Modelo,
conta e método de autenticação são configurados por agente na interface.
O código mantém os nomes internos `PAPERCLIP_*` por compatibilidade.

## Iniciar futuramente, quando autorizado

```sh
docker compose --env-file docker/papermarketing/.env -f docker/papermarketing/compose.yaml up -d
docker compose --env-file docker/papermarketing/.env -f docker/papermarketing/compose.yaml ps
```

Abrir `http://localhost:3100`, criar a conta local e concluir **Claim this instance**
na primeira instalação autenticada privada. O serviço fica ligado somente a
`127.0.0.1`; para testar em uma VPS, usar túnel SSH até o navegador. Uma futura
exposição pública requer URL pública, TLS no proxy e o fluxo de bootstrap
descrito em [Deployment modes](../../doc/DEPLOYMENT-MODES.md). Não trocar
para `local_trusted` para disponibilizar pela internet.

Criar dois workspaces com nomes e conteúdos distintos. Em cada um, cadastrar
agentes por tipo, revisar o perfil e configurar contas separadamente. Fechar
o cadastro antes de conectar uma conta mantém o agente em configuração, sem
execução. Criar projetos e tarefas não exige CMS ou plataforma de publicação.

## Persistência, atualização e recuperação

O volume `database` guarda o PostgreSQL. O volume `application` guarda arquivos,
instruções, configurações e material de autenticação gerenciado pelo upstream.
Preservar ambos e `.env`; um dump do banco sozinho não é um backup completo.
As migrações existentes são aplicadas no início. Este primeiro incremento não
adiciona tabelas: o perfil de marketing usa metadados validados do agente.

Antes de atualizar, pausar o aplicativo e produzir um conjunto consistente.
Exemplo para shell Linux, a partir de `docker/papermarketing`:

```sh
umask 077
mkdir -p backups
docker compose stop app
docker compose exec -T db pg_dump -U papermarketing -d papermarketing -Fc > backups/database.dump
docker compose run --rm --no-deps --entrypoint sh app -c 'tar -C /paperclip -czf - .' > backups/application.tar.gz
cp .env backups/instance.env
```

Guardar esse conjunto cifrado fora do host. Para testar restauração, usar outra
instalação vazia, copiar o `.env` do backup e restaurar o volume da aplicação e
o dump antes de iniciar o aplicativo. Não restaurar sobre dados em uso.

```sh
docker compose up -d db
docker compose exec -T db pg_restore -U papermarketing -d papermarketing --exit-on-error < backups/database.dump
docker compose run --rm --no-deps -T --entrypoint sh app -c 'tar -C /paperclip -xzf -' < backups/application.tar.gz
docker compose up -d app
```

Confirmar login, workspaces, agentes, instruções e arquivos após a restauração.
Para uma atualização, registrar o commit, fazer backup, atualizar
`PAPERCLIP_BUILD_COMMIT` em `.env`, reconstruir e iniciar. Uma reversão que
envolva migrações exige a imagem anterior e o conjunto de backup correspondente.

## Limites desta primeira composição

O banco separado e as permissões por `companyId` não isolam processos de agentes.
Runtimes locais podem executar no mesmo contêiner da aplicação, que possui acesso
ao banco e ao volume. Não usar este pacote para agentes de usuários não confiáveis.
O isolamento de trabalhadores por workspace, sem credenciais do servidor e sem
acesso a diretórios de outros workspaces, continua uma etapa de qualificação antes
de declarar o MVP completo. Não há montagem do socket Docker nesta composição.

O caminho comum de subprocessos remove `DATABASE_URL` e `BETTER_AUTH_SECRET`
herdados do servidor. Isso evita a transmissão implícita dessas duas credenciais;
não impede acesso ao sistema de arquivos ou a outros processos do mesmo host.
Uma conexão explicitamente configurada para o agente continua sendo transmitida.

Contas de assinatura devem ser conectadas apenas pelos métodos suportados pelo
provedor e pelo harness. A existência de uma opção de login não comprova consumo
pela assinatura. Validar isso com as próprias contas no teste posterior. OpenRouter
e DeepSeek podem cobrar créditos de API; não há promessa de assinatura de chat
equivalente. Geração de imagem e vídeo depende das ferramentas conectadas.

O build de imagem, o primeiro boot e a restauração devem ser homologados em Linux.
Consultar o relatório do incremento para distinguir verificações executadas de
passos preparados. A telemetria upstream fica desabilitada nesta composição.

## Qualificação automatizada, sem deploy

O workflow `papermarketing qualification` executa a suíte Vitest completa em
partições, typecheck, build e a imagem `production`. A imagem é carregada apenas
no runner temporário do GitHub; não há publicação em registro nem deploy.

O teste `scripts/papermarketing/image-smoke.mjs` exige explicitamente o projeto
Compose `papermarketing-qualification` e `PAPERMARKETING_TEST_ONLY=1`. Cria dados
artificiais, usuários, dois workspaces, chaves de agente e os 12 tipos de marketing;
verifica permissões, referências a segredos e persistência após reiniciar o banco
e o aplicativo. Os usuários de workspace não são administradores da instância.
Nenhuma conta LLM é conectada e nenhum modelo é invocado. Ao terminar, a CI
remove somente os contêineres e volumes desse projeto de teste.
