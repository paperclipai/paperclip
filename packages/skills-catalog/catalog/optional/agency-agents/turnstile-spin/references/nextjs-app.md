# Next.js (App Router)

For `app/`-directory Next.js projects. The widget needs to run on the client, so the page or component must be `"use client"`. The siteverify call lives server-side, either in a Server Action or an API route.

```tsx title="app/signup/page.tsx"
"use client";
import Script from "next/script";
import { type FormEvent, useRef, useState } from "react";

type TurnstileWidgetId = string;
type TurnstileApi = {
	render: (
		container: HTMLElement,
		options: {
			sitekey: string;
			action: string;
			callback: (token: string) => void;
		},
	) => TurnstileWidgetId;
	reset: (widgetId: TurnstileWidgetId) => void;
};

declare global {
	interface Window {
		turnstile: TurnstileApi;
	}
}

export default function SignupPage() {
	const turnstileContainer = useRef<HTMLDivElement>(null);
	const signupWidgetId = useRef<TurnstileWidgetId | null>(null);
	const [token, setToken] = useState("");

	function renderTurnstile() {
		if (!turnstileContainer.current || signupWidgetId.current !== null) return;
		signupWidgetId.current = window.turnstile.render(turnstileContainer.current, {
			sitekey: "YOUR_SITEKEY",
			action: "signup",
			callback: setToken,
		});
	}

	async function handleSubmit(e: FormEvent<HTMLFormElement>) {
		e.preventDefault();
		try {
			const res = await fetch("/api/signup", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token }),
			});
			const data = await res.json();
			if (!res.ok || data.ok !== true) throw new Error("Submission failed");
			// proceed
		} catch {
			// surface the error
		} finally {
			if (signupWidgetId.current !== null) {
				window.turnstile.reset(signupWidgetId.current);
				setToken("");
			}
		}
	}

	return (
		<>
			<Script
				src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
				strategy="afterInteractive"
				onReady={renderTurnstile}
			/>
			<form onSubmit={handleSubmit}>
				<input name="email" type="email" required />
				<div ref={turnstileContainer} />
				<button type="submit" disabled={!token}>
					Sign up
				</button>
			</form>
		</>
	);
}
```

Explicit rendering returns the widget ID for this surface. The `finally` block resets that ID after network, JSON, validation, server, or successful same-page completion.

API route (canonical siteverify):

```ts title="app/api/signup/route.ts"
const expectedHostnames = new Set(
	(process.env.TURNSTILE_HOSTNAMES ?? "")
		.split(",")
		.map((h) => h.trim())
		.filter(Boolean),
);

export async function POST(req: Request) {
	const { token } = await req.json();
	const remoteip = req.headers.get("x-forwarded-for") ?? undefined;

	if (expectedHostnames.size === 0) {
		return new Response("forbidden", { status: 403 });
	}

	const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			secret: process.env.TURNSTILE_SECRET!,
			response: token,
			...(remoteip ? { remoteip } : {}),
		}),
	});
	const result = await r.json();
	if (
		r.ok !== true ||
		result.success !== true ||
		result.action !== "signup" ||
		!expectedHostnames.has(result.hostname)
	) {
		return new Response("forbidden", { status: 403 });
	}

	// existing signup logic runs here
	return Response.json({ ok: true });
}
```

`signup` is the stable action for this surface. Preserve an existing custom migration action and compare the returned action to the same value. Siteverify is mandatory for every widget mode, including pre-clearance. Set `TURNSTILE_HOSTNAMES` to the deployment-specific frontend hostnames; a production value must not include `localhost` or `127.0.0.1`.

## Variant: Server Action

If you are using Server Actions, do the siteverify call from the action itself. The widget still goes in a client component, but the verify call moves server-side:

```tsx title="app/signup/actions.ts"
"use server";
import { headers } from "next/headers";

export type SignupState = { ok?: true; error?: string } | null;

const expectedHostnames = new Set(
	(process.env.TURNSTILE_HOSTNAMES ?? "")
		.split(",")
		.map((h) => h.trim())
		.filter(Boolean),
);

export async function submitSignup(
	_previousState: SignupState,
	formData: FormData,
): Promise<SignupState> {
	const token = formData.get("cf-turnstile-response");
	if (typeof token !== "string") return { error: "Verification failed" };
	if (expectedHostnames.size === 0) return { error: "Verification failed" };
	const remoteip = (await headers()).get("x-forwarded-for") ?? undefined;

	const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			secret: process.env.TURNSTILE_SECRET!,
			response: token,
			...(remoteip ? { remoteip } : {}),
		}),
	});
	const result = await r.json();
	if (
		r.ok !== true ||
		result.success !== true ||
		result.action !== "signup" ||
		!expectedHostnames.has(result.hostname)
	) {
		return { error: "Verification failed" };
	}

	// process signup
	return { ok: true };
}
```

```tsx title="app/signup/page.tsx (server-action variant)"
"use client";
import Script from "next/script";
import { useActionState, useRef, useState } from "react";
import { submitSignup, type SignupState } from "./actions";

type TurnstileWidgetId = string;
type TurnstileApi = {
	render: (
		container: HTMLElement,
		options: {
			sitekey: string;
			action: string;
			callback: (token: string) => void;
		},
	) => TurnstileWidgetId;
	reset: (widgetId: TurnstileWidgetId) => void;
};

declare global {
	interface Window {
		turnstile: TurnstileApi;
	}
}

export default function SignupPage() {
	const turnstileContainer = useRef<HTMLDivElement>(null);
	const signupActionWidgetId = useRef<TurnstileWidgetId | null>(null);
	const [token, setToken] = useState("");
	const [state, action, pending] = useActionState(
		async (previousState: SignupState, formData: FormData) => {
			try {
				return await submitSignup(previousState, formData);
			} finally {
				if (signupActionWidgetId.current !== null) {
					window.turnstile.reset(signupActionWidgetId.current);
					setToken("");
				}
			}
		},
		null,
	);

	function renderTurnstile() {
		if (!turnstileContainer.current || signupActionWidgetId.current !== null) return;
		signupActionWidgetId.current = window.turnstile.render(
			turnstileContainer.current,
			{
				sitekey: "YOUR_SITEKEY",
				action: "signup",
				callback: setToken,
			},
		);
	}

	return (
		<>
			<Script
				src="https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit"
				strategy="afterInteractive"
				onReady={renderTurnstile}
			/>
			<form action={action}>
				<input name="email" type="email" required />
				<div ref={turnstileContainer} />
				{state?.error && <p role="alert">{state.error}</p>}
				<button type="submit" disabled={!token || pending}>
					Sign up
				</button>
			</form>
		</>
	);
}
```

Server Actions can return state without navigating. This wrapper accepts `previousState` before `FormData` and resets the retained widget ID in `finally`, including validation, server, and network failures.

## Substitutions

| Placeholder         | Replace with                                                         |
| ------------------- | -------------------------------------------------------------------- |
| `YOUR_SITEKEY`      | The widget site key from Step 8                                      |
| `TURNSTILE_SECRET`  | Env-var name. Value is the secret captured in Step 8, kept off disk. |
