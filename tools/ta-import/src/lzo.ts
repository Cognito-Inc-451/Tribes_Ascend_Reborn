/** LZO1X decompressor (format used by UE3 cooked packages). */
export function lzoDecompress(src: Uint8Array, dstLen: number): Uint8Array {
  const dst = new Uint8Array(dstLen);
  let ip = 0, op = 0, t = 0, m = 0;

  const lit = (n: number) => { dst.set(src.subarray(ip, ip + n), op); ip += n; op += n; };
  const cpy = (from: number, n: number) => { for (let i = 0; i < n; i++) dst[op++] = dst[from + i]; };

  type S = 'loop' | 'first' | 'match' | 'done' | 'next';
  let s: S = 'loop';
  if (src[0] > 17) {
    t = src[ip++] - 17;
    if (t < 4) s = 'next';
    else { lit(t); s = 'first'; }
  }

  for (;;) {
    switch (s) {
      case 'loop':
        t = src[ip++];
        if (t >= 16) { s = 'match'; break; }
        if (t === 0) {
          while (src[ip] === 0) { t += 255; ip++; }
          t += 15 + src[ip++];
        }
        lit(t + 3);
        s = 'first';
        break;
      case 'first':
        t = src[ip++];
        if (t >= 16) { s = 'match'; break; }
        m = op - 0x801 - (t >> 2) - (src[ip++] << 2);
        cpy(m, 3);
        s = 'done';
        break;
      case 'match':
        if (t >= 64) {
          m = op - 1 - ((t >> 2) & 7) - (src[ip++] << 3);
          cpy(m, (t >> 5) + 1);
        } else if (t >= 32) {
          t &= 31;
          if (t === 0) { while (src[ip] === 0) { t += 255; ip++; } t += 31 + src[ip++]; }
          m = op - 1 - ((src[ip] >> 2) + (src[ip + 1] << 6));
          ip += 2;
          cpy(m, t + 2);
        } else if (t >= 16) {
          m = op - ((t & 8) << 11);
          t &= 7;
          if (t === 0) { while (src[ip] === 0) { t += 255; ip++; } t += 7 + src[ip++]; }
          m -= (src[ip] >> 2) + (src[ip + 1] << 6);
          ip += 2;
          if (m === op) return op === dstLen ? dst : dst.subarray(0, op);
          m -= 0x4000;
          cpy(m, t + 2);
        } else {
          m = op - 1 - (t >> 2) - (src[ip++] << 2);
          cpy(m, 2);
        }
        s = 'done';
        break;
      case 'done':
        t = src[ip - 2] & 3;
        s = t === 0 ? 'loop' : 'next';
        break;
      case 'next':
        lit(t);
        t = src[ip++];
        s = 'match';
        break;
    }
    if (ip > src.length + 3) throw new Error('LZO: input overrun');
  }
}
