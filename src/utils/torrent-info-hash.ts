import crypto from "node:crypto";

export function computeInfoHash(torrentData: Buffer): string {
  const infoKey = Buffer.from("4:info");
  const infoStart = torrentData.indexOf(infoKey);
  if (infoStart === -1) throw new Error("No info dict in torrent");

  const dictStart = infoStart + infoKey.length;
  const state = { pos: dictStart };
  skipValue(torrentData, state);

  const infoBytes = torrentData.subarray(dictStart, state.pos);
  return crypto.createHash("sha1").update(infoBytes).digest("hex");
}

function skipValue(buf: Buffer, state: { pos: number }): void {
  const ch = buf[state.pos];
  if (ch === 0x64) {
    state.pos++;
    while (buf[state.pos] !== 0x65) {
      skipValue(buf, state);
      skipValue(buf, state);
    }
    state.pos++;
  } else if (ch === 0x6c) {
    state.pos++;
    while (buf[state.pos] !== 0x65) skipValue(buf, state);
    state.pos++;
  } else if (ch === 0x69) {
    state.pos++;
    state.pos = buf.indexOf(0x65, state.pos) + 1;
  } else {
    const colon = buf.indexOf(0x3a, state.pos);
    const len = parseInt(buf.subarray(state.pos, colon).toString(), 10);
    state.pos = colon + 1 + len;
  }
}
