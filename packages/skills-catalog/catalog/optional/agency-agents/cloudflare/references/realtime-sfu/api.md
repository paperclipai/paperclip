# API Reference

## Authentication

```bash
curl -X POST 'https://rtc.live/v1/apps/${CALLS_APP_ID}/sessions/new' \
  -H "Authorization: Bearer ${CALLS_APP_SECRET}"
```

## Core Concepts

**Sessions:** PeerConnection to Cloudflare edge  
**Tracks:** Media/data channels (audio/video/datachannel)  
**No rooms:** Build presence via track sharing

## Client Libraries

**PartyTracks (Recommended):** Observable-based client library for production use. Handles device changes, network switches, ICE restarts automatically. Push/pull API with React hooks. See patterns.md for full examples.

```bash
npm install partytracks @cloudflare/calls
```

**Raw API:** Direct HTTP + WebRTC for custom requirements (documented below).

## Endpoints

### Create Session
```http
POST /v1/apps/{appId}/sessions/new
→ {sessionId, sessionDescription}
```

### Add Track (Publish)
```http
POST /v1/apps/{appId}/sessions/{sessionId}/tracks/new
Body: {
  sessionDescription: {sdp, type: "offer"},
  tracks: [{location: "local", trackName: "my-video"}]
}
→ {sessionDescription, tracks: [{trackName}]}
```

### Add Track (Subscribe)
```http
POST /v1/apps/{appId}/sessions/{sessionId}/tracks/new
Body: {
  tracks: [{
    location: "remote",
    trackName: "remote-track-id",
    sessionId: "other-session-id"
  }]
}
→ {sessionDescription} (server offer)
```

### Renegotiate
```http
PUT /v1/apps/{appId}/sessions/{sessionId}/renegotiate
Body: {sessionDescription: {sdp, type: "answer"}}
```

### Close Tracks
```http
PUT /v1/apps/{appId}/sessions/{sessionId}/tracks/close
Body: {tracks: [{trackName}]}
→ {requiresImmediateRenegotiation: boolean}
```

### Get Session
```http
GET /v1/apps/{appId}/sessions/{sessionId}
→ {sessionId, tracks: TrackMetadata[]}
```

## TypeScript Types

```typescript
interface TrackMetadata {
  trackName: string;
  location: "local" | "remote";
  sessionId?: string; // For remote tracks
  mid?: string; // WebRTC mid
}
```

## WebRTC Flow

```typescript
// 1. Create PeerConnection
const pc = new RTCPeerConnection({
  iceServers: [{urls: 'stun:stun.cloudflare.com:3478'}]
});

// 2. Add tracks
const stream = await navigator.mediaDevices.getUserMedia({video: true, audio: true});
stream.getTracks().forEach(track => pc.addTrack(track, stream));

// 3. Create offer
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);

// 4. Send to backend → Cloudflare API
const response = await fetch('/api/new-session', {
  method: 'POST',
  body: JSON.stringify({sdp: offer.sdp})
});

// 5. Set remote answer
const {sessionDescription} = await response.json();
await pc.setRemoteDescription(sessionDescription);
```

## Publishing

```typescript
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);

const res = await fetch(`/api/sessions/${sessionId}/tracks`, {
  method: 'POST',
  body: JSON.stringify({
    sdp: offer.sdp,
    tracks: [{location: 'local', trackName: 'my-video'}]
  })
});

const {sessionDescription, tracks} = await res.json();
await pc.setRemoteDescription(sessionDescription);
const publishedTrackId = tracks[0].trackName; // Share with others
```

## Subscribing

```typescript
const res = await fetch(`/api/sessions/${sessionId}/tracks`, {
  method: 'POST',
  body: JSON.stringify({
    tracks: [{location: 'remote', trackName: remoteTrackId, sessionId: remoteSessionId}]
  })
});

const {sessionDescription} = await res.json();
await pc.setRemoteDescription(sessionDescription);

const answer = await pc.createAnswer();
await pc.setLocalDescription(answer);

await fetch(`/api/sessions/${sessionId}/renegotiate`, {
  method: 'PUT',
  body: JSON.stringify({sdp: answer.sdp})
});

pc.ontrack = (event) => {
  const [remoteStream] = event.streams;
  videoElement.srcObject = remoteStream;
};
```
