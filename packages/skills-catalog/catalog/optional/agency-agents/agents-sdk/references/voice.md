# Voice (Experimental)

Fetch https://developers.cloudflare.com/agents/api-reference/voice/ for complete documentation.

`@cloudflare/voice` — real-time speech-to-text and text-to-speech for agents. Audio streams over WebSocket.

```bash
npm install @cloudflare/voice
```

## Server

```typescript
import { Agent } from "agents";
import { withVoice, WorkersAITTS, WorkersAINova3STT } from "@cloudflare/voice";

export class VoiceAgent extends withVoice(Agent)<Env> {
  transcriber = new WorkersAINova3STT(this);
  tts = new WorkersAITTS(this);

  async onTurn(transcript: string, context: VoiceTurnContext) {
    const result = streamText({
      model: createWorkersAI({ binding: this.env.AI })("@cf/meta/llama-4-scout-17b-16e-instruct"),
      messages: [
        { role: "system", content: "You are a voice assistant." },
        ...context.conversationHistory,
        { role: "user", content: transcript }
      ]
    });

    for await (const chunk of result.textStream) {
      if (context.signal.aborted) break;
      context.speak(chunk);
    }
  }
}
```

## Lifecycle Hooks

| Hook | Purpose |
|------|---------|
| `onTurn(transcript, ctx)` | Handle transcribed speech (required) |
| `beforeCallStart(conn)` | Auth/validation before call starts |
| `onCallStart(conn)` | Call connected |
| `onCallEnd(conn)` | Call disconnected |
| `onInterrupt()` | User interrupted agent speech |

## Client (React)

```tsx
import { useVoiceAgent } from "@cloudflare/voice/react";

function VoiceUI() {
  const { isConnected, isSpeaking, connect, disconnect } = useVoiceAgent({
    agent: "VoiceAgent",
    name: "session-1"
  });

  return <button onClick={isConnected ? disconnect : connect}>
    {isConnected ? "End Call" : "Start Call"}
  </button>;
}
```

## STT/TTS Providers

Workers AI (default), Deepgram, ElevenLabs — install the provider package and swap the `transcriber`/`tts` properties.
