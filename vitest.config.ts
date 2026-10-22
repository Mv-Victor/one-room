import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['tests/unit/**/*.test.ts', 'src/services/reuse/**/*.test.ts'], environment: 'node' },
});
