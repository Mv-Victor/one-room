import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          app: resolve('src/main/app.ts'),
          database: resolve('src/workers/database.ts'),
          smoke: resolve('tests/integration/foundation-smoke.ts'),
          nativeCaptureSmoke: resolve('tests/integration/native-capture-smoke.ts'),
          navigationBenchmark: resolve('tests/integration/navigation-benchmark.ts'),
        },
        output: { format: 'es', entryFileNames: '[name].js' },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: resolve('src/main/preload.ts'),
        output: { format: 'cjs', entryFileNames: 'index.cjs' },
      },
    },
  },
  renderer: {
    root: 'src/renderer',
    plugins: [react()],
    server: { host: '127.0.0.1', port: 5173 },
    build: { rollupOptions: { input: resolve('src/renderer/index.html') } },
  },
});
