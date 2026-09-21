import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { activatePersistence } from '../../src/core/persistence/activation.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { runCycle } from '../../src/core/cycle.ts';
import { runImport } from '../../src/commands/import.ts';
import { localWriteContext, submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { withEnv } from '../helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;
let repoRoot: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-managed-writers-'));
  await withEnv({ GBRAIN_HOME: home }, async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    repoRoot = join(home, 'repo');
    mkdirSync(repoRoot);
    await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', ['default', repoRoot]);
    await claimWorktree(engine, 'default', repoRoot);
    expect((await activatePersistence(engine, { confirmQuiesced: true })).enabled).toBe(true);
  });
}, 120_000);

afterAll(async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    await disposePersistenceConsumer(engine);
    await engine.disconnect();
  });
  rmSync(home, { recursive: true, force: true });
});

const requests = async (sql: string) =>
  Number((await engine.executeRaw<{ n: string }>(`SELECT count(*)::text AS n FROM persistence_requests WHERE ${sql}`))[0].n);

test('gbrain import writes a managed brain through the coordinator, database-only, and replays unchanged files', async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const staging = join(home, 'staging');
    mkdirSync(staging);
    writeFileSync(join(staging, 'handoff-demo.md'), '---\ntitle: "Demo"\ntype: note\ntags: [handoff]\n---\n\nFirst body.\n');
    await runImport(engine, [staging, '--no-embed']);
    const page = await engine.getPage('handoff-demo', { sourceId: 'default' });
    expect(page?.compiled_truth).toContain('First body.');
    expect(existsSync(join(repoRoot, 'handoff-demo.md'))).toBe(false);
    const afterFirst = await requests("operation='put_page' AND slug='handoff-demo'");
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    await runImport(engine, [staging, '--no-embed']);
    await runImport(engine, [staging, '--no-embed']);
    const steady = await requests("operation='put_page' AND slug='handoff-demo'");
    await runImport(engine, [staging, '--no-embed']);
    expect(await requests("operation='put_page' AND slug='handoff-demo'")).toBe(steady);

    writeFileSync(join(staging, 'handoff-demo.md'), '---\ntitle: "Demo"\ntype: note\ntags: [handoff]\n---\n\nSecond body.\n');
    await runImport(engine, [staging, '--no-embed']);
    expect((await engine.getPage('handoff-demo', { sourceId: 'default' }))?.compiled_truth).toContain('Second body.');
    // Reverting to earlier bytes is a new intent over a newer revision, never a stale replay.
    writeFileSync(join(staging, 'handoff-demo.md'), '---\ntitle: "Demo"\ntype: note\ntags: [handoff]\n---\n\nFirst body.\n');
    await runImport(engine, [staging, '--no-embed']);
    expect((await engine.getPage('handoff-demo', { sourceId: 'default' }))?.compiled_truth).toContain('First body.');

    // A purged page is recreated by the next import, never answered by the original creation receipt.
    await submitPageMutation(localWriteContext(engine, 'default'), { operation: 'delete_page', waitMs: 60_000,
      params: { source_id: 'default', slug: 'handoff-demo', force: true, purge: true, database_only: true } });
    expect(await engine.getPage('handoff-demo', { sourceId: 'default' })).toBeFalsy();
    await runImport(engine, [staging, '--no-embed']);
    expect((await engine.getPage('handoff-demo', { sourceId: 'default' }))?.compiled_truth).toContain('First body.');

    // A mixed-case frontmatter slug still replays against the stored lower-case revision.
    const alice = (body: string) => writeFileSync(join(staging, 'people-alice.md'), `---\ntitle: Alice\nslug: People-Alice\n---\n\n${body}\n`);
    for (const body of ['One.', 'Two.', 'One.']) { alice(body); await runImport(engine, [staging, '--no-embed']); }
    expect((await engine.getPage('people-alice', { sourceId: 'default' }))?.compiled_truth).toContain('One.');

    // The file is the source of truth: emptying it clears the page, as the legacy importer did.
    writeFileSync(join(staging, 'people-alice.md'), '');
    await runImport(engine, [staging, '--no-embed']);
    expect((await engine.getPage('people-alice', { sourceId: 'default' }))?.compiled_truth ?? '').not.toContain('One.');
  });
}, 120_000);

test('the brain-wide maintenance lane completes on a managed brain', async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const report = await runCycle(engine, {
      brainDir: repoRoot,
      phases: ['synthesize', 'resolve_symbol_edges', 'patterns', 'synthesize_concepts', 'grade_takes',
        'calibration_profile', 'drift', 'skillopt', 'embed', 'orphans', 'purge'],
    } as Parameters<typeof runCycle>[1]);
    // The embed phase needs a provider this fixture does not configure; only the writer fence is under test.
    const fenced = report.phases.filter(p => p.status === 'fail' && p.phase !== 'embed');
    expect(fenced).toEqual([]);
    expect(report.phases.find(p => p.phase === 'synthesize')?.details?.reason).toBe('writer_coordinator_required');
    expect(report.phases.find(p => p.phase === 'patterns')?.details?.reason).toBe('writer_coordinator_required');
  });
}, 120_000);
