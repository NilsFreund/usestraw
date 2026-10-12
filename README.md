<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/NilsFreund/usestraw/main/.github/banner-dark.jpg">
    <img src="https://raw.githubusercontent.com/NilsFreund/usestraw/main/.github/banner.jpg" alt="usestraw: SIP without the hangover" width="640">
  </picture>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/usestraw"><img src="https://img.shields.io/npm/v/usestraw" alt="npm"></a>
  <a href="https://github.com/NilsFreund/usestraw/actions/workflows/ci.yml"><img src="https://github.com/NilsFreund/usestraw/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://github.com/NilsFreund/usestraw/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT license"></a>
</p>

Make and take phone calls from Node. The audio comes as Web Streams.

```ts
import { connect } from "usestraw"

const phone = await connect(process.env.SIP_URL) // tls://alice:secret@sip.example.com

for await (const call of phone.incoming) {
  void call.accept(new TransformStream()) // callers hear themselves
}
```

Put your voice agent where the `TransformStream` is, and it answers the phone.

- Zero dependencies, 37 kB min+gzip, 100% test coverage.
- `STRAW_DEBUG=1` prints the SIP traffic, and every phone keeps a replayable trace.
- Hand-tested with real calls through Kamailio and FreeSWITCH.

## Install

```sh
npm install usestraw
```

You need Node 22.12+ (TypeScript 5.7+ for the types) and a SIP account from your provider or PBX.

## Calling out

```ts
const call = await phone.call("+44 20 7946 0123", { agent: new TransformStream() })
if (!call.ok) console.log(call.reason) // "busy", "no-answer", …
```

## Limits

0.1 runs in Node only and speaks G.711 only. It has no SRTP, DTMF, hold or transfer yet. The browser comes next.

## More

[Guide](https://github.com/NilsFreund/usestraw/blob/main/GUIDE.md) · [Examples](https://github.com/NilsFreund/usestraw/tree/main/examples) · [llms.txt](https://github.com/NilsFreund/usestraw/blob/main/llms.txt) · [Security](https://github.com/NilsFreund/usestraw/blob/main/SECURITY.md) · [MIT](https://github.com/NilsFreund/usestraw/blob/main/LICENSE)
