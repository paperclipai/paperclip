# C3 Usage Patterns

## Quick Workflows

For framework apps, follow [Framework Setup](README.md#framework-setup).

```bash
# TypeScript API Worker
npm create cloudflare@latest my-api -- --type=hello-world --lang=ts --deploy

# Astro static site  
npm create cloudflare@latest my-blog -- --type=web-app --framework=astro --platform=pages --ts
```

## CI/CD (GitHub Actions)

```yaml
- name: Deploy
  run: npm run deploy
  env:
    CLOUDFLARE_API_TOKEN: ${{ secrets.CLOUDFLARE_API_TOKEN }}
    CLOUDFLARE_ACCOUNT_ID: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
```

**Non-interactive requires:**
```bash
--type=<value>       # Required
--no-git             # Recommended (CI already in git)
--no-deploy          # Deploy separately with secrets
--framework=<value>  # For web-app
--ts / --no-ts       # Required
```

## Monorepo

C3 detects workspace config (`package.json` workspaces or `pnpm-workspace.yaml`).

```bash
cd packages/
npm create cloudflare@latest my-worker -- --type=hello-world --lang=ts --no-deploy
```

## Custom Templates

```bash
# GitHub repo
npm create cloudflare@latest -- --template=username/repo
npm create cloudflare@latest -- --template=cloudflare/templates/worker-openapi

# Local path
npm create cloudflare@latest my-app -- --template=../my-template
```

**Template requires `c3.config.json`:**
```json
{
  "name": "my-template",
  "category": "hello-world",
  "copies": [{ "path": "src/" }, { "path": "wrangler.jsonc" }],
  "transforms": [{ "path": "package.json", "jsonc": { "name": "{{projectName}}" }}]
}
```

## Existing Projects

```bash
# Add Cloudflare to existing Worker
npm create cloudflare@latest . -- --type=pre-existing --existing-script=./dist/index.js
```

For existing framework apps, follow [Framework Setup](README.md#framework-setup).

## Post-Creation Checklist

1. Review `wrangler.jsonc` - set `compatibility_date`, verify `name`
2. Create bindings: `wrangler kv namespace create`, `wrangler d1 create`, `wrangler r2 bucket create`
3. Generate types: `npm run cf-typegen`
4. Test: `npm run dev`
5. Deploy: `npm run deploy`
6. Set secrets: `wrangler secret put SECRET_NAME`
