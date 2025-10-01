import base from './vitest.base';
import { defineConfig, mergeConfig } from 'vitest/config';

export default mergeConfig(
  base,
  defineConfig({
    test: {
      include: ['test/integration/**/*.{test,spec}.{ts,tsx,js}'],
      exclude: ['node_modules/**', 'dist/**']
    },
  }),
);
