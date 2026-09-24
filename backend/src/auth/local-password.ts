import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";

const FORMAT = "scrypt-v1";
const COST = 16_384;
const BLOCK_SIZE = 8;
const PARALLELISM = 1;
const KEY_BYTES = 64;
const MAX_PASSWORD_BYTES = 256;

export function validateLocalPassword(value: unknown): string {
  if (typeof value !== "string") throw new Error("password_required");
  const bytes = Buffer.byteLength(value);
  if (Array.from(value).length < 12) throw new Error("password_too_short");
  if (bytes > MAX_PASSWORD_BYTES) throw new Error("password_too_long");
  return value;
}

export async function hashLocalPassword(password: string): Promise<string> {
  validateLocalPassword(password);
  const salt = randomBytes(16);
  const hash = await derive(password, salt, COST, BLOCK_SIZE, PARALLELISM);
  return [
    FORMAT,
    String(COST),
    String(BLOCK_SIZE),
    String(PARALLELISM),
    salt.toString("base64url"),
    hash.toString("base64url"),
  ].join("$");
}

export async function verifyLocalPassword(password: string, encoded: string): Promise<boolean> {
  const [format, costText, blockSizeText, parallelismText, saltText, expectedText, ...extra] = encoded.split("$");
  if (format !== FORMAT || !saltText || !expectedText || extra.length) return false;
  const cost = Number(costText);
  const blockSize = Number(blockSizeText);
  const parallelism = Number(parallelismText);
  if (cost !== COST || blockSize !== BLOCK_SIZE || parallelism !== PARALLELISM) return false;
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltText, "base64url");
    expected = Buffer.from(expectedText, "base64url");
  } catch {
    return false;
  }
  if (salt.length !== 16 || expected.length !== KEY_BYTES) return false;
  const actual = await derive(password, salt, cost, blockSize, parallelism).catch(() => undefined);
  return Boolean(actual && actual.length === expected.length && timingSafeEqual(actual, expected));
}

function derive(password: string, salt: Buffer, cost: number, blockSize: number, parallelism: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scryptCallback(password, salt, KEY_BYTES, {
      N: cost,
      r: blockSize,
      p: parallelism,
      maxmem: 64 * 1024 * 1024,
    }, (error, value) => error ? reject(error) : resolve(value));
  });
}
