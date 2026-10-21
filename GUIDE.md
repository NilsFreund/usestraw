# Straw guide

Everything the [README](README.md) leaves out. The JSDoc has every option in detail.

- [Connecting](#connecting)
- [Taking calls](#taking-calls)
- [Making calls](#making-calls)
- [Voice agents](#voice-agents)
- [Servers and UIs](#servers-and-uis)
- [Browsers](#browsers)
- [Trunks](#trunks)
- [Errors](#errors)
- [Debugging](#debugging)
- [Limits](#limits)
- [Security](#security)
- [Where Straw fits](#where-straw-fits)

## Connecting

```ts
const phone = await connect("tls://alice:secret@sip.example.com")
```

`tls://` defaults to port 5061, `udp://` to 5060 and `wss://` to 443, with an optional path like `wss://alice:secret@sip.example.com/ws`. Prefer TLS or WebSocket over TLS; `ws://` works only for localhost, since it would send the password in the clear. Percent-encode special characters in the password, or pass it as `{ password }`. When your SIP domain and the server differ, or your provider has a separate auth user:

```ts
const phone = await connect({
  uri: "sip:+442079460456@sip.example.com",
  password: process.env.SIP_PASSWORD,
  server: "tls://edge.example.com",
  authUser: "u-12345",
})
```

`connect()` resolves once the phone is registered, so `phone.status` is `"online"`, later `"reconnecting"` or `"closed"`.

**Getting a SIP account:** Straw is a SIP phone, so it needs what a desk phone or softphone needs: a user, a password and a server. Most VoIP providers sell a number with such an account; look for "SIP credentials" or "bring your own device". Asterisk or FreeSWITCH give you accounts on your own machine for free. Business SIP trunks work too, see [Trunks](#trunks).

## Taking calls

```ts
for await (const call of phone.incoming) {
  if (call.from === "anonymous") void call.end({ reason: "declined" })
  else void call.accept(createAgent())
}
```

Don't `await` a whole call inside the loop, or the next caller waits. `accept()` resolves to the live call, or to an unanswered one if the caller gave up. `end()` says `"busy"` by default, so your other devices keep ringing; `"declined"` stops them all.

## Making calls

Like `fetch`, `phone.call()` resolves for busy and unanswered calls too, so check `ok`. It rejects for a bad address, a closed phone, an aborted `signal`, no free audio port, or in the browser a refused microphone. The `timeout` counts from when the call goes out. Numbers can look like `"+44 20 7946-0123"`, `"+44 (0)20 7946 0123"` or `"tel:+442079460123"`; user names and `sip:` addresses work too.

```ts
const call = await phone.call("+44 20 7946 0123", { timeout: 30_000, signal })
if (call.ok) {
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

## Voice agents

An agent is any `{ readable, writable }` pair, usually a `TransformStream`, one per call. It gets the caller's audio and the caller hears what it writes. Pass it to `accept(agent)` or `phone.call(to, { agent })`. When it closes its output or throws, Straw hangs up.

- Audio is mono 16-bit PCM at 8 kHz in 20 ms frames of 160 samples. Most speech models want 16 or 24 kHz, so resample in your agent.
- Frames keep coming during silence, so counting quiet frames finds the end of a turn.
- `call.audio.clear()` drops unplayed audio when the caller interrupts.
- `call.audio.played` says how many ms the caller actually heard, so you can cut the transcript there.
- Writes resolve at once until 30 s are queued.

[`examples/parrot.ts`](examples/parrot.ts) puts it together: it repeats what you say and stops when you interrupt. Swap the `join(words)` it writes back for your speech model's reply.

## Servers and UIs

```ts
process.once("SIGTERM", () => {
  void phone.close({ drain: true, signal: AbortSignal.timeout(60_000) })
})
```

With `drain`, new callers get busy and running calls finish before the phone unregisters. The `signal` ends the wait and hangs up the rest. `maxCalls` (default 100) turns callers away as busy once that many calls run. A call that sends no audio for a minute is hung up with `reason: "dropped"` (not while the far end holds the call; in the browser, a call drops when its connection fails).

`await using` closes a phone or hangs up a call at the end of the scope. Node 24 runs it as is. On Node 22 it needs a compiler that lowers it, like TypeScript with a target below ESNext, because Node's type stripping leaves it alone.

A phone and its calls are stores, so React can use them directly:

```tsx
const snapshot = useSyncExternalStore(phone.subscribe, () => phone.toJSON())
```

`toJSON()` is frozen plain data without the trace, and stays the same object until something changes.

## Browsers

The same `import { connect } from "usestraw"` picks the browser build. It registers over `wss://` (RFC 7118) and calls through WebRTC, one peer connection per call. So the server has to speak both SIP over WebSocket and WebRTC media (ICE and DTLS-SRTP), as Asterisk with `webrtc=yes`, FreeSWITCH, or Kamailio with rtpengine do.

```ts
const phone = await connect({
  uri: "sip:alice@example.com",
  password, // this user's own SIP password, from your backend
  server: "wss://edge.example.com/ws",
  iceServers: [{ urls: "stun:stun.example.com" }],
})

let current: Call | undefined
callButton.onclick = async () => {
  current = await phone.call(numberInput.value) // the first call asks for the microphone
}
hangUpButton.onclick = () => void current?.end()

for await (const call of phone.incoming) {
  current = call
  answerButton.onclick = () => void call.accept()
}
```

Start calls and answers from a click, which lets the browser use the microphone and the speakers.

- The page has to be secure: https, or localhost while you develop.
- The page holds the SIP password, so give every user their own account and fetch it from your backend. Never ship one in the bundle.
- Without an agent, the first call or answer asks for the microphone. A refusal rejects `accept()` with `NotAllowedError`, and the call keeps ringing for another try.
- Behind NAT, pass `iceServers`. TURN servers need a `username` and `credential`.
- One phone in one tab at a time keeps its Contact across reloads, so the registrar replaces the old binding. Other tabs, and a second phone in the same tab, register beside it.
- `call.audio` is the same 8 kHz PCM as in Node. What you write plays along with the microphone. An agent takes the microphone's place, so the browser never asks for it, and the far end still plays through the speakers.
- Under a Content-Security-Policy, allow the `wss://` server in `connect-src`. `call.audio` also needs `blob:` in `script-src` (or `script-src-elem`, if you set it) for its AudioWorklet; otherwise a call or answer with an agent rejects with `SecurityError` before it goes out, and an incoming call keeps ringing.
- Browsers start audio only after the user clicked on the page (Safari: shortly before). An agent that answers before that hears nothing, and what it writes waits for the next click or key press.
- A closed tab's registration lasts until it expires, unless the server drops it with the connection.
- `localStorage.STRAW_DEBUG = "1"`, then a reload, prints the ladder in the console.
- Hand-tested in Chrome. Firefox and Safari follow the same standards but haven't been tried on real calls yet.

## Trunks

A trunk with IP authentication sends calls to a fixed address and needs no registration:

```ts
const phone = await connect({
  uri: "sip:+442079460456@sip.carrier.example", // your number, used as caller ID
  register: false,
  localPort: 5060,
  acceptFrom: ["203.0.113.0/24", "198.51.100.16/28"],
})
```

`connect()` then only checks that the server answers a SIP ping, and fails with `"no-answer"` if it doesn't, often because the trunk doesn't allow this machine's IP yet. The phone pings again every minute.

- Give the trunk this machine's public IP and `localPort`.
- List every signaling range your provider publishes in `acceptFrom`. Calls often come from more addresses than the server's name resolves to.
- Open `localPort` and UDP 16384–24575 (audio) to the provider, and forward them behind NAT.
- If the trunk also challenges outgoing calls, pass `password` and `realm`. Without registration Straw can't learn the realm and would answer a challenge in any realm.
- Over UDP a source address can be forged, so don't treat caller ID as proof.

## Errors

`connect()` rejects with a `ConnectError`. Switch on `reason`:

| `reason` | Meaning |
| --- | --- |
| `"wrong-password"` | Credentials refused. Try `authUser` if your provider has a separate auth user. |
| `"password-missing"` | The server wants a password. |
| `"unsupported-auth"` | The server wants auth Straw doesn't speak, or a realm other than `realm`. |
| `"refused"` | Registration denied for good, e.g. 403. Some servers answer a wrong password with 403. |
| `"unavailable"` | The server can't register you right now, e.g. 503. |
| `"no-answer"` | No response. Check host, port and transport, and that a trunk allows your IP. |
| `"network"` | The connection failed, or the TLS certificate isn't trusted. Use `tls.ca` for a private CA, or `NODE_EXTRA_CA_CERTS` with `wss://`. |

Once online, the phone re-registers and reconnects on its own. While it is down, `status` is `"reconnecting"`, `error` says why and `retryAt` says when it tries again. While the connection itself is lost, `phone.call()` throws that error. Running calls keep going when the server keeps them.

A call that didn't connect or has ended has a `reason`: `hangup`, `cancelled`, `answered-elsewhere`, `busy`, `declined`, `not-found`, `no-answer`, `unavailable`, `rejected`, `unauthorized`, `incompatible` or `dropped`. New reasons may come in minor versions, so keep a `default` branch.

## Debugging

`STRAW_DEBUG=1` prints the SIP traffic to stderr:

```text
$ STRAW_DEBUG=1 node examples/call.ts "+44 20 7946 0123"
    0.000  phone → 203.0.113.10:5060  REGISTER sip:example.com SIP/2.0
    0.004  203.0.113.10:5060 → phone  SIP/2.0 401 Unauthorized
    0.004  phone → 203.0.113.10:5060  REGISTER sip:example.com SIP/2.0
    0.007  203.0.113.10:5060 → phone  SIP/2.0 200 OK
    0.007  ● online for 600 s
    0.008  phone → 203.0.113.10:5060  INVITE sip:+442079460123@example.com SIP/2.0
    0.012  203.0.113.10:5060 → phone  SIP/2.0 200 OK
    0.012  phone → 203.0.113.10:5060  ACK sip:bob@203.0.113.10:5060 SIP/2.0
    0.012  ● call live PCMU to 198.51.100.7:18610
```

`phone.trace` holds the latest 512 KB of SIP traffic, timers and random draws, with password hashes, ICE passwords and SDES keys masked. Attach it to bug reports. `ladder(trace)` from `usestraw/core` draws it like above, and `replay(trace)` reruns it to check the same outputs come out. Replays need the usestraw version that made the trace, and a trace that grew past 512 KB still draws but no longer replays. `trace: false` turns it off.

## Limits

- **Electron:** run the phone in the main process or a `utilityProcess` and send `toJSON()` snapshots to the window. jsdom tests import `usestraw/node`.
- **G.711 only in Node** (8 kHz narrowband), no Opus. In browsers WebRTC picks the codec, and `call.audio` is 8 kHz either way.
- **No SRTP in Node.** TLS protects signaling, but audio travels unencrypted, as on most SIP trunks. Browsers always encrypt it.
- **No STUN or ICE in Node.** Over UDP behind NAT, Straw keeps the mapping open and registers its public address. Audio is offered at the public address only when the NAT kept Straw's port, as on a cloud VM; otherwise your provider has to send audio back to where it comes from (symmetric RTP; on Twilio Elastic SIP Trunking, switch it on). Most do.
- **No DTMF yet.** Key presses reach the audio as tones at best, and some servers drop them.
- **No PRACK and no session timers.** Calls that require them (`Require: 100rel` or `timer`) are refused with 420. Outgoing calls end as `"rejected"` on carriers that insist.
- **No auth inside a call.** A provider that challenges your hangup may keep the call open, and billing, until it times out.
- **No RTCP and no DNS SRV lookups,** so give the server's host name. Over UDP, Straw resolves it once.
- **No TLS server,** so a trunk without registration calls in over UDP.
- **No hold, transfer, TCP or video** yet.

**Asterisk** (not hand-tested yet): these PJSIP settings fit Straw in Node behind NAT and across reconnects. `dtmf_mode=auto` keeps key presses in-band. For browsers, the endpoint needs `webrtc=yes` and a `wss` transport instead.

```ini
[straw]
type=endpoint
aors=straw
disallow=all
allow=ulaw,alaw
rewrite_contact=yes
rtp_symmetric=yes
direct_media=no
dtmf_mode=auto

[straw]
type=aor
max_contacts=1
remove_existing=yes
```

## Security

- `tls://` and `wss://` verify certificates. Use `tls.ca` for a private CA with `tls://`, and `NODE_EXTRA_CA_CERTS` with `wss://` in Node.
- Over UDP only your SIP server may start calls; strangers who find the port get no answer. `acceptFrom` adds IPs and CIDR ranges, or allows `"anyone"` for direct IP calls.
- Straw answers digest challenges only for the realms your server used when registering, never with a weaker hash, and never inside a call. Without registration, or when the registrar never asked for a password, it answers any realm on an outgoing call unless you set `realm`. Use a long random SIP password.
- An incoming call starts sending audio only once the caller confirmed it, so a forged call cannot aim your audio at someone else. Straw hangs up when nothing comes back for a minute while it sends.
- Straw takes audio only from the signalled address, or another port on the same host. When the signalled address is private, it learns the real one from the first packets within 2 s; another host never replaces a public address (RTP Bleed).
- The parser has hard size limits and is fuzzed. Passwords never show up in errors, logs or traces.

Report vulnerabilities privately, see [SECURITY.md](SECURITY.md).

## Where Straw fits

Straw is a SIP phone, not a server. SIP runs in a pure state machine with no sockets or clocks, which is what makes replays work and lets the tests simulate loss, NAT and roaming in milliseconds. It speaks RFC 3261 and 6026 (SIP), 7118 and 5626 (WebSocket and outbound), 7616 and 8760 (digest), 3264 and 8866 (SDP), 3550 and 3551 (RTP).

| You want to | Use |
| --- | --- |
| Make and take calls from Node or the browser with your own SIP account, audio in your code | Straw |
| Let a platform bridge calls to your agent | Twilio Media Streams, LiveKit SIP or Jambonz |
| Build a full browser softphone today, with hold, transfer and DTMF | SIP.js or JsSIP |
| Build a SIP proxy, registrar or B2BUA | drachtio, Kamailio or OpenSIPS |
| Run a PBX | Asterisk or FreeSWITCH |

`usestraw/core` exports the state machine for custom transports and tests. It is experimental until the browser softphone ships; `ladder` and `replay` stay as they are.

Working on Straw itself? See [AGENTS.md](AGENTS.md).
