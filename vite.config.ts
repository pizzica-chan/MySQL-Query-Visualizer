import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** file:// 直開き — 非 module の classic script を #root の後ろに置く */
function fixDistHtmlForFileProtocol(): Plugin {
  return {
    name: 'fix-dist-html-for-file-protocol',
    closeBundle() {
      const htmlPath = resolve(process.cwd(), 'dist/index.html');
      let html = readFileSync(htmlPath, 'utf8');

      const scriptRe =
        /<script[^>]*\ssrc="(\.\/assets\/[^"]+\.js)"[^>]*>\s*<\/script>/i;
      const match = html.match(scriptRe);
      if (!match) {
        throw new Error('[fix-dist-html-for-file-protocol] dist/index.html に JS 参照が見つかりません');
      }

      const scriptTag = `<script defer src="${match[1]}"></script>`;
      html = html.replace(match[0], '');
      html = html.replace(/<div id="root"><\/div>/, `<div id="root"></div>\n    ${scriptTag}`);

      writeFileSync(htmlPath, html);
    },
  };
}

export default defineConfig({
  base: './',
  plugins: [react(), fixDistHtmlForFileProtocol()],
  build: {
    cssCodeSplit: false,
    target: 'es2015',
    rollupOptions: {
      output: {
        format: 'iife',
        inlineDynamicImports: true,
        entryFileNames: 'assets/app.js',
        assetFileNames: 'assets/app[extname]',
      },
    },
  },
  test: {
    globals: false,
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
  },
});
