import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

/** file:// 直開き — ビルド後にインライン script の type=module を外す */
function stripInlineModuleType(): Plugin {
  return {
    name: 'strip-inline-module-type',
    closeBundle() {
      const htmlPath = resolve(process.cwd(), 'dist/index.html');
      const html = readFileSync(htmlPath, 'utf8');
      writeFileSync(
        htmlPath,
        html.replace(/<script type="module" crossorigin>/g, '<script>'),
      );
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true }), stripInlineModuleType()],
  build: {
    // file:// 直開き — 外部 module スクリプトを使わず IIFE を index.html にインライン
    cssCodeSplit: false,
    target: 'es2015',
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
      },
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
