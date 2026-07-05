import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

/** file:// 直開き — CSS をインライン化し、classic script を #root の後ろに置く */
function fixDistHtmlForFileProtocol(): Plugin {
  return {
    name: 'fix-dist-html-for-file-protocol',
    closeBundle() {
      const distDir = resolve(process.cwd(), 'dist');
      const htmlPath = resolve(distDir, 'index.html');
      let html = readFileSync(htmlPath, 'utf8');

      const cssLinkRe = /<link[^>]*href="(\.\/assets\/[^"]+\.css)"[^>]*>\s*/i;
      const cssMatch = html.match(cssLinkRe);
      if (!cssMatch) {
        throw new Error('[fix-dist-html-for-file-protocol] dist/index.html に CSS 参照が見つかりません');
      }

      const cssPath = resolve(distDir, cssMatch[1]!.replace(/^\.\//, ''));
      const css = readFileSync(cssPath, 'utf8');
      html = html.replace(cssLinkRe, `<style>${css}</style>\n    `);

      const scriptRe =
        /<script[^>]*\ssrc="(\.\/assets\/[^"]+\.js)"[^>]*>\s*<\/script>/i;
      const scriptMatch = html.match(scriptRe);
      if (!scriptMatch) {
        throw new Error('[fix-dist-html-for-file-protocol] dist/index.html に JS 参照が見つかりません');
      }

      const scriptTag = `<script defer src="${scriptMatch[1]}"></script>`;
      html = html.replace(scriptMatch[0], '');
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
