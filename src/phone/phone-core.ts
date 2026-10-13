import { createCore } from "../core/core"
import type { Core } from "../core/types"
import { createRecordedCore, type RecordedCore } from "../recorder/recorder"
import type { PhoneSettings } from "./options"
import type { Link, Platform } from "./platform"
import { secureRandom } from "./random"

// One core for the phone's life, so a new connection keeps the registration and the calls
export function startCore(
  first: Link,
  settings: PhoneSettings,
  platform: Platform,
): { readonly recorder: RecordedCore | undefined; readonly core: Core } {
  const { aor, credentials, maxCalls, acceptFrom, trace } = settings
  const { debug } = platform
  // Over TLS and WebSocket only the server reaches us anyway
  const filtered = acceptFrom !== "anyone" && first.local.transport === "UDP"
  const options = {
    address: first.local,
    aor,
    random: secureRandom,
    ...(credentials ? { credentials } : {}),
    ...(maxCalls === undefined ? {} : { maxCalls }),
    ...(filtered
      ? { acceptFrom: [...first.peers, ...(acceptFrom === "server" ? [] : acceptFrom)] }
      : {}),
  }
  try {
    const recorder = trace || debug ? createRecordedCore(options, { onStep: debug }) : undefined
    return { recorder, core: recorder ?? createCore(options) }
  } catch (thrown) {
    first.close()
    throw thrown
  }
}
