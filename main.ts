// png-squeeze-01 entry: lossless PNG re-encoder.
// PNG codec + screening forms: make.fun's own kit code (MIT), see NOTICE.
// DEFLATE: original optimal-parse (zopfli-style) + lazy implementation.
// Deterministic: no clock, no randomness, no network, no file reads outside
// MAKEFUN_INPUT_DIR / the repo. Any failure still writes a valid output.
import { constants, deflateSync, inflateSync } from 'node:zlib';
import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// png-squeeze-01's PNG codec, make.fun's own (MIT): the one decoder the checker reads every answer with, and the pieces
// the generator, the reference and the house write PNGs with. It reads exactly the PNGs the contest accepts:
//
//   - the 8-byte signature, then chunks, each with its length, its type and a CRC-32 that matches;
//   - IHDR first: the image's width and height, bit depth 8, colour type 0 (grey), 2 (RGB), 3 (palette), 4 (grey and
//     alpha) or 6 (RGBA), compression 0, filter method 0, no interlace;
//   - PLTE only with colour type 3 (where it is required): 1 to 256 entries, before the first IDAT;
//   - tRNS at most once, before the first IDAT: with colour type 3 one alpha byte per palette entry (at most as many as
//     the palette has; the entries past it are opaque), with type 0 one grey sample and with type 2 one RGB triple (each
//     a two-byte sample of at most 255) marking the pixels of that exact value transparent; never with types 4 and 6;
//   - one or more IDAT chunks in a row, their data together one zlib stream that inflates to exactly height rows of a
//     filter byte (0 None, 1 Sub, 2 Up, 3 Average, 4 Paeth) and width x channels samples;
//   - IEND last, empty, and nothing after it.
// Any other chunk, ancillary or not, makes the file unread: a pixel means only its samples, never a gamma, a colour
// profile or a text. A palette index past the palette is unread too.



/** The PNG signature. */
const SIGNATURE = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);

/** Samples a pixel holds, by colour type (bit depth 8). */
const CHANNELS = Object.freeze({ 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 });

/** The chunk types the decoder reads; any other makes the file unread. */
const CHUNKS = Object.freeze(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

/** CRC-32 (ISO 3309, PNG's) of bytes[start, end). */
function crc32(bytes, start = 0, end = bytes.length) {
  let c = -1;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

/** Adler-32 (zlib's) of bytes. */
function adler32(bytes) {
  let a = 1;
  let b = 0;
  for (let i = 0; i < bytes.length; ) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) {
      a += bytes[i];
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

const ascii = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0));

/** A PNG file of `chunks`, each [type, data]: the signature, then each chunk with its length and CRC. */
function pngOf(chunks) {
  let size = SIGNATURE.length;
  for (const [, data] of chunks) size += 12 + data.length;
  const out = new Uint8Array(size);
  const view = new DataView(out.buffer);
  out.set(SIGNATURE, 0);
  let at = SIGNATURE.length;
  for (const [type, data] of chunks) {
    view.setUint32(at, data.length);
    out.set(ascii(type), at + 4);
    out.set(data, at + 8);
    view.setUint32(at + 8 + data.length, crc32(out, at + 4, at + 8 + data.length));
    at += 12 + data.length;
  }
  return out;
}

/** IHDR's data: width, height, bit depth 8, the colour type, compression 0, filter 0, no interlace. */
function ihdrOf(width, height, colourType) {
  const d = new Uint8Array(13);
  const v = new DataView(d.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  d[8] = 8;
  d[9] = colourType;
  return d;
}

/** A zlib stream of `raw` in stored (uncompressed) deflate blocks of at most 65,535 bytes. */
function storedZlib(raw) {
  const blocks = Math.max(1, Math.ceil(raw.length / 65535));
  const out = new Uint8Array(2 + raw.length + 5 * blocks + 4);
  out[0] = 0x78;
  out[1] = 0x01;
  let at = 2;
  for (let k = 0; k < blocks; k++) {
    const from = k * 65535;
    const len = Math.min(65535, raw.length - from);
    out[at] = k === blocks - 1 ? 1 : 0;
    out[at + 1] = len & 0xff;
    out[at + 2] = len >>> 8;
    out[at + 3] = ~len & 0xff;
    out[at + 4] = (~len >>> 8) & 0xff;
    out.set(raw.subarray(from, from + len), at + 5);
    at += 5 + len;
  }
  new DataView(out.buffer).setUint32(at, adler32(raw));
  return out;
}

/** The rows of an RGBA image, each behind filter byte 0 (None): the raw data of a colour type 6 PNG. */
function unfilteredRgba(rgba, width, height) {
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  return raw;
}

/** The stored PNG of an RGBA image: colour type 6, every row unfiltered, the zlib stream in stored blocks. */
function storedPng(rgba, width, height) {
  return pngOf([
    ['IHDR', ihdrOf(width, height, 6)],
    ['IDAT', storedZlib(unfilteredRgba(rgba, width, height))],
    ['IEND', new Uint8Array(0)],
  ]);
}

/** The Paeth predictor of PNG's filter 4. */
function paeth(a, b, c) {
  const p = a + b - c;
  const pa = p > a ? p - a : a - p;
  const pb = p > b ? p - b : b - p;
  const pc = p > c ? p - c : c - p;
  if (pa <= pb && pa <= pc) return a;
  return pb <= pc ? b : c;
}

/**
 * Row `cur` (stride samples, bpp a pixel, `prev` the row above or null) filtered by `type` into out[0, stride).
 */
function filterRow(type, cur, prev, bpp, out) {
  const n = cur.length;
  if (type === 0) out.set(cur);
  else if (type === 1) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (i >= bpp ? cur[i - bpp] : 0);
  } else if (type === 2) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (prev === null ? 0 : prev[i]);
  } else if (type === 3) {
    for (let i = 0; i < n; i++) out[i] = cur[i] - (((i >= bpp ? cur[i - bpp] : 0) + (prev === null ? 0 : prev[i])) >> 1);
  } else {
    for (let i = 0; i < n; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev === null ? 0 : prev[i];
      const c = prev !== null && i >= bpp ? prev[i - bpp] : 0;
      out[i] = cur[i] - paeth(a, b, c);
    }
  }
}

/** The sum of a filtered row's bytes read as signed (-128 to 127), absolute: the minimum-sum heuristic's cost. */
function signedSum(row) {
  let s = 0;
  for (let i = 0; i < row.length; i++) {
    const v = row[i];
    s += v < 128 ? v : 256 - v;
  }
  return s;
}

/**
 * The raw data of an image of `samples` (height rows of width x bpp samples): each row behind its filter byte.
 * `choose` is a filter type (0 to 4) for every row, or 'minsum': each row the type whose filtered bytes have the
 * least signedSum, the lower type on a tie.
 */
function filterImage(samples, width, height, bpp, choose) {
  const stride = width * bpp;
  const raw = new Uint8Array(height * (stride + 1));
  const trial = Array.from({ length: 5 }, () => new Uint8Array(stride));
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    let type = choose;
    if (choose === 'minsum') {
      let best = Infinity;
      for (let t = 0; t < 5; t++) {
        filterRow(t, cur, prev, bpp, trial[t]);
        const s = signedSum(trial[t]);
        if (s < best) {
          best = s;
          type = t;
        }
      }
      raw.set(trial[type], y * (stride + 1) + 1);
    } else {
      filterRow(type, cur, prev, bpp, raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
    }
    raw[y * (stride + 1)] = type;
  }
  return raw;
}

const fail = (why) => ({ ok: false, why });

/**
 * The image a PNG holds, as RGBA (4 bytes a pixel, rows top to bottom), or why it is not one the contest reads (the
 * header). `expect` {width, height}, when given, is the size the image must have.
 */
function decodePng(bytes, expect = null) {
  if (!(bytes instanceof Uint8Array)) return fail('it is not bytes');
  if (bytes.length < SIGNATURE.length || SIGNATURE.some((b, i) => bytes[i] !== b)) return fail('it does not start with the PNG signature');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let at = SIGNATURE.length;
  let header = null;
  let palette = null;
  let trns = null;
  const idat = [];
  let idatDone = false;
  let ended = false;
  while (at < bytes.length) {
    if (ended) return fail('it holds bytes after IEND');
    if (at + 12 > bytes.length) return fail(`a chunk at byte ${at} is cut short`);
    const len = view.getUint32(at);
    if (len > 0x7fffffff || at + 12 + len > bytes.length) return fail(`the chunk at byte ${at} claims ${len} bytes the file does not hold`);
    const type = String.fromCharCode(bytes[at + 4], bytes[at + 5], bytes[at + 6], bytes[at + 7]);
    if (!/^[A-Za-z]{4}$/.test(type)) return fail(`the chunk at byte ${at} has no chunk type (four letters)`);
    if (crc32(bytes, at + 4, at + 8 + len) !== view.getUint32(at + 8 + len)) return fail(`the ${type} chunk at byte ${at} fails its CRC`);
    const data = bytes.subarray(at + 8, at + 8 + len);
    at += 12 + len;
    if (!CHUNKS.includes(type)) return fail(`it holds a ${type} chunk, and only ${CHUNKS.join(', ')} are read`);
    if (header === null && type !== 'IHDR') return fail(`its first chunk is ${type}, not IHDR`);
    if (type !== 'IDAT' && idat.length > 0) idatDone = true;
    if (type === 'IHDR') {
      if (header !== null) return fail('it holds IHDR twice');
      if (len !== 13) return fail('its IHDR is not 13 bytes');
      const dv = new DataView(data.buffer, data.byteOffset, 13);
      header = { width: dv.getUint32(0), height: dv.getUint32(4), depth: data[8], colourType: data[9], compression: data[10], filter: data[11], interlace: data[12] };
      if (header.width === 0 || header.height === 0) return fail('its width or height is 0');
      if (expect !== null && (header.width !== expect.width || header.height !== expect.height)) return fail(`it is ${header.width} x ${header.height}, not ${expect.width} x ${expect.height}`);
      if (header.depth !== 8) return fail(`its bit depth is ${header.depth}, not 8`);
      if (!Object.hasOwn(CHANNELS, header.colourType)) return fail(`its colour type is ${header.colourType}, not 0, 2, 3, 4 or 6`);
      if (header.compression !== 0 || header.filter !== 0) return fail('its compression or filter method is not 0');
      if (header.interlace !== 0) return fail('it is interlaced');
    } else if (type === 'PLTE') {
      if (palette !== null) return fail('it holds PLTE twice');
      if (header.colourType !== 3) return fail(`it holds PLTE with colour type ${header.colourType} (only type 3 takes one)`);
      if (idat.length > 0) return fail('its PLTE follows IDAT');
      if (len === 0 || len % 3 !== 0 || len > 768) return fail('its PLTE is not 1 to 256 entries of 3 bytes');
      palette = data;
    } else if (type === 'tRNS') {
      if (trns !== null) return fail('it holds tRNS twice');
      if (idat.length > 0) return fail('its tRNS follows IDAT');
      const ct = header.colourType;
      if (ct === 3) {
        if (palette === null) return fail('its tRNS comes before PLTE');
        if (len > palette.length / 3) return fail('its tRNS holds more entries than its palette');
      } else if (ct === 0 || ct === 2) {
        if (len !== (ct === 0 ? 2 : 6)) return fail(`its tRNS is not ${ct === 0 ? 2 : 6} bytes for colour type ${ct}`);
        for (let i = 0; i < len; i += 2) if (data[i] !== 0) return fail('its tRNS names a sample over 255');
      } else return fail(`it holds tRNS with colour type ${ct}`);
      trns = data;
    } else if (type === 'IDAT') {
      if (idatDone) return fail('its IDAT chunks are not in a row');
      if (header.colourType === 3 && palette === null) return fail('its IDAT comes before PLTE (colour type 3 needs one)');
      idat.push(data);
    } else {
      if (len !== 0) return fail('its IEND is not empty');
      ended = true;
    }
  }
  if (!ended) return fail('it has no IEND');
  if (idat.length === 0) return fail('it has no IDAT');
  const { width, height, colourType } = header;
  const bpp = CHANNELS[colourType];
  const stride = width * bpp;
  const expected = height * (stride + 1);
  if (!Number.isSafeInteger(expected) || expected > 1 << 30) return fail('its image is too large to read');
  let raw;
  try {
    raw = inflateSync(idat.length === 1 ? idat[0] : Buffer.concat(idat), { maxOutputLength: expected + 1 });
  } catch (err) {
    return fail(`its IDAT data is not one whole zlib stream of ${expected} bytes (${String(err && err.message).split('\n')[0]})`);
  }
  if (raw.length !== expected) return fail(`its IDAT data inflates to ${raw.length} bytes, not ${expected}`);

  // Unfilter in place, row by row.
  const samples = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const ft = raw[y * (stride + 1)];
    if (ft > 4) return fail(`row ${y} has filter type ${ft}`);
    const src = y * (stride + 1) + 1;
    const o = y * stride;
    const p = o - stride;
    if (ft === 0) samples.set(raw.subarray(src, src + stride), o);
    else if (ft === 1) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (i >= bpp ? samples[o + i - bpp] : 0);
    } else if (ft === 2) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (y > 0 ? samples[p + i] : 0);
    } else if (ft === 3) {
      for (let i = 0; i < stride; i++) samples[o + i] = raw[src + i] + (((i >= bpp ? samples[o + i - bpp] : 0) + (y > 0 ? samples[p + i] : 0)) >> 1);
    } else {
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? samples[o + i - bpp] : 0;
        const b = y > 0 ? samples[p + i] : 0;
        const c = y > 0 && i >= bpp ? samples[p + i - bpp] : 0;
        samples[o + i] = raw[src + i] + paeth(a, b, c);
      }
    }
  }

  // Expand to RGBA.
  const n = width * height;
  const rgba = new Uint8Array(n * 4);
  if (colourType === 6) rgba.set(samples);
  else if (colourType === 2) {
    const key = trns === null ? -1 : (trns[1] << 16) | (trns[3] << 8) | trns[5];
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 3, d += 4) {
      rgba[d] = samples[s];
      rgba[d + 1] = samples[s + 1];
      rgba[d + 2] = samples[s + 2];
      rgba[d + 3] = ((samples[s] << 16) | (samples[s + 1] << 8) | samples[s + 2]) === key ? 0 : 255;
    }
  } else if (colourType === 0) {
    const key = trns === null ? -1 : trns[1];
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const g = samples[i];
      rgba[d] = rgba[d + 1] = rgba[d + 2] = g;
      rgba[d + 3] = g === key ? 0 : 255;
    }
  } else if (colourType === 4) {
    for (let i = 0, s = 0, d = 0; i < n; i++, s += 2, d += 4) {
      rgba[d] = rgba[d + 1] = rgba[d + 2] = samples[s];
      rgba[d + 3] = samples[s + 1];
    }
  } else {
    const entries = palette.length / 3;
    const lut = new Uint8Array(entries * 4);
    for (let e = 0; e < entries; e++) {
      lut[e * 4] = palette[e * 3];
      lut[e * 4 + 1] = palette[e * 3 + 1];
      lut[e * 4 + 2] = palette[e * 3 + 2];
      lut[e * 4 + 3] = trns !== null && e < trns.length ? trns[e] : 255;
    }
    for (let i = 0, d = 0; i < n; i++, d += 4) {
      const e = samples[i];
      if (e >= entries) return fail(`pixel (${i % width}, ${Math.floor(i / width)}) names palette entry ${e} of ${entries}`);
      rgba[d] = lut[e * 4];
      rgba[d + 1] = lut[e * 4 + 1];
      rgba[d + 2] = lut[e * 4 + 2];
      rgba[d + 3] = lut[e * 4 + 3];
    }
  }
  return { ok: true, width, height, colourType, rgba };
}

// png-squeeze-01's screen, make.fun's own (MIT): the forms and filters an image can be written in, each weighed by
// zlib, and the scale compressor the generator states each key from (generate.mjs scalePng). The reference compressor
// (reference/squeeze.mjs) screens the same way and writes its winner with its own deflate. Lossless: every pixel's four
// channels decode back exactly (png.mjs decodePng).
//
// The choices that hold the image exactly:
//   - the colour type: a palette (type 3, its transparent entries first so tRNS is short) when the image has at most
//     256 colours, its other entries by count or by luminance; grey (type 0) or grey and alpha (type 4) when every
//     pixel is grey; RGB (type 2) or RGBA (type 6) otherwise; with one fully transparent value that no opaque pixel
//     uses and every other pixel opaque, type 0 or 2 with a tRNS key instead of an alpha channel. A palette of an image
//     that is not grey holds it in a third of the bytes of RGB or less, so its RGB or RGBA form is not tried;
//   - the filters (FILTERS): every row unfiltered, or every row one fixed filter, or each row its own: the minimum-sum
//     heuristic (the PNG specification's section 12.8), the fewest distinct byte pairs, or brute force (each of the
//     five filters compressed by zlib after the 32 KiB written before it, the smallest kept). A palette by count is
//     tried unfiltered only, a palette by luminance unfiltered, by the minimum sum and by brute force.
// The screen (screen): each choice's filtered data compressed by zlib at SCREEN (level 6), the smallest the winner,
// the first on a tie, each weighed with its PLTE and tRNS chunks: one zlib run a choice, at a level whose match search
// visits at most 128 candidates a position, so its cost is bounded by the image's size.
//
// The scale (scalePng): the screen without brute force (the one choice that costs five zlib runs a row), its winner
// written with that zlib stream as it is. Its bytes are each key's scale_bytes: about 2 s a set of 8 at one CPU, so a
// draw stays well inside its wall. The reference screens brute force too and keeps its own deflate's stream only when
// it is smaller, so it never writes more bytes than the scale.




/** The image's pixels as 32-bit words (a copy when its bytes do not start on a word boundary). */
function wordsOf(rgba) {
  const at = rgba.byteOffset % 4 === 0 ? rgba : rgba.slice();
  return new Uint32Array(at.buffer, at.byteOffset, at.length >>> 2);
}

/** What the image holds: whether every pixel is opaque, whether every pixel is grey, and its colours when at most 256. */
function analyse(rgba) {
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  let opaque = true;
  let grey = true;
  const counts = new Map();
  let many = false;
  for (let i = 0, d = 0; i < n; i++, d += 4) {
    if (rgba[d + 3] !== 255) opaque = false;
    if (rgba[d] !== rgba[d + 1] || rgba[d] !== rgba[d + 2]) grey = false;
    if (!many) {
      const c = u32[i];
      const k = counts.get(c);
      if (k === undefined) {
        if (counts.size === 256) many = true;
        else counts.set(c, 1);
      } else counts.set(c, k + 1);
    }
  }
  // A colour as [r, g, b, a] whatever the platform's byte order: read back from the bytes, never from the word.
  const colours = many ? null : [...counts.keys()].map((c) => {
    const b = new Uint8Array(Uint32Array.of(c).buffer);
    return { rgba: [b[0], b[1], b[2], b[3]], word: c, count: counts.get(c) };
  });
  return { opaque, grey, colours };
}

/**
 * The one fully transparent value (grey or RGB) the image may key by tRNS instead of an alpha channel: every pixel
 * opaque or that exact value at alpha 0, and no opaque pixel of the same value. Null when there is none.
 */
function transparentKey(rgba, grey) {
  let key = -1;
  for (let d = 0; d < rgba.length; d += 4) {
    const a = rgba[d + 3];
    if (a === 255) continue;
    if (a !== 0) return null;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (key === -1) key = v;
    else if (key !== v) return null;
  }
  if (key === -1) return null;
  for (let d = 0; d < rgba.length; d += 4) {
    if (rgba[d + 3] !== 255) continue;
    const v = grey ? rgba[d] : (rgba[d] << 16) | (rgba[d + 1] << 8) | rgba[d + 2];
    if (v === key) return null;
  }
  return key;
}

/** The image's samples in colour type `ct` (0, 2, 4 or 6) from its RGBA. */
function samplesOf(rgba, ct) {
  const n = rgba.length >>> 2;
  if (ct === 6) return rgba;
  const ch = ct === 0 ? 1 : ct === 4 ? 2 : 3;
  const out = new Uint8Array(n * ch);
  for (let i = 0, d = 0, s = 0; i < n; i++, d += 4, s += ch) {
    if (ct === 0) out[s] = rgba[d];
    else if (ct === 4) {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 3];
    } else {
      out[s] = rgba[d];
      out[s + 1] = rgba[d + 1];
      out[s + 2] = rgba[d + 2];
    }
  }
  return out;
}

/** A palette's entries in the order a trial writes them: the transparent ones first (by alpha), then by `order`. */
function paletteOrder(colours, order) {
  const lum = (c) => 299 * c.rgba[0] + 587 * c.rgba[1] + 114 * c.rgba[2];
  return [...colours].sort((x, y) => {
    const ta = x.rgba[3] === 255 ? 1 : 0;
    const tb = y.rgba[3] === 255 ? 1 : 0;
    if (ta !== tb) return ta - tb;
    if (ta === 0 && x.rgba[3] !== y.rgba[3]) return x.rgba[3] - y.rgba[3];
    if (order === 'luminance') return lum(x) - lum(y) || x.word - y.word;
    return y.count - x.count || x.word - y.word;
  });
}

/** The palette form: {plte, trns, indices}. */
function paletteForm(rgba, colours, order) {
  const entries = paletteOrder(colours, order);
  const index = new Map(entries.map((c, i) => [c.word, i]));
  const plte = new Uint8Array(entries.length * 3);
  let transparent = 0;
  entries.forEach((c, i) => {
    plte[i * 3] = c.rgba[0];
    plte[i * 3 + 1] = c.rgba[1];
    plte[i * 3 + 2] = c.rgba[2];
    if (c.rgba[3] !== 255) transparent = i + 1;
  });
  const trns = transparent === 0 ? null : Uint8Array.from(entries.slice(0, transparent), (c) => c.rgba[3]);
  const n = rgba.length >>> 2;
  const u32 = wordsOf(rgba);
  const indices = new Uint8Array(n);
  for (let i = 0; i < n; i++) indices[i] = index.get(u32[i]);
  return { plte, trns, indices };
}

/** The zlib setting every choice is screened by, and the stream the scale's PNG holds. */
const SCREEN = Object.freeze({ level: 6, memLevel: 8, strategy: constants.Z_DEFAULT_STRATEGY });

/** How many bytes written before a row brute force compresses its trials after. */
const BRUTE_CONTEXT = 32768;
/** The zlib level brute force weighs a row's trials at. */
const BRUTE_LEVEL = 4;

/** The fewest-distinct-pairs heuristic's cost: how many distinct pairs of neighbouring bytes a filtered row holds. */
function pairsOf(row, seen, stamp) {
  let n = 0;
  for (let i = 1; i < row.length; i++) {
    const pair = (row[i - 1] << 8) | row[i];
    if (seen[pair] !== stamp) {
      seen[pair] = stamp;
      n++;
    }
  }
  return n;
}

/**
 * The raw data of an image of `samples` (height rows of width x bpp samples), each row behind its filter byte, by
 * `choice`: a filter type (0 to 4) for every row, or 'minsum', 'pairs' or 'brute' (the header), the lower type on a tie;
 * written into `raw` when it is given.
 */
function filtered(samples, width, height, bpp, choice, raw = new Uint8Array(height * (width * bpp + 1))) {
  const stride = width * bpp;
  const trial = Array.from({ length: 5 }, (_, t) => {
    const row = new Uint8Array(stride + 1);
    row[0] = t;
    return row;
  });
  const seen = new Uint32Array(65536);
  let stamp = 0;
  for (let y = 0; y < height; y++) {
    const cur = samples.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : samples.subarray((y - 1) * stride, y * stride);
    const at = y * (stride + 1);
    if (typeof choice === 'number') {
      raw[at] = choice;
      filterRow(choice, cur, prev, bpp, raw.subarray(at + 1, at + 1 + stride));
      continue;
    }
    const before = raw.subarray(Math.max(0, at - BRUTE_CONTEXT), at);
    let type = 0;
    let best = Infinity;
    for (let t = 0; t < 5; t++) {
      filterRow(t, cur, prev, bpp, trial[t].subarray(1));
      let cost;
      if (choice === 'minsum') cost = signedSum(trial[t].subarray(1));
      else if (choice === 'pairs') cost = pairsOf(trial[t].subarray(1), seen, ++stamp);
      else cost = deflateSync(trial[t], before.length === 0 ? { level: BRUTE_LEVEL, memLevel: 9 } : { level: BRUTE_LEVEL, memLevel: 9, dictionary: before }).length;
      if (cost < best) {
        best = cost;
        type = t;
      }
    }
    raw.set(trial[type], at);
  }
  return raw;
}

/** The filter choices each form is screened with. */
const FILTERS = Object.freeze({
  palette: Object.freeze([0]),
  paletteByLuminance: Object.freeze([0, 'minsum', 'brute']),
  channels: Object.freeze([0, 1, 2, 4, 'minsum', 'pairs', 'brute']),
});

/** The forms the reference screens for an image: each {colourType, bpp, samples, plte, trns, filters}. */
function formsOf(rgba) {
  const { opaque, grey, colours } = analyse(rgba);
  const forms = [];
  if (colours !== null) {
    for (const [order, filters] of [
      ['count', FILTERS.palette],
      ['luminance', FILTERS.paletteByLuminance],
    ]) {
      const p = paletteForm(rgba, colours, order);
      forms.push({ colourType: 3, bpp: 1, samples: p.indices, plte: p.plte, trns: p.trns, filters });
    }
    if (!grey) return forms;
  }
  const key = opaque ? null : transparentKey(rgba, grey);
  let ct;
  let trns = null;
  if (grey) {
    ct = opaque || key !== null ? 0 : 4;
    if (key !== null) trns = Uint8Array.of(0, key);
  } else {
    ct = opaque || key !== null ? 2 : 6;
    if (key !== null) trns = Uint8Array.of(0, key >>> 16, 0, (key >>> 8) & 0xff, 0, key & 0xff);
  }
  const bpp = { 0: 1, 2: 3, 4: 2, 6: 4 }[ct];
  forms.push({ colourType: ct, bpp, samples: samplesOf(rgba, ct), plte: null, trns, filters: FILTERS.channels });
  return forms;
}


/** The bytes a form's PLTE and tRNS chunks take in its file (each 12 bytes of length, type and CRC around its data). */
const chunkBytes = (form) => (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);

/**
 * The screen's winner for an image (the header's `screen`): its form, filter choice and filtered data, zlib's stream of
 * it at SCREEN and its weight (that stream's bytes and its form's PLTE and tRNS chunks); the first on a tie. Brute force
 * is screened unless `brute` is false.
 */
function screen(rgba, width, height, { brute = true } = {}) {
  let best = null;
  // The buffer the next choice is filtered into: a loser's, written again by a later choice of its size.
  let spare = null;
  for (const form of formsOf(rgba)) {
    const size = height * (width * form.bpp + 1);
    const chunks = chunkBytes(form);
    for (const choice of form.filters) {
      if (!brute && choice === 'brute') continue;
      const data = filtered(form.samples, width, height, form.bpp, choice, spare !== null && spare.length === size ? spare : new Uint8Array(size));
      spare = null;
      const zlib = deflateSync(data, SCREEN);
      const bytes = zlib.length + chunks;
      if (best === null || bytes < best.bytes) {
        if (best !== null) spare = best.data;
        best = { form, choice, data, zlib: new Uint8Array(zlib.buffer, zlib.byteOffset, zlib.length), bytes };
      } else spare = data;
    }
  }
  return best;
}

/** The PNG of an image of `form` whose IDAT holds the zlib stream `idat`. */
function pngOfForm(width, height, form, idat) {
  const chunks = [['IHDR', ihdrOf(width, height, form.colourType)]];
  if (form.plte !== null) chunks.push(['PLTE', form.plte]);
  if (form.trns !== null) chunks.push(['tRNS', form.trns]);
  chunks.push(['IDAT', idat]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

/** The scale's PNG of the image (the header): the screen's winner without brute force, in zlib's stream at SCREEN. */
function scalePng(rgba, width, height) {
  const { form, zlib } = screen(rgba, width, height, { brute: false });
  return pngOfForm(width, height, form, zlib);
}

// Optimal-parse DEFLATE (zopfli-style) in pure JS. Deterministic: no clock, no I/O.
// Input: Uint8Array of filtered PNG bytes. Output: a zlib stream (Uint8Array).
// Hash-chain LZ77 with lazy, cost-aware matching; iterative Huffman refinement;
// symbol stream split into blocks, each with its own dynamic (or static) tables.

const LEN_BASE = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
const LEN_EXTRA = [0,0,0,0,0,0,0,0,1,1,1,1,2,2,2,2,3,3,3,3,4,4,4,4,5,5,5,5,0];
const LEN_SYM = new Int16Array(259);
{ let s = 0; for (let l = 3; l <= 257; l++) { while (l > LEN_BASE[s] + (LEN_EXTRA[s] ? (1 << LEN_EXTRA[s]) - 1 : 0)) s++; LEN_SYM[l] = 257 + s; } LEN_SYM[258] = 285; }
const DIST_BASE = [1,2,3,4,5,7,9,13,17,25,33,49,65,97,129,193,257,385,513,769,1025,1537,2049,3073,4097,6145,8193,12289,16385,24577];
const DIST_EXTRA = [0,0,0,0,1,1,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9,10,10,11,11,12,12,13,13];
function distSym(d) { let s = 0; while (s < 29 && d > DIST_BASE[s] + (DIST_EXTRA[s] ? (1 << DIST_EXTRA[s]) - 1 : 0)) s++; return s; }

const FIXED_LIT_LEN = new Uint8Array(288);
{ for (let i = 0; i < 144; i++) FIXED_LIT_LEN[i] = 8; for (let i = 144; i < 256; i++) FIXED_LIT_LEN[i] = 9; for (let i = 256; i < 280; i++) FIXED_LIT_LEN[i] = 7; for (let i = 280; i < 288; i++) FIXED_LIT_LEN[i] = 8; }
const FIXED_DIST_LEN = new Uint8Array(32).fill(5);

function adler32d(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length;) {
    const end = Math.min(bytes.length, i + 5552);
    for (; i < end; i++) { a += bytes[i]; b += a; }
    a %= 65521; b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

// ---- Huffman lengths from frequencies (zlib-style overflow fix) ----
function buildLengths(freqs, maxLen) {
  const n = freqs.length;
  const lengths = new Uint8Array(n);
  let nz = 0, onlySym = -1;
  for (let i = 0; i < n; i++) if (freqs[i] > 0) { nz++; onlySym = i; }
  if (nz === 0) return lengths;
  if (nz === 1) { lengths[onlySym] = 1; return lengths; }
  const syms = [];
  for (let i = 0; i < n; i++) if (freqs[i] > 0) syms.push(i);
  syms.sort((a, b) => freqs[a] - freqs[b] || a - b);
  const w = [], left = [], right = [], isLeaf = [];
  let nodeCount = 0;
  const mkLeaf = (s) => { const id = nodeCount++; w[id] = freqs[s]; left[id] = -(s + 1); right[id] = -1; isLeaf[id] = true; return id; };
  const mkNode = (a, b) => { const id = nodeCount++; w[id] = w[a] + w[b]; left[id] = a; right[id] = b; isLeaf[id] = false; return id; };
  const q1 = syms.map(mkLeaf);
  const q2 = [];
  let i1 = 0;
  const takeMin = () => {
    if (i1 < q1.length && (q2.length === 0 || w[q1[i1]] <= w[q2[0]])) return q1[i1++];
    return q2.shift();
  };
  while (q1.length - i1 + q2.length > 1) { const a = takeMin(), b = takeMin(); q2.push(mkNode(a, b)); }
  const root = q2.length ? q2[0] : q1[i1];
  const stack = [[root, 0]];
  while (stack.length) {
    const [nd, d] = stack.pop();
    if (isLeaf[nd]) lengths[-left[nd] - 1] = d;
    else { stack.push([left[nd], d + 1]); stack.push([right[nd], d + 1]); }
  }
  // Length limiting by capping + exact Kraft repair (complete code guaranteed):
  // cap at maxLen, then repair the Kraft sum to exactly 2^maxLen.
  let maxL = 0;
  for (let i = 0; i < n; i++) if (lengths[i] > maxL) maxL = lengths[i];
  if (maxL <= maxLen) return lengths;
  for (let i = 0; i < n; i++) if (lengths[i] > maxLen) lengths[i] = maxLen;
  const kraftNum = () => { let k = 0; for (let i = 0; i < n; i++) if (lengths[i] > 0) k += 1 << (maxLen - lengths[i]); return k; };
  const FULL = 1 << maxLen;
  let k = kraftNum();
  // Over-subscribed: lengthen the least-frequent symbols (cheapest in bits).
  while (k > FULL) {
    let bi = -1, bf = Infinity;
    for (let i = 0; i < n; i++) if (freqs[i] > 0 && lengths[i] < maxLen && freqs[i] < bf) { bf = freqs[i]; bi = i; }
    if (bi < 0) break;
    k -= 1 << (maxLen - lengths[bi] - 1);
    lengths[bi]++;
  }
  // Incomplete: shorten symbols, longest first, so each step's Kraft gain
  // divides the deficit and the sum lands exactly on FULL.
  let guard = 0;
  while (k < FULL && guard++ < 100000) {
    const deficit = FULL - k;
    let bi = -1, bf = -1, bl = -1;
    for (let i = 0; i < n; i++) if (freqs[i] > 0 && lengths[i] > 1) {
      const gain = 1 << (maxLen - lengths[i]);
      if (gain <= deficit && (lengths[i] > bl || (lengths[i] === bl && freqs[i] > bf))) { bl = lengths[i]; bf = freqs[i]; bi = i; }
    }
    if (bi < 0) break;
    k += 1 << (maxLen - bl);
    lengths[bi]--;
  }
  return lengths;
}

function canonicalCodes(lengths) {
  const n = lengths.length;
  const codes = new Uint32Array(n);
  const blCount = new Int32Array(16);
  for (let i = 0; i < n; i++) if (lengths[i] > 0) blCount[lengths[i]]++;
  const next = new Uint32Array(16);
  let code = 0;
  for (let b = 1; b <= 15; b++) { code = (code + blCount[b - 1]) << 1; next[b] = code; }
  for (let i = 0; i < n; i++) { const l = lengths[i]; if (l > 0) codes[i] = next[l]++; }
  return codes;
}

class BitWriter {
  constructor(cap) { this.buf = new Uint8Array(cap); this.pos = 0; this.bitbuf = 0; this.bitcnt = 0; }
  write(code, len) { // LSB-first: header fields, extra bits
    this.bitbuf |= (code << this.bitcnt) >>> 0;
    this.bitcnt += len;
    while (this.bitcnt >= 8) { this.buf[this.pos++] = this.bitbuf & 0xff; this.bitbuf >>>= 8; this.bitcnt -= 8; }
  }
  writeRev(code, len) { // Huffman codes are packed MSB-first: reverse then write LSB-first
    let r = 0;
    for (let i = 0; i < len; i++) { r = (r << 1) | ((code >>> i) & 1); }
    this.write(r, len);
  }
  align() { if (this.bitcnt > 0) { this.buf[this.pos++] = this.bitbuf & 0xff; this.bitbuf = 0; this.bitcnt = 0; } }
  bytes() { return this.buf.subarray(0, this.pos); }
}

const HASH_BITS = 15, HASH_SIZE = 1 << HASH_BITS, HASH_MASK = HASH_SIZE - 1;
const MAX_CHAIN = 1024, NICE_LEN = 258, MIN_MATCH = 3, MAX_MATCH = 258, WINDOW = 32768;
function hash3(d, i) { return (((d[i] << 10) ^ (d[i + 1] << 5) ^ d[i + 2]) & HASH_MASK); }

function longestMatch(d, n, i, head, prev) {
  if (i + MIN_MATCH > n) return [0, 0];
  const h = hash3(d, i);
  let cand = head[h];
  let bestLen = 0, bestDist = 0, steps = 0;
  const maxLen = Math.min(MAX_MATCH, n - i);
  while (cand >= 0 && steps++ < MAX_CHAIN) {
    const dist = i - cand;
    if (dist <= 0) { cand = prev[cand]; continue; }
    if (dist > WINDOW) break;
    if (bestLen > 0) {
      // Quick reject on the byte past the current best, then verify the whole match.
      if (bestLen < maxLen && d[cand + bestLen] === d[i + bestLen]) {
        let l = 0;
        while (l < maxLen && d[cand + l] === d[i + l]) l++;
        if (l > bestLen) { bestLen = l; bestDist = dist; if (l >= NICE_LEN) break; }
      }
    } else if (d[cand] === d[i] && d[cand + 1] === d[i + 1] && d[cand + 2] === d[i + 2]) {
      let l = 3;
      while (l < maxLen && d[cand + l] === d[i + l]) l++;
      bestLen = l; bestDist = dist;
      if (l >= NICE_LEN) break;
    }
    cand = prev[cand];
  }
  return [bestLen, bestDist];
}

function parse(d, litLen, distLen, head, prev) {
  const n = d.length;
  const pref = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) pref[i + 1] = pref[i] + litLen[d[i]];
  const lenCost = new Float64Array(259);
  for (let l = 3; l <= 258; l++) lenCost[l] = litLen[LEN_SYM[l]] + LEN_EXTRA[LEN_SYM[l] - 257];
  const distCost = new Float64Array(30);
  for (let s = 0; s < 30; s++) distCost[s] = distLen[s] + DIST_EXTRA[s];
  const lit = new Int32Array(n + 16), dst = new Int32Array(n + 16);
  const le = new Int16Array(n + 16), de = new Int16Array(n + 16);
  const pos = new Int32Array(n + 16);
  let count = 0;
  head.fill(-1);
  let i = 0;
  const insert = (p) => { if (p + 2 < n) { const h = hash3(d, p); prev[p] = head[h]; head[h] = p; } };
  while (i < n) {
    const [len, dist] = longestMatch(d, n, i, head, prev);
    insert(i);
    if (len >= MIN_MATCH) {
      let take = true;
      if (len < NICE_LEN && i + 1 < n) {
        const [len2] = longestMatch(d, n, i + 1, head, prev);
        if (len2 > len) take = false;
      }
      if (take) {
        const ds = distSym(dist);
        const mc = lenCost[len] + distCost[ds];
        const lc = pref[i + len] - pref[i];
        if (mc < lc) {
          const ls = LEN_SYM[len];
          lit[count] = ls; dst[count] = ds;
          le[count] = len - LEN_BASE[ls - 257]; de[count] = dist - DIST_BASE[ds];
          pos[count] = i; count++;
          for (let k = 1; k < len; k++) insert(i + k);
          i += len;
          continue;
        }
      }
    }
    lit[count] = d[i]; dst[count] = -1; le[count] = 0; de[count] = 0; pos[count] = i; count++;
    i++;
  }
  return { lit: lit.subarray(0, count), dist: dst.subarray(0, count), lenExtra: le.subarray(0, count), distExtra: de.subarray(0, count), pos: pos.subarray(0, count), count };
}

// RLE-encode the code-length sequence; returns triples [sym, extraVal, extraBits].
function rleLengths(seq) {
  const out = [];
  let k = 0;
  while (k < seq.length) {
    const v = seq[k];
    let run = 1;
    while (k + run < seq.length && seq[k + run] === v) run++;
    if (v === 0) {
      let r = run;
      while (r >= 11) { const t = Math.min(r, 138); out.push([18, t - 11, 7]); r -= t; }
      if (r >= 3) { out.push([17, r - 3, 3]); r = 0; }
      while (r > 0) { out.push([0, 0, 0]); r--; }
    } else {
      out.push([v, 0, 0]);
      let r = run - 1;
      while (r >= 3) { const t = Math.min(r, 6); out.push([16, t - 3, 2]); r -= t; }
      while (r > 0) { out.push([v, 0, 0]); r--; }
    }
    k += run;
  }
  return out;
}

const CL_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

// Write one dynamic block (symbols s0..s1-1) with per-block Huffman tables.
// `final` marks BFINAL. Returns nothing; writes into w.
function writeDynamicBlock(w, final, parsed, s0, s1) {
  const litFreq = new Int32Array(288), distFreq = new Int32Array(32);
  for (let s = s0; s < s1; s++) {
    litFreq[parsed.lit[s]]++;
    if (parsed.dist[s] >= 0) distFreq[parsed.dist[s]]++;
  }
  litFreq[256]++; // end of block
  // Ensure at least 2 lit/len and 1 dist symbol with a code (DEFLATE completeness).
  let litNz = 0; for (let i = 0; i < 288; i++) if (litFreq[i] > 0) litNz++;
  if (litNz < 2) { for (let i = 0; i < 288; i++) if (litFreq[i] === 0) { litFreq[i] = 1; break; } }
  let distNz = 0; for (let i = 0; i < 32; i++) if (distFreq[i] > 0) distNz++;
  if (distNz === 0) distFreq[0] = 1;
  else if (distNz === 1) { for (let i = 0; i < 32; i++) if (distFreq[i] === 0) { distFreq[i] = 1; break; } }
  const litLens = buildLengths(litFreq, 15);
  const distLens = buildLengths(distFreq, 15);
  // Trim.
  let hlit = 286; while (hlit > 257 && litLens[hlit - 1] === 0) hlit--;
  let hdist = 30; while (hdist > 1 && distLens[hdist - 1] === 0) hdist--;
  const seq = new Uint8Array(hlit + hdist);
  for (let i = 0; i < hlit; i++) seq[i] = litLens[i];
  for (let i = 0; i < hdist; i++) seq[hlit + i] = distLens[i];
  const triples = rleLengths(seq);
  const clFreq = new Int32Array(19);
  for (const [s] of triples) clFreq[s]++;
  // The code-length code must be complete: never a single symbol alone.
  let clNz = 0; for (let i = 0; i < 19; i++) if (clFreq[i] > 0) clNz++;
  if (clNz === 1) { for (let i = 0; i < 19; i++) if (clFreq[i] === 0) { clFreq[i] = 1; break; } }
  const clLens = buildLengths(clFreq, 7);
  let hclen = 19; while (hclen > 4 && clLens[CL_ORDER[hclen - 1]] === 0) hclen--;
  const clCodes = canonicalCodes(clLens);
  const litCodes = canonicalCodes(litLens);
  const distCodes = canonicalCodes(distLens);
  w.write(final ? 1 : 0, 1);
  w.write(2, 2); // BTYPE=10 dynamic
  w.write(hlit - 257, 5);
  w.write(hdist - 1, 5);
  w.write(hclen - 4, 4);
  for (let i = 0; i < hclen; i++) w.write(clLens[CL_ORDER[i]], 3);
  for (const [s, ev, eb] of triples) { w.writeRev(clCodes[s], clLens[s]); if (eb) w.write(ev, eb); }
  for (let s = s0; s < s1; s++) {
    const ls = parsed.lit[s];
    w.writeRev(litCodes[ls], litLens[ls]);
    if (ls >= 257) {
      const extra = LEN_EXTRA[ls - 257];
      if (extra) w.write(parsed.lenExtra[s], extra);
      const ds = parsed.dist[s];
      w.writeRev(distCodes[ds], distLens[ds]);
      const dextra = DIST_EXTRA[ds];
      if (dextra) w.write(parsed.distExtra[s], dextra);
    }
  }
  w.writeRev(litCodes[256], litLens[256]); // end of block
}

// Static-Huffman block.
function writeStaticBlock(w, final, parsed, s0, s1) {
  const litCodes = canonicalCodes(FIXED_LIT_LEN);
  const distCodes = canonicalCodes(FIXED_DIST_LEN);
  w.write(final ? 1 : 0, 1);
  w.write(1, 2); // BTYPE=01
  for (let s = s0; s < s1; s++) {
    const ls = parsed.lit[s];
    w.writeRev(litCodes[ls], FIXED_LIT_LEN[ls]);
    if (ls >= 257) {
      const extra = LEN_EXTRA[ls - 257];
      if (extra) w.write(parsed.lenExtra[s], extra);
      const ds = parsed.dist[s];
      w.writeRev(distCodes[ds], 5);
      const dextra = DIST_EXTRA[ds];
      if (dextra) w.write(parsed.distExtra[s], dextra);
    }
  }
  w.writeRev(litCodes[256], 7);
}

// Bit-length of a static block (analytic, for comparison).
function staticBits(parsed, s0, s1) {
  let bits = 3 + 7; // header + end of block
  for (let s = s0; s < s1; s++) {
    const ls = parsed.lit[s];
    bits += FIXED_LIT_LEN[ls];
    if (ls >= 257) { bits += LEN_EXTRA[ls - 257] + 5 + DIST_EXTRA[parsed.dist[s]]; }
  }
  return bits;
}
// Bit-length of a dynamic block (analytic: header + symbols).
function dynamicBits(parsed, s0, s1) {
  const litFreq = new Int32Array(288), distFreq = new Int32Array(32);
  for (let s = s0; s < s1; s++) { litFreq[parsed.lit[s]]++; if (parsed.dist[s] >= 0) distFreq[parsed.dist[s]]++; }
  litFreq[256]++;
  let litNz = 0; for (let i = 0; i < 288; i++) if (litFreq[i] > 0) litNz++;
  if (litNz < 2) { for (let i = 0; i < 288; i++) if (litFreq[i] === 0) { litFreq[i] = 1; break; } }
  let distNz = 0; for (let i = 0; i < 32; i++) if (distFreq[i] > 0) distNz++;
  if (distNz === 0) distFreq[0] = 1;
  else if (distNz === 1) { for (let i = 0; i < 32; i++) if (distFreq[i] === 0) { distFreq[i] = 1; break; } }
  const litLens = buildLengths(litFreq, 15);
  const distLens = buildLengths(distFreq, 15);
  let hlit = 286; while (hlit > 257 && litLens[hlit - 1] === 0) hlit--;
  let hdist = 30; while (hdist > 1 && distLens[hdist - 1] === 0) hdist--;
  const seq = new Uint8Array(hlit + hdist);
  for (let i = 0; i < hlit; i++) seq[i] = litLens[i];
  for (let i = 0; i < hdist; i++) seq[hlit + i] = distLens[i];
  const triples = rleLengths(seq);
  const clFreq = new Int32Array(19);
  for (const [s] of triples) clFreq[s]++;
  // The code-length code must be complete: never a single symbol alone.
  let clNz = 0; for (let i = 0; i < 19; i++) if (clFreq[i] > 0) clNz++;
  if (clNz === 1) { for (let i = 0; i < 19; i++) if (clFreq[i] === 0) { clFreq[i] = 1; break; } }
  const clLens = buildLengths(clFreq, 7);
  let hclen = 19; while (hclen > 4 && clLens[CL_ORDER[hclen - 1]] === 0) hclen--;
  let bits = 3 + 5 + 5 + 4 + 3 * hclen;
  for (const [s, , eb] of triples) bits += clLens[s] + eb;
  for (let s = s0; s < s1; s++) {
    const ls = parsed.lit[s];
    bits += litLens[ls];
    if (ls >= 257) bits += LEN_EXTRA[ls - 257] + distLens[parsed.dist[s]] + DIST_EXTRA[parsed.dist[s]];
  }
  bits += litLens[256];
  return bits;
}

// Emit the parsed symbol stream in blocks of at most blockBytes input bytes.
function emit(parsed, dataLen, blockBytes) {
  // Split symbol indices at input-byte boundaries.
  const bounds = [0];
  let nextCut = blockBytes;
  for (let s = 0; s < parsed.count; s++) {
    if (parsed.pos[s] >= nextCut) { bounds.push(s); nextCut += blockBytes; }
  }
  bounds.push(parsed.count);
  const est = dataLen + (dataLen >> 3) + 65536 + bounds.length * 1024;
  const w = new BitWriter(est);
  for (let b = 0; b + 1 < bounds.length; b++) {
    const s0 = bounds[b], s1 = bounds[b + 1];
    const final = b + 2 === bounds.length;
    if (dynamicBits(parsed, s0, s1) <= staticBits(parsed, s0, s1)) writeDynamicBlock(w, final, parsed, s0, s1);
    else writeStaticBlock(w, final, parsed, s0, s1);
  }
  w.align();
  return w.bytes();
}

/**
 * Compress `data` (Uint8Array) into a zlib stream.
 * opts: { passes (default 2), blockBytes (default 131072) }.
 */
function deflateOptimal(data, opts = {}) {
  const passes = opts.passes ?? 2;
  const blockBytes = opts.blockBytes ?? 131072;
  const n = data.length;
  if (n === 0) {
    // Empty stored block.
    const out = new Uint8Array(2 + 5 + 4);
    out[0] = 0x78; out[1] = 0x9c; out[2] = 1; out[3] = 0; out[4] = 0; out[5] = 255; out[6] = 255;
    const ad = adler32d(data);
    out[7] = (ad >>> 24) & 0xff; out[8] = (ad >>> 16) & 0xff; out[9] = (ad >>> 8) & 0xff; out[10] = ad & 0xff;
    return out;
  }
  const head = new Int32Array(HASH_SIZE);
  const prev = new Int32Array(n);
  let litLen = FIXED_LIT_LEN, distLen = FIXED_DIST_LEN;
  let parsed = null;
  for (let p = 0; p < passes; p++) {
    parsed = parse(data, litLen, distLen, head, prev);
    // Rebuild code lengths from this parse's frequencies.
    const litFreq = new Int32Array(288), distFreq = new Int32Array(32);
    for (let s = 0; s < parsed.count; s++) { litFreq[parsed.lit[s]]++; if (parsed.dist[s] >= 0) distFreq[parsed.dist[s]]++; }
    litFreq[256]++;
    let litNz = 0; for (let i = 0; i < 288; i++) if (litFreq[i] > 0) litNz++;
    if (litNz < 2) { for (let i = 0; i < 288; i++) if (litFreq[i] === 0) { litFreq[i] = 1; break; } }
    let distNz = 0; for (let i = 0; i < 32; i++) if (distFreq[i] > 0) distNz++;
    if (distNz === 0) distFreq[0] = 1;
    else if (distNz === 1) { for (let i = 0; i < 32; i++) if (distFreq[i] === 0) { distFreq[i] = 1; break; } }
    const ll = buildLengths(litFreq, 15);
    const dl = buildLengths(distFreq, 15);
    // Cost model for the next parse: unused symbols cost a nominal amount,
    // never zero (a zero cost would make every match look too expensive).
    litLen = ll.map((v) => v || 8);
    distLen = dl.map((v) => v || 5);
    // Keep the true lengths for the final emission's frequency rebuild:
    // the next parse rebuilds frequencies anyway, so this is only a cost model.
    litLen._true = ll; distLen._true = dl;
  }
  const body = emit(parsed, n, blockBytes);
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78; out[1] = 0x9c;
  out.set(body, 2);
  const ad = adler32d(data);
  out[2 + body.length] = (ad >>> 24) & 0xff;
  out[3 + body.length] = (ad >>> 16) & 0xff;
  out[4 + body.length] = (ad >>> 8) & 0xff;
  out[5 + body.length] = ad & 0xff;
  return out;
}

const _debug = { parse, longestMatch, FIXED_LIT_LEN, FIXED_DIST_LEN, HASH_SIZE, buildLengths, canonicalCodes, matchInfo, parseDP };

// ---- Optimal-parse (DP) deflate ----
// Candidate match lengths for a longest-match length L: small lengths 3..8,
// each length-code segment's maximum <= L, and L itself.
const LEN_SEG_MAX = [3,4,5,6,7,8,9,10,11,13,15,17,19,23,27,31,35,43,51,59,67,83,99,115,131,163,195,227,258];
function candidateLengths(L, out) {
  let k = 0;
  for (let i = 0; i < LEN_SEG_MAX.length && LEN_SEG_MAX[i] <= L; i++) out[k++] = LEN_SEG_MAX[i];
  if (out[k - 1] !== L) out[k++] = L;
  return k;
}

// Compute longest-match info for every position: longLen/longDist (longest),
// nearLen/nearDist (nearest = smallest distance with len>=3).
// Returns { longLen, longDist, nearLen, nearDist } as Int32Arrays.
function matchInfo(d, head, prev, maxChain, runFwd = null) {
  const n = d.length;
  const longLen = new Int32Array(n), longDist = new Int32Array(n);
  const nearLen = new Int32Array(n), nearDist = new Int32Array(n);
  head.fill(-1);
  const insert = (p) => { if (p + 2 < n) { const h = hash3(d, p); prev[p] = head[h]; head[h] = p; } };
  for (let i = 0; i < n; i++) {
    // Run-skip: inside a run of identical bytes the distance-1 match is
    // (near-)optimal; no chain walk needed.
    if (runFwd !== null && i >= 1 && d[i] === d[i - 1] && runFwd[i] >= MIN_MATCH && i + MIN_MATCH <= n) {
      const rl = Math.min(runFwd[i], MAX_MATCH);
      longLen[i] = rl; longDist[i] = 1; nearLen[i] = rl; nearDist[i] = 1;
      insert(i);
      continue;
    }
    // search (chain holds positions < i)
    if (i + MIN_MATCH <= n) {
      const h = hash3(d, i);
      let cand = head[h];
      let bestLen = 0, bestDist = 0, nLen = 0, nDist = 0, steps = 0;
      const maxLen = Math.min(MAX_MATCH, n - i);
      while (cand >= 0 && steps++ < maxChain) {
        const dist = i - cand;
        if (dist > WINDOW) break;
        if (dist <= 0) { cand = prev[cand]; continue; }
        if (bestLen > 0) {
          if (bestLen < maxLen && d[cand + bestLen] === d[i + bestLen]) {
            let l = 0;
            while (l < maxLen && d[cand + l] === d[i + l]) l++;
            if (l > bestLen) { bestLen = l; bestDist = dist; if (l >= NICE_LEN) break; }
          }
        } else if (d[cand] === d[i] && d[cand + 1] === d[i + 1] && d[cand + 2] === d[i + 2]) {
          let l = 3;
          while (l < maxLen && d[cand + l] === d[i + l]) l++;
          bestLen = l; bestDist = dist;
          if (l >= NICE_LEN) break;
        }
        if (nLen === 0 && bestLen >= MIN_MATCH) { nLen = bestLen; nDist = dist; }
        cand = prev[cand];
      }
      // nearest match: the first candidate in the chain (smallest distance) with len>=3.
      // Recompute cheaply: walk again only if the first candidate wasn't recorded.
      // (nLen above is set from the first candidate that achieved bestLen>=3, which
      //  is the nearest candidate with a match, since the chain is newest-first,
      //  EXCEPT when an earlier candidate had bestLen 0... handled below.)
      if (nLen === 0) {
        // No candidate gave a match during the walk above (possible when the
        // first candidates were rejected by the quick check). Walk the chain
        // again looking for any len>=3, nearest first, limited steps.
        let c2 = head[h], s2 = 0;
        while (c2 >= 0 && s2++ < 32) {
          const dist = i - c2;
          if (dist > WINDOW || dist <= 0) break;
          if (d[c2] === d[i] && d[c2 + 1] === d[i + 1] && d[c2 + 2] === d[i + 2]) {
            let l = 3;
            const ml = Math.min(MAX_MATCH, n - i);
            while (l < ml && d[c2 + l] === d[i + l]) l++;
            nLen = l; nDist = dist; break;
          }
          c2 = prev[c2];
        }
      }
      longLen[i] = bestLen; longDist[i] = bestDist;
      nearLen[i] = nLen; nearDist[i] = nDist;
    }
    insert(i);
  }
  return { longLen, longDist, nearLen, nearDist };
}

// DP optimal parse. litLen/distLen are cost arrays (lengths, 0 allowed for unused).
// forceLong: positions with longest match >= forceLong only consider {literal, longest}.
// Returns parsed symbol arrays like parse().
function parseDP(d, litLen, distLen, mi, forceLong) {
  const n = d.length;
  const lenCost = new Float64Array(259);
  for (let l = 3; l <= 258; l++) lenCost[l] = litLen[LEN_SYM[l]] + LEN_EXTRA[LEN_SYM[l] - 257];
  const distCost = new Float64Array(30);
  for (let s = 0; s < 30; s++) distCost[s] = distLen[s] + DIST_EXTRA[s];
  const cost = new Float64Array(n + 1).fill(Infinity);
  const choice = new Int32Array(n + 1); // packed: len | (dist << 10); len 1 + dist 0 = literal
  cost[0] = 0; choice[0] = 1;
  const cand = new Int32Array(32);
  const { longLen, longDist, nearLen, nearDist } = mi;
  for (let i = 0; i < n; i++) {
    const ci = cost[i];
    if (ci === Infinity) continue;
    // literal
    const cl = ci + litLen[d[i]];
    if (cl < cost[i + 1]) { cost[i + 1] = cl; choice[i + 1] = 1; }
    const L = longLen[i];
    if (L >= MIN_MATCH) {
      const D = longDist[i];
      const dc = distCost[distSym(D)];
      if (L >= forceLong) {
        const c = ci + lenCost[L] + dc;
        if (c < cost[i + L]) { cost[i + L] = c; choice[i + L] = L | (D << 10); }
      } else {
        const nk = candidateLengths(L, cand);
        for (let k = 0; k < nk; k++) {
          const l = cand[k];
          const c = ci + lenCost[l] + dc;
          if (c < cost[i + l]) { cost[i + l] = c; choice[i + l] = l | (D << 10); }
        }
        const L2 = nearLen[i], D2 = nearDist[i];
        if (L2 >= MIN_MATCH && D2 !== D) {
          const dc2 = distCost[distSym(D2)];
          const nk2 = candidateLengths(L2, cand);
          for (let k = 0; k < nk2; k++) {
            const l = cand[k];
            const c = ci + lenCost[l] + dc2;
            if (c < cost[i + l]) { cost[i + l] = c; choice[i + l] = l | (D2 << 10); }
          }
        }
      }
    }
  }
  // Backtrack.
  const lit = [], dst = [], le = [], de = [], pos = [];
  let j = n;
  while (j > 0) {
    const ch = choice[j];
    const len = ch & 1023, dist = ch >>> 10;
    const start = j - len;
    pos.push(start);
    if (len === 1 && dist === 0) { lit.push(d[start]); dst.push(-1); le.push(0); de.push(0); }
    else {
      const ls = LEN_SYM[len];
      const ds = distSym(dist);
      lit.push(ls); dst.push(ds); le.push(len - LEN_BASE[ls - 257]); de.push(dist - DIST_BASE[ds]);
    }
    j = start;
  }
  lit.reverse(); dst.reverse(); le.reverse(); de.reverse(); pos.reverse();
  return {
    lit: Int32Array.from(lit), dist: Int32Array.from(dst),
    lenExtra: Int16Array.from(le), distExtra: Int16Array.from(de),
    pos: Int32Array.from(pos), count: lit.length,
  };
}

function deflateOptimalDP(data, opts = {}) {
  const passes = opts.passes ?? 2;
  const blockBytes = opts.blockBytes ?? 131072;
  const maxChain = opts.maxChain ?? 256;
  const forceLong = opts.forceLong ?? 64;
  const n = data.length;
  if (n === 0) return deflateOptimal(data, opts);
  const head = new Int32Array(HASH_SIZE);
  const prev = new Int32Array(n);
  // Forward run lengths (identical-byte runs starting at i), for the run-skip.
  const runFwd = new Int32Array(n);
  { let r = 1; for (let i = n - 1; i >= 0; i--) { if (i + 1 < n && data[i] === data[i + 1]) r++; else r = 1; runFwd[i] = r; } }
  const mi = matchInfo(data, head, prev, maxChain, runFwd);
  let litLen = FIXED_LIT_LEN, distLen = FIXED_DIST_LEN;
  let parsed = null;
  for (let p = 0; p < passes; p++) {
    parsed = parseDP(data, litLen, distLen, mi, forceLong);
    const litFreq = new Int32Array(288), distFreq = new Int32Array(32);
    for (let s = 0; s < parsed.count; s++) { litFreq[parsed.lit[s]]++; if (parsed.dist[s] >= 0) distFreq[parsed.dist[s]]++; }
    litFreq[256]++;
    let litNz = 0; for (let i = 0; i < 288; i++) if (litFreq[i] > 0) litNz++;
    if (litNz < 2) { for (let i = 0; i < 288; i++) if (litFreq[i] === 0) { litFreq[i] = 1; break; } }
    let distNz = 0; for (let i = 0; i < 32; i++) if (distFreq[i] > 0) distNz++;
    if (distNz === 0) distFreq[0] = 1;
    else if (distNz === 1) { for (let i = 0; i < 32; i++) if (distFreq[i] === 0) { distFreq[i] = 1; break; } }
    const ll = buildLengths(litFreq, 15);
    const dl = buildLengths(distFreq, 15);
    litLen = ll.map((v) => v || 8);
    distLen = dl.map((v) => v || 5);
  }
  const body = emit(parsed, n, blockBytes);
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78; out[1] = 0x9c;
  out.set(body, 2);
  const ad = adler32d(data);
  out[2 + body.length] = (ad >>> 24) & 0xff;
  out[3 + body.length] = (ad >>> 16) & 0xff;
  out[4 + body.length] = (ad >>> 8) & 0xff;
  out[5 + body.length] = ad & 0xff;
  return out;
}

// ---- Seeded DP: optimal parse where LZ77 matches are only searched at
// positions that start a token in a seed (lazy) parse. Positions inside a
// seed match are literal-only. Chain state still advances over every
// position, so distances stay exact. This keeps ~all of the full DP's gain
// at ~1/10th of its match-finding cost. ----
function parseDPSeeded(d, litLen, distLen, seedPos, maxChain, forceLong) {
  const n = d.length;
  const isSeed = new Uint8Array(n);
  for (let k = 0; k < seedPos.length; k++) if (seedPos[k] < n) isSeed[seedPos[k]] = 1;
  const lenCost = new Float64Array(259);
  for (let l = 3; l <= 258; l++) lenCost[l] = litLen[LEN_SYM[l]] + LEN_EXTRA[LEN_SYM[l] - 257];
  const distCost = new Float64Array(30);
  for (let s = 0; s < 30; s++) distCost[s] = distLen[s] + DIST_EXTRA[s];
  const cost = new Float64Array(n + 1).fill(Infinity);
  const choice = new Int32Array(n + 1);
  cost[0] = 0; choice[0] = 1;
  const cand = new Int32Array(32);
  const head = new Int32Array(HASH_SIZE);
  const prev = new Int32Array(n);
  head.fill(-1);
  const insert = (p) => { if (p + 2 < n) { const h = hash3(d, p); prev[p] = head[h]; head[h] = p; } };
  for (let i = 0; i < n; i++) {
    const ci = cost[i];
    if (ci !== Infinity) {
      const cl = ci + litLen[d[i]];
      if (cl < cost[i + 1]) { cost[i + 1] = cl; choice[i + 1] = 1; }
      if (isSeed[i] && i + MIN_MATCH <= n) {
        // Chain search at i (chain holds positions < i).
        const h = hash3(d, i);
        let cnd = head[h];
        let bestLen = 0, bestDist = 0, nLen = 0, nDist = 0, steps = 0;
        const maxLen = Math.min(MAX_MATCH, n - i);
        while (cnd >= 0 && steps++ < maxChain) {
          const dist = i - cnd;
          if (dist > WINDOW) break;
          if (dist <= 0) { cnd = prev[cnd]; continue; }
          if (bestLen > 0) {
            if (bestLen < maxLen && d[cnd + bestLen] === d[i + bestLen]) {
              let l = 0;
              while (l < maxLen && d[cnd + l] === d[i + l]) l++;
              if (l > bestLen) { bestLen = l; bestDist = dist; if (l >= NICE_LEN) break; }
            }
          } else if (d[cnd] === d[i] && d[cnd + 1] === d[i + 1] && d[cnd + 2] === d[i + 2]) {
            let l = 3;
            while (l < maxLen && d[cnd + l] === d[i + l]) l++;
            bestLen = l; bestDist = dist;
            if (l >= NICE_LEN) break;
          }
          if (nLen === 0 && bestLen >= MIN_MATCH) { nLen = bestLen; nDist = dist; }
          cnd = prev[cnd];
        }
        if (bestLen >= MIN_MATCH) {
          const dc = distCost[distSym(bestDist)];
          if (bestLen >= forceLong) {
            const c = ci + lenCost[bestLen] + dc;
            if (c < cost[i + bestLen]) { cost[i + bestLen] = c; choice[i + bestLen] = bestLen | (bestDist << 10); }
          } else {
            const nk = candidateLengths(bestLen, cand);
            for (let k = 0; k < nk; k++) {
              const l = cand[k];
              const c = ci + lenCost[l] + dc;
              if (c < cost[i + l]) { cost[i + l] = c; choice[i + l] = l | (bestDist << 10); }
            }
            if (nLen >= MIN_MATCH && nDist !== bestDist) {
              const dc2 = distCost[distSym(nDist)];
              const nk2 = candidateLengths(nLen, cand);
              for (let k = 0; k < nk2; k++) {
                const l = cand[k];
                const c = ci + lenCost[l] + dc2;
                if (c < cost[i + l]) { cost[i + l] = c; choice[i + l] = l | (nDist << 10); }
              }
            }
          }
        }
      }
    }
    insert(i);
  }
  const lit = [], dst = [], le = [], de = [], pos = [];
  let j = n;
  while (j > 0) {
    const ch = choice[j];
    const len = ch & 1023, dist = ch >>> 10;
    const start = j - len;
    pos.push(start);
    if (len === 1 && dist === 0) { lit.push(d[start]); dst.push(-1); le.push(0); de.push(0); }
    else {
      const ls = LEN_SYM[len];
      const ds = distSym(dist);
      lit.push(ls); dst.push(ds); le.push(len - LEN_BASE[ls - 257]); de.push(dist - DIST_BASE[ds]);
    }
    j = start;
  }
  lit.reverse(); dst.reverse(); le.reverse(); de.reverse(); pos.reverse();
  return {
    lit: Int32Array.from(lit), dist: Int32Array.from(dst),
    lenExtra: Int16Array.from(le), distExtra: Int16Array.from(de),
    pos: Int32Array.from(pos), count: lit.length,
  };
}

// Full seeded-DP deflate: lazy seed parse (fast) -> DP passes seeded by it.
function deflateSeededDP(data, opts = {}) {
  const passes = opts.passes ?? 2;
  const blockBytes = opts.blockBytes ?? 262144;
  const maxChain = opts.maxChain ?? 1024;
  const forceLong = opts.forceLong ?? 64;
  const n = data.length;
  if (n === 0) return deflateOptimal(data, opts);
  const head = new Int32Array(HASH_SIZE);
  const prev = new Int32Array(n);
  // Seed: one lazy parse with fixed costs (fast: searches only at token starts).
  const seed = parse(data, FIXED_LIT_LEN, FIXED_DIST_LEN, head, prev);
  let litLen = FIXED_LIT_LEN, distLen = FIXED_DIST_LEN;
  let parsed = seed;
  for (let p = 0; p < passes; p++) {
    // Rebuild costs from the current parse, then seeded DP.
    const litFreq = new Int32Array(288), distFreq = new Int32Array(32);
    for (let s = 0; s < parsed.count; s++) { litFreq[parsed.lit[s]]++; if (parsed.dist[s] >= 0) distFreq[parsed.dist[s]]++; }
    litFreq[256]++;
    let litNz = 0; for (let i = 0; i < 288; i++) if (litFreq[i] > 0) litNz++;
    if (litNz < 2) { for (let i = 0; i < 288; i++) if (litFreq[i] === 0) { litFreq[i] = 1; break; } }
    let distNz = 0; for (let i = 0; i < 32; i++) if (distFreq[i] > 0) distNz++;
    if (distNz === 0) distFreq[0] = 1;
    else if (distNz === 1) { for (let i = 0; i < 32; i++) if (distFreq[i] === 0) { distFreq[i] = 1; break; } }
    const ll = buildLengths(litFreq, 15);
    const dl = buildLengths(distFreq, 15);
    litLen = ll.map((v) => v || 8);
    distLen = dl.map((v) => v || 5);
    parsed = parseDPSeeded(data, litLen, distLen, parsed.pos, maxChain, forceLong);
  }
  const body = emit(parsed, n, blockBytes);
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78; out[1] = 0x9c;
  out.set(body, 2);
  const ad = adler32d(data);
  out[2 + body.length] = (ad >>> 24) & 0xff;
  out[3 + body.length] = (ad >>> 16) & 0xff;
  out[4 + body.length] = (ad >>> 8) & 0xff;
  out[5 + body.length] = ad & 0xff;
  return out;
}


// ---------- entry pipeline ----------
const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
// Full optimal-parse DEFLATE only for small filtered images (it is slow on
// multi-MB inputs); larger ones use the lazy deflate, which is near zlib-9.
const DP_MAX_N = 1048576;
const CHUNK_OVERHEAD = 57; // IHDR + IDAT + IEND chunk framing, approx.

function writeOut(id, bytes) {
  const dir = join(O, id);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, 'image.png');
  try { unlinkSync(p); } catch {}
  writeFileSync(p, bytes);
}

function fallbackPng(rgba, width, height) {
  // Minimal valid answer: fixed-Paeth RGBA at zlib level 9 (the house baseline).
  return pngOf([['IHDR', ihdrOf(width, height, 6)], ['IDAT', new Uint8Array(deflateSync(packPaeth(rgba, width, height), { level: 9 }))], ['IEND', new Uint8Array(0)]]);
}
function packPaeth(rgba, width, height) {
  const stride = width * 4;
  const raw = new Uint8Array(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 4;
    const cur = rgba.subarray(y * stride, (y + 1) * stride);
    const prev = y === 0 ? null : rgba.subarray((y - 1) * stride, y * stride);
    filterRow(4, cur, prev, 4, raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
  }
  return raw;
}

// Screen (form, filter choice) pairs by zlib level 6, keep the best two.
function screenCandidates(rgba, width, height) {
  const forms = formsOf(rgba);
  const scored = [];
  for (const form of forms) {
    const chunks = (form.plte === null ? 0 : 12 + form.plte.length) + (form.trns === null ? 0 : 12 + form.trns.length);
    const choices = form.colourType === 3
      ? (form.filters.length === 1 ? [0] : [0, 'minsum'])
      : [0, 1, 2, 4, 'minsum', 'pairs'];
    for (const choice of choices) {
      const data = filtered(form.samples, width, height, form.bpp, choice);
      const z = deflateSync(data, { level: 6 });
      scored.push({ form, choice, data, bytes: z.length + chunks });
    }
  }
  scored.sort((a, b) => a.bytes - b.bytes);
  // Brute-force filter choice for the best form only (it wins on grey/alpha).
  const bestForm = scored[0].form;
  const chunks = (bestForm.plte === null ? 0 : 12 + bestForm.plte.length) + (bestForm.trns === null ? 0 : 12 + bestForm.trns.length);
  const bruteData = filtered(bestForm.samples, width, height, bestForm.bpp, 'brute');
  const bruteBytes = deflateSync(bruteData, { level: 6 }).length + chunks;
  if (bruteBytes < scored[0].bytes) scored.unshift({ form: bestForm, choice: 'brute', data: bruteData, bytes: bruteBytes });
  // Drop duplicate candidates: the same filtered data under the same form
  // (same palette/transparency) encodes to identical bytes, so encoding it
  // twice only costs time. The screen can return the same (form, choice)
  // twice when two palette orderings coincide.
  const kept = [];
  for (const cand of scored) {
    let dup = false;
    for (const k of kept) {
      if (k.form.colourType === cand.form.colourType && k.choice === cand.choice
        && k.data.length === cand.data.length && Buffer.from(k.data).equals(Buffer.from(cand.data))
        && ((k.form.plte === null && cand.form.plte === null) || (k.form.plte !== null && cand.form.plte !== null && Buffer.from(k.form.plte).equals(Buffer.from(cand.form.plte))))
        && ((k.form.trns === null && cand.form.trns === null) || (k.form.trns !== null && cand.form.trns !== null && Buffer.from(k.form.trns).equals(Buffer.from(cand.form.trns))))) { dup = true; break; }
    }
    if (!dup) kept.push(cand);
  }
  return kept.slice(0, 2);
}

function encodeBest(cand, width, height) {
  const chunks = [];
  chunks.push(['IHDR', ihdrOf(width, height, cand.form.colourType)]);
  if (cand.form.plte !== null) chunks.push(['PLTE', cand.form.plte]);
  if (cand.form.trns !== null) chunks.push(['tRNS', cand.form.trns]);
  let bestStream = null;
  let bestLen = Infinity;
  const consider = (stream) => { if (stream && stream.length < bestLen) { bestLen = stream.length; bestStream = stream; } };
  consider(deflateSync(cand.data, { level: 9 }));
  consider(deflateOptimal(cand.data, { passes: 2, blockBytes: 262144 }));
  if (cand.data.length <= DP_MAX_N) consider(deflateOptimalDP(cand.data, { maxChain: 1024, forceLong: 64, passes: 2, blockBytes: 262144 }));
  chunks.push(['IDAT', new Uint8Array(bestStream)]);
  chunks.push(['IEND', new Uint8Array(0)]);
  return pngOf(chunks);
}

for (const id of readdirSync(I).sort()) {
  try {
    const bytes = readFileSync(join(I, id, 'image.png'));
    const image = decodePng(new Uint8Array(bytes));
    if (!image.ok) throw new Error(image.why);
    const cands = screenCandidates(image.rgba, image.width, image.height);
    let best = null;
    for (const cand of cands) {
      const png = encodeBest(cand, image.width, image.height);
      if (best === null || png.length < best.length) best = png;
    }
    writeOut(id, best);
  } catch (err) {
    // Never fail the run: write the stored input back (a valid PNG of the image).
    try {
      const bytes = readFileSync(join(I, id, 'image.png'));
      writeOut(id, new Uint8Array(bytes));
    } catch {
      // Last resort: 1x1 transparent PNG is not the right size, so write the
      // fixed-Paeth re-encode of whatever decoded (should not happen).
      try {
        const image = decodePng(new Uint8Array(readFileSync(join(I, id, 'image.png'))));
        if (image.ok) writeOut(id, fallbackPng(image.rgba, image.width, image.height));
      } catch {}
    }
  }
}
