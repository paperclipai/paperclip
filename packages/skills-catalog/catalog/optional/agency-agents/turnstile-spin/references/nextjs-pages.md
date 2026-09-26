# Next.js (Pages Router)

For older Next.js projects using `pages/` rather than `app/`. The widget renders client-side; siteverify lives in the API route.

```tsx title="pages/signup.tsx"
import Script from "next/script";

export default function SignupPage() {
	return (
		<>
			<Script src="https://challenges.cloudflare.com/turnstile/v0/api.js" />
			<form action="/api/signup" method="POST">
				<input name="email" type="email" required />
				<div
					className="cf-turnstile"
					data-sitekey="YOUR_SITEKEY"
					data-action="signup"
				/>
				<button type="submit">Sign up</button>
			</form>
		</>
	);
}
```

This native form navigates to the API response, so it does not need client-side reset code.

API route (canonical siteverify):

```ts title="pages/api/signup.ts"
import type { NextApiRequest, NextApiResponse } from "next";

const expectedHostnames = new Set(
	(process.env.TURNSTILE_HOSTNAMES ?? "")
		.split(",")
		.map((h) => h.trim())
		.filter(Boolean),
);

export default async function handler(
	req: NextApiRequest,
	res: NextApiResponse,
) {
	const token = req.body["cf-turnstile-response"] ?? req.body.token;
	if (expectedHostnames.size === 0) {
		return res.status(403).json({ error: "Verification failed" });
	}
	const remoteip =
		(req.headers["x-forwarded-for"] as string | undefined)?.split(",")[0] ??
		req.socket.remoteAddress;

	const verify = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
		method: "POST",
		headers: { "Content-Type": "application/x-www-form-urlencoded" },
		body: new URLSearchParams({
			secret: process.env.TURNSTILE_SECRET!,
			response: token,
			...(remoteip ? { remoteip } : {}),
		}),
	});
	const result = await verify.json();
	if (
		verify.ok !== true ||
		result.success !== true ||
		result.action !== "signup" ||
		!expectedHostnames.has(result.hostname)
	) {
		return res.status(403).json({ error: "Verification failed" });
	}
	// process signup
	return res.json({ ok: true });
}
```

`signup` is the stable action for this surface. Preserve an existing custom migration action and compare the returned action to the same value. Siteverify is mandatory for every widget mode, including pre-clearance. Set `TURNSTILE_HOSTNAMES` to the deployment-specific frontend hostnames; a production value must not include `localhost` or `127.0.0.1`.

## Substitutions

| Placeholder         | Replace with                                                         |
| ------------------- | -------------------------------------------------------------------- |
| `YOUR_SITEKEY`      | The widget site key from Step 8                                      |
| `TURNSTILE_SECRET`  | Env-var name. Value is the secret captured in Step 8, kept off disk. |
