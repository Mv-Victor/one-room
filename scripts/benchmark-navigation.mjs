import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(root, 'out/main/navigationBenchmark.js');
if (!existsSync(entry)) throw new Error('Run npm run build before the navigation benchmark.');
const require = createRequire(import.meta.url);
const result = spawnSync(require('electron'), [entry], {
  cwd: root, stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
});
if (result.error) throw result.error;
process.exit(result.status ?? 1);
