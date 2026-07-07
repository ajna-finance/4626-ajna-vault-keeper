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
    // Coverage gate over the recovery surfaces this suite owns (run via
    // `pnpm run test:coverage`); thresholds sit a couple of points under the
    // measured baseline so real regressions fail without flaking on noise.
    coverage: {
      enabled: false,
      provider: 'v8' as const,
      reporter: ['text'],
      include: [
        'src/ark/recovery.ts',
        'src/ark/swapAdapters/**',
        'src/utils/remoteSigner.ts',
        'src/utils/scheduler.ts',
      ],
      thresholds: { statements: 87, lines: 87, functions: 88, branches: 78 },
    },
  },
  'ark-integration': {
    ...chainSuite,
    include: [
      'test/integration/arkKeeperFailure.test.ts',
      'test/integration/arkKeeperSuccess.test.ts',
    ],
    exclude: ['**/test/mocks/**/*', 'node_modules/**', 'dist/**'],
  },
  'recovery-integration': {
    ...chainSuite,
    include: [
      'test/integration/recoveryDetect.test.ts',
      'test/integration/recoveryKeeper.test.ts',
    ],
    exclude: ['**/test/mocks/**/*', 'node_modules/**', 'dist/**'],
    // The execute-flow gate: runExecute's remaining uncovered paths need
    // fault-injection seams (rcv write races, chain-time failures, on-chain
    // refill reverts), so the threshold reflects everything reachable today.
    coverage: {
      enabled: false,
      provider: 'v8' as const,
      reporter: ['text'],
      include: ['src/keepers/recoveryKeeper.ts', 'src/ark/recovery.ts'],
      thresholds: { statements: 89, lines: 89, functions: 92, branches: 82 },
    },
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
