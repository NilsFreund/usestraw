import type { SipResponse } from "../message/types"
import type { MediaAddress } from "../sdp/types"
import { familyOf, isPrivate } from "../support/ip"
import type { TransportAddress } from "../transport/address"
import { publicHost } from "./registration/binding"

/** The public address the server saw this phone at, for audio behind a NAT. */
export interface Outside {
  learn(response: SipResponse, local: TransportAddress): void
  forget(): void
  advertised(media: MediaAddress): MediaAddress
}

export function createOutside(): Outside {
  let host: string | undefined
  return {
    learn: (response, local) => {
      host = publicHost(response, local) ?? host
    },
    forget: () => {
      host = undefined
    },
    // Behind a NAT that keeps ports, as on a cloud VM, audio must come to the address the server saw
    advertised: (media) => {
      if (host === undefined || !isPrivate(media.host)) return media
      return familyOf(host) === familyOf(media.host) ? { ...media, host } : media
    },
  }
}
