# Hugo

For Hugo static sites. The widget renders on any page that includes the partial; siteverify happens at whatever backend handles your form submissions (a Cloudflare Pages Function, a Worker, an external API, or a form host with a server-side hook).

```html title="layouts/partials/turnstile.html"
<script
	src="https://challenges.cloudflare.com/turnstile/v0/api.js"
	async
	defer
></script>

<form action="{{ .Site.Params.turnstileFormEndpoint }}" method="POST">
	<input name="email" type="email" required />
	<div
		class="cf-turnstile"
		data-sitekey="{{ .Site.Params.turnstileSitekey }}"
		data-action="subscribe"
	></div>
	<button type="submit">Subscribe</button>
</form>
```

Add the params to your site config:

```toml title="hugo.toml"
[params]
turnstileSitekey = "YOUR_SITEKEY"
turnstileFormEndpoint = "/api/subscribe"  # path to your existing form handler
```

Reference the partial from any layout or content file:

```text
{{ partial "turnstile.html" . }}
```

## Backend (where siteverify lives)

Hugo doesn't host server-side code, so the form endpoint must live elsewhere. Two common setups:

**Cloudflare Pages Function** (`functions/api/subscribe.js`):

```js
export async function onRequestPost({ request, env }) {
	const form = await request.formData();
	const token = form.get("cf-turnstile-response");

	const expectedHostnames = new Set(
		(env.TURNSTILE_HOSTNAMES ?? "")
			.split(",")
			.map((h) => h.trim())
			.filter(Boolean),
	);
	if (expectedHostnames.size === 0) {
		return new Response("forbidden", { status: 403 });
	}

	const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			secret: env.TURNSTILE_SECRET,
			response: token,
			remoteip: request.headers.get("CF-Connecting-IP"),
		}),
	});
	const result = await r.json();
	if (
		r.ok !== true ||
		result.success !== true ||
		result.action !== "subscribe" ||
		!expectedHostnames.has(result.hostname)
	) {
		return new Response("forbidden", { status: 403 });
	}

	// process subscribe
	return new Response("ok");
}
```

`subscribe` is the stable action for this surface. Preserve an existing custom migration action and compare the returned action to the same value. Siteverify is mandatory for every widget mode, including pre-clearance. Set `TURNSTILE_HOSTNAMES` to the deployment-specific frontend hostnames; a production value must not include `localhost` or `127.0.0.1`.

After the user approves a canonical absolute `WRANGLER_BIN` outside the project, set the secret with `(set +x; printf '%s' "$WIDGET_SECRET" | "$WRANGLER_BIN" pages secret put TURNSTILE_SECRET)` (or use the dashboard's Pages → your project → Settings → Environment variables → Add secret).

**External backend**: any Node/Ruby/Python/Go handler can do the same call. See the [vanilla-html reference](./vanilla-html.md) for non-Cloudflare-specific snippets.

## Variant: shortcode for content files

If you want to drop the widget into Markdown content (not just layouts), create a shortcode:

```html title="layouts/shortcodes/turnstile-form.html"
{{ partial "turnstile.html" . }}
```

Use in content:

```markdown title="content/contact.md"
---
title: Contact
---

Contact us:

{{< turnstile-form >}}
```

## Substitutions

| Placeholder              | Replace with                                                         |
| ------------------------ | -------------------------------------------------------------------- |
| `YOUR_SITEKEY`           | The widget site key from Step 8                                      |
| `turnstileFormEndpoint`  | The path or URL to your form handler (Pages Function, Worker, etc.)  |
| `TURNSTILE_SECRET`       | Env-var name in your backend. Value is the secret captured in Step 8.|
