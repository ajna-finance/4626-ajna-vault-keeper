import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { keccak256 as viemKeccak256 } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const KEYSTORE_VERSION = 3;
const CIPHER = 'aes-128-ctr';
const KDF = 'scrypt';
const SCRYPT_N = 262144;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const DKLEN = 32;
const KEYSTORE_FILE_MODE = 0o600;

const MIN_SCRYPT_N = 1024;
const MAX_SCRYPT_N = 1048576;
const MAX_SCRYPT_R = 16;
const MAX_SCRYPT_P = 16;
const MIN_SALT_BYTES = 16;
const MAX_SALT_BYTES = 64;
const IV_BYTES = 16;
const HEX_PATTERN = /^[0-9a-fA-F]*$/;

function isSafePositiveInt(value: unknown): value is number {
  return (
    typeof value === 'number' && Number.isInteger(value) && value > 0 && Number.isSafeInteger(value)
  );
}

function isPowerOfTwo(value: number): boolean {
  return value > 0 && (value & (value - 1)) === 0;
}

function isEvenHexString(value: unknown): value is string {
  return typeof value === 'string' && value.length % 2 === 0 && HEX_PATTERN.test(value);
}

interface KeystoreV3 {
  version: 3;
  id: string;
  address: string;
  crypto: {
    cipher: string;
    ciphertext: string;
    cipherparams: { iv: string };
    kdf: string;
    kdfparams: {
      dklen: number;
      salt: string;
      n: number;
      r: number;
      p: number;
    };
    mac: string;
  };
}

function mac(derivedKey: Buffer, ciphertext: Buffer): string {
  const macBody = Buffer.concat([derivedKey.subarray(16, 32), ciphertext]);
  const hex = viemKeccak256(macBody) as string;
  return hex.slice(2);
}

function uuidv4(): string {
  const bytes = randomBytes(16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}

export function encryptKeystore(privateKey: string, password: string): KeystoreV3 {
  const key = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
  const keyBuf = Buffer.from(key, 'hex');

  const address = privateKeyToAccount(`0x${key}` as `0x${string}`)
    .address.toLowerCase()
    .slice(2);

  const salt = randomBytes(32);
  const iv = randomBytes(16);

  const derivedKey = scryptSync(Buffer.from(password, 'utf-8'), salt, DKLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
    maxmem: 256 * SCRYPT_N * SCRYPT_R,
  });

  const cipher = createCipheriv(CIPHER, derivedKey.subarray(0, 16), iv);
  const ciphertext = Buffer.concat([cipher.update(keyBuf), cipher.final()]);

  return {
    version: KEYSTORE_VERSION,
    id: uuidv4(),
    address,
    crypto: {
      cipher: CIPHER,
      ciphertext: ciphertext.toString('hex'),
      cipherparams: { iv: iv.toString('hex') },
      kdf: KDF,
      kdfparams: {
        dklen: DKLEN,
        salt: salt.toString('hex'),
        n: SCRYPT_N,
        r: SCRYPT_R,
        p: SCRYPT_P,
      },
      mac: mac(derivedKey as Buffer, ciphertext),
    },
  };
}

export function decryptKeystore(keystore: KeystoreV3, password: string): `0x${string}` {
  const { crypto: c } = keystore;

  if (c.kdf !== KDF) {
    throw new Error(`Unsupported KDF: ${c.kdf}`);
  }
  if (c.cipher !== CIPHER) {
    throw new Error(`Unsupported cipher: ${c.cipher}`);
  }

  const { dklen, n, r, p, salt: saltHex } = c.kdfparams;

  if (dklen !== DKLEN) {
    throw new Error(`Unsupported scrypt dklen: ${dklen} (expected ${DKLEN})`);
  }
  if (!isSafePositiveInt(n) || !isPowerOfTwo(n) || n < MIN_SCRYPT_N || n > MAX_SCRYPT_N) {
    throw new Error(`Unsupported scrypt N: ${n}`);
  }
  if (!isSafePositiveInt(r) || r > MAX_SCRYPT_R) {
    throw new Error(`Unsupported scrypt r: ${r}`);
  }
  if (!isSafePositiveInt(p) || p > MAX_SCRYPT_P) {
    throw new Error(`Unsupported scrypt p: ${p}`);
  }
  if (!isEvenHexString(saltHex)) {
    throw new Error('Invalid scrypt salt encoding');
  }
  const saltBytes = saltHex.length / 2;
  if (saltBytes < MIN_SALT_BYTES || saltBytes > MAX_SALT_BYTES) {
    throw new Error(`Unsupported scrypt salt length: ${saltBytes} bytes`);
  }
  if (!isEvenHexString(c.cipherparams.iv) || c.cipherparams.iv.length !== IV_BYTES * 2) {
    throw new Error(`Invalid cipher IV: expected ${IV_BYTES} bytes`);
  }
  if (!isEvenHexString(c.ciphertext)) {
    throw new Error('Invalid ciphertext encoding');
  }

  const salt = Buffer.from(saltHex, 'hex');
  const iv = Buffer.from(c.cipherparams.iv, 'hex');
  const ciphertext = Buffer.from(c.ciphertext, 'hex');

  const derivedKey = scryptSync(Buffer.from(password, 'utf-8'), salt, dklen, {
    N: n,
    r,
    p,
    maxmem: 256 * n * r,
  });

  const computedMac = mac(derivedKey as Buffer, ciphertext);
  if (computedMac !== c.mac) {
    throw new Error('Incorrect password: MAC mismatch');
  }

  const decipher = createDecipheriv(CIPHER, derivedKey.subarray(0, 16), iv);
  const privateKey = Buffer.concat([decipher.update(ciphertext), decipher.final()]);

  return `0x${privateKey.toString('hex')}`;
}

export async function readKeystoreFile(path: string): Promise<KeystoreV3> {
  const content = await readFile(path, 'utf-8');
  return JSON.parse(content) as KeystoreV3;
}

export async function writeKeystoreFile(
  path: string,
  keystore: KeystoreV3,
  options: { overwrite?: boolean } = {},
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const flag = options.overwrite ? 'w' : 'wx';
  await writeFile(path, JSON.stringify(keystore, null, 2) + '\n', {
    mode: KEYSTORE_FILE_MODE,
    flag,
  });
  await chmod(path, KEYSTORE_FILE_MODE);
}

export async function promptPassword(message: string): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });

  try {
    process.stderr.write(message);

    const originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((_chunk: string | Uint8Array) => true) as typeof process.stderr.write;

    const password = await rl.question('');

    process.stderr.write = originalWrite;
    process.stderr.write('\n');

    return password;
  } finally {
    rl.close();
  }
}

export async function loadPrivateKeyFromKeystore(keystorePath: string): Promise<`0x${string}`> {
  const keystore = await readKeystoreFile(keystorePath);
  const password = await promptPassword('Enter keystore password: ');
  return decryptKeystore(keystore, password);
}
