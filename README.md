# Straw

**SIP without the hangover.** Make and take phone calls from Node. The audio comes as Web Streams.

[![npm](https://img.shields.io/npm/v/usestraw)](https://www.npmjs.com/package/usestraw)
[![CI](https://github.com/NilsFreund/usestraw/actions/workflows/ci.yml/badge.svg)](https://github.com/NilsFreund/usestraw/actions/workflows/ci.yml)
[![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)](package.json)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

```ts
import { connect } from "usestraw"

const phone = await connect(process.env.SIP_URL) // tls://alice:secret@sip.example.com

for await (const call of phone.incoming) {
  void call.accept(new TransformStream()) // callers hear themselves
}
```

Replace the `TransformStream` with your voice agent and it answers the phone.

- Calls are plain data: `status`, `ok`, `reason`, `ended`.
- Audio is 8 kHz PCM as `Int16Array` Web Streams. Any `TransformStream` can be an agent.
- `fetch`-style calls, `AbortSignal`, `for await`, `await using`, and `subscribe` for React.
- `STRAW_DEBUG=1` prints a live SIP ladder, and every phone keeps a replayable recording.
- Zero dependencies, 34 kB min+gzip, 100% test coverage. Tested with real calls through Kamailio and FreeSWITCH.

> [!NOTE]
> 0.1 runs in Node only; the browser softphone is next. Check [the limits](#limits) first.

## Install

```sh
npm install usestraw
```

You need Node 22.12+ and a SIP account, from a provider or your own PBX (Asterisk, FreeSWITCH). Pass it as one URL:

```sh
export SIP_URL="tls://alice:secret@sip.example.com"
```

`tls://` defaults to port 5061, `udp://` to 5060. Prefer TLS. Percent-encode special characters in the password, or pass it separately: `connect(url, { password })`.

## Take calls

```ts
for await (const call of phone.incoming) {
  console.log(`${call.callerName ?? call.from} is calling`)
  if (call.from === "anonymous") void call.end({ reason: "declined" })
  else void call.accept(createAgent())
}
```

Don't `await` a whole call inside the loop, or the next caller waits. `accept()` resolves to the live call, or to an unanswered one if the caller gave up. `end()` says `"busy"` by default, so your other devices keep ringing; `"declined"` stops them all.

Without an agent, use the streams directly:

```ts
const live = await call.accept()
if (live.ok) {
  for await (const frame of live.audio.readable) {
    // 160 samples (20 ms), every 20 ms, silence included
  }
}
```

## Make calls

```ts
const call = await phone.call("+49 30 1234567", { timeout: 30_000 })

if (!call.ok) {
  console.log(call.reason) // "busy", "no-answer", "declined", …
} else {
  const writer = call.audio.writable.getWriter()
  try {
    await writer.write(greeting) // 8 kHz Int16Array, any length
    await writer.close() // resolves once the last sample is out
  } catch {
    // they hung up first
  }
  await call.end()
}
```

Like `fetch`, `call()` resolves for busy and unanswered calls too, so check `ok`. It rejects for a bad address, a closed phone, an aborted `signal`, or no free audio port. Numbers can look like `"+49 30 123 45-67"` or `"(030) 1234567"`; user names and `sip:` addresses work too.

## Voice agents

An agent is any `{ readable, writable }` pair. It gets the caller's audio in 20 ms frames, and the caller hears what it writes. Pass it to `accept(agent)` or `phone.call(to, { agent })`. When it closes its output or throws, Straw hangs up.

For more control, use the streams. This is the core of [`examples/parrot.ts`](examples/parrot.ts), which repeats what you say and stops when you interrupt:

```ts
const call = await ringing.accept()
if (!call.ok) return
const writer = call.audio.writable.getWriter()
let turn: Int16Array[] = []
let loud = 0
let quiet = 0
for await (const frame of call.audio.readable) {
  const speaking = level(frame) > 800
  loud = speaking ? loud + 1 : 0
  quiet = speaking ? 0 : quiet + 1
  if (loud === 4) call.audio.clear() // they talk, we stop
  if (speaking || turn.length > 0) turn.push(frame)
  if (quiet === 35) {
    writer.write(reply(turn)).catch(() => {}) // 700 ms of silence ends their turn
    turn = []
  }
}
```

Replace `reply()` with your speech model.

- Frames keep coming during silence, so counting quiet frames finds the end of a turn.
- `call.audio.clear()` drops unplayed audio when the caller interrupts.
- `call.audio.played` says how many ms the caller actually heard, so you can cut the transcript there.
- Writes resolve at once until 30 s are queued.

Most speech models want 16 or 24 kHz, so resample in your agent.

## UI

A phone and its calls are stores. With React:

```tsx
const status = useSyncExternalStore(phone.subscribe, () => phone.status)
const calls = useSyncExternalStore(phone.subscribe, () => phone.calls)
```

`phone.calls` is a new array only when something changed. `JSON.stringify(call)` gives plain data.

## Servers

```ts
process.once("SIGTERM", () => {
  void phone.close({ drain: true, signal: AbortSignal.timeout(60_000) })
})
```

With `drain`, new callers get busy and running calls finish before the phone unregisters. The `signal` ends the wait and hangs up the rest. `maxCalls` (default 100) turns callers away as busy once that many calls run, and a call that sends no audio for a minute is hung up with `reason: "timeout"` (not while on hold). On Node 24 or in TypeScript, `await using` closes a phone or hangs up a call at the end of the scope.

## Errors

`connect()` rejects with a `ConnectError`. Switch on `reason`:

| `reason` | Meaning |
| --- | --- |
| `"wrong-password"` | Credentials refused. Try `authUser` if your provider has a separate auth user. |
| `"password-missing"` | The server wants a password. |
| `"unsupported-auth"` | The server wants auth that Straw doesn't speak. |
| `"refused"` | Registration denied for good, e.g. 403. |
| `"unavailable"` | The server can't register you right now, e.g. 503. |
| `"no-answer"` | No response. Check host, port and transport. |
| `"network"` | The connection failed, or the TLS certificate isn't trusted. |

Once online, the phone re-registers on its own. During an outage, `status` is `"reconnecting"`, with `error` and `retryAt` set.

Ended calls have a `reason` too: `hangup`, `cancelled`, `busy`, `declined`, `not-found`, `no-answer`, `unavailable`, `rejected`, `unauthorized`, `incompatible` or `timeout`.

## Debugging

`STRAW_DEBUG=1` prints the SIP traffic to stderr:

```text
$ STRAW_DEBUG=1 node examples/call.ts "+49 30 1234567"
    0.000  phone → 203.0.113.10:5060  REGISTER sip:example.com SIP/2.0
    0.004  203.0.113.10:5060 → phone  SIP/2.0 401 Unauthorized
    0.004  phone → 203.0.113.10:5060  REGISTER sip:example.com SIP/2.0
    0.007  203.0.113.10:5060 → phone  SIP/2.0 200 OK
    0.007  ● online for 3600 s
    0.008  phone → 203.0.113.10:5060  INVITE sip:+49301234567@example.com SIP/2.0
    0.011  203.0.113.10:5060 → phone  SIP/2.0 180 Ringing
    0.011  ● call ringing 180
    0.012  203.0.113.10:5060 → phone  SIP/2.0 200 OK
    0.012  phone → 203.0.113.10:5060  ACK sip:bob@203.0.113.10:5060 SIP/2.0
    0.012  ● call live PCMU to 198.51.100.7:18610
    0.994  phone → 203.0.113.10:5060  BYE sip:bob@203.0.113.10:5060 SIP/2.0
    0.996  203.0.113.10:5060 → phone  SIP/2.0 200 OK
    0.996  ● call ended by local: hangup
```

`phone.trace` holds the latest 512 KB of SIP traffic, timers and random draws, with password hashes masked. Attach it to bug reports:

```ts
import { ladder, replay } from "usestraw/core"

const trace = phone.trace ?? ""
console.log(ladder(trace)) // the ladder above, after the fact
console.log(replay(trace)) // { ok: true, steps: 42 }, or the first step that differs
```

Replays need the usestraw version that made the trace, and a trace that grew past 512 KB still draws but no longer replays. `trace: false` turns it off.

## API

| | |
| --- | --- |
| `connect(url, options?)` | Registers and resolves once online. Options: `password`, `authUser`, `tls.ca`, `signal`, `trace`, `maxCalls`. |
| `phone.status` | `"connecting"`, `"online"`, `"reconnecting"` or `"offline"`, plus `error` and `retryAt`. |
| `phone.incoming` | Ringing calls, for `for await`. |
| `phone.call(to, options?)` | Calls out. Options: `agent`, `timeout`, `signal`. |
| `phone.calls` | Calls that haven't ended. |
| `phone.subscribe(listener)` | Fires when any of the above changes. |
| `phone.close(options?)` | Hangs up and goes offline. Options: `drain`, `signal`. |
| `phone.trace` | The recording. |
| `call.accept(agent?)` | Answers a ringing call. |
| `call.end(options?)` | Declines, cancels or hangs up. |
| `call.audio` | `readable`, `writable`, `played`, `clear()`, `sampleRate`. |
| `call.status`, `ok`, `reason`, `ended` | State and outcome. |
| `call.id`, `direction`, `from`, `to`, `callerName` | Who called whom. |

The JSDoc has the details. `usestraw/core` exports the protocol without I/O, for custom transports and tests: `createCore`, `parseMessage`, `serializeMessage`, `createRecordedCore`, `replay`, `ladder`.

## How it works

SIP runs in a pure state machine with no sockets or clocks. The Node layer feeds it packets and the time, and does what it returns. Same inputs, same outputs: that's what makes replays work, and it lets the tests simulate loss, reordering, NAT and roaming in milliseconds.

Standards: RFC 3261 and 6026 (SIP), 7616 and 8760 (digest auth), 3264 and 8866 (SDP), 3550 and 3551 (RTP), G.711 μ-law and A-law.

## Limits

- Node only. Browser and Electron are next.
- G.711 only (8 kHz narrowband), no Opus.
- No SRTP. TLS protects signalling, but audio travels unencrypted, as on most SIP trunks.
- No STUN or ICE. Behind NAT, your provider has to send audio back to where it came from. Most do.
- No DTMF, hold, transfer, TCP, WebSocket or video yet.

## Security

- `tls://` verifies certificates. Use `tls.ca` for a private CA.
- Over UDP only your SIP server may start calls; strangers who find the port get no answer at all. `acceptFrom: "anyone"` allows direct IP calls.
- Straw answers authentication only for the realms your server used when registering, never with a weaker hash, and never inside a call, where the far end could be asking. Digest still lets a callee behind a provider that merely forwards challenges ask for a hash, so use a long random SIP password.
- An incoming call starts sending audio only once the caller confirmed it, so a forged call cannot aim your audio at someone else.
- Audio comes from the signalled address. When that is a private address behind NAT, Straw learns the real one from the first packets in the first 2 s, like most SIP stacks (RTP Bleed protection).
- The parser has hard size limits and is fuzzed.
- Passwords never show up in errors, logs or traces.

Report vulnerabilities privately, see [SECURITY.md](SECURITY.md).

## Where Straw fits

| You want to | Use |
| --- | --- |
| Make and take calls from Node with any SIP provider, audio in your code | Straw |
| Build a browser softphone today | SIP.js or JsSIP |
| Build a SIP proxy, registrar or B2BUA | drachtio, Kamailio or OpenSIPS |
| Run a PBX | Asterisk or FreeSWITCH |

## AI coding agents

[`llms.txt`](llms.txt) covers the API and common mistakes, and ships with the package. [AGENTS.md](AGENTS.md) is for agents working on this repo.

## Contributing

```sh
bun install
bun run check   # lint, types, tests, 100% coverage
bun run build
```

After a build, the [examples](examples) run against any SIP account: `SIP_URL=… node examples/echo.ts`.

## License

[MIT](LICENSE)
