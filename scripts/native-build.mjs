import { mkdir, readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.platform !== 'darwin' || process.arch !== 'arm64') {
  console.error('Native helper build requires macOS 14+ on Apple Silicon.');
  process.exit(1);
}
const outputDir = join(root, 'resources/native');
const moduleCache = join(root, 'native/.build/module-cache');
await mkdir(outputDir, { recursive: true });
await mkdir(moduleCache, { recursive: true });
const sources = (await readdir(join(root, 'native'))).filter((file) => file.endsWith('.swift')).sort();
const output = join(outputDir, 'one-room-helper');
const build = spawnSync('xcrun', ['swiftc', '-swift-version', '5', '-O', '-target', 'arm64-apple-macos14.0',
  '-module-cache-path', moduleCache, ...sources.map((file) => join(root, 'native', file)),
  '-framework', 'Cocoa', '-framework', 'ApplicationServices', '-framework', 'ScreenCaptureKit',
  '-framework', 'Vision', '-framework', 'ImageIO', '-o', output], { stdio: 'inherit' });
if (build.error) throw build.error;
if (build.status !== 0) process.exit(build.status ?? 1);
const signing = spawnSync('codesign', ['--force', '--sign', process.env.ONE_ROOM_SIGN_IDENTITY || '-',
  '--options', 'runtime', '--timestamp=none', '--identifier', 'com.one-room.native-helper', output], { stdio: 'inherit' });
if (signing.error) throw signing.error;
if (signing.status !== 0) process.exit(signing.status ?? 1);
console.log('Built and signed resources/native/one-room-helper (macOS 14+, arm64, Swift 5 mode).');
console.log('Ad-hoc signing is for local development; release packaging must sign the nested helper with the app identity.');
