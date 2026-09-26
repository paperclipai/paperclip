# Pages Functions Request Design

Choose where behavior belongs before adapting an example.

| Task | Documentation |
| --- | --- |
| Share authentication, logging, and error handling | [Middleware](https://developers.cloudflare.com/pages/functions/middleware/) |
| Choose request handlers and asynchronous completion behavior | [API reference](https://developers.cloudflare.com/pages/functions/api-reference/) |
| Keep asset requests outside Function invocation where appropriate | [Routing](https://developers.cloudflare.com/pages/functions/routing/) |
| Use custom or framework-generated routing | [Advanced mode](https://developers.cloudflare.com/pages/functions/advanced-mode/) |
| Integrate storage or another service | [Bindings](https://developers.cloudflare.com/pages/functions/bindings/) |
| Exercise the assembled application locally | [Local development](https://developers.cloudflare.com/pages/functions/local-development/) |

Define the response owner and middleware scope before adding authentication or response transformations. Test protected routes, rejected requests, and static fallbacks together. Choose consistency and concurrency requirements before using storage for session state or rate limiting; a generic read-modify-write example is not a complete policy.

See [Pages project decisions](../pages/patterns.md) for framework and migration work.
