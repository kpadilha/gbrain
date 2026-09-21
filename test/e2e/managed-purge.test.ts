import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { activatePersistence } from '../../src/core/persistence/activation.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { localWriteContext, purgeWriteRequestId, submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { registerBuiltinHandlers } from '../../src/commands/jobs.ts';
import { LAST_GLOBAL_AT_KEY } from '../../src/core/cycle.ts';
import { withEnv } from '../helpers/with-env.ts';
import { hasDatabase, setupDB, teardownDB } from './helpers.ts';

const SLUG = 'notes/expired-tombstone';

function managedPurgeSuite(label: string, open: () => Promise<BrainEngine>, close: (e: BrainEngine) => Promise<void>) {
  describe(`expired tombstones on a managed brain (${label})`, () => {
    let engine: BrainEngine;
    let home: string;
    let repoRoot: string;
    let revision: string;

    beforeAll(async () => {
      home = mkdtempSync(join(tmpdir(), 'gbrain-managed-purge-'));
      await withEnv({ GBRAIN_HOME: home }, async () => {
        engine = await open();
        repoRoot = join(home, 'repo');
        mkdirSync(repoRoot);
        await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', ['default', repoRoot]);
        await claimWorktree(engine, 'default', repoRoot);
        expect((await activatePersistence(engine, { confirmQuiesced: true })).enabled).toBe(true);
        const ctx = localWriteContext(engine, 'default');
        await submitPageMutation(ctx, { operation: 'put_page', waitMs: 60_000,
          params: { source_id: 'default', slug: SLUG, content: '---\ntitle: Expired\ntype: note\n---\n\nGone soon.\n' } });
        const live = await engine.readPageSnapshot(SLUG, { sourceId: 'default' });
        await submitPageMutation(ctx, { operation: 'delete_page', waitMs: 60_000,
          params: { source_id: 'default', slug: SLUG, expected_revision: live!.revision } });
        // Clock travel past the 72 h window, under the capability the coordinator itself holds.
        await engine.transaction(async tx => {
          await tx.executeRaw(`SELECT set_config('gbrain.write_sources','["default"]',true)`);
          await tx.executeRaw(`UPDATE pages SET deleted_at = now() - interval '73 hours' WHERE source_id='default' AND slug=$1`, [SLUG]);
        });
        revision = (await engine.readPageSnapshot(SLUG, { sourceId: 'default', includeDeleted: true }))!.revision;
      });
    }, 120_000);

    afterAll(async () => {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        await disposePersistenceConsumer(engine);
        await close(engine);
      });
      rmSync(home, { recursive: true, force: true });
    });

    const purgeRequests = async () => engine.executeRaw<{ id: string; request_id: string; state: string }>(
      `SELECT id::text, request_id::text, state FROM persistence_requests WHERE operation='delete_page' AND slug=$1 AND intent->>'purge'='true'`, [SLUG]);

    test('the global lane purges through the coordinator and stamps last_global_at', async () => {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        expect(existsSync(join(repoRoot, `${SLUG}.md`))).toBe(false);
        expect(await engine.getConfig(LAST_GLOBAL_AT_KEY)).toBeNull();
        const handlers = new Map<string, (job: unknown) => Promise<any>>();
        await registerBuiltinHandlers({ register: (name: string, fn: (job: unknown) => Promise<any>) => handlers.set(name, fn) } as never, engine);
        const result = await handlers.get('autopilot-global-maintenance')!({ id: 7301, data: { phases: ['purge'], repoPath: repoRoot } });
        const purge = result.report.phases.find((p: { phase: string }) => p.phase === 'purge');
        expect({ status: purge.status, stamped: await engine.getConfig(LAST_GLOBAL_AT_KEY) !== null, error: purge.error?.message ?? purge.summary })
          .toMatchObject({ status: 'ok', stamped: true });
        expect(purge.details.purged_pages_count).toBe(1);
        expect(await engine.readPageSnapshot(SLUG, { sourceId: 'default', includeDeleted: true })).toBeNull();
        const rows = await purgeRequests();
        expect(rows.map(r => [r.request_id, r.state])).toEqual([[purgeWriteRequestId('default', SLUG, revision), 'committed']]);
      });
    }, 120_000);

    test('a replayed purge reuses the committed receipt after the row is gone', async () => {
      await withEnv({ GBRAIN_HOME: home }, async () => {
        const [before] = await purgeRequests();
        const r = await submitPageMutation(localWriteContext(engine, 'default'), { operation: 'delete_page', waitMs: 60_000, params: {
          request_id: before.request_id, source_id: 'default', slug: SLUG, expected_revision: revision, purge: true } });
        expect(r.status).toBe('purged');
        expect(await purgeRequests()).toEqual([before]);
      });
    }, 120_000);
  });
}

managedPurgeSuite('PGLite', async () => {
  const e = new PGLiteEngine();
  await e.connect({});
  await e.initSchema();
  return e;
}, e => e.disconnect());

if (hasDatabase()) managedPurgeSuite('Postgres', () => setupDB(), () => teardownDB());
