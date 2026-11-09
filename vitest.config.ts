import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/generated/**', 'src/cli/main.ts'],
      reporter: ['text', 'text-summary'],
      // ADR 2026-11-09: domain >= 90 % branches; the whole package must not fall below these.
      thresholds: {
        lines: 90,
        statements: 90,
        functions: 90,
        branches: 85,
        'src/domain/**': { branches: 90 },
      },
    },
  },
});
