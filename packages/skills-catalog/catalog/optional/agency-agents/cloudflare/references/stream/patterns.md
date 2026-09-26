# Stream Patterns

Use the official workflow examples after identifying where the existing application handles authorization, video ownership, and processing state.

| Workflow | Read |
|---|---|
| Browser uploads through a server-issued URL | [Direct creator uploads](https://developers.cloudflare.com/stream/uploading-videos/direct-creator-uploads/) |
| Large or interruption-prone uploads | [Resumable uploads](https://developers.cloudflare.com/stream/uploading-videos/resumable-uploads/) |
| Update application state when processing completes | [Video webhooks](https://developers.cloudflare.com/stream/manage-video-library/using-webhooks/) and [upload progress tracking](https://developers.cloudflare.com/stream/uploading-videos/direct-creator-uploads/#track-upload-progress) |
| Verify an incoming processing notification | [Webhook authenticity](https://developers.cloudflare.com/stream/manage-video-library/using-webhooks/#verify-webhook-authenticity) |
| Embed playback in a React application | [Stream Player and framework integrations](https://developers.cloudflare.com/stream/viewing-videos/using-the-stream-player/) |
| Serve private videos | [Signed playback and signing examples](https://developers.cloudflare.com/stream/viewing-videos/securing-your-stream/) |
| Broadcast from a browser | [Browser-based WebRTC](https://developers.cloudflare.com/stream/examples/browser-based-webrtc/) |

## Application Decisions

- Check the user's permission before issuing upload URLs or playback tokens. Decide how uploaded video IDs map to application records and who may later view or delete them.
- Model uploading, processing, ready, and failed states in the UI. Use documented status and notification data; select retry and timeout policies to suit the application instead of assuming a fixed encoding deadline.
- Preserve the raw webhook request body for verification before applying state changes. Decide how the application's existing event handling reconciles notifications with stored video records.
- For live playback, decide whether viewers follow a channel across broadcasts or open a specific recording; see [live workflows](./api-live.md).

See [configuration.md](./configuration.md) for setup and [gotchas.md](./gotchas.md) for diagnosis.
