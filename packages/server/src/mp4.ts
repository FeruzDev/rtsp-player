/**
 * Minimal fragmented-MP4 stream parser.
 * Splits ffmpeg's `-movflags frag_keyframe+empty_moov` output into an init segment
 * (ftyp + moov) and media segments (moof + mdat), detecting keyframes and the codec string.
 */

interface BoxRef {
  type: string;
  start: number;
  end: number;
}

function* childBoxes(buf: Buffer, start: number, end: number): Generator<BoxRef> {
  let p = start;
  while (p + 8 <= end) {
    const size = buf.readUInt32BE(p);
    if (size < 8 || p + size > end) return;
    yield { type: buf.toString('ascii', p + 4, p + 8), start: p, end: p + size };
    p += size;
  }
}

const hex2 = (n: number) => n.toString(16).padStart(2, '0');

function reverseBits32(n: number): number {
  let r = 0;
  for (let i = 0; i < 32; i++) {
    r = (r << 1) | (n & 1);
    n >>>= 1;
  }
  return r >>> 0;
}

/** Builds an RFC 6381 codec string (e.g. `avc1.64001f`) from a `moov` box. */
export function codecFromInit(init: Buffer): string {
  const codecs: string[] = [];

  const avcC = init.indexOf('avcC');
  const hvcC = init.indexOf('hvcC');
  if (avcC > 0) {
    codecs.push(`avc1.${hex2(init[avcC + 5])}${hex2(init[avcC + 6])}${hex2(init[avcC + 7])}`);
  } else if (hvcC > 0) {
    const entry = init.indexOf('hev1') > 0 ? 'hev1' : 'hvc1';
    const b = hvcC + 4; // payload start (configurationVersion)
    const p = init[b + 1];
    const space = ['', 'A', 'B', 'C'][p >> 6];
    const tier = (p >> 5) & 1 ? 'H' : 'L';
    const profile = p & 0x1f;
    const compat = reverseBits32(init.readUInt32BE(b + 2)).toString(16);
    const constraints: string[] = [];
    for (let i = 0; i < 6; i++) constraints.push(hex2(init[b + 6 + i]).toUpperCase());
    while (constraints.length && constraints[constraints.length - 1] === '00') constraints.pop();
    const level = init[b + 12];
    codecs.push([`${entry}.${space}${profile}`, compat, `${tier}${level}`, ...constraints].join('.'));
  }

  if (init.indexOf('mp4a') > 0) codecs.push('mp4a.40.2');
  return codecs.join(',');
}

/** Returns `true` when the first sample of the first track fragment is a sync sample. */
export function isKeyframeFragment(moof: Buffer): boolean {
  for (const traf of childBoxes(moof, 8, moof.length)) {
    if (traf.type !== 'traf') continue;
    let defaultFlags: number | undefined;
    for (const box of childBoxes(moof, traf.start + 8, traf.end)) {
      if (box.type === 'tfhd') {
        const flags = moof.readUInt32BE(box.start + 8) & 0xffffff;
        let p = box.start + 16; // after version/flags + track_ID
        if (flags & 0x1) p += 8;
        if (flags & 0x2) p += 4;
        if (flags & 0x8) p += 4;
        if (flags & 0x10) p += 4;
        if (flags & 0x20) defaultFlags = moof.readUInt32BE(p);
      } else if (box.type === 'trun') {
        const flags = moof.readUInt32BE(box.start + 8) & 0xffffff;
        let p = box.start + 16; // after version/flags + sample_count
        if (flags & 0x1) p += 4;
        let sampleFlags: number | undefined;
        if (flags & 0x4) {
          sampleFlags = moof.readUInt32BE(p);
        } else if (flags & 0x400) {
          if (flags & 0x100) p += 4;
          if (flags & 0x200) p += 4;
          sampleFlags = moof.readUInt32BE(p);
        } else {
          sampleFlags = defaultFlags;
        }
        if (sampleFlags === undefined) return true;
        const nonSync = (sampleFlags >> 16) & 1;
        return nonSync === 0;
      }
    }
    return true; // first traf only
  }
  return true;
}

export interface Mp4SegmenterEvents {
  onInit: (init: Buffer, codec: string) => void;
  onSegment: (segment: Buffer, keyframe: boolean) => void;
}

export class Mp4Segmenter {
  private chunks: Buffer[] = [];
  private length = 0;
  private initParts: Buffer[] = [];
  private moof: Buffer | null = null;

  constructor(private readonly events: Mp4SegmenterEvents) {}

  push(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.length += chunk.length;

    while (this.length >= 8) {
      const head = this.peek(16);
      let size = head.readUInt32BE(0);
      if (size === 1) {
        if (head.length < 16) return;
        size = Number(head.readBigUInt64BE(8));
      }
      if (size < 8) throw new Error(`Invalid MP4 box size ${size}`);
      if (this.length < size) return;
      const box = this.take(size);
      this.handle(box.toString('ascii', 4, 8), box);
    }
  }

  private peek(n: number): Buffer {
    if (this.chunks[0].length >= n || this.chunks.length === 1) return this.chunks[0].subarray(0, n);
    const merged = Buffer.concat(this.chunks);
    this.chunks = [merged];
    return merged.subarray(0, n);
  }

  private take(n: number): Buffer {
    const merged = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const box = merged.subarray(0, n);
    const rest = merged.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.length -= n;
    return Buffer.from(box);
  }

  private handle(type: string, box: Buffer): void {
    switch (type) {
      case 'ftyp':
        this.initParts = [box];
        break;
      case 'moov': {
        this.initParts.push(box);
        const init = Buffer.concat(this.initParts);
        this.events.onInit(init, codecFromInit(init));
        break;
      }
      case 'moof':
        this.moof = box;
        break;
      case 'mdat':
        if (this.moof) {
          const keyframe = isKeyframeFragment(this.moof);
          this.events.onSegment(Buffer.concat([this.moof, box]), keyframe);
          this.moof = null;
        }
        break;
      default:
        // styp, sidx, mfra, free... are not needed for MSE playback
        break;
    }
  }
}
