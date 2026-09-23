/**
 * `gbrain export` writes every live page but never removed the file of a page
 * that had been deleted or re-slugged, so the markdown mirror only ever grew.
 * Measured on a real brain: 1695 live pages against 2426 files on disk — 731
 * leftovers, 675 of them from worktrees pruned weeks earlier. A backup taken
 * from that directory restores pages the brain no longer has.
 *
 * `--prune` makes the mirror a faithful copy: files this run did not write are
 * removed, and only the two shapes export itself produces are candidates.
 */

import { describe, test, expect, beforeAll, afterAll, spyOn } from 'bun:test';
import { mkdtempSync, existsSync, writeFileSync, mkdirSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { runExport } from '../src/commands/export.ts';

let engine: PGLiteEngine;
let outDir: string;

const KEPT = 'notes/kept';
const DROPPED = 'notes/dropped';

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
  outDir = mkdtempSync(join(tmpdir(), 'gbrain-prune-'));

  for (const slug of [KEPT, DROPPED]) {
    await engine.putPage(slug, {
      type: 'note',
      title: slug,
      compiled_truth: `# ${slug}\n\nBody.`,
      frontmatter: { type: 'note', title: slug },
    } as any, { sourceId: 'default' });
  }

  await runExport(engine, ['--dir', outDir]);
  expect(existsSync(join(outDir, DROPPED + '.md'))).toBe(true);

  // The page goes away, and so must its file on the next pruning export.
  await engine.deletePage(DROPPED, { sourceId: 'default' });

  // A sidecar for a page that no longer exists, and a file that is not ours.
  mkdirSync(join(outDir, 'notes', '.raw'), { recursive: true });
  writeFileSync(join(outDir, 'notes', '.raw', 'dropped.json'), '{}\n');
  writeFileSync(join(outDir, 'README.txt'), 'kept by the user\n');

  await runExport(engine, ['--dir', outDir, '--prune']);
}, 60000);

afterAll(async () => {
  await engine.disconnect();
  rmSync(outDir, { recursive: true, force: true });
}, 30000);

describe('export --prune keeps the mirror faithful to the brain', () => {
  test('removes the file of a page that no longer exists', () => {
    expect(existsSync(join(outDir, DROPPED + '.md'))).toBe(false);
  });

  test('keeps the file of a live page', () => {
    expect(existsSync(join(outDir, KEPT + '.md'))).toBe(true);
  });

  test('removes an orphaned .raw sidecar', () => {
    expect(existsSync(join(outDir, 'notes', '.raw', 'dropped.json'))).toBe(false);
  });

  test('leaves a file export never writes alone', () => {
    expect(existsSync(join(outDir, 'README.txt'))).toBe(true);
  });
});

test('refuses to prune when the page listing may be truncated', async () => {
  const listPages = engine.listPages.bind(engine);
  const fake = { slug: 'notes/fake', type: 'note', title: 'x', compiled_truth: '', timeline: '', frontmatter: {} };
  (engine as unknown as { listPages: unknown }).listPages = async (f: { limit: number }) => Array.from({ length: f.limit }, () => fake);
  const exit = spyOn(process, 'exit').mockImplementation(((code: number) => { throw new Error(`exit ${code}`); }) as never);
  try {
    await expect(runExport(engine, ['--dir', outDir, '--prune'])).rejects.toThrow('exit 1');
    expect(existsSync(join(outDir, KEPT + '.md'))).toBe(true);
    expect(existsSync(join(outDir, 'notes', 'fake.md'))).toBe(false);
  } finally {
    exit.mockRestore();
    (engine as unknown as { listPages: unknown }).listPages = listPages;
  }
}, 60000);
