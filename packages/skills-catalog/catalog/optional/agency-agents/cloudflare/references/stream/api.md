# Stream API Reference

Read the task-specific documentation for request schemas, SDK examples, and response fields. For live inputs and outputs, use [api-live.md](./api-live.md).

| Task | Read |
|---|---|
| Issue a one-time upload URL to an end user | [Direct creator uploads](https://developers.cloudflare.com/stream/uploading-videos/direct-creator-uploads/) |
| Resume uploads or handle unreliable connections | [Resumable uploads and requirements](https://developers.cloudflare.com/stream/uploading-videos/resumable-uploads/) |
| Import a video already hosted elsewhere | [Upload via link](https://developers.cloudflare.com/stream/uploading-videos/upload-via-link/) |
| Embed an iframe or React player | [Use the Stream Player](https://developers.cloudflare.com/stream/viewing-videos/using-the-stream-player/) |
| Use HLS/DASH with an existing player | [Use your own player](https://developers.cloudflare.com/stream/viewing-videos/using-own-player/) |
| Issue playback tokens | [Signed URLs and token-generation choices](https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream/#three-ways-to-generate-signed-tokens) |
| Generate previews or downloadable files | [Thumbnails](https://developers.cloudflare.com/stream/viewing-videos/displaying-thumbnails/) and [downloads](https://developers.cloudflare.com/stream/viewing-videos/download-videos/) |
| Upload captions or generate them with Stream | [Add captions](https://developers.cloudflare.com/stream/edit-videos/adding-captions/) |
| Apply branding during upload | [Watermarks](https://developers.cloudflare.com/stream/edit-videos/applying-watermarks/) |
| Trim an on-demand video | [Video clipping](https://developers.cloudflare.com/stream/edit-videos/video-clipping/) |
| List and filter videos through the REST API | [List videos](https://developers.cloudflare.com/api/resources/stream/methods/list/) |
| Manage videos from a Worker | [Stream binding methods](https://developers.cloudflare.com/stream/manage-video-library/bindings/#methods) |
| React to encoding success or failure | [Video webhooks](https://developers.cloudflare.com/stream/manage-video-library/using-webhooks/) |

Keep the returned video UID associated with the application's owning user or record. Treat upload completion and playback readiness as separate application states; see [workflow decisions](./patterns.md).
