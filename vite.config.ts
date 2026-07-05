import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { viteSingleFile } from 'vite-plugin-singlefile';

/** file:// 直開き — インライン script を #root の後ろへ移動し type=module を外す */
function finalizeSingleFileHtml(): Plugin {
  return {
    name: 'finalize-single-file-html',
    closeBundle() {
      const htmlPath = resolve(process.cwd(), 'dist/index.html');
      let html = readFileSync(htmlPath, 'utf8');

      const scriptMatch = html.match(/<script(?:\s[^>]*)?>[\s\S]*?<\/script>/);
      if (!scriptMatch) return;

      html = html.replace(scriptMatch[0], '');
      html = html.replace(
        /<div id="root"><\/div>/,
        `<div id="root"></div>\n    ${scriptMatch[0].replace(/<script(?:\s[^>]*)?>/, '<script>')}`,
      );

      writeFileSync(htmlPath, html);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true }), finalizeSingleFileHtml()],
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
