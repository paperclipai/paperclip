# Astro

For Astro projects. The widget renders in a page; siteverify lives in an Astro Action, an API route, or a Pages Function. Astro frontmatter reads the sitekey from env at build time; the secret stays server-only.

```astro title="src/pages/signup.astro"
---
const SITEKEY = import.meta.env.PUBLIC_TURNSTILE_SITEKEY;
---

<html>
	<head>
		<script
			src="https://challenges.cloudflare.com/turnstile/v0/api.js"
			async
			defer
		></script>
	</head>
	<body>
		<form action="/api/signup" method="POST">
			<input name="email" type="email" required />
			<div
				class="cf-turnstile"
				data-sitekey={SITEKEY}
				data-action="signup"
			/>
			<button type="submit">Sign up</button>
		</form>
	</body>
</html>
```

In your `.env`:

```text
PUBLIC_TURNSTILE_SITEKEY=YOUR_SITEKEY
TURNSTILE_SECRET=YOUR_SECRET
```

The `PUBLIC_` prefix is mandatory for client-exposed variables in Astro. The secret has **no** prefix; it stays server-only.

## API route (canonical siteverify)

```ts title="src/pages/api/signup.ts"
import type { APIRoute } from "astro";

const expectedHostnames = new Set(
	(import.meta.env.TURNSTILE_HOSTNAMES ?? "")
		.split(",")
		.map((h) => h.trim())
		.filter(Boolean),
);

export const POST: APIRoute = async ({ request, clientAddress }) => {
	const form = await request.formData();
	const token = form.get("cf-turnstile-response");
	if (typeof token !== "string" || expectedHostnames.size === 0) {
		return new Response("forbidden", { status: 403 });
	}

	const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			secret: import.meta.env.TURNSTILE_SECRET,
			response: token,
			remoteip: clientAddress,
		}),
	});
	const result = await verify.json();
	if (
		verify.ok !== true ||
		result.success !== true ||
		result.action !== "signup" ||
		!expectedHostnames.has(result.hostname)
	) {
		return new Response("forbidden", { status: 403 });
	}

	// process signup
	return Response.json({ ok: true });
};
```

## Variant: Astro Actions

If the project uses Astro Actions, call siteverify from the action:

```ts title="src/actions/index.ts"
import { defineAction } from "astro:actions";
import { z } from "astro:schema";

const expectedHostnames = new Set(
	(import.meta.env.TURNSTILE_HOSTNAMES ?? "")
		.split(",")
		.map((h) => h.trim())
		.filter(Boolean),
);

export const server = {
	signup: defineAction({
		accept: "form",
		input: z.object({
			email: z.string().email(),
			"cf-turnstile-response": z.string(),
		}),
		handler: async (input, ctx) => {
			if (expectedHostnames.size === 0) throw new Error("Verification failed");
			const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
				method: "POST",
				headers: { "Content-Type": "application/x-www-form-urlencoded" },
				body: new URLSearchParams({
					secret: import.meta.env.TURNSTILE_SECRET,
					response: input["cf-turnstile-response"],
					remoteip: ctx.clientAddress,
				}),
			});
			const result = await verify.json();
			if (
				verify.ok !== true ||
				result.success !== true ||
				result.action !== "signup" ||
				!expectedHostnames.has(result.hostname)
			) {
				throw new Error("Verification failed");
			}
			// process signup
		},
	}),
};
```

`signup` is the stable action for this surface. Preserve an existing custom migration action and compare the returned action to the same value. Siteverify is mandatory for every widget mode, including pre-clearance. Set `TURNSTILE_HOSTNAMES` to the deployment-specific frontend hostnames; a production value must not include `localhost` or `127.0.0.1`.

For a client-side Astro Action, replace the native form and script with an explicit widget. Retain this surface's widget ID and reset it in `finally` after every same-page request completion:

```astro
<form id="signup-action-form">
	<input name="email" type="email" required />
	<div id="signup-action-turnstile" data-sitekey={SITEKEY}></div>
	<button type="submit">Sign up</button>
</form>
<script>
	import { actions } from "astro:actions";

	type TurnstileApi = {
		render: (
			container: HTMLElement,
			options: { sitekey: string; action: string },
		) => string;
		reset: (widgetId: string) => void;
	};

	const turnstileWindow = window as Window & { turnstile?: TurnstileApi };
	const form = document.getElementById("signup-action-form") as HTMLFormElement;
	const container = document.getElementById("signup-action-turnstile") as HTMLElement;
	let signupActionWidgetId: string | undefined;

	const renderWidget = () => {
		if (!turnstileWindow.turnstile) return;
		signupActionWidgetId = turnstileWindow.turnstile.render(container, {
			sitekey: container.dataset.sitekey!,
			action: "signup",
		});
	};

	if (turnstileWindow.turnstile) {
		renderWidget();
	} else {
		const script = document.createElement("script");
		script.src =
			"https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
		script.async = true;
		script.addEventListener("load", renderWidget, { once: true });
		document.head.appendChild(script);
	}

	form.addEventListener("submit", async (event) => {
		event.preventDefault();
		try {
			const { error } = await actions.signup(new FormData(form));
			if (error) throw error;
			// proceed
		} catch {
			// surface the error
		} finally {
			if (signupActionWidgetId !== undefined) {
				turnstileWindow.turnstile?.reset(signupActionWidgetId);
			}
		}
	});
</script>
```

## Substitutions

| Placeholder         | Replace with                                                         |
| ------------------- | -------------------------------------------------------------------- |
| `YOUR_SITEKEY`      | The widget site key from Step 8                                      |
| `YOUR_SECRET`       | The secret captured in Step 8. Stays in env, never inlined.          |
