# Paperclip — Deploy no Dokploy

> Fork do [paperclipai/paperclip](https://github.com/paperclipai/paperclip) com fixes para deploy em produção via Docker/Dokploy.

---

## O que foi corrigido neste fork

- **`Dockerfile`** — adicionado `COPY packages/plugins/sdk/package.json` no stage `deps` e build do `plugin-sdk` antes do server, corrigindo erro `TS2307: Cannot find module '@paperclipai/plugin-sdk'`
- **`docker-compose.quickstart.yml`** — substituído bind mount por volume nomeado + serviço `paperclip-init` para corrigir erro `EACCES: permission denied` no diretório `/paperclip`

---

## Pré-requisitos

- Dokploy instalado no VPS
- Banco PostgreSQL externo provisionado (recomendado — evita problemas com o Postgres embutido)
- Domínio apontando para o VPS

---

## Passo a passo no Dokploy

### 1. Criar o serviço

**New Project → Add Service → Compose**

- **Source:** Git → `https://github.com/wesleybpereira/paperclip`
- **Branch:** `master`
- **Compose file:** `docker-compose.quickstart.yml`

---

### 2. Variáveis de ambiente

Na aba **Environment**, configure:

```env
# URL pública do Paperclip (sem barra no final)
PAPERCLIP_PUBLIC_URL=https://pc.seudominio.com.br

# Hostname permitido (mesmo valor do domínio)
PAPERCLIP_ALLOWED_HOSTNAMES=pc.seudominio.com.br

# Segredo de autenticação — gere com: openssl rand -hex 32
BETTER_AUTH_SECRET=cole_aqui_o_resultado

# Banco de dados externo (recomendado)
# Pegue a connection string no serviço Postgres do Dokploy
DATABASE_URL=postgresql://usuario:senha@host:5432/paperclip

# Chaves de API dos agentes (podem ser configuradas depois no UI)
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
```

> **Importante:** o `DATABASE_URL` usa o nome interno do serviço Postgres no Dokploy como host (ex: `postgres` ou o nome que você deu ao serviço), não `localhost`.

---

### 3. Domínio

Na aba **Domains**:

- **Host:** `pc.seudominio.com.br`
- **Container Port:** `3100`
- **HTTPS:** ativado (Let's Encrypt)

---

### 4. Deploy

Clique em **Deploy** e aguarde o build. O build leva alguns minutos pois compila o TypeScript e a UI.

---

## Primeiro acesso (obrigatório após o primeiro deploy)

Após o container subir, acesse o **Docker Terminal** do serviço no Dokploy e rode:

```bash
cd /app && pnpm paperclipai onboard --yes
```

Aguarde finalizar. Depois rode:

```bash
cd /app && pnpm paperclipai auth bootstrap-ceo
```

Esse comando gera uma **URL de convite**. Copie e abra no navegador para criar a conta admin.

---

## Atualizações futuras

Quando o repositório original lançar uma nova versão:

```bash
# No seu terminal local, dentro do fork
git remote add upstream https://github.com/paperclipai/paperclip
git fetch upstream
git merge upstream/master

# Resolva conflitos no Dockerfile e docker-compose.quickstart.yml se necessário
# mantendo as linhas do fix do plugin-sdk e do volume nomeado

git push origin master
```

Depois clique em **Redeploy** no Dokploy.

> **Atenção no merge:** quando o repositório original corrigir o bug do plugin-sdk, o merge vai ser simples — só tomar cuidado para manter as duas linhas adicionadas no `Dockerfile` e o `docker-compose.quickstart.yml` corrigido (detalhes na seção abaixo).

---

## Estrutura dos fixes

### Dockerfile — linhas adicionadas

```dockerfile
# No stage deps — adicionado após os outros COPY de packages:
COPY packages/plugins/sdk/package.json packages/plugins/sdk/

# No stage build — adicionado antes do build da UI:
RUN pnpm --filter @paperclipai/plugin-sdk build
```

### docker-compose.quickstart.yml — mudanças

- Volume bind mount → volume nomeado `paperclip_data`
- Adicionado serviço `paperclip-init` (busybox) que corrige permissões antes de subir o app
- Adicionado `PAPERCLIP_ALLOWED_HOSTNAMES` nas envs
