import { afterAll, beforeAll, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { activatePersistence } from '../src/core/persistence/activation.ts';
import { claimWorktree } from '../src/core/persistence/ownership.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runImport } from '../src/commands/import.ts';
import { importWriteRequestId, localWriteContext, submitPageMutation } from '../src/core/persistence/page-mutations.ts';
import { createHash } from 'node:crypto';
import { importManagedDatabaseOnly } from '../src/core/persistence/import-mutations.ts';
import { withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import { withEnv } from './helpers/with-env.ts';

let engine: PGLiteEngine;
let home: string;
let repoRoot: string;
let otherRoot: string;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), 'gbrain-managed-writers-'));
  await withEnv({ GBRAIN_HOME: home }, async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    repoRoot = join(home, 'repo');
    mkdirSync(repoRoot);
    await engine.executeRaw('UPDATE sources SET local_path=$2 WHERE id=$1', ['default', repoRoot]);
    otherRoot = join(home, 'other');
    mkdirSync(otherRoot);
    await engine.executeRaw('INSERT INTO sources(id,name,local_path) VALUES($1,$1,$2)', ['other', otherRoot]);
    await claimWorktree(engine, 'other', otherRoot);
    await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', ['unowned']);
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

test('gbrain import --database-only writes a managed brain through the coordinator and replays unchanged files', async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const staging = join(home, 'staging');
    mkdirSync(staging);
    writeFileSync(join(staging, 'handoff-demo.md'), '---\ntitle: "Demo"\ntype: note\ntags: [handoff]\n---\n\nFirst body.\n');
    await runImport(engine, [staging, '--no-embed', '--database-only', '--source-id', 'default']);
    const page = await engine.getPage('handoff-demo', { sourceId: 'default' });
    expect(page?.compiled_truth).toContain('First body.');
    expect(existsSync(join(repoRoot, 'handoff-demo.md'))).toBe(false);
    const afterFirst = await requests("operation='put_page' AND slug='handoff-demo'");
    expect(afterFirst).toBeGreaterThanOrEqual(1);

    await runImport(engine, [staging, '--no-embed', '--database-only', '--source-id', 'default']);
    await runImport(engine, [staging, '--no-embed', '--database-only', '--source-id', 'default']);
    const steady = await requests("operation='put_page' AND slug='handoff-demo'");
    await runImport(engine, [staging, '--no-embed', '--database-only', '--source-id', 'default']);
    expect(await requests("operation='put_page' AND slug='handoff-demo'")).toBe(steady);

    writeFileSync(join(staging, 'handoff-demo.md'), '---\ntitle: "Demo"\ntype: note\ntags: [handoff]\n---\n\nSecond body.\n');
    await runImport(engine, [staging, '--no-embed', '--database-only', '--source-id', 'default']);
    expect((await engine.getPage('handoff-demo', { sourceId: 'default' }))?.compiled_truth).toContain('Second body.');
    // Reverting to earlier bytes is a new intent over a newer revision, never a stale replay.
    writeFileSync(join(staging, 'handoff-demo.md'), '---\ntitle: "Demo"\ntype: note\ntags: [handoff]\n---\n\nFirst body.\n');
    await runImport(engine, [staging, '--no-embed', '--database-only', '--source-id', 'default']);
    expect((await engine.getPage('handoff-demo', { sourceId: 'default' }))?.compiled_truth).toContain('First body.');

    // A purged page is recreated by the next import, never answered by the original creation receipt.
    await submitPageMutation(localWriteContext(engine, 'default'), { operation: 'delete_page', waitMs: 60_000,
      params: { source_id: 'default', slug: 'handoff-demo', force: true, purge: true, database_only: true } });
    expect(await engine.getPage('handoff-demo', { sourceId: 'default' })).toBeFalsy();
    await runImport(engine, [staging, '--no-embed', '--database-only', '--source-id', 'default']);
    expect((await engine.getPage('handoff-demo', { sourceId: 'default' }))?.compiled_truth).toContain('First body.');

    // A mixed-case frontmatter slug still replays against the stored lower-case revision.
    const alice = (body: string) => writeFileSync(join(staging, 'people-alice.md'), `---\ntitle: Alice\nslug: People-Alice\n---\n\n${body}\n`);
    const revisions: string[] = [];
    for (const body of ['One.', 'Two.', 'One.']) {
      alice(body);
      const run = await runImport(engine, [staging, '--no-embed', '--database-only', '--source-id', 'default']);
      // runImport records per-file failures instead of throwing.
      expect({ errors: run.errors, failures: run.failures }).toEqual({ errors: 0, failures: [] });
      const snapshot = await engine.readPageSnapshot('people-alice', { sourceId: 'default' });
      expect(snapshot?.page.compiled_truth).toContain(body);
      revisions.push(snapshot!.revision);
    }
    expect(new Set(revisions).size).toBe(3);

    // The file is the source of truth: emptying it clears the page, as the legacy importer did.
    writeFileSync(join(staging, 'people-alice.md'), '');
    await runImport(engine, [staging, '--no-embed', '--database-only', '--source-id', 'default']);
    expect((await engine.getPage('people-alice', { sourceId: 'default' }))?.compiled_truth ?? '').not.toContain('One.');
  });
}, 120_000);

test('database-only import keeps every managed import guard', async () => {
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const staging = join(home, 'staging-guards');
    mkdirSync(staging);
    const file = join(staging, 'guarded.md');
    writeFileSync(file, '---\ntitle: Guarded\n---\n\nBody.\n');
    const remoteJob = { version: 1, kind: 'remote_generic', principal: { kind: 'oauth_client', id: 'x' }, grant: {}, payloadHash: 'x' } as never;
    await expect(withSubmissionAuthority(remoteJob, () => importManagedDatabaseOnly(engine, file, 'guarded.md')))
      .rejects.toMatchObject({ code: 'permission_denied' });
    await expect(importManagedDatabaseOnly(engine, file, 'guarded.md', { sourceId: 'unowned' }))
      .rejects.toMatchObject({ code: 'owner_unavailable' });
    const foreign = join(otherRoot, 'foreign.md');
    writeFileSync(foreign, '---\ntitle: Foreign\n---\n\nBody.\n');
    await expect(importManagedDatabaseOnly(engine, foreign, 'foreign.md')).rejects.toMatchObject({ code: 'source_changed' });
    expect(await engine.getPage('guarded', { sourceId: 'default' })).toBeFalsy();
    expect(await engine.getPage('foreign', { sourceId: 'default' })).toBeFalsy();
    expect(await requests("operation='put_page' AND slug IN ('guarded','foreign')")).toBe(0);
  });
}, 120_000);

test('database-only import ids never collide with v1 ids accepted by older code', () => {
  // Older code accepted v1 ids with a force intent; reusing them with expected_revision is a conflict.
  const v1 = (material: string) => {
    const hex = createHash('sha256').update(material).digest('hex').slice(0, 32);
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20)}`;
  };
  const args = ['default', 'people-alice', 'Body.\n', 'rev-1'] as const;
  const [source, slug, content, revision] = args;
  expect(importWriteRequestId(...args)).not.toBe(v1(`import-v1\0${source}\0${slug}\0${revision}\0${content}`));
  expect(importWriteRequestId(...args)).toBe(importWriteRequestId(...args));
});
