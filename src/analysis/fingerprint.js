const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

export class FingerprintError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "FingerprintError";
    this.code = code;
    this.path = details.path ?? null;
    this.actual = details.actual;
  }
}

function fail(code, message, path, actual) {
  throw new FingerprintError(code, message, { path, actual });
}

function assertCanonicalValue(value, path, ancestors) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      fail("NON_FINITE_NUMBER", `${path} must be a finite JSON number.`, path, value);
    }
    return;
  }
  if (typeof value !== "object") {
    fail("NON_JSON_VALUE", `${path} is not JSON-compatible.`, path, typeof value);
  }
  if (ancestors.has(value)) {
    fail("CYCLIC_VALUE", `${path} contains a cycle.`, path, "cycle");
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      if (!(index in value)) {
        fail("SPARSE_ARRAY", `${path} must not contain array holes.`, `${path}[${index}]`, "array hole");
      }
      assertCanonicalValue(value[index], `${path}[${index}]`, ancestors);
    }
  } else {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      fail("NON_PLAIN_OBJECT", `${path} must be a plain object.`, path, prototype?.constructor?.name ?? null);
    }
    for (const key of Object.keys(value)) {
      if (UNSAFE_KEYS.has(key)) {
        fail("UNSAFE_OBJECT_KEY", `Unsafe object key is forbidden: ${key}.`, `${path}.${key}`, key);
      }
      assertCanonicalValue(value[key], `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

/** Deterministic JSON with recursively sorted object keys and preserved array order. */
export function canonicalJson(value) {
  assertCanonicalValue(value, "$", new Set());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(",")}}`;
}

export const canonicalizeJson = canonicalJson;

function utf8Encode(text) {
  if (typeof TextEncoder === "function") return new TextEncoder().encode(text);
  const bytes = [];
  for (let index = 0; index < text.length; index += 1) {
    let codePoint = text.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      } else {
        codePoint = 0xfffd;
      }
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) {
      codePoint = 0xfffd;
    }
    if (codePoint <= 0x7f) bytes.push(codePoint);
    else if (codePoint <= 0x7ff) {
      bytes.push(0xc0 | (codePoint >>> 6), 0x80 | (codePoint & 0x3f));
    } else if (codePoint <= 0xffff) {
      bytes.push(
        0xe0 | (codePoint >>> 12),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    } else {
      bytes.push(
        0xf0 | (codePoint >>> 18),
        0x80 | ((codePoint >>> 12) & 0x3f),
        0x80 | ((codePoint >>> 6) & 0x3f),
        0x80 | (codePoint & 0x3f),
      );
    }
  }
  return Uint8Array.from(bytes);
}

const INITIAL_HASH = Object.freeze([
  0x6a09e667,
  0xbb67ae85,
  0x3c6ef372,
  0xa54ff53a,
  0x510e527f,
  0x9b05688c,
  0x1f83d9ab,
  0x5be0cd19,
]);

const ROUND_CONSTANTS = Object.freeze([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5,
  0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc,
  0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
  0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3,
  0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5,
  0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

function rotateRight(value, amount) {
  return (value >>> amount) | (value << (32 - amount));
}

function bytesToHex(bytes) {
  let result = "";
  for (const byte of bytes) result += byte.toString(16).padStart(2, "0");
  return result;
}

/** Synchronous, dependency-free SHA-256 used when WebCrypto is unavailable. */
export function sha256HexFallback(input) {
  if (typeof input !== "string") {
    fail("INVALID_HASH_INPUT", "SHA-256 input must be a string.", "$", typeof input);
  }
  const message = utf8Encode(input);
  const bitLength = message.length * 8;
  const paddedLength = Math.ceil((message.length + 9) / 64) * 64;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;
  const lengthHigh = Math.floor(bitLength / 0x100000000);
  const lengthLow = bitLength >>> 0;
  padded[paddedLength - 8] = (lengthHigh >>> 24) & 0xff;
  padded[paddedLength - 7] = (lengthHigh >>> 16) & 0xff;
  padded[paddedLength - 6] = (lengthHigh >>> 8) & 0xff;
  padded[paddedLength - 5] = lengthHigh & 0xff;
  padded[paddedLength - 4] = (lengthLow >>> 24) & 0xff;
  padded[paddedLength - 3] = (lengthLow >>> 16) & 0xff;
  padded[paddedLength - 2] = (lengthLow >>> 8) & 0xff;
  padded[paddedLength - 1] = lengthLow & 0xff;

  const hash = [...INITIAL_HASH];
  const words = new Uint32Array(64);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let index = 0; index < 16; index += 1) {
      const wordOffset = offset + index * 4;
      words[index] = (
        (padded[wordOffset] << 24) |
        (padded[wordOffset + 1] << 16) |
        (padded[wordOffset + 2] << 8) |
        padded[wordOffset + 3]
      ) >>> 0;
    }
    for (let index = 16; index < 64; index += 1) {
      const s0 = rotateRight(words[index - 15], 7) ^ rotateRight(words[index - 15], 18) ^ (words[index - 15] >>> 3);
      const s1 = rotateRight(words[index - 2], 17) ^ rotateRight(words[index - 2], 19) ^ (words[index - 2] >>> 10);
      words[index] = (words[index - 16] + s0 + words[index - 7] + s1) >>> 0;
    }

    let [a, b, c, d, e, f, g, h] = hash;
    for (let index = 0; index < 64; index += 1) {
      const sum1 = rotateRight(e, 6) ^ rotateRight(e, 11) ^ rotateRight(e, 25);
      const choose = (e & f) ^ (~e & g);
      const temporary1 = (h + sum1 + choose + ROUND_CONSTANTS[index] + words[index]) >>> 0;
      const sum0 = rotateRight(a, 2) ^ rotateRight(a, 13) ^ rotateRight(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const temporary2 = (sum0 + majority) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temporary1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temporary1 + temporary2) >>> 0;
    }
    hash[0] = (hash[0] + a) >>> 0;
    hash[1] = (hash[1] + b) >>> 0;
    hash[2] = (hash[2] + c) >>> 0;
    hash[3] = (hash[3] + d) >>> 0;
    hash[4] = (hash[4] + e) >>> 0;
    hash[5] = (hash[5] + f) >>> 0;
    hash[6] = (hash[6] + g) >>> 0;
    hash[7] = (hash[7] + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  hash.forEach((word, index) => {
    digest[index * 4] = (word >>> 24) & 0xff;
    digest[index * 4 + 1] = (word >>> 16) & 0xff;
    digest[index * 4 + 2] = (word >>> 8) & 0xff;
    digest[index * 4 + 3] = word & 0xff;
  });
  return bytesToHex(digest);
}

/** Use WebCrypto when available, with a deterministic pure-JS fallback. */
export async function sha256Hex(input, options = {}) {
  if (typeof input !== "string") {
    fail("INVALID_HASH_INPUT", "SHA-256 input must be a string.", "$", typeof input);
  }
  const subtle = options.forceFallback === true ? null : globalThis.crypto?.subtle;
  if (subtle && typeof subtle.digest === "function") {
    try {
      const digest = await subtle.digest("SHA-256", utf8Encode(input));
      return bytesToHex(new Uint8Array(digest));
    } catch {
      // A conforming fallback is required for restricted browser contexts.
    }
  }
  return sha256HexFallback(input);
}

export async function fingerprintJson(value, options = {}) {
  return sha256Hex(canonicalJson(value), options);
}

export const fingerprintDataset = fingerprintJson;

export async function fingerprintSplit(split, options = {}) {
  if (split === null || typeof split !== "object" || Array.isArray(split)) {
    fail("INVALID_SPLIT", "split must be a plain object.", "$", split);
  }
  const fingerprintable = {};
  for (const [key, value] of Object.entries(split)) {
    if (key !== "splitFingerprint") fingerprintable[key] = value;
  }
  return fingerprintJson(fingerprintable, options);
}
