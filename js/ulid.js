// ULID 生成（Crockford Base32、48bit タイムスタンプ + 80bit 乱数）
const B32 = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

export function ulid(now = Date.now()) {
  let time = '';
  let n = now;
  for (let i = 0; i < 10; i++) {
    time = B32[n % 32] + time;
    n = Math.floor(n / 32);
  }
  const bytes = new Uint8Array(16);
  if (globalThis.crypto && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  let rand = '';
  for (let i = 0; i < 16; i++) rand += B32[bytes[i] % 32];
  return time + rand;
}
