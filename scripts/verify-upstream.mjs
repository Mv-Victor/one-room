import { readFile, access } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({ options: {
  'source-root': { type: 'string' }, offline: { type: 'boolean', default: false },
  json: { type: 'boolean', default: false },
} });
const sourceRoot = values['source-root'] || process.env.ONE_ROOM_UPSTREAM_DIR || '/tmp/one-room-upstream-research.Fex6Go';
const feature = join(root, 'specs/001-event-driven-capture');
const lock = JSON.parse(await readFile(join(feature, 'source-lock.json'), 'utf8'));
assert.equal(lock.schemaVersion, 1, 'unsupported source lock version');
const files = new Map();
const projects = [];

for (const project of lock.projects) {
  assert.match(project.commit, /^[a-f0-9]{40}$/);
  assert.match(project.repository, /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
  const localRoot = join(sourceRoot, project.name);
  try {
    await access(join(localRoot, '.git'));
    const revision = spawnSync('git', ['-C', localRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' });
    assert.equal(revision.status, 0, `${project.name}: cannot read local git revision`);
    assert.equal(revision.stdout.trim(), project.commit, `${project.name}: local clone is not the locked revision`);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  let localFiles = 0;
  let fetchedFiles = 0;
  for (const file of project.files) {
    assert.ok(!file.path.startsWith('/') && !file.path.split('/').includes('..'), 'unsafe locked path');
    if (project.name === 'screenpipe') assert.ok(!file.path.split('/').includes('ee'), 'Screenpipe ee source is outside the selected MIT scope');
    let bytes;
    try {
      bytes = await readFile(join(localRoot, file.path));
      localFiles += 1;
    } catch (error) {
      if (error.code !== 'ENOENT' || values.offline) throw error;
      const repository = project.repository.slice('https://github.com/'.length);
      const url = `https://raw.githubusercontent.com/${repository}/${project.commit}/${file.path}`;
      const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
      assert.ok(response.ok, `${project.name}/${file.path}: HTTP ${response.status}`);
      bytes = Buffer.from(await response.arrayBuffer());
      fetchedFiles += 1;
    }
    assert.equal(createHash('sha256').update(bytes).digest('hex'), file.sha256, `${project.name}/${file.path}: SHA256 mismatch`);
    const text = bytes.toString('utf8');
    const lines = text.split('\n');
    // source-lock lineCount includes the trailing empty split when a file ends in LF.
    assert.equal(lines.length, file.lineCount, `${project.name}/${file.path}: line count mismatch`);
    files.set(`${project.name}/${file.path}`, { bytes, lines });
  }
  projects.push({ name: project.name, commit: project.commit, files: project.files.length, localFiles, fetchedFiles });
}

const excerptDocument = await readFile(join(feature, 'code-excerpts.md'), 'utf8');
for (const excerpt of lock.excerpts) {
  const file = files.get(`${excerpt.project}/${excerpt.path}`);
  assert.ok(file, `${excerpt.id}: source file not locked`);
  const actual = file.lines.slice(excerpt.startLine - 1, excerpt.endLine).join('\n');
  assert.equal(actual, excerpt.text, `${excerpt.id}: locked excerpt does not match the source range`);
  assert.ok(excerptDocument.includes(`## ${excerpt.id}\n`), `${excerpt.id}: missing document heading`);
  assert.ok(excerptDocument.includes(excerpt.text), `${excerpt.id}: document excerpt changed`);
}
const licenses = [
  ['screenpipe/LICENSE.md', 'screenpipe-MIT.txt'],
  ['memorylane/LICENSE', 'memorylane-GPL-3.0.txt'],
];
for (const [source, filename] of licenses) {
  const retained = await readFile(join(feature, 'licenses', filename));
  assert.ok(retained.equals(files.get(source).bytes), `${filename}: retained license differs from upstream`);
}
const summary = { ok: true, projects, files: files.size, excerpts: lock.excerpts.length, licenses: licenses.length };
console.log(values.json ? JSON.stringify(summary, null, 2) :
  `Upstream verification passed: ${summary.files} locked files, ${summary.excerpts} exact excerpts, ${summary.licenses} original licenses.\n` +
  projects.map((project) => `${project.name} ${project.commit}: ${project.localFiles} local, ${project.fetchedFiles} fetched from fixed commit`).join('\n'));
