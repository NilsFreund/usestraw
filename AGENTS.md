# AGENTS.md

Straw is a SIP user agent for Node, in TypeScript, with zero runtime dependencies. The public API lives in `src/phone`, the protocol in a sans-I/O core, and everything Node-specific in `src/node`.

## Commands

```sh
bun install
bun run check                         # biome, tsc (also without Node types), vitest with 100% coverage
bunx vitest run test/phone/call-list.test.ts
bun run build                         # tsdown, plus attw and publint
bun run format                        # biome --write
```

The pre-commit hook runs biome, the typecheck and all tests.

## Layout

- `src/core`: registration, calls and dialogs as a pure state machine (`handle(input, now)`, `nextDeadline()`).
- `src/message`, `src/transaction`, `src/auth`, `src/sdp`: parsing, RFC 3261 transactions, digest auth, SDP offer/answer.
- `src/rtp`: G.711, RTP, jitter buffer and media engine, also sans-I/O.
- `src/phone`: `Phone`, calls and their streams, the connection and its reconnects, and options; the public types live in `types.ts`. It runs anywhere: timers yes, Node modules and `process` no. It gets its connection, audio and debug output from a `Platform`.
- `src/node`: the Node platform, with sockets (`links.ts`), RTP audio (`audio.ts`), `STRAW_DEBUG` and `connect()`.
- `src/index.ts` is `usestraw` (and `usestraw/node`), `src/core.ts` is `usestraw/core`, `src/browser.ts` is the browser placeholder until 0.2.
- `src/recorder`, `src/simulation`: recorder, replay, ladder, and the deterministic network simulation.
- `test` mirrors `src`. `test/scenarios` runs whole flows through the simulated network; `test/node/carrier.ts` is a local SIP carrier.
- `examples`: runnable apps that import `usestraw`. They are typechecked.

## Rules

- Outside `src/node` and `src/phone`, no Node modules, timers, `Date`, `crypto` or `process`. Time comes from `now`, randomness from the injected `Random`. Biome and `tsconfig.neutral.json` enforce this, and keep Node out of `src/phone` too.
- MD5, SHA-256, SHA-512/256 and HMAC are hand-written in `src/support`, because the core is synchronous and WebCrypto is async and has no MD5. They are tested against the published vectors and `node:crypto`.
- 100% coverage. Modules with their own logic get unit tests, small glue modules are covered through their users, and whole flows run as scenarios through the simulated network. Prefer the simulation over mocks, and polling or fake timers over sleeps.
- Zero runtime dependencies.
- Almost no comments. One-line RFC references like `// RFC 3261 §17.1.1.2` are fine. Public exports get short JSDoc.
- Small files, small functions, plain names.
- Public API: data over verbs, app words over SIP words (`"busy"`, not `486`), Web standards. It has to fit a browser softphone later.
- Errors say what went wrong and what to do. Never include passwords.
- Never commit credentials, real hostnames or phone numbers. Tests use `example.com` and documentation addresses.
- Commit messages: one Conventional Commits line.
