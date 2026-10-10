# Examples

Each file runs against any SIP account. Node 22.18+ runs TypeScript directly:

```sh
export SIP_URL="tls://alice:secret@sip.example.com"
node examples/echo.ts
```

In this repo, run `bun run build` first, because the examples import `usestraw` like your app would. `STRAW_DEBUG=1` shows the SIP traffic.

| | |
| --- | --- |
| [`echo.ts`](echo.ts) | Plays callers back to themselves. Drains on Ctrl+C. |
| [`call.ts`](call.ts) | `node examples/call.ts "+49 30 1234567"` plays a short tune, or prints why nobody answered. |
| [`voicemail.ts`](voicemail.ts) | Beeps, records up to a minute, saves a WAV. |
| [`parrot.ts`](parrot.ts) | A voice agent without the AI: repeats you when you pause, stops when you interrupt. |
