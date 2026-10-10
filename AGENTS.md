# AGENTS.md

Straw is a SIP user agent for Node, in TypeScript, with zero runtime dependencies. The public API lives in `src/node`, the protocol in a sans-I/O core.

## Commands

```sh
bun install
bun run check                         # biome, tsc, vitest with 100% coverage
bunx vitest run test/node/calls.test.ts
bun run build                         # tsdown, plus attw and publint
bun run format                        # biome --write
```

The pre-commit hook runs biome, the typecheck and all tests.

## Layout

- `src/core`: registration, calls and dialogs as a pure state machine (`handle(input, now)`, `nextDeadline()`).
- `src/message`, `src/transaction`, `src/auth`, `src/sdp`: parsing, RFC 3261 transactions, digest auth, SDP offer/answer.
- `src/rtp`: G.711, RTP, jitter buffer and media engine, also sans-I/O.
- `src/node`: the only code with sockets, timers and `process`: `connect()`, `Phone`, calls, audio streams.
- `src/recorder`, `src/simulation`: recorder, replay, ladder, and the deterministic network simulation.
- `test` mirrors `src`. `test/scenarios` runs whole flows through the simulated network; `test/node/carrier.ts` is a local SIP carrier.
- `examples`: runnable apps that import `usestraw`. They are typechecked.

## Rules

- Outside `src/node`, no Node modules, timers, `Date`, `crypto` or `process`. Time comes from `now`, randomness from the injected `Random`. Biome enforces this.
- 100% coverage. Test through the public surface; prefer the simulation over mocks.
- Zero runtime dependencies.
- Almost no comments. One-line RFC references like `// RFC 3261 §17.1.1.2` are fine. Public exports get short JSDoc.
- Small files, small functions, plain names.
- Public API: data over verbs, app words over SIP words (`"busy"`, not `486`), Web standards. It has to fit a browser softphone later.
- Errors say what went wrong and what to do. Never include passwords.
- Never commit credentials, real hostnames or phone numbers. Tests use `example.com` and documentation addresses.
- Commit messages: one Conventional Commits line.
