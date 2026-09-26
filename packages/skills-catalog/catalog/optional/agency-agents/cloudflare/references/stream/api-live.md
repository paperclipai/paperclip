# Stream Live Streaming API

Choose the ingest protocol and viewer experience before creating live inputs. Read the current examples for returned endpoints and credentials instead of constructing publish URLs from an input ID.

| Task | Read |
|---|---|
| Create an RTMPS/SRT input and connect an encoder | [Start a live stream](https://developers.cloudflare.com/stream/stream-live/start-stream-live/) |
| Update inputs, recording, retention, or stream keys | [Manage live inputs](https://developers.cloudflare.com/stream/stream-live/start-stream-live/#manage-live-inputs) |
| Choose persistent-channel playback versus a particular video | [View by live input ID or video ID](https://developers.cloudflare.com/stream/stream-live/watch-live-stream/#view-by-live-input-id-or-video-id) |
| Find and replay recorded broadcasts | [Replay recordings](https://developers.cloudflare.com/stream/stream-live/replay-recordings/) |
| Forward broadcasts to external platforms | [Simulcasting configuration and limits](https://developers.cloudflare.com/stream/stream-live/simulcasting/) |
| Receive connection and disconnection notifications | [Live webhooks](https://developers.cloudflare.com/stream/stream-live/webhooks/) |
| Publish and play using WHIP/WHEP | [WebRTC requirements and endpoints](https://developers.cloudflare.com/stream/webrtc-beta/) and [browser integration](https://developers.cloudflare.com/stream/examples/browser-based-webrtc/) |
| Diagnose encoder, buffering, or latency problems | [Live troubleshooting](https://developers.cloudflare.com/stream/stream-live/troubleshooting/) |

Keep publishing credentials separate from viewer playback data. Decide whether the application stores a reusable live input, individual recording IDs, or both. Route recording processing events through [video webhooks](https://developers.cloudflare.com/stream/manage-video-library/using-webhooks/); live connection events have their own notification setup.

See [configuration.md](./configuration.md) for access decisions and [patterns.md](./patterns.md) for application state handling.
