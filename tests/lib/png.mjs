/* 极简 PNG 解码（零依赖）
 *
 * 为什么要自己写：
 *   「近黑渐变上有没有色带」这种问题**只能从像素里数出来**。
 *   压缩过的截图肉眼看不出，缩略图更看不出 ——
 *   而这个项目的测试是零 npm 依赖的，不想为了读一张 PNG 引 sharp。
 *
 * 只支持 8 位、非隔行、colorType 2(RGB) / 6(RGBA) ——
 * Chromium 的截图就这两种。别的组合**直接抛错**，不静默给错数据：
 * 一个悄悄返回错误像素的解码器，会让上面所有测量都变成假数据。
 *
 * PNG 结构（够用就行）：
 *   8 字节签名 → 若干 chunk（长度4 + 类型4 + 数据 + CRC4）→ IEND
 *   像素数据在 IDAT 里（可能多个，要拼起来再 inflate）
 *   解压后是逐行的：每行开头 1 字节 filter，后面是 宽 × 通道数 字节
 */
import fs from 'node:fs';
import zlib from 'node:zlib';

const SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** 把一行解 filter（五种，Paeth 是最后一种也是最常用的一种） */
function unfilter(cur, prev, filter, bpp) {
  const n = cur.length;
  for (let x = 0; x < n; x++) {
    const a = x >= bpp ? cur[x - bpp] : 0;   // 左
    const b = prev[x];                        // 上
    const c = x >= bpp ? prev[x - bpp] : 0;   // 左上
    let v = cur[x];
    if (filter === 1) v += a;
    else if (filter === 2) v += b;
    else if (filter === 3) v += (a + b) >> 1;
    else if (filter === 4) {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    } else if (filter !== 0) {
      throw new Error(`未知的行 filter ${filter}`);
    }
    cur[x] = v & 0xff;
  }
}

export function decodePng(file) {
  return decodePngBuffer(fs.readFileSync(file));
}

/** 同一套解码，但直接吃 Buffer —— 给「截图数据在内存里、不落盘」的调用方用
 *  （banding.mjs 自己采集时就是这种情况）。 */
export function decodePngBuffer(buf) {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(SIG)) {
    throw new Error('不是 PNG（签名对不上）');
  }

  let off = 8;
  let ihdr = null;
  const idat = [];
  while (off + 8 <= buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      ihdr = {
        width: data.readUInt32BE(0),
        height: data.readUInt32BE(4),
        bitDepth: data[8],
        colorType: data[9],
        interlace: data[12],
      };
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }

  if (!ihdr) throw new Error('PNG 里没有 IHDR');
  if (ihdr.bitDepth !== 8) throw new Error(`只支持 8 位，实得 ${ihdr.bitDepth}`);
  if (ihdr.interlace !== 0) throw new Error('不支持隔行 PNG');
  const ch = ihdr.colorType === 2 ? 3 : ihdr.colorType === 6 ? 4 : 0;
  if (!ch) throw new Error(`不支持的 colorType ${ihdr.colorType}（只做 2=RGB / 6=RGBA）`);

  const { width: w, height: h } = ihdr;
  const stride = w * ch;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  if (raw.length < (stride + 1) * h) {
    throw new Error(`像素数据不完整：期望 ${(stride + 1) * h} 字节，实得 ${raw.length}`);
  }

  const out = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < h; y++) {
    const base = y * (stride + 1);
    const filter = raw[base];
    const cur = Buffer.from(raw.subarray(base + 1, base + 1 + stride));
    unfilter(cur, prev, filter, ch);
    cur.copy(out, y * stride);
    prev = cur;
  }

  return { width: w, height: h, channels: ch, data: out };
}

/** 单点亮度，Rec.709。只用于比大小，不需要做色彩管理。 */
export function luma(img, x, y) {
  const i = (y * img.width + x) * img.channels;
  return 0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2];
}

/** 沿一列取亮度数组（闭开区间 [y0, y1)） */
export function columnLuma(img, x, y0, y1) {
  const out = new Array(Math.max(0, y1 - y0));
  for (let i = 0; i < out.length; i++) out[i] = luma(img, x, y0 + i);
  return out;
}

/** 中位数（会改传入数组的顺序，调用方自己复制） */
export function median(a) {
  if (!a.length) return NaN;
  const s = [...a].sort((p, q) => p - q);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
