# Security

Found a vulnerability? Thank you, reports are very welcome. Please send them privately, so attackers can't use the hole before a fix is out: open the repository's **Security** tab and choose **Report a vulnerability**, or email contact@nilsfreund.de. A public issue would show everyone how to attack phones that haven't updated yet.

Include steps to reproduce and what an attacker could do. A `phone.trace` or packet capture helps; traces mask password hashes but can contain numbers and addresses.

Expect a first answer within a week. Until 1.0, only the latest release gets fixes.

In scope: hostile SIP or SDP (crashes, hangs, memory growth), leaked passwords or digest responses, injected or stolen call audio (RTP Bleed), TLS without verification, and secrets in errors, logs or traces.

`test/fixtures/tls/localhost.key` is a throwaway self-signed key for the TLS tests, not a leaked secret.
