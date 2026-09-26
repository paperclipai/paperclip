# Images Configuration

Inspect the project's Wrangler configuration, dependency versions, existing bindings, and credential storage before changing setup. Preserve its configuration format and generate binding types through its existing tooling.

| Task | Documentation |
|------|---------------|
| Add the optimization binding | [Binding setup](https://developers.cloudflare.com/images/optimization/binding/#setup) |
| Configure hosted-image management in a Worker | [Hosted binding setup](https://developers.cloudflare.com/images/storage/binding/#setup) |
| Choose local or remote development for the optimization binding | [Local binding development](https://developers.cloudflare.com/images/optimization/binding/#interact-with-your-images-binding-locally) |
| Upload through the dashboard or API | [Upload methods](https://developers.cloudflare.com/images/storage/upload-images/methods/) |
| Create named presets for hosted images | [Create predefined variants](https://developers.cloudflare.com/images/optimization/hosted-images/create-variants/) |
| Enable dynamic options for hosted-image URLs | [Enable flexible variants](https://developers.cloudflare.com/images/optimization/hosted-images/enable-flexible-variants/) |
| Find account hash and delivery URL components | [Serve uploaded images](https://developers.cloudflare.com/images/optimization/hosted-images/serve-uploaded-images/) |
| Configure private access and generate signed URLs | [Serve private images](https://developers.cloudflare.com/images/optimization/hosted-images/serve-private-images/) |
| Set hosted-image cache lifetime | [Browser TTL](https://developers.cloudflare.com/images/optimization/hosted-images/browser-ttl/) |

Keep API tokens and signing keys in the project's secret mechanism. Verify private-delivery requirements when choosing variants, and follow the documented signing procedure rather than maintaining a custom signing recipe here. Confirm that the selected local test mode covers the features being changed. Continue with [API selection](api.md) or [patterns](patterns.md).
