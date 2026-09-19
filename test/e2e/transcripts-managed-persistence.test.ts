import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { activatePersistence } from '../../src/core/persistence/activation.ts';
import { claimWorktree } from '../../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import { runTranscriptsIngest, transcriptWriteRequestId } from '../../src/core/transcripts/ingest.ts';
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
    await runTranscriptsIngest(engine, opts);
    const replay = await engine.executeRaw<{ n: string }>(
      "SELECT count(*)::text AS n FROM persistence_requests WHERE operation='put_page' AND slug LIKE 'conversations/%'",
    );
    expect(Number(replay[0].n)).toBe(1);
  });
});

test('transcript write IDs are stable UUIDs and content-sensitive', () => {
  const a = transcriptWriteRequestId('put_page', 'default', 'conversations/a', 'one');
  expect(a).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  expect(transcriptWriteRequestId('put_page', 'default', 'conversations/a', 'one')).toBe(a);
  expect(transcriptWriteRequestId('put_page', 'default', 'conversations/a', 'two')).not.toBe(a);
});
