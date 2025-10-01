import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: './vitest.global-setup.ts',
    testTimeout: 60000,
    hookTimeout: 60000,
    pool: 'threads',
    poolOptions: { threads: { singleThread: true } },
    sequence: {
      concurrent: false,
      shuffle: false
    },
    exclude: [
      '**/test/mocks/**/*'
    ]
  },
});
