import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';
import { resolve } from 'node:path';
import type { RollupLog } from 'rollup';

// zod ships `@__PURE__` comments Rollup cannot place; they are harmless.
const quietWarnings = {
  onwarn(warning: RollupLog, defaultHandler: (warning: RollupLog) => void) {
    if (warning.code === 'INVALID_ANNOTATION') {
      return;
    }
    defaultHandler(warning);
  },
};

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    build: { rollupOptions: quietWarnings },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['zod'] })],
    build: {
      rollupOptions: {
        ...quietWarnings,
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer'),
      },
    },
    plugins: [react()],
    build: { rollupOptions: quietWarnings },
  },
});
