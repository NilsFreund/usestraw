const lines = (...text: string[]) => `${text.join("\r\n")}\r\n`

export const freeswitch: string = lines(
  "v=0",
  "o=FreeSWITCH 1728540000 1728540001 IN IP4 203.0.113.5",
  "s=FreeSWITCH",
  "c=IN IP4 203.0.113.5",
  "t=0 0",
  "m=audio 23456 RTP/AVP 8 0 101",
  "a=rtpmap:8 PCMA/8000",
  "a=rtpmap:0 PCMU/8000",
  "a=rtpmap:101 telephone-event/8000",
  "a=fmtp:101 0-16",
  "a=ptime:20",
  "a=sendrecv",
  "a=rtcp:23457 IN IP4 203.0.113.5",
)

export const asterisk: string = lines(
  "v=0",
  "o=- 1234567890 1234567890 IN IP4 198.51.100.10",
  "s=Asterisk",
  "c=IN IP4 198.51.100.10",
  "t=0 0",
  "m=audio 10000 RTP/AVP 111 3 0 8 101",
  "a=rtpmap:111 opus/48000/2",
  "a=fmtp:111 useinbandfec=1",
  "a=rtpmap:3 GSM/8000",
  "a=rtpmap:0 PCMU/8000",
  "a=rtpmap:8 PCMA/8000",
  "a=rtpmap:101 telephone-event/8000",
  "a=fmtp:101 0-16",
  "a=ptime:30",
  "a=maxptime:150",
  "a=sendrecv",
)

export const ims: string = lines(
  "v=0",
  "o=SBC 4711 4712 IN IP4 192.0.2.99",
  "s=-",
  "c=IN IP4 192.0.2.99",
  "t=0 0",
  "m=audio 30000 RTP/AVP 104 102 105 100",
  "b=AS:41",
  "a=rtpmap:104 AMR-WB/16000",
  "a=fmtp:104 mode-change-capability=2;max-red=0",
  "a=rtpmap:102 AMR/8000",
  "a=rtpmap:105 telephone-event/16000",
  "a=rtpmap:100 telephone-event/8000",
  "a=ptime:20",
  "a=maxptime:240",
)

export const webrtc: string = lines(
  "v=0",
  "o=- 4611731400430051336 2 IN IP4 127.0.0.1",
  "s=-",
  "t=0 0",
  "a=group:BUNDLE 0",
  "m=audio 9 UDP/TLS/RTP/SAVPF 111 0 8",
  "c=IN IP4 0.0.0.0",
  "a=rtcp:9 IN IP4 0.0.0.0",
  "a=ice-ufrag:abcd",
  "a=fingerprint:sha-256 AA:BB",
  "a=rtpmap:111 opus/48000/2",
  "a=rtpmap:0 PCMU/8000",
  "a=rtpmap:8 PCMA/8000",
)

export const rtpengine: string = lines(
  "v=0",
  "o=- 3792 3793 IN IP6 2001:db8::5",
  "s=-",
  "t=0 0",
  "m=audio 40002 RTP/AVP 0 101",
  "c=IN IP6 2001:db8::5",
  "a=rtpmap:0 PCMU/8000",
  "a=rtpmap:101 telephone-event/8000",
  "a=fmtp:101 0-15",
  "a=sendrecv",
)

// RFC 4317 §2.1 with addresses instead of host names: audio and video offered, we can only play audio
export const rfc4317: string = lines(
  "v=0",
  "o=alice 2890844526 2890844526 IN IP4 198.51.100.1",
  "s=",
  "c=IN IP4 198.51.100.1",
  "t=0 0",
  "m=audio 49170 RTP/AVP 0 8 97",
  "a=rtpmap:0 PCMU/8000",
  "a=rtpmap:8 PCMA/8000",
  "a=rtpmap:97 iLBC/8000",
  "m=video 51372 RTP/AVP 31 32",
  "a=rtpmap:31 H261/90000",
  "a=rtpmap:32 MPV/90000",
)

// RFC 4317 §2.6 with addresses instead of host names: the first audio line has PCMU, the second iLBC
export const twoAudio: string = lines(
  "v=0",
  "o=alice 2890844526 2890844526 IN IP4 198.51.100.1",
  "s=",
  "c=IN IP4 198.51.100.1",
  "t=0 0",
  "m=audio 49170 RTP/AVP 0",
  "a=rtpmap:0 PCMU/8000",
  "m=audio 51372 RTP/AVP 97 101",
  "a=rtpmap:97 iLBC/8000",
  "a=rtpmap:101 telephone-event/8000",
)
