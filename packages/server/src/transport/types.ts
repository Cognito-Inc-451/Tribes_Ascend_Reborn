import type { TransportKind } from '@ar/shared';

export interface Connection {
  readonly kind: TransportKind;
  readonly remote: string;
  sendReliable(data: Uint8Array): void;
  sendUnreliable(data: Uint8Array): void;
  onMessage: (data: Uint8Array) => void;
  onClose: () => void;
  close(reason?: string): void;
  backlog(): number;
}

/** Length-prefixed framing for byte streams (WebTransport reliable stream). */
export class FrameDecoder {
  private buf = new Uint8Array(0);

  push(chunk: Uint8Array, emit: (frame: Uint8Array) => void, maxFrame = 8 * 1024 * 1024): boolean {
    const merged = new Uint8Array(this.buf.length + chunk.length);
    merged.set(this.buf);
    merged.set(chunk, this.buf.length);
    let off = 0;
    while (merged.length - off >= 4) {
      const len = new DataView(merged.buffer, merged.byteOffset + off, 4).getUint32(0, true);
      if (len > maxFrame) return false;
      if (merged.length - off - 4 < len) break;
      emit(merged.slice(off + 4, off + 4 + len));
      off += 4 + len;
    }
    this.buf = merged.slice(off);
    return true;
  }
}

export function frame(data: Uint8Array): Uint8Array {
  const out = new Uint8Array(data.length + 4);
  new DataView(out.buffer).setUint32(0, data.length, true);
  out.set(data, 4);
  return out;
}
