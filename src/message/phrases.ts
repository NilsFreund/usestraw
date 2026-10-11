// RFC 3261 §21: the reason phrases of the statuses we send
const PHRASES: Readonly<Record<number, string>> = {
  100: "Trying",
  180: "Ringing",
  200: "OK",
  400: "Bad Request",
  403: "Forbidden",
  404: "Not Found",
  405: "Method Not Allowed",
  415: "Unsupported Media Type",
  416: "Unsupported URI Scheme",
  420: "Bad Extension",
  480: "Temporarily Unavailable",
  481: "Call/Transaction Does Not Exist",
  482: "Loop Detected",
  486: "Busy Here",
  487: "Request Terminated",
  488: "Not Acceptable Here",
  500: "Server Internal Error",
  501: "Not Implemented",
  503: "Service Unavailable",
  600: "Busy Everywhere",
  603: "Decline",
}

export function phraseFor(status: number): string {
  return PHRASES[status] ?? "Rejected"
}
