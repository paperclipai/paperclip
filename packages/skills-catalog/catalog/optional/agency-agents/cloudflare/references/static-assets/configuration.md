# Static Assets Configuration

Inspect the build script, output directory, Wrangler configuration, and any framework-generated deployment configuration first. Configure the files actually produced by the build, and identify which paths need Worker logic.

| Task | Documentation |
|------|---------------|
| Set the asset directory and exclude non-public files | [Directory](https://developers.cloudflare.com/workers/static-assets/binding/#directory) and [ignoring assets](https://developers.cloudflare.com/workers/static-assets/binding/#ignoring-assets) |
| Make assets available to Worker code | [Asset binding configuration](https://developers.cloudflare.com/workers/static-assets/binding/#binding) |
| Select paths that must run Worker logic before asset serving | [Worker-first configuration](https://developers.cloudflare.com/workers/static-assets/binding/#run_worker_first) |
| Configure SPA fallback and navigation behavior | [SPA configuration](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/#configuration) |
| Configure generated HTML and missing-page responses | [SSG configuration](https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/#configuration) |
| Choose canonical HTML URLs and trailing slash handling | [HTML handling modes](https://developers.cloudflare.com/workers/static-assets/routing/advanced/html-handling/) |
| Configure assets produced by the Cloudflare Vite plugin | [Vite asset configuration](https://developers.cloudflare.com/workers/vite-plugin/reference/static-assets/#configuration) |
| Configure static response headers or redirects | [Headers](https://developers.cloudflare.com/workers/static-assets/headers/) and [redirects](https://developers.cloudflare.com/workers/static-assets/redirects/) |

For Vite projects, inspect generated output before overriding asset paths. For protected routes, ensure that the selected routing configuration reaches the authorization logic before returning an asset. Use [patterns.md](patterns.md) to decide routing intent and [gotchas.md](gotchas.md) to verify it.
