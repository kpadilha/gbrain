import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { activatePersistence } from '../../src/core/persistence/activation.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { nextTranscriptRequestId, runTranscriptsIngest, transcriptWriteRequestId } from '../../src/core/transcripts/ingest.ts';
import { localWriteContext, submitPageMutation } from '../../src/core/persistence/page-mutations.ts';
import { withEnv } from '../helpers/with-env.ts';

const fixture = join(import.meta.dir, '..', 'fixtures', 'transcripts', 'codex-rollout.jsonl');
let engine: PGLiteEngine;
let home: string;
let repoRoot: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-transcript-managed-'));
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

test('managed transcript ingest routes page writes through the durable coordinator', async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const opts = { paths: [fixture], sourceId: 'default', userPatternsPath: '/nonexistent-patterns.txt' };
    const first = await runTranscriptsIngest(engine, opts);
    expect(first.sessionsErrored).toBe(0);
    expect(first.pages.imported).toBe(1);
    const rows = await engine.executeRaw<{ n: string }>(
      "SELECT count(*)::text AS n FROM persistence_requests WHERE operation='put_page' AND slug LIKE 'conversations/%'",
    );
    expect(Number(rows[0].n)).toBe(1);
    expect(existsSync(join(repoRoot, `${first.slugsTouched[0]}.md`))).toBe(false);
    // The first rescan admits one no-op over the new revision; from then on rescans replay it.
    const puts = async () => Number((await engine.executeRaw<{ n: string }>(
      "SELECT count(*)::text AS n FROM persistence_requests WHERE operation='put_page' AND slug LIKE 'conversations/%'"))[0].n);
    await runTranscriptsIngest(engine, opts);
    const settled = await puts();
    await runTranscriptsIngest(engine, opts);
    await runTranscriptsIngest(engine, opts);
    expect(await puts()).toBe(settled);
  });
});

test('transcript write IDs are stable UUIDs, content- and revision-sensitive', () => {
  const a = transcriptWriteRequestId('put_page', 'default', 'conversations/a', 'r1', 'one');
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(transcriptWriteRequestId('put_page', 'default', 'conversations/a', 'r1', 'one')).toBe(a);
  expect(transcriptWriteRequestId('put_page', 'default', 'conversations/a', 'r1', 'two')).not.toBe(a);
  expect(transcriptWriteRequestId('put_page', 'default', 'conversations/a', 'r2', 'one')).not.toBe(a);
});

test('a recreated part is deleted again instead of replaying the first delete receipt', async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const ctx = localWriteContext(engine, 'default');
    const slug = 'conversations/recreated-p2';
    const content = '---\ntitle: Part 2\ntype: conversation\n---\n\nSame bytes every time.\n';
    const live = async () => (await engine.readPageSnapshot(slug, { sourceId: 'default' }))?.page.deleted_at == null
      && !!(await engine.readPageSnapshot(slug, { sourceId: 'default' }));
    for (let round = 0; round < 2; round++) {
      await submitPageMutation(ctx, { operation: 'put_page', waitMs: 60_000, params: { request_id: await nextTranscriptRequestId(ctx, 'put_page', slug, content),
        source_id: 'default', slug, content, force: true, database_only: true } });
      expect(await live()).toBe(true);
      await submitPageMutation(ctx, { operation: 'delete_page', waitMs: 60_000, params: { request_id: await nextTranscriptRequestId(ctx, 'delete_page', slug),
        source_id: 'default', slug, force: true, database_only: true } });
      expect(await live()).toBe(false);
    }
  });
}, 120_000);
