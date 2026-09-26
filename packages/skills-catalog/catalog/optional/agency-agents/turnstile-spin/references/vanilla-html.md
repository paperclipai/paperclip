# Vanilla HTML

For static sites or any project without a JS framework. The widget renders client-side; the form submits to whatever backend handles your form (a Node/PHP/Ruby/Go server, a Cloudflare Worker, a Pages Function, a third-party form host that supports server-side hooks, etc.).

```html
<!doctype html>
<html>
	<head>
		<script
			src="https://challenges.cloudflare.com/turnstile/v0/api.js"
			async
			defer
		></script>
	</head>
	<body>
		<form action="/api/subscribe" method="POST">
			<input name="email" type="email" required />
			<div
				class="cf-turnstile"
				data-sitekey="YOUR_SITEKEY"
				data-action="subscribe"
			></div>
			<button type="submit">Subscribe</button>
		</form>
	</body>
</html>
```

When the form submits, the browser includes `cf-turnstile-response` automatically. Your backend reads it and calls canonical siteverify.

## Backend (any language)

Add this to your existing `/api/subscribe` handler before the rest of its logic:

```js
// Node / fetch idiom
const expectedHostnames = new Set(
	(process.env.TURNSTILE_HOSTNAMES ?? '')
		.split(',')
		.map((h) => h.trim())
		.filter(Boolean),
);
if (expectedHostnames.size === 0) return res.status(403).end();

const token = req.body['cf-turnstile-response'];
const r = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
	method: 'POST',
	headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
	body: new URLSearchParams({
		secret: process.env.TURNSTILE_SECRET,
		response: token,
		remoteip: req.ip,
	}),
});
const result = await r.json();
if (
	r.ok !== true ||
	result.success !== true ||
	result.action !== 'subscribe' ||
	!expectedHostnames.has(result.hostname)
) {
	return res.status(403).end();
}
// existing handler logic runs here
```

Equivalent calls in other backend languages (each also compares `result.hostname` to a `TURNSTILE_HOSTNAMES` allowlist):

```ruby
# Ruby
require 'net/http'; require 'uri'; require 'json'; require 'set'
expected_hostnames = (ENV['TURNSTILE_HOSTNAMES'] || '').split(',').map(&:strip).reject(&:empty?).to_set
halt 403 if expected_hostnames.empty?
res = Net::HTTP.post_form(URI('https://challenges.cloudflare.com/turnstile/v0/siteverify'),
  secret: ENV['TURNSTILE_SECRET'], response: params['cf-turnstile-response'], remoteip: request.ip)
result = JSON.parse(res.body)
halt 403 unless res.is_a?(Net::HTTPSuccess) && result['success'] == true && result['action'] == 'subscribe' && expected_hostnames.include?(result['hostname'])
```

```python
# Python (requests)
expected_hostnames = {h.strip() for h in os.environ.get('TURNSTILE_HOSTNAMES', '').split(',') if h.strip()}
if not expected_hostnames:
    return '', 403
r = requests.post('https://challenges.cloudflare.com/turnstile/v0/siteverify',
    data={'secret': os.environ['TURNSTILE_SECRET'],
          'response': form['cf-turnstile-response'],
          'remoteip': request.remote_addr})
result = r.json()
if (not r.ok or result.get('success') is not True or result.get('action') != 'subscribe'
        or result.get('hostname') not in expected_hostnames):
    return '', 403
```

`subscribe` is the stable action for this surface. Preserve an existing custom migration action and compare the returned action to the same value. Siteverify is mandatory for every widget mode, including pre-clearance. Set `TURNSTILE_HOSTNAMES` to the deployment-specific frontend hostnames; a production value must not include `localhost` or `127.0.0.1`.

## Variant: AJAX submit instead of form action

For an AJAX flow, replace the native form and API script with explicit rendering. Keep this surface's widget ID and reset it in `finally`, which covers network, JSON, validation, and server failures as well as successful same-page completion.

```html
<form id="subscribe-form">
	<input name="email" type="email" required />
	<div id="subscribe-turnstile"></div>
	<button type="submit">Subscribe</button>
</form>
<script>
	let subscribeWidgetId;

	window.onSubscribeTurnstileLoad = () => {
		subscribeWidgetId = window.turnstile.render("#subscribe-turnstile", {
			sitekey: "YOUR_SITEKEY",
			action: "subscribe",
		});
	};

	document.getElementById("subscribe-form").addEventListener("submit", async (event) => {
		event.preventDefault();
		try {
			const res = await fetch("/api/subscribe", {
				method: "POST",
				body: new FormData(event.currentTarget),
			});
			const json = await res.json();
			if (!res.ok || json.ok !== true) throw new Error("Submission failed");
			// proceed
		} catch {
			// surface the error
		} finally {
			if (subscribeWidgetId !== undefined) {
				window.turnstile.reset(subscribeWidgetId);
			}
		}
	});
</script>
<script
	src="https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onSubscribeTurnstileLoad&render=explicit"
	async
	defer
></script>
```

## No backend?

If your project is pure-static (no server-side handler — just HTML served from a CDN), Spin doesn't apply. Siteverify is server-side by design. Options:

- Add a Cloudflare Pages Function (`functions/api/subscribe.js`) to host the siteverify call.
- Deploy a tiny Cloudflare Worker that does siteverify against your existing form host.
- Use a third-party form host that exposes a server-side webhook where you can wire siteverify.

## Substitutions

| Placeholder         | Replace with                                                         |
| ------------------- | -------------------------------------------------------------------- |
| `YOUR_SITEKEY`      | The widget site key from Step 8                                      |
| `/api/subscribe`    | The path to your existing form-handling endpoint                     |
| `TURNSTILE_SECRET`  | Env-var name. Value is the secret captured in Step 8, kept off disk. |
