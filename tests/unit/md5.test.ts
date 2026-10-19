import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { md5 } from '../../src/flash/md5';

describe('md5', () => {
  it('matches the reference vectors and node:crypto at block boundaries', () => {
    const enc = new TextEncoder();
    expect(md5(new Uint8Array(0))).toBe('d41d8cd98f00b204e9800998ecf8427e');
    expect(md5(enc.encode('abc'))).toBe('900150983cd24fb0d6963f7d28e17f72');
    for (const n of [55, 56, 63, 64, 65, 1000, 70_000]) {
      const data = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff);
      expect(md5(data)).toBe(createHash('md5').update(data).digest('hex'));
    }
  });
});
