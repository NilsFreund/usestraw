# Changelog

Format: [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions: [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `connect(url | options)`: registers over TLS or UDP and reconnects on its own. `status`, `error`, `retryAt`, `subscribe`.
- `phone.incoming`, `call.accept(agent?)`, `call.end({ reason })`, and `maxCalls`.
- `phone.call(to, { agent, timeout, signal })`, resolving like `fetch` with `ok` and `reason`.
- Call audio as Web Streams of 8 kHz PCM, with `played` and `clear()` for barge-in. Any `TransformStream` can be an agent.
- `phone.close({ drain, signal })` and `await using`.
- G.711 μ-law and A-law over RTP, with an adaptive jitter buffer and RTP Bleed protection.
- SDP offer/answer, re-INVITEs, forking, CANCEL, and digest auth with MD5, SHA-256 and SHA-512-256.
- `STRAW_DEBUG=1` live ladder and replayable `phone.trace`.
- `usestraw/core`: the sans-I/O SIP core.

[Unreleased]: https://github.com/NilsFreund/usestraw/commits/main
