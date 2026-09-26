# Static Assets Routing Patterns

Decide which requests need application logic before choosing configuration. Record expected behavior for public files, API paths, protected content, browser navigation, and missing URLs.

| Routing need | Documentation |
|--------------|---------------|
| Serve public assets with minimal Worker involvement | [Default Worker routing](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/) |
| Combine a SPA with API routes | [Advanced SPA routing control](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/#advanced-routing-control) |
| Require authentication or transform assets before serving | [Run Worker before each request](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/#run-worker-before-each-request) |
| Route an OAuth callback or selected dynamic paths to the Worker | [Run Worker first for selective paths](https://developers.cloudflare.com/workers/static-assets/routing/worker-script/#run-worker-first-for-selective-paths) |
| Select assets for locale or experiment variants | [Asset binding API](https://developers.cloudflare.com/workers/static-assets/binding/#runtime-api-reference) and [Worker-first routing](https://developers.cloudflare.com/workers/static-assets/binding/#run_worker_first) |
| Serve generated HTML with a custom 404 | [Custom 404 pages](https://developers.cloudflare.com/workers/static-assets/routing/static-site-generation/#custom-404-pages) |
| Apply static cache/security headers or redirects | [Custom headers](https://developers.cloudflare.com/workers/static-assets/headers/#custom-headers) and [redirects](https://developers.cloudflare.com/workers/static-assets/redirects/) |

Keep public asset paths eligible for direct serving when they do not need application logic. Ensure protected paths cannot bypass the authorization handler through an asset match or navigation fallback. For locale or experiment routing, map accepted variants to known build outputs and define a fallback explicitly.

Use [configuration.md](configuration.md) for setup and [gotchas.md](gotchas.md) for representative request checks.
