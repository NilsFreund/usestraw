# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions: [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.2.0-rc.0] - 2026-10-19

Browsers join Node: the same phone registers over WebSocket and calls through WebRTC, with the audio as the same PCM streams.

### Added

- Browsers: `import { connect } from "usestraw"` picks the browser build, which registers over `wss://` and calls through WebRTC. It asks for the microphone on the first call or answer, and a refused microphone keeps an incoming call ringing for another try. `iceServers` passes STUN and TURN servers on. One phone in one tab at a time keeps its registration across reloads; other tabs and phones register beside it. `call.audio` is the same 8 kHz PCM as in Node: what you write plays along with the microphone, and an agent takes the microphone's place, so the browser never asks for it. A call or answer with an agent rejects before it goes out when the page can't run `call.audio` (a Content-Security-Policy needs `blob:` in `script-src`). `localStorage.STRAW_DEBUG = "1"` prints the ladder to the console.
- SIP over WebSocket in Node too: `wss://user:password@host[:port][/path]` URLs and `wss://` servers, `ws://` for localhost only. Reconnects keep the registration, and a server that stops answering keepalives, or sends a message over 64 KB, gets replaced by a new connection (RFC 7118, RFC 5626).
- The `IceServer` type for `iceServers`.
- `usestraw/core`: `instance` sets the RFC 5626 instance id to register with over WebSocket.
- `usestraw/core`: `media: "sdp"` lets the app make the SDP, as WebRTC does. Calls take `{ sdp }`; events carry the far end's SDP as a `description` shaped like `RTCSessionDescriptionInit` (`offer`, `pranswer`, `answer`, `rollback`). A byte-identical refresh gets the same SDP back, any other offer inside a call, or a re-INVITE without one, becomes an `offer` event for an `answer` command, refused with 488 and rolled back when none comes within 10 s or the far end cancels.

### Changed

- In the browser, `connect()` makes calls instead of rejecting with `NotSupportedError`.
- The `timeout` of `phone.call()` counts from when the call goes out, so a microphone prompt doesn't use up the ring time.
- Traces also mask ICE passwords and SDES keys, at the same length, so they still replay.
- `usestraw/core`: with `media: "sdp"`, a `CallEvent` can have the new state `"offer"`, so exhaustive switches need a branch for it.

## [0.1.0-rc.0] - 2026-10-12

The first release candidate: make and take phone calls from Node, with the audio as Web Streams.

### Added

- `connect(url | options)`: registers over TLS or UDP and reconnects on its own. `status`, `error`, `retryAt`, `subscribe`.
- `phone.incoming`, `call.accept(agent?)`, `call.end({ reason })`, and `maxCalls`. Accepted calls are `"answering"` until the caller confirms, and a call another device took ends as `"answered-elsewhere"` (RFC 3326).
- `phone.call(to, { agent, timeout, signal })`, resolving like `fetch` with `ok` and `reason`. Numbers as people write them and `tel:` links work.
- Call audio as Web Streams of 8 kHz PCM, with `played` and `clear()` for barge-in. Any `TransformStream` can be an agent.
- `phone.close({ drain, signal })` and `await using`.
- G.711 μ-law and A-law over RTP, with an adaptive jitter buffer and RTP Bleed protection.
- SDP offer/answer, re-INVITEs, forking, CANCEL, and digest auth with MD5, SHA-256 and SHA-512-256. No RFC 4733 events are offered yet, so key presses reach the audio as tones at best.
- `STRAW_DEBUG=1` live ladder and replayable `phone.trace`.
- `phone.toJSON()` and `call.toJSON()`: frozen snapshots without the trace that stay the same object until something changes, for React's `useSyncExternalStore`, logs and IPC; `phone.calls` is frozen too.
- Over UDP only the SIP server may start calls (`acceptFrom: "anyone"` for direct IP calls), others only reach a running call, and strangers' packets stay out of the trace; when registered, digest answers only the registered realm, never with a weaker hash, and `realm` pins one.
- Calls without audio for 60 s are hung up as `"dropped"`, also while Straw only sends; a refused re-registration ends calls with a proper BYE.
- Reconnects after a dropped TLS connection, keeping registration and calls; CRLF keepalives over UDP and TLS, dead-connection detection for servers that answer them, and 600 s registrations.
- Behind NAT over UDP, registers the public address the registrar saw (RFC 3581) and drops the private one; behind a NAT that keeps ports, as on a cloud VM, audio is offered at the public address too, over UDP and TLS.
- After a TLS reconnect, registers the new connection's Contact and asks to drop the old one in the same REGISTER.
- Trunks without registration: `register: false` with a SIP ping every minute, a fixed `localPort`, and `acceptFrom` lists of IPs and CIDR ranges.
- `usestraw/core`: the sans-I/O SIP core, experimental until the browser softphone settles it.
- `usestraw/node` for the Node build, and a browser placeholder whose `connect()` rejects with `NotSupportedError` until 0.2.

[Unreleased]: https://github.com/NilsFreund/usestraw/compare/v0.2.0-rc.0...HEAD
[0.2.0-rc.0]: https://github.com/NilsFreund/usestraw/compare/v0.1.0-rc.0...v0.2.0-rc.0
[0.1.0-rc.0]: https://github.com/NilsFreund/usestraw/releases/tag/v0.1.0-rc.0
