import { afterAll, beforeAll, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { activatePersistence } from '../../src/core/persistence/activation.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { runCycle } from '../../src/core/cycle.ts';
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
