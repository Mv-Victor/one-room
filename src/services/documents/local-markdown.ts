import { createHash, randomUUID } from 'node:crypto';
import { constants, type BigIntStats } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, dirname, extname, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { createTwoFilesPatch } from 'diff';
import { DomainError } from '../../shared/errors';

export const MAX_MARKDOWN_BYTES = 2 * 1024 * 1024;
export type FileIdentity = { dev: string; ino: string };
export type PathIdentity = FileIdentity & { path: string; kind: 'directory' | 'symlink' };
// This record is main-only. Public target summaries must omit all paths and identities.
export type LocalTargetRecord = {
  id: string;
  kind: 'local_markdown';
  displayName: string;
  selectedPath: string;
  canonicalPath: string;
  identity: FileIdentity;
  ancestors: PathIdentity[];
  size: number;
  mtimeNs: string;
};
export type MarkdownSection = {
  sectionRef: string;
  title: string;
  heading: string;
  level: number;
  date: string | null;
  startByte: number;
  endByte: number;
};
export type LocalMarkdownSnapshot = {
  target: LocalTargetRecord;
  hash: string;
  bytes: Buffer;
  bom: boolean;
  newline: '\n' | '\r\n';
  sections: MarkdownSection[];
};
export type ConfirmedMarkdownSection = MarkdownSection & { targetId: string; snapshotHash: string };
export type MarkdownCandidate = {
  targetId: string;
  beforeHash: string;
  afterHash: string;
  beforeBytes: Buffer;
  afterBytes: Buffer;
  replacementBytes: Buffer;
  section: ConfirmedMarkdownSection;
  diff: string;
};

export const markdownHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
const identity = (stat: BigIntStats): FileIdentity => ({ dev: String(stat.dev), ino: String(stat.ino) });
export const sameFileIdentity = (a: FileIdentity, b: FileIdentity): boolean => a.dev === b.dev && a.ino === b.ino;
const unsupported = (): never => { throw new DomainError('INVALID_ARGUMENT', 'This Markdown format cannot be updated safely.', 'UNSUPPORTED_FORMAT'); };
export const targetConflict = (): never => { throw new DomainError('CONFLICT', 'The selected document changed. Select and review it again.', 'TARGET_CONFLICT'); };

function decode(bytes: Buffer): { text: string; bom: boolean; newline: '\n' | '\r\n' } {
  if (bytes.length > MAX_MARKDOWN_BYTES) throw new DomainError('INVALID_ARGUMENT', 'The document exceeds 2 MiB.', 'INPUT_TOO_LARGE');
  const bom = bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes.subarray(bom ? 3 : 0)); }
  catch { return unsupported(); }
  if (text.includes('\0') || text.includes('\ufeff') || /\r(?!\n)/.test(text)) return unsupported();
  const crlf = text.includes('\r\n'), loneLf = /(?<!\r)\n/.test(text);
  if (crlf && loneLf) return unsupported();
  return { text, bom, newline: crlf ? '\r\n' : '\n' };
}

function headings(bytes: Buffer, document: ReturnType<typeof decode>): MarkdownSection[] {
  const sections: MarkdownSection[] = [], titles = new Set<string>(), dates = new Set<string>();
  let offset = document.bom ? 3 : 0, fence: { marker: string; count: number } | null = null;
  const lines = document.text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  for (const rawLine of lines) {
    const line = rawLine.replace(/\r?\n$/, '');
    const fenced = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenced) {
      const marker = fenced[1][0], count = fenced[1].length;
      if (!fence) fence = { marker, count };
      else if (fence.marker === marker && count >= fence.count && /^ {0,3}(?:`+|~+)\s*$/.test(line)) fence = null;
    } else if (!fence) {
      const heading = /^ {0,3}(#{1,6})[\t ]+(.+?)\s*$/.exec(line);
      if (heading) {
        const title = heading[2].replace(/[\t ]+#+[\t ]*$/, '').trim();
        const key = title.normalize('NFC').toLocaleLowerCase('en-US');
        const foundDates = title.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [];
        if (!title || titles.has(key) || new Set(foundDates).size !== foundDates.length || foundDates.some(date => dates.has(date))) return unsupported();
        titles.add(key); for (const date of foundDates) dates.add(date);
        sections.push({ sectionRef: `section:${offset}:${markdownHash(Buffer.from(line)).slice(0, 16)}`, title, heading: line,
          level: heading[1].length, date: foundDates[0] ?? null, startByte: offset, endByte: bytes.length });
      } else if (/^ {0,3}(?:={2,}|-{2,})\s*$/.test(line)) {
        // Setext headings overlap with thematic breaks; ask for a simpler explicit section.
        return unsupported();
      }
    }
    offset += Buffer.byteLength(rawLine);
  }
  if (!sections.length || fence) return unsupported();
  for (let index = 0; index < sections.length; index++) {
    sections[index].endByte = sections.slice(index + 1).find(next => next.level <= sections[index].level)?.startByte ?? bytes.length;
  }
  return sections;
}

async function ancestorIdentities(selectedPath: string): Promise<PathIdentity[]> {
  const result: PathIdentity[] = [];
  let current = dirname(selectedPath);
  for (;;) {
    const stat = await lstat(current, { bigint: true });
    if (!stat.isDirectory() && !stat.isSymbolicLink()) return targetConflict();
    result.push({ path: current, ...identity(stat), kind: stat.isSymbolicLink() ? 'symlink' : 'directory' });
    const canonical = await realpath(current), resolved = await lstat(canonical, { bigint: true });
    if (!resolved.isDirectory()) return targetConflict();
    if (canonical !== current) result.push({ path: canonical, ...identity(resolved), kind: 'directory' });
    if (dirname(current) === current) break;
    current = dirname(current);
  }
  return result;
}

function filesystemError(error: unknown): never {
  if (error instanceof DomainError) throw error;
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT' || code === 'ENOTDIR') throw new DomainError('NOT_FOUND', 'The selected document is unavailable.', 'TARGET_NOT_FOUND');
  if (code === 'EACCES' || code === 'EPERM') throw new DomainError('PERMISSION_DENIED', 'The selected document cannot be read.');
  if (code === 'ELOOP') return targetConflict();
  throw new DomainError('INTERNAL', 'The selected document could not be read.', 'READ_FAILED');
}

export class LocalMarkdownConnector {
  snapshot(target: LocalTargetRecord, bytes: Buffer): LocalMarkdownSnapshot {
    const document = decode(bytes);
    return { target, bytes: Buffer.from(bytes), hash: markdownHash(bytes), bom: document.bom, newline: document.newline, sections: headings(bytes, document) };
  }

  async register(selectedPath: string): Promise<LocalTargetRecord> {
    try {
      const selected = await lstat(selectedPath, { bigint: true }), normalized = resolve(selectedPath);
      if (!selected.isFile() || selected.isSymbolicLink() || !['.md', '.markdown'].includes(extname(normalized).toLowerCase())) return unsupported();
      const canonicalPath = await realpath(normalized), stat = await lstat(canonicalPath, { bigint: true });
      if (!stat.isFile() || !sameFileIdentity(identity(selected), identity(stat))) return targetConflict();
      const target: LocalTargetRecord = { id: randomUUID(), kind: 'local_markdown', displayName: basename(normalized), selectedPath: normalized,
        canonicalPath, identity: identity(stat), ancestors: await ancestorIdentities(normalized), size: Number(stat.size), mtimeNs: String(stat.mtimeNs) };
      await this.inspect(target);
      return target;
    } catch (error) { return filesystemError(error); }
  }

  async readCurrent(target: LocalTargetRecord, expectedIdentity: FileIdentity | null = target.identity): Promise<{ bytes: Buffer; target: LocalTargetRecord; mode: number }> {
    try {
      const selected = await lstat(target.selectedPath, { bigint: true });
      if (!selected.isFile() || selected.isSymbolicLink() || await realpath(target.selectedPath) !== target.canonicalPath) return targetConflict();
      for (const expected of target.ancestors) {
        const current = await lstat(expected.path, { bigint: true });
        if (!sameFileIdentity(identity(current), expected) || (expected.kind === 'symlink' ? !current.isSymbolicLink() : !current.isDirectory())) return targetConflict();
      }
      const handle = await open(target.canonicalPath, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const before = await handle.stat({ bigint: true });
        if (!before.isFile() || !sameFileIdentity(identity(before), identity(selected)) || (expectedIdentity && !sameFileIdentity(identity(before), expectedIdentity))) return targetConflict();
        if (before.size > BigInt(MAX_MARKDOWN_BYTES)) throw new DomainError('INVALID_ARGUMENT', 'The document exceeds 2 MiB.', 'INPUT_TOO_LARGE');
        const buffer = Buffer.alloc(MAX_MARKDOWN_BYTES + 1);
        let length = 0;
        for (;;) {
          const chunk = await handle.read(buffer, length, buffer.length - length, length);
          length += chunk.bytesRead;
          if (length > MAX_MARKDOWN_BYTES) throw new DomainError('INVALID_ARGUMENT', 'The document exceeds 2 MiB.', 'INPUT_TOO_LARGE');
          if (!chunk.bytesRead) break;
        }
        const bytes = buffer.subarray(0, length), after = await handle.stat({ bigint: true });
        if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs || bytes.length !== Number(after.size)) return targetConflict();
        return { bytes, target: { ...target, identity: identity(after), size: bytes.length, mtimeNs: String(after.mtimeNs) }, mode: Number(after.mode & 0o7777n) };
      } finally { await handle.close(); }
    } catch (error) { return filesystemError(error); }
  }

  async inspect(target: LocalTargetRecord): Promise<LocalMarkdownSnapshot> {
    const current = await this.readCurrent(target);
    return this.snapshot(current.target, current.bytes);
  }

  confirm(snapshot: LocalMarkdownSnapshot, sectionRef: string): ConfirmedMarkdownSection {
    const section = snapshot.sections.find(section => section.sectionRef === sectionRef);
    if (!section) throw new DomainError('INVALID_ARGUMENT', 'Select one unambiguous document section.', 'UNSUPPORTED_FORMAT');
    return { ...section, targetId: snapshot.target.id, snapshotHash: snapshot.hash };
  }

  candidate(snapshot: LocalMarkdownSnapshot, section: ConfirmedMarkdownSection, replacementMarkdown: string): MarkdownCandidate {
    const originalSection = snapshot.sections.find(item => item.sectionRef === section.sectionRef);
    if (snapshot.hash !== markdownHash(snapshot.bytes) || section.targetId !== snapshot.target.id || section.snapshotHash !== snapshot.hash || !originalSection ||
      Object.keys(originalSection).some(key => originalSection[key as keyof MarkdownSection] !== section[key as keyof MarkdownSection])) return targetConflict();
    if (typeof replacementMarkdown !== 'string' || replacementMarkdown.includes('\ufeff')) return unsupported();
    const replacementRaw = Buffer.from(replacementMarkdown, 'utf8');
    if (replacementRaw.toString('utf8') !== replacementMarkdown) return unsupported();
    const replacementDocument = decode(replacementRaw);
    const replacement = Buffer.from(replacementDocument.text.replace(/\r\n/g, '\n').replace(/\n/g, snapshot.newline));
    const replacementHeadings = headings(replacement, decode(replacement));
    const first = replacementHeadings[0];
    const dates = snapshot.sections.filter(item => item.startByte >= section.startByte && item.startByte < section.endByte && item.date).map(item => item.date).sort();
    if (first.startByte !== 0 || first.heading !== section.heading || first.level !== section.level || first.date !== section.date ||
      replacementHeadings.slice(1).some(item => item.level <= section.level) ||
      JSON.stringify(replacementHeadings.filter(item => item.date).map(item => item.date).sort()) !== JSON.stringify(dates) ||
      (section.endByte < snapshot.bytes.length && !replacement.subarray(-snapshot.newline.length).equals(Buffer.from(snapshot.newline)))) return unsupported();
    const before = snapshot.bytes.subarray(0, section.startByte), after = snapshot.bytes.subarray(section.endByte);
    const bytes = Buffer.concat([before, replacement, after]);
    const parsed = decode(bytes); headings(bytes, parsed);
    if (!bytes.subarray(0, before.length).equals(before) || !bytes.subarray(before.length + replacement.length).equals(after)) return targetConflict();
    const name = snapshot.target.displayName.replace(/[\r\n\t]/g, '_');
    return { targetId: snapshot.target.id, beforeHash: snapshot.hash, afterHash: markdownHash(bytes), beforeBytes: Buffer.from(snapshot.bytes), afterBytes: bytes,
      replacementBytes: replacement, section, diff: createTwoFilesPatch(name, name, snapshot.bytes.toString('utf8'), bytes.toString('utf8'), '', '', { context: Number.MAX_SAFE_INTEGER }) };
  }
}
