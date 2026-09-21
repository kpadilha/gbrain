import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { recordManagedRoots } from '../src/core/persistence/root-registry.ts';
import { withEnv } from './helpers/with-env.ts';

test('an unchanged managed-root refresh leaves registry inodes untouched', async () => {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-root-quiet-'));
  const root = join(home, 'repo'); mkdirSync(root);
  const brainId = randomUUID();
  const record = { local_path: root, source_id: 's', source_incarnation: 'i', worktree_id: randomUUID(), topology_generation: 1 };
  await withEnv({ GBRAIN_HOME: home }, async () => {
    const directory = join(home, '.gbrain', 'persistence', 'managed-roots');
    recordManagedRoots(brainId, [record]);
    const [file] = readdirSync(directory);
    const before = [statSync(join(directory, file)), statSync(directory)].map(s => [s.ino, s.ctimeMs]);
    Bun.sleepSync(20); // coarse kernel timestamps would hide a redundant chmod
    recordManagedRoots(brainId, [record]);
    expect([statSync(join(directory, file)), statSync(directory)].map(s => [s.ino, s.ctimeMs])).toEqual(before);
    chmodSync(join(directory, file), 0o644);
    recordManagedRoots(brainId, [record]);
    expect(statSync(join(directory, file)).mode & 0o777).toBe(0o600);
  });
});
