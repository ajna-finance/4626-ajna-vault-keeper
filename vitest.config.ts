import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const globalSetup = fileURLToPath(new URL('./test/setup/global-setup.ts', import.meta.url));

const common = {
  testTimeout: 60000,
  hookTimeout: 60000,
  pool: 'threads',
  poolOptions: { threads: { singleThread: true } },
  sequence: {
    concurrent: false,
    shuffle: false,
  },
};

const chainSuite = {
  ...common,
  globalSetup,
};

const suites = {
  'ark-unit': {
    ...chainSuite,
    include: ['test/**/*.{test,spec}.{ts,tsx,js}'],
    exclude: [
      '**/test/mocks/**/*',
      'test/integration/**',
      'test/metavault/**',
      'test/property/**',
      'test/keepers/metavaultKeeper.test.ts',
      'node_modules/**',
      'dist/**',
    ],
  },
  'ark-integration': {
    ...chainSuite,
    include: [
      'test/integration/arkKeeperFailure.test.ts',
      'test/integration/arkKeeperSuccess.test.ts',
    ],
    exclude: ['**/test/mocks/**/*', 'node_modules/**', 'dist/**'],
  },
  'metavault-unit': {
    ...chainSuite,
    include: [
      'test/metavault/**/*.{test,spec}.{ts,tsx,js}',
      'test/keepers/metavaultKeeper.test.ts',
      'test/ark/utils/selectBuckets.test.ts',
    ],
    exclude: ['**/test/mocks/**/*', 'node_modules/**', 'dist/**', 'test/property/**'],
  },
  'metavault-integration': {
    ...chainSuite,
    include: ['test/integration/metavaultKeeper.integration.test.ts'],
    exclude: ['**/test/mocks/**/*', 'node_modules/**', 'dist/**'],
  },
  metavault: {
    ...chainSuite,
    include: [
      'test/metavault/**/*.{test,spec}.{ts,tsx,js}',
      'test/keepers/metavaultKeeper.test.ts',
      'test/ark/utils/selectBuckets.test.ts',
      'test/integration/metavaultKeeper.integration.test.ts',
    ],
    exclude: ['**/test/mocks/**/*', 'node_modules/**', 'dist/**'],
  },
  property: {
    ...common,
    include: ['test/property/**/*.{test,spec}.{ts,tsx,js}'],
    setupFiles: ['dotenv/config'],
    exclude: ['**/test/mocks/**/*', 'node_modules/**', 'dist/**'],
  },
};

const suiteName = process.env.VITEST_SUITE ?? 'ark-unit';
const suite = suites[suiteName as keyof typeof suites];

if (!suite) {
  throw new Error(
    `Unknown VITEST_SUITE '${suiteName}'. Expected one of: ${Object.keys(suites).join(', ')}`,
  );
}

export default defineConfig({
  test: suite,
});
