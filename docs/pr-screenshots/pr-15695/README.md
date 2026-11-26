# Notification avatar review

These Chromium screenshots render the production `ToastProvider` and `ToastViewport` with the app stylesheet. Both themes show a person notification and an agent notification. The person uses the existing Storybook sample profile image. The agent uses the existing `ceo-cliptoon.png` fixture through a mocked custom-avatar asset response.

These are isolated UI renders with synthetic task and actor data, not screenshots of a production account. The capture waits for both avatar images to load before taking each screenshot. The authenticated WebSocket path is covered separately in `server/src/__tests__/live-events-toast.test.ts`.

- [Light theme](notification-avatars-light.png)
- [Dark theme](notification-avatars-dark.png)
