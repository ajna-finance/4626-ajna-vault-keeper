import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { encryptKeystore, writeKeystoreFile } from '../src/utils/keystore.ts';

const DEFAULT_PATH = resolve('keystore', 'keeper-key.json');

async function prompt(message: string, hide = false): Promise<string> {
  const rl = createInterface({
    input: process.stdin,
    output: process.stderr,
    terminal: true,
  });

  try {
    if (hide) {
      process.stderr.write(message);
      const originalWrite = process.stderr.write.bind(process.stderr);
      process.stderr.write = ((_chunk: string | Uint8Array) => true) as typeof process.stderr.write;
      const answer = await rl.question('');
      process.stderr.write = originalWrite;
      process.stderr.write('\n');
      return answer;
    }
    return await rl.question(message);
  } finally {
    rl.close();
  }
}

async function main() {
  console.error('=== Ethereum V3 Keystore Import ===\n');

  const privateKey = await prompt('Enter private key (hex, with or without 0x prefix): ', true);

  const cleaned = privateKey.startsWith('0x') ? privateKey.slice(2) : privateKey;
  if (!/^[0-9a-fA-F]{64}$/.test(cleaned)) {
    console.error('Error: Invalid private key. Must be 64 hex characters.');
    process.exit(1);
  }

  const password = await prompt('Enter encryption password: ', true);
  if (password.length === 0) {
    console.error('Error: Password cannot be empty.');
    process.exit(1);
  }

  const confirm = await prompt('Confirm encryption password: ', true);
  if (password !== confirm) {
    console.error('Error: Passwords do not match.');
    process.exit(1);
  }

  const outputPath = (await prompt(`Output path [${DEFAULT_PATH}]: `)) || DEFAULT_PATH;
  const resolvedPath = resolve(outputPath);

  console.error('\nEncrypting private key (this may take a moment)...');
  const keystore = encryptKeystore(privateKey, password);

  try {
    await writeKeystoreFile(resolvedPath, keystore);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') {
      throw err;
    }
    const answer = await prompt(`File exists at ${resolvedPath}. Overwrite? (y/N): `);
    if (!/^y(es)?$/i.test(answer.trim())) {
      console.error('Aborted: existing keystore was not modified.');
      process.exit(1);
    }
    await writeKeystoreFile(resolvedPath, keystore, { overwrite: true });
  }

  console.error(`\nKeystore file written to: ${resolvedPath}`);
  console.error(`Address: 0x${keystore.address}`);
  console.error('\nAdd this to your .env:');
  console.error(`  KEYSTORE_PATH=${resolvedPath}`);
  console.error('\nYou can now remove PRIVATE_KEY from your .env file.');
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
