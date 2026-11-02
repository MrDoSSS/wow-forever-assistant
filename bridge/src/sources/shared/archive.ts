// Bounded ZIP reader: validate paths, sizes and CRC before selecting static data.
import { crc32 } from 'node:zlib';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

export const ARCHIVE_LIMITS = {
  archiveBytes: 32 * 1024 * 1024,
  entries: 4096,
  fileBytes: 8 * 1024 * 1024,
  totalUncompressedBytes: 128 * 1024 * 1024,
  selectedBytes: 32 * 1024 * 1024,
} as const;

export type ArchiveLimits = { -readonly [K in keyof typeof ARCHIVE_LIMITS]: number };

export class ArchiveError extends Error {
  constructor(
    readonly code:
      | 'archive_too_large'
      | 'bad_zip'
      | 'too_many_entries'
      | 'unsafe_path'
      | 'duplicate_entry'
      | 'encrypted_entry'
      | 'link_entry'
      | 'too_large'
      | 'size_mismatch'
      | 'crc_mismatch'
      | 'missing_toc',
    message: string,
  ) {
    super(message);
    this.name = 'ArchiveError';
  }
}

function checkPath(name: string): void {
  if (name.includes('\0') || name.includes('\\') || name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw new ArchiveError('unsafe_path', `unsafe entry name ${JSON.stringify(name)}`);
  }
  if (name.split('/').some((part) => part === '..' || part === '.')) {
    throw new ArchiveError('unsafe_path', `unsafe entry name ${JSON.stringify(name)}`);
  }
}

function isLink(entry: Entry): boolean {
  const unixMode = (entry.externalFileAttributes >>> 16) & 0o170000;
  return unixMode === 0o120000;
}

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(buffer, { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error || !zip) reject(new ArchiveError('bad_zip', error?.message ?? 'cannot open zip'));
      else resolve(zip);
    });
  });
}

function readEntry(zip: ZipFile, entry: Entry, limit: number): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) return reject(new ArchiveError('bad_zip', error?.message ?? 'cannot read entry'));
      const chunks: Buffer[] = [];
      let total = 0;
      stream.on('data', (chunk: Buffer) => {
        total += chunk.length;
        if (total > limit) {
          stream.destroy(new ArchiveError('too_large', `${entry.fileName} exceeds ${limit} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      stream.on('error', (e) => reject(e instanceof ArchiveError ? e : new ArchiveError('size_mismatch', String(e))));
      stream.on('end', () => resolve(new Uint8Array(Buffer.concat(chunks))));
    });
  });
}

/** Read the archive: validate all entries first, then extract selected files. */
export async function readSelectedArchive(
  archive: Uint8Array,
  selection: { root: string; select: (name: string) => boolean },
  limits: ArchiveLimits = { ...ARCHIVE_LIMITS },
): Promise<{ files: Map<string, Uint8Array>; entryCount: number }> {
  if (archive.byteLength > limits.archiveBytes) {
    throw new ArchiveError('archive_too_large', `archive is ${archive.byteLength} bytes`);
  }
  const zip = await openZip(Buffer.from(archive.buffer, archive.byteOffset, archive.byteLength));
  try {
    if (zip.entryCount > limits.entries) throw new ArchiveError('too_many_entries', `${zip.entryCount} entries`);
    const entries: Entry[] = [];
    await new Promise<void>((resolve, reject) => {
      zip.on('entry', (entry: Entry) => {
        entries.push(entry);
        zip.readEntry();
      });
      zip.on('end', () => resolve());
      zip.on('error', (e) => reject(new ArchiveError('bad_zip', String(e))));
      zip.readEntry();
    });

    const seen = new Set<string>();
    let declaredTotal = 0;
    let selectedTotal = 0;
    const selected: Entry[] = [];
    for (const entry of entries) {
      const name = entry.fileName;
      checkPath(name);
      const normalized = name.normalize('NFC').toLowerCase();
      if (seen.has(normalized)) throw new ArchiveError('duplicate_entry', `duplicate entry ${name}`);
      seen.add(normalized);
      if ((entry.generalPurposeBitFlag & 0x1) !== 0) throw new ArchiveError('encrypted_entry', `encrypted entry ${name}`);
      if (isLink(entry)) throw new ArchiveError('link_entry', `link entry ${name}`);
      declaredTotal += entry.uncompressedSize;
      if (declaredTotal > limits.totalUncompressedBytes) throw new ArchiveError('too_large', 'archive uncompresses too large');
      if (!name.startsWith(selection.root)) throw new ArchiveError('unsafe_path', `entry outside ${selection.root}: ${name}`);
      if (selection.select(name)) {
        if (entry.uncompressedSize > limits.fileBytes) throw new ArchiveError('too_large', `${name} is too large`);
        selectedTotal += entry.uncompressedSize;
        if (selectedTotal > limits.selectedBytes) throw new ArchiveError('too_large', 'selected data is too large');
        selected.push(entry);
      }
    }

    const files = new Map<string, Uint8Array>();
    for (const entry of selected) {
      const bytes = await readEntry(zip, entry, limits.fileBytes);
      if (bytes.byteLength !== entry.uncompressedSize) throw new ArchiveError('size_mismatch', `${entry.fileName} size mismatch`);
      if (crc32(bytes) >>> 0 !== entry.crc32 >>> 0) throw new ArchiveError('crc_mismatch', `${entry.fileName} CRC mismatch`);
      files.set(entry.fileName, bytes);
    }
    return { files, entryCount: entries.length };
  } finally {
    zip.close();
  }
}
