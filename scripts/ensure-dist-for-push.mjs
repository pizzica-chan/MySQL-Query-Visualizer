import { execSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

function gitOutput(args) {
  return execSync(['git', ...args].join(' '), {
    cwd: root,
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  }).trim();
}

console.log('[ensure-dist] dist/ を再ビルドします...');
execSync('npm run build', { cwd: root, stdio: 'inherit' });

const changed = gitOutput(['diff', '--name-only', 'HEAD', '--', 'dist/']);
const untracked = gitOutput(['ls-files', '--others', '--exclude-standard', '--', 'dist/']);

if (changed || untracked) {
  const files = [...new Set([...changed.split('\n').filter(Boolean), ...untracked.split('\n').filter(Boolean)])];
  console.error('');
  console.error('[ensure-dist] dist/ が最新ビルドと一致していません。');
  console.error('  差分:', files.join(', '));
  console.error('  npm run build の結果を dist/ にコミットしてから push してください。');
  process.exit(1);
}

console.log('[ensure-dist] dist/ は最新ビルドと一致しています。');
