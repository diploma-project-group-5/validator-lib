// Vitest config for the Stryker mutation run (npm run mutation): the regular suite without
// coverage and without architecture.test.ts, which reads the source text that Stryker instruments.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/architecture.test.ts'],
  },
});
