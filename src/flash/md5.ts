/**
 * MD5 as lowercase hex. esptool-js leaves the hash to the caller (`calculateMD5Hash`, for
 * Verify), and WebCrypto has no MD5. Self-contained on purpose: the e2e harness injects this
 * function's source into the page for the simulated chip (tests/fake-esp.ts).
 */
export function md5(data: Uint8Array): string {
  const S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
  const K = new Uint32Array(64);
  for (let i = 0; i < 64; i++) K[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 2 ** 32);
  // Pad: 0x80, zeros to 56 mod 64, then the bit length as 64-bit little endian.
  const len = data.length;
  const padded = new Uint8Array((((len + 8) >> 6) + 1) * 64);
  padded.set(data);
  padded[len] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, (len * 8) >>> 0, true);
  view.setUint32(padded.length - 4, Math.floor(len / 2 ** 29), true);

  let a0 = 0x67452301;
  let b0 = 0xefcdab89;
  let c0 = 0x98badcfe;
  let d0 = 0x10325476;
  const M = new Uint32Array(16);
  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) M[i] = view.getUint32(off + i * 4, true);
    let a = a0;
    let b = b0;
    let c = c0;
    let d = d0;
    for (let i = 0; i < 64; i++) {
      let f: number;
      let g: number;
      const round = i >> 4;
      if (round === 0) {
        f = (b & c) | (~b & d);
        g = i;
      } else if (round === 1) {
        f = (d & b) | (~d & c);
        g = (5 * i + 1) & 15;
      } else if (round === 2) {
        f = b ^ c ^ d;
        g = (3 * i + 5) & 15;
      } else {
        f = c ^ (b | ~d);
        g = (7 * i) & 15;
      }
      const s = S[(round << 2) | (i & 3)]!;
      const sum = (a + f + K[i]! + M[g]!) >>> 0;
      a = d;
      d = c;
      c = b;
      b = (b + ((sum << s) | (sum >>> (32 - s)))) >>> 0;
    }
    a0 = (a0 + a) >>> 0;
    b0 = (b0 + b) >>> 0;
    c0 = (c0 + c) >>> 0;
    d0 = (d0 + d) >>> 0;
  }
  let hex = '';
  for (const word of [a0, b0, c0, d0])
    for (let i = 0; i < 4; i++) hex += ((word >>> (i * 8)) & 0xff).toString(16).padStart(2, '0');
  return hex;
}
