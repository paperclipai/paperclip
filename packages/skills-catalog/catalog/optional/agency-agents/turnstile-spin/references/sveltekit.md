# SvelteKit

For SvelteKit projects. The widget renders in the page; siteverify is called from a SvelteKit form action (or a `+server.ts` endpoint) server-side.

```svelte title="src/routes/signup/+page.svelte"
<script>
	import { enhance } from "$app/forms";
	import { onMount } from "svelte";

	let turnstileContainer;
	let signupWidgetId;

	onMount(() => {
		const render = () => {
			signupWidgetId = window.turnstile.render(turnstileContainer, {
				sitekey: "YOUR_SITEKEY",
				action: "signup",
			});
			delete window.onSignupTurnstileLoad;
		};

		if (window.turnstile) {
			render();
			return;
		}

		window.onSignupTurnstileLoad = render;
		const script = document.createElement("script");
		script.src =
			"https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onSignupTurnstileLoad&render=explicit";
		script.async = true;
		document.head.appendChild(script);

		return () => {
			delete window.onSignupTurnstileLoad;
		};
	});
</script>

<form
	method="POST"
	use:enhance={() => {
		return async ({ result, update }) => {
			try {
				await update();
			} finally {
				if (result.type !== "redirect" && signupWidgetId !== undefined) {
					window.turnstile.reset(signupWidgetId);
				}
			}
		};
	}}
>
	<input name="email" type="email" required />
	<div bind:this={turnstileContainer}></div>
	<button type="submit">Sign up</button>
</form>
```

Form action (canonical siteverify):

```ts title="src/routes/signup/+page.server.ts"
import type { Actions } from "./$types";
import { fail } from "@sveltejs/kit";
import { TURNSTILE_SECRET, TURNSTILE_HOSTNAMES } from "$env/static/private";

const expectedHostnames = new Set(
	(TURNSTILE_HOSTNAMES ?? "")
		.split(",")
		.map((h) => h.trim())
		.filter(Boolean),
);

export const actions: Actions = {
	default: async ({ request, getClientAddress }) => {
		const data = await request.formData();
		const token = data.get("cf-turnstile-response");
		if (typeof token !== "string" || expectedHostnames.size === 0) {
			return fail(403, { error: "Verification failed" });
		}

		const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
			method: "POST",
			headers: { "Content-Type": "application/x-www-form-urlencoded" },
			body: new URLSearchParams({
				secret: TURNSTILE_SECRET,
				response: token,
				remoteip: getClientAddress(),
			}),
		});
		const result = await verify.json();
		if (
			verify.ok !== true ||
			result.success !== true ||
			result.action !== "signup" ||
			!expectedHostnames.has(result.hostname)
		) {
			return fail(403, { error: "Verification failed" });
		}

		// process signup
		return { ok: true };
	},
};
```

`signup` is the stable action for this surface. Preserve an existing custom migration action and compare the returned action to the same value. Siteverify is mandatory for every widget mode, including pre-clearance. Set `TURNSTILE_HOSTNAMES` to the deployment-specific frontend hostnames; a production value must not include `localhost` or `127.0.0.1`.

In `.env`:

```text
TURNSTILE_SECRET=YOUR_SECRET
```

The `$env/static/private` import enforces that the secret never reaches the client bundle.

## Variant: client-side fetch to an endpoint

If you need a JSON API rather than progressive-enhancement form post, use `+server.ts`:

```ts title="src/routes/api/signup/+server.ts"
import type { RequestHandler } from "./$types";
import { TURNSTILE_SECRET, TURNSTILE_HOSTNAMES } from "$env/static/private";

const expectedHostnames = new Set(
	(TURNSTILE_HOSTNAMES ?? "")
		.split(",")
		.map((h) => h.trim())
		.filter(Boolean),
);

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
	const { token } = await request.json();
	if (expectedHostnames.size === 0) {
		return new Response("forbidden", { status: 403 });
	}
	const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			secret: TURNSTILE_SECRET,
			response: token,
			remoteip: getClientAddress(),
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
	return new Response(JSON.stringify({ ok: true }), { status: 200 });
};
```

The explicit renderer above retains `signupWidgetId`. Reset it in `finally` when calling this endpoint so every completion path gets a fresh token:

```svelte
<script>
	async function submit(e) {
		e.preventDefault();
		try {
			const token = new FormData(e.currentTarget).get("cf-turnstile-response");
			const res = await fetch("/api/signup", {
				method: "POST",
				body: JSON.stringify({ token }),
			});
			const result = await res.json();
			if (!res.ok || result.ok !== true) throw new Error("Submission failed");
			// proceed
		} catch {
			// surface error
		} finally {
			if (signupWidgetId !== undefined) {
				window.turnstile.reset(signupWidgetId);
			}
		}
	}
</script>
```

## Substitutions

| Placeholder         | Replace with                                                         |
| ------------------- | -------------------------------------------------------------------- |
| `YOUR_SITEKEY`      | The widget site key from Step 8                                      |
| `YOUR_SECRET`       | The secret captured in Step 8. Stays in env, never inlined.          |
