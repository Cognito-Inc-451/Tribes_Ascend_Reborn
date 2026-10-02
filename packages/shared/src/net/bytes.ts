export class ByteWriter {
  private buf: ArrayBuffer;
  private view: DataView;
  private arr: Uint8Array;
  off = 0;

  constructor(size = 1024) {
    this.buf = new ArrayBuffer(size);
    this.view = new DataView(this.buf);
    this.arr = new Uint8Array(this.buf);
  }

  private ensure(n: number) {
    if (this.off + n <= this.buf.byteLength) return;
    let size = this.buf.byteLength * 2;
    while (size < this.off + n) size *= 2;
    const nb = new ArrayBuffer(size);
    new Uint8Array(nb).set(this.arr);
    this.buf = nb;
    this.view = new DataView(nb);
    this.arr = new Uint8Array(nb);
  }

  u8(v: number) { this.ensure(1); this.view.setUint8(this.off, v); this.off += 1; return this; }
  i8(v: number) { this.ensure(1); this.view.setInt8(this.off, v); this.off += 1; return this; }
  u16(v: number) { this.ensure(2); this.view.setUint16(this.off, v, true); this.off += 2; return this; }
  i16(v: number) { this.ensure(2); this.view.setInt16(this.off, v, true); this.off += 2; return this; }
  u32(v: number) { this.ensure(4); this.view.setUint32(this.off, v >>> 0, true); this.off += 4; return this; }
  i32(v: number) { this.ensure(4); this.view.setInt32(this.off, v, true); this.off += 4; return this; }
  f32(v: number) { this.ensure(4); this.view.setFloat32(this.off, v, true); this.off += 4; return this; }
  f64(v: number) { this.ensure(8); this.view.setFloat64(this.off, v, true); this.off += 8; return this; }
  bytes(b: Uint8Array) { this.ensure(b.length); this.arr.set(b, this.off); this.off += b.length; return this; }
  str(s: string) { const b = new TextEncoder().encode(s); this.u16(b.length); this.bytes(b); return this; }
  finish(): Uint8Array { return this.arr.slice(0, this.off); }
}

export class ByteReader {
  private view: DataView;
  off = 0;

  constructor(private data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }

  get remaining() { return this.data.byteLength - this.off; }
  u8() { const v = this.view.getUint8(this.off); this.off += 1; return v; }
  i8() { const v = this.view.getInt8(this.off); this.off += 1; return v; }
  u16() { const v = this.view.getUint16(this.off, true); this.off += 2; return v; }
  i16() { const v = this.view.getInt16(this.off, true); this.off += 2; return v; }
  u32() { const v = this.view.getUint32(this.off, true); this.off += 4; return v; }
  i32() { const v = this.view.getInt32(this.off, true); this.off += 4; return v; }
  f32() { const v = this.view.getFloat32(this.off, true); this.off += 4; return v; }
  f64() { const v = this.view.getFloat64(this.off, true); this.off += 8; return v; }
  bytes(n: number) { const b = this.data.subarray(this.off, this.off + n); this.off += n; return b; }
  str() { const n = this.u16(); return new TextDecoder().decode(this.bytes(n)); }
}
