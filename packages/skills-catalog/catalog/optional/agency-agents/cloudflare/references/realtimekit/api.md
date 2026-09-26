# RealtimeKit API Reference

Complete API reference for Meeting object, REST endpoints, and SDK methods.

## Meeting Object API

### `meeting.self` - Local Participant

```typescript
// Properties: id, userId, name, audioEnabled, videoEnabled, screenShareEnabled, audioTrack, videoTrack, screenShareTracks, roomJoined, roomState
// Methods
await meeting.self.enableAudio() / disableAudio() / enableVideo() / disableVideo() / enableScreenShare() / disableScreenShare()
await meeting.self.setName("Name")  // Before join only
await meeting.self.setDevice(device)
const devices = await meeting.self.getAllDevices() / getAudioDevices() / getVideoDevices() / getSpeakerDevices()
// Events: 'roomJoined', 'audioUpdate', 'videoUpdate', 'screenShareUpdate', 'deviceUpdate', 'deviceListUpdate'
meeting.self.on('roomJoined', () => {})
meeting.self.on('audioUpdate', ({ audioEnabled, audioTrack }) => {})
```

### `meeting.participants` - Remote Participants

**Collections**:
```typescript
meeting.participants.joined / active / waitlisted / pinned  // Maps
const participants = meeting.participants.joined.toArray()
const count = meeting.participants.joined.size()
const p = meeting.participants.joined.get('peer-id')
```

**Participant Properties**:
```typescript
participant.id / userId / name
participant.audioEnabled / videoEnabled / screenShareEnabled
participant.audioTrack / videoTrack / screenShareTracks
```

**Events**:
```typescript
meeting.participants.joined.on('participantJoined', (participant) => {})
meeting.participants.joined.on('participantLeft', (participant) => {})
```

### `meeting.meta` - Metadata
```typescript
meeting.meta.meetingId / meetingTitle / meetingStartedTimestamp
```

### `meeting.chat` - Chat
```typescript
meeting.chat.messages  // Array
await meeting.chat.sendTextMessage("Hello") / sendImageMessage(file)
meeting.chat.on('chatUpdate', ({ message, messages }) => {})
```

### `meeting.polls` - Polling
```typescript
meeting.polls.items  // Array
await meeting.polls.create(question, options, anonymous, hideVotes)
await meeting.polls.vote(pollId, optionIndex)
```

### `meeting.plugins` - Collaborative Apps
```typescript
meeting.plugins.all  // Array
await meeting.plugins.activate(pluginId) / deactivate()
```

### `meeting.ai` - AI Features
```typescript
meeting.ai.transcripts  // Live transcriptions (when enabled in Preset)
```

### Core Methods
```typescript
await meeting.join()   // Emits 'roomJoined' on meeting.self
await meeting.leave()
```

## TypeScript Types

```typescript
import type { RealtimeKitClient, States, UIConfig, Participant } from '@cloudflare/realtimekit';

// Main interface
interface RealtimeKitClient {
  self: SelfState;          // Local participant (id, userId, name, audioEnabled, videoEnabled, roomJoined, roomState)
  participants: { joined, active, waitlisted, pinned };  // Reactive Maps
  chat: ChatNamespace;      // messages[], sendTextMessage(), sendImageMessage()
  polls: PollsNamespace;    // items[], create(), vote()
  plugins: PluginsNamespace;  // all[], activate(), deactivate()
  ai: AINamespace;          // transcripts[]
  meta: MetaState;          // meetingId, meetingTitle, meetingStartedTimestamp
  join(): Promise<void>;
  leave(): Promise<void>;
}

// Participant (self & remote share same shape)
interface Participant {
  id: string;                      // Peer ID (changes on rejoin)
  userId: string;                  // Persistent participant ID
  name: string;
  audioEnabled: boolean;
  videoEnabled: boolean;
  screenShareEnabled: boolean;
  audioTrack: MediaStreamTrack | null;
  videoTrack: MediaStreamTrack | null;
  screenShareTracks: MediaStreamTrack[];
}
```

## Store Architecture

RealtimeKit uses reactive store (event-driven updates, live Maps):

```typescript
// Subscribe to state changes
meeting.self.on('audioUpdate', ({ audioEnabled, audioTrack }) => {});
meeting.participants.joined.on('participantJoined', (p) => {});

// Access current state synchronously
const isAudioOn = meeting.self.audioEnabled;
const count = meeting.participants.joined.size();
```

**Key principles:** State updates emit events after changes. Use `.toArray()` sparingly. Collections are live Maps.

## REST API

Base: `https://api.cloudflare.com/client/v4/accounts/{account_id}/realtime/kit/{app_id}`

### Meetings
```bash
GET    /meetings                                    # List all
GET    /meetings/{meeting_id}                       # Get details
POST   /meetings                                    # Create: {"title": "..."}
PATCH  /meetings/{meeting_id}                       # Update: {"title": "...", "record_on_start": true}
```

### Participants
```bash
GET    /meetings/{meeting_id}/participants                          # List all
GET    /meetings/{meeting_id}/participants/{participant_id}         # Get details
POST   /meetings/{meeting_id}/participants                          # Add: {"name": "...", "preset_name": "...", "custom_participant_id": "..."}
PATCH  /meetings/{meeting_id}/participants/{participant_id}         # Update: {"name": "...", "preset_name": "..."}
DELETE /meetings/{meeting_id}/participants/{participant_id}         # Delete
POST   /meetings/{meeting_id}/participants/{participant_id}/token   # Refresh token
```

### Active Session
```bash
GET  /meetings/{meeting_id}/active-session               # Get active session
POST /meetings/{meeting_id}/active-session/kick          # Kick users: {"user_ids": ["id1", "id2"]}
POST /meetings/{meeting_id}/active-session/kick-all      # Kick all
POST /meetings/{meeting_id}/active-session/poll          # Create poll: {"question": "...", "options": [...], "anonymous": false}
```

### Recording
```bash
GET  /recordings?meeting_id={meeting_id}                 # List recordings
GET  /recordings/active-recording/{meeting_id}           # Get active recording
POST /recordings                                         # Start: {"meeting_id": "...", "type": "composite"} (or "track")
PUT  /recordings/{recording_id}                          # Control: {"action": "pause"} (or "resume", "stop")
POST /recordings/track                                   # Track recording: {"meeting_id": "...", "layers": [...]}
```

### Livestreaming
```bash
GET  /livestreams?exclude_meetings=false                                # List all
GET  /livestreams/{livestream_id}                                       # Get details
POST /meetings/{meeting_id}/livestreams                                 # Start for meeting
POST /meetings/{meeting_id}/active-livestream/stop                      # Stop
POST /livestreams                                                       # Create independent: returns {ingest_server, stream_key, playback_url}
```

### Sessions & Analytics
```bash
GET  /sessions                                                          # List all
GET  /sessions/{session_id}                                             # Get details
GET  /sessions/{session_id}/participants                                # List participants
GET  /sessions/{session_id}/participants/{participant_id}               # Call stats
GET  /sessions/{session_id}/chat                                        # Download chat CSV
GET  /sessions/{session_id}/transcript                                  # Download transcript CSV
GET  /sessions/{session_id}/summary                                     # Get summary
POST /sessions/{session_id}/summary                                     # Generate summary
GET  /analytics/daywise?start_date=YYYY-MM-DD&end_date=YYYY-MM-DD      # Day-wise analytics
GET  /analytics/livestreams/overall                                     # Livestream analytics
```

### Webhooks
```bash
GET    /webhooks                    # List all
POST   /webhooks                    # Create: {"url": "https://...", "events": ["session.started", "session.ended"]}
PATCH  /webhooks/{webhook_id}       # Update
DELETE /webhooks/{webhook_id}       # Delete
```

## Session Lifecycle

```
Initialization → Join Intent → [Waitlist?] → Meeting Screen (Stage) → Ended
                                   ↓ Approved
                               [Rejected → Ended]
```

UI Kit handles state transitions automatically.

## See Also

- [Configuration](./configuration.md) - Setup and installation
- [Patterns](./patterns.md) - Usage examples
- [README](./README.md) - Overview and quick start
