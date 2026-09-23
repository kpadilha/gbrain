import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { pagesOperations } from '../src/core/ops/pages.ts';
import { withSubmissionAuthority } from '../src/core/minions/submission-authority.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine?.disconnect(); }, 60_000);

const purge = pagesOperations.find(op => op.name === 'purge_deleted_pages')!;
const ctx = (remote: boolean | undefined) => ({ engine, remote, dryRun: false, sourceId: 'default', config: { engine: 'pglite' },
  logger: { info() {}, warn() {}, error() {} } }) as unknown as OperationContext;
const tombstones = async () => (await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM pages WHERE deleted_at IS NOT NULL'))[0].n;

test('purge_deleted_pages refuses every caller that is not the local CLI', async () => {
  await engine.putPage('notes/gone', { type: 'note', title: 'Gone', compiled_truth: 'x', timeline: '' });
  await engine.softDeletePage('notes/gone', { sourceId: 'default' });
  await engine.executeRaw("UPDATE pages SET deleted_at = now() - interval '100 hours' WHERE slug='notes/gone'");
  for (const remote of [true, undefined]) {
    await expect(purge.handler(ctx(remote), { older_than_hours: 0 })).rejects.toMatchObject({ code: 'permission_denied' });
  }
  const remoteJob = { version: 1, kind: 'remote_generic', principal: { kind: 'oauth_client', id: 'x' }, grant: {}, payloadHash: 'x' } as never;
  await expect(withSubmissionAuthority(remoteJob, () => purge.handler(ctx(false), { older_than_hours: 0 })))
    .rejects.toMatchObject({ code: 'permission_denied' });
  expect(await tombstones()).toBe(1);
  expect(await purge.handler(ctx(false), { older_than_hours: 72 })).toMatchObject({ status: 'purged', count: 1 });
  expect(await tombstones()).toBe(0);
}, 60_000);
