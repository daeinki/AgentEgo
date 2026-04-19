import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'packages/*/src/**/*.test.ts',
      'packages/*/test/**/*.spec.ts',
      'packages/channels/*/src/**/*.test.ts',
    ],
  },
});
