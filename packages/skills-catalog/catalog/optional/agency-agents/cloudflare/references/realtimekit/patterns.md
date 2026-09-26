# RealtimeKit Patterns

## UI Kit (Minimal Code)

```tsx
// React
import { RtkMeeting } from '@cloudflare/realtimekit-react-ui';
<RtkMeeting authToken="<token>" onLeave={() => console.log('Left')} />

// Angular
@Component({ template: `<rtk-meeting [authToken]="authToken" (rtkLeave)="onLeave($event)"></rtk-meeting>` })
export class AppComponent { authToken = '<token>'; onLeave(event: unknown) {} }

// HTML/Web Components
<script type="module" src="https://cdn.jsdelivr.net/npm/@cloudflare/realtimekit-ui/dist/realtimekit-ui/realtimekit-ui.esm.js"></script>
<rtk-meeting id="meeting"></rtk-meeting>
<script>document.getElementById('meeting').authToken = '<token>';</script>
```

## UI Components

RealtimeKit provides 133+ pre-built Stencil.js Web Components with framework wrappers:

### Layout Components
- `<RtkMeeting>` - Full meeting UI (all-in-one)
- `<RtkHeader>`, `<RtkStage>`, `<RtkControlbar>` - Layout sections
- `<RtkSidebar>` - Chat/participants sidebar
- `<RtkGrid>` - Adaptive video grid

### Control Components  
- `<RtkMicToggle>`, `<RtkCameraToggle>` - Media controls
- `<RtkScreenShareToggle>` - Screen sharing
- `<RtkLeaveButton>` - Leave meeting
- `<RtkSettingsModal>` - Device settings

### Grid Variants
- `<RtkSpotlightGrid>` - Active speaker focus
- `<RtkAudioGrid>` - Audio-only mode
- `<RtkPaginatedGrid>` - Paginated layout

**See full catalog**: https://docs.realtime.cloudflare.com/ui-kit

## Core SDK Patterns

### Basic Setup
```typescript
import RealtimeKitClient from '@cloudflare/realtimekit';

const meeting = new RealtimeKitClient({ authToken, video: true, audio: true });
meeting.self.on('roomJoined', () => console.log('Joined:', meeting.meta.meetingTitle));
meeting.participants.joined.on('participantJoined', (p) => console.log(`${p.name} joined`));
await meeting.join();
```

### Video Grid & Device Selection
```typescript
// Video grid
function VideoGrid({ meeting }) {
  const [participants, setParticipants] = useState([]);
  useEffect(() => {
    const update = () => setParticipants(meeting.participants.joined.toArray());
    meeting.participants.joined.on('participantJoined', update);
    meeting.participants.joined.on('participantLeft', update);
    update();
    return () => { meeting.participants.joined.off('participantJoined', update); meeting.participants.joined.off('participantLeft', update); };
  }, [meeting]);
  return <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
    {participants.map(p => <VideoTile key={p.id} participant={p} />)}
  </div>;
}

function VideoTile({ participant }) {
  const videoRef = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (videoRef.current && participant.videoTrack) videoRef.current.srcObject = new MediaStream([participant.videoTrack]);
  }, [participant.videoTrack]);
  return <div><video ref={videoRef} autoPlay playsInline muted /><div>{participant.name}</div></div>;
}

// Device selection
const devices = await meeting.self.getAllDevices();
const switchCamera = (deviceId: string) => {
  const device = devices.find(d => d.deviceId === deviceId);
  if (device) await meeting.self.setDevice(device);
};
```

## React Hooks (Official)

```typescript
import { useRealtimeKitClient, useRealtimeKitSelector } from '@cloudflare/realtimekit-react-ui';

function MyComponent() {
  const [meeting, initMeeting] = useRealtimeKitClient();
  const audioEnabled = useRealtimeKitSelector(m => m.self.audioEnabled);
  const participantCount = useRealtimeKitSelector(m => m.participants.joined.size());
  
  useEffect(() => { initMeeting({ authToken: '<token>' }); }, []);
  
  return <div>
    <button onClick={() => meeting?.self.enableAudio()}>{audioEnabled ? 'Mute' : 'Unmute'}</button>
    <span>{participantCount} participants</span>
  </div>;
}
```

**Benefits:** Automatic re-renders, memoized selectors, type-safe

## Waitlist Handling

```typescript
// Monitor waitlist
meeting.participants.waitlisted.on('participantJoined', (participant) => {
  console.log(`${participant.name} is waiting`);
  // Show admin UI to approve/reject
});

// Approve from waitlist (backend only)
await fetch(
  `https://api.cloudflare.com/client/v4/accounts/${accountId}/realtime/kit/${appId}/meetings/${meetingId}/active-session/waitlist/approve`,
  {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${apiToken}` },
    body: JSON.stringify({ user_ids: [participant.userId] })
  }
);

// Client receives automatic transition when approved
meeting.self.on('roomJoined', () => console.log('Approved and joined'));
```

## Audio-Only Mode

```typescript
const meeting = new RealtimeKitClient({
  authToken: '<token>',
  video: false,  // Disable video
  audio: true,
  mediaConfiguration: {
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  }
});

// Use audio grid component
import { RtkAudioGrid } from '@cloudflare/realtimekit-react-ui';
<RtkAudioGrid meeting={meeting} />
```

## Addon System

```typescript
// List available addons
meeting.plugins.all.forEach(plugin => {
  console.log(plugin.id, plugin.name, plugin.active);
});

// Activate collaborative app
await meeting.plugins.activate('whiteboard-addon-id');

// Listen for activations
meeting.plugins.on('pluginActivated', ({ plugin }) => {
  console.log(`${plugin.name} activated`);
});

// Deactivate
await meeting.plugins.deactivate();
```

## Backend Integration

### Token Generation (Workers)
```typescript
export interface Env { CLOUDFLARE_API_TOKEN: string; CLOUDFLARE_ACCOUNT_ID: string; REALTIMEKIT_APP_ID: string; }

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    
    if (url.pathname === '/api/join-meeting') {
      const { meetingId, userName, presetName } = await request.json();
      const response = await fetch(
        `https://api.cloudflare.com/client/v4/accounts/${env.CLOUDFLARE_ACCOUNT_ID}/realtime/kit/${env.REALTIMEKIT_APP_ID}/meetings/${meetingId}/participants`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${env.CLOUDFLARE_API_TOKEN}` },
          body: JSON.stringify({ name: userName, preset_name: presetName })
        }
      );
      const data = await response.json();
      return Response.json({ authToken: data.result.authToken });
    }
    
    return new Response('Not found', { status: 404 });
  }
};
```

## Best Practices

### Security
1. **Never expose API tokens client-side** - Generate participant tokens server-side only
2. **Don't reuse participant tokens** - Generate fresh token per session, use refresh endpoint if expired
3. **Use custom participant IDs** - Map to your user system for cross-session tracking

### Performance
1. **Event-driven updates** - Listen to events, don't poll. Use `toArray()` only when needed
2. **Media quality constraints** - Set appropriate resolution/bitrate limits based on network conditions
3. **Device management** - Enable `autoSwitchAudioDevice` for better UX, handle device list updates

### Architecture
1. **Separate Apps for environments** - staging vs production to prevent data mixing
2. **Preset strategy** - Create presets at App level, reuse across meetings
3. **Token management** - Backend generates tokens, frontend receives via authenticated endpoint

## In This Reference
- [README.md](README.md) - Overview, core concepts, quick start
- [configuration.md](configuration.md) - SDK config, presets, wrangler setup
- [api.md](api.md) - Client SDK APIs, REST endpoints
- [gotchas.md](gotchas.md) - Common issues, troubleshooting, limits
