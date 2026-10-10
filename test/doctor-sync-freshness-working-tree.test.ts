/**
 * Regression: `sync_freshness` must mirror `gbrain sync`'s up-to-date
 * predicate instead of inventing extra work.
 *
 * Observed live (v0.57.0.0, managed-persistence brain): `gbrain sync --all
 * --no-pull` returned `up_to_date` for all 14 sources while `gbrain doctor
 * --json` failed `sync_freshness` on five of them —
 *   - krishna-kb / hermes-sessions: HEAD === last_commit, `chunker_version`
 *     NULL (the managed lane never writes that legacy column);
 *   - miro-test / pm-5m / polymarket-market-maker: HEAD === last_commit,
 *     tracked-but-uncommitted `.env` / `.claude/session-handoff.md`.
 *
 * Sync's predicate is HEAD === last_commit plus, ONLY when the run imports the
 * working tree (detached HEAD or `sync.include_working_tree`), an empty
 * uncommitted import set — sync.ts:1951 `importWorkingTree`, mirrored by the
 * managed lane at core/persistence/sync-discovery.ts:125. Both divergences
 * above are therefore this check's bug, not stale sources.
 *
 * Hermetic: real temp git repos (so `isDetachedHead` sees a real attached /
 * detached HEAD); the head+clean probes come from git-head.ts's test seams.
 */

import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  _setGitCleanProbeForTests,
  _setGitHeadProbeForTests,
  probeSourceGitState,
} from '../src/core/git-head.ts';
import { checkSyncFreshness } from '../src/commands/doctor.ts';
import { chunkerStamp } from '../src/core/chunkers/code.ts';

const CURRENT = chunkerStamp();
const repos: string[] = [];

/** Real git repo; `detached` checks out the commit so HEAD is not a branch. */
function makeRepo(detached: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'sync-fresh-wt-'));
  repos.push(dir);
  const g = (...args: string[]) => execFileSync('git', ['-C', dir, ...args], { stdio: 'ignore' });
  g('init', '-q');
  g('config', 'user.email', 't@example.com');
  g('config', 'user.name', 't');
  writeFileSync(join(dir, 'a.md'), '# a\n');
  g('add', 'a.md');
  g('commit', '-q', '-m', 'init');
  writeFileSync(join(dir, 'a.md'), '# a edited\n'); // tracked, uncommitted
  if (detached) g('checkout', '-q', '--detach');
  return dir;
}

/** Same shape the v0.41.27.0 suite uses; getConfig stays optional. */
function stubEngine(rows: any[], config?: Record<string, string>, managed = false): any {
  return {
    executeRaw: async (sql: string) => (/^SELECT enabled FROM persistence_brain/.test(sql) ? [{ enabled: managed }] : rows),
    ...(config ? { getConfig: async (k: string) => config[k] } : {}),
  };
}

function row(local_path: string, chunker_version: string | null) {
  return {
    id: 'src', name: '', local_path,
    last_sync_at: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000),
    last_commit: 'abc', chunker_version,
  };
}

beforeEach(() => {
  _setGitHeadProbeForTests(() => 'abc'); // HEAD === last_commit
  _setGitCleanProbeForTests(() => false); // tracked dirt present
});

afterAll(() => {
  _setGitHeadProbeForTests(null);
  _setGitCleanProbeForTests(null);
  for (const dir of repos) { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } }
});

describe('sync_freshness mirrors sync\'s up-to-date predicate', () => {
  test('attached repo + tracked dirt + NULL chunker_version → ok (sync says up_to_date)', async () => {
    const result = await checkSyncFreshness(stubEngine([row(makeRepo(false), null)]), { localOnly: true });
    expect(result.status).toBe('ok');
    expect(result.details).toEqual({ unchanged_count: 1, synced_recently_count: 0, stale_count: 0 });
    expect(result.message).toContain('no new commits since last sync');
  });

  test('attached repo + tracked dirt + chunker_version match → ok (dirt is not work)', async () => {
    const result = await checkSyncFreshness(stubEngine([row(makeRepo(false), CURRENT)]), { localOnly: true });
    expect(result.status).toBe('ok');
    expect(result.details).toEqual({ unchanged_count: 1, synced_recently_count: 0, stale_count: 0 });
  });

  // The gates that must NOT relax:
  test('detached repo + tracked dirt → fail (sync imports the working tree there)', async () => {
    const result = await checkSyncFreshness(stubEngine([row(makeRepo(true), CURRENT)]), { localOnly: true });
    expect(result.status).toBe('fail'); // 9d old, past the 72h fail tier
    expect(result.details?.stale_count).toBe(1);
  });

  test('sync.include_working_tree=true + tracked dirt → fail (same posture, committed repos)', async () => {
    const result = await checkSyncFreshness(
      stubEngine([row(makeRepo(false), CURRENT)], { 'sync.include_working_tree': 'true' }),
      { localOnly: true },
    );
    expect(result.status).toBe('fail');
    expect(result.details?.stale_count).toBe(1);
  });

  test('recorded chunker_version that differs still blocks (never mask a re-chunk)', async () => {
    const result = await checkSyncFreshness(stubEngine([row(makeRepo(false), '0')]), { localOnly: true });
    expect(result.status).toBe('fail');
    expect(result.details?.stale_count).toBe(1);
  });

  test('managed brain + pre-stamp chunker_version → ok (managed sync never reads the stamp)', async () => {
    const result = await checkSyncFreshness(stubEngine([row(makeRepo(false), '8')], undefined, true), { localOnly: true });
    expect(result.status).toBe('ok');
    expect(result.details).toEqual({ unchanged_count: 1, synced_recently_count: 0, stale_count: 0 });
  });

  // Guard the probe contract itself: no clean probe when sync would not import
  // the working tree, and the clean probe IS consulted when it would.
  test('probe posture: clean probe skipped for commit-driven, consulted for detached', () => {
    const attached = makeRepo(false);
    const detached = makeRepo(true);
    let cleanCalls = 0;
    _setGitCleanProbeForTests(() => { cleanCalls++; return false; });
    expect(probeSourceGitState(attached, 'abc')).toBe('unchanged');
    expect(cleanCalls).toBe(0);
    expect(probeSourceGitState(detached, 'abc', { requireCleanWorkingTree: 'ignore-untracked' })).toBe('changed');
    expect(cleanCalls).toBe(1);
  });
});
