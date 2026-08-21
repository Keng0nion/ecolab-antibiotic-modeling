export const RNG_ALGORITHM = "xoshiro128ss-splitmix32-v1";
export const RANDOM_ALGORITHM = RNG_ALGORITHM;

const UINT32_RANGE = 0x1_0000_0000;
const UINT32_MAX = 0xffff_ffff;
const TEXT_ENCODER_AVAILABLE = typeof TextEncoder === "function";

function fail(code, message, ErrorType = TypeError) {
  const error = new ErrorType(message);
  error.code = code;
  throw error;
}

function assertUint32(value, name = "seed") {
  if (!Number.isInteger(value) || value < 0 || value > UINT32_MAX) {
    fail("INVALID_UINT32_SEED", `${name} must be an unsigned 32-bit integer.`);
  }
  return value >>> 0;
}

function rotateLeft(value, amount) {
  return ((value << amount) | (value >>> (32 - amount))) >>> 0;
}

/** One SplitMix32 step. The returned state is suitable for the next step. */
export function splitmix32(state) {
  const nextState = (assertUint32(state, "state") + 0x9e3779b9) >>> 0;
  let value = nextState;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  value = (value ^ (value >>> 15)) >>> 0;
  return { state: nextState, value };
}

function seedState(seed) {
  let state = assertUint32(seed);
  const words = new Uint32Array(4);
  for (let index = 0; index < words.length; index += 1) {
    const mixed = splitmix32(state);
    state = mixed.state;
    words[index] = mixed.value;
  }
  if ((words[0] | words[1] | words[2] | words[3]) === 0) words[0] = 1;
  return words;
}

function utf8Bytes(text) {
  if (TEXT_ENCODER_AVAILABLE) return new TextEncoder().encode(text);
  const bytes = [];
  for (let index = 0; index < text.length; index += 1) {
    let codePoint = text.charCodeAt(index);
    if (codePoint >= 0xd800 && codePoint <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        codePoint = 0x10000 + ((codePoint - 0xd800) << 10) + (next - 0xdc00);
        index += 1;
      } else codePoint = 0xfffd;
    } else if (codePoint >= 0xdc00 && codePoint <= 0xdfff) codePoint = 0xfffd;

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

function mixWord(hash, word) {
  let value = (hash ^ (word >>> 0)) >>> 0;
  value = Math.imul(value ^ (value >>> 16), 0x21f0aaad);
  value = Math.imul(value ^ (value >>> 15), 0x735a2d97);
  return (value ^ (value >>> 15)) >>> 0;
}

function hashText(text) {
  let hash = 0x811c9dc5;
  for (const byte of utf8Bytes(text)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return mixWord(hash, text.length);
}

function hashPart(part) {
  if (typeof part === "number") {
    if (!Number.isSafeInteger(part)) {
      fail("INVALID_SUBSTREAM_PART", "Numeric substream identifiers must be safe integers.");
    }
    const low = part >>> 0;
    const high = Math.floor(part / UINT32_RANGE) >>> 0;
    return mixWord(mixWord(0x4e554d31, low), high);
  }
  if (typeof part === "string") return hashText(`s:${part}`);
  if (typeof part === "boolean") return part ? 0x54525545 : 0x46414c53;
  if (part === null) return 0x4e554c4c;
  fail(
    "INVALID_SUBSTREAM_PART",
    "Substream identifiers must be strings, safe integers, booleans, or null.",
  );
}

/**
 * Deterministically derive an independent uint32 seed from a root seed and
 * stable identifiers. No mutable parent RNG state is consumed.
 */
export function deriveSeed(seed, ...parts) {
  let hash = mixWord(0x58533156, assertUint32(seed));
  for (let index = 0; index < parts.length; index += 1) {
    hash = mixWord(hash, index);
    hash = mixWord(hash, hashPart(parts[index]));
  }
  return mixWord(hash, parts.length);
}

export const deriveSubstreamSeed = deriveSeed;

/** Create a stateful xoshiro128** generator from an exact uint32 seed. */
export function createRandom(seed) {
  const words = seedState(seed);
  let s0 = words[0];
  let s1 = words[1];
  let s2 = words[2];
  let s3 = words[3];

  function nextUint32() {
    const result = Math.imul(rotateLeft(Math.imul(s1, 5) >>> 0, 7), 9) >>> 0;
    const temporary = (s1 << 9) >>> 0;
    s2 ^= s0;
    s3 ^= s1;
    s1 ^= s2;
    s0 ^= s3;
    s2 ^= temporary;
    s3 = rotateLeft(s3, 11);
    s0 >>>= 0;
    s1 >>>= 0;
    s2 >>>= 0;
    s3 >>>= 0;
    return result;
  }

  function next() {
    return nextUint32() / UINT32_RANGE;
  }

  function nextOpen() {
    return (nextUint32() + 0.5) / UINT32_RANGE;
  }

  return Object.freeze({
    algorithm: RNG_ALGORITHM,
    seed: seed >>> 0,
    nextUint32,
    uint32: nextUint32,
    next,
    random: next,
    nextOpen,
    substream(...parts) {
      return createRandom(deriveSeed(seed, ...parts));
    },
  });
}

export const createRng = createRandom;
export const createRandomGenerator = createRandom;

/** Create a sample-indexed stream, invariant to processing order or chunking. */
export function createSubstream(seed, ...parts) {
  return createRandom(deriveSeed(seed, ...parts));
}

export function randomUint32At(seed, ...parts) {
  return createSubstream(seed, ...parts).nextUint32();
}

export function randomAt(seed, ...parts) {
  return createSubstream(seed, ...parts).next();
}

export function normalizeSeed(seed) {
  return assertUint32(seed);
}
