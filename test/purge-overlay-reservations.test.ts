/**
 * The purge overlay re-renders a takes fence without the purged rows. It must
 * keep the fence's existing reservation rows (W9F item 4) and reserve the
 * purged rows' numbers, so no later take reuses a purged number.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { dropPurgedFenceRows } from '../src/core/facts/purge-overlay.ts';
import { fenceClaimHashes } from '../src/core/facts/withdrawal-overlay.ts';
import { redactStoredText } from '../src/core/secret-scan.ts';
import { TAKES_FENCE_BEGIN, TAKES_FENCE_END, parseTakesFence, renderTakesFence } from '../src/core/takes-fence.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 60_000);
afterAll(async () => { await engine.disconnect(); });

test('a purged take row leaves a reservation and existing reservations survive', async () => {
  const take = (rowNum: number, claim: string) => ({ ...parseTakesFence(`${TAKES_FENCE_BEGIN}\n| # | claim | kind | who | weight | since | source |\n|---|-------|------|-----|--------|-------|--------|\n| ${rowNum} | ${claim} | take | alice-example | 0.5 |  | chat |\n${TAKES_FENCE_END}`).takes[0]! });
  const fence = renderTakesFence([take(1, 'Keep this claim'), take(3, 'Purge this claim'), take(4, 'Keep this one too')], [2]);
  const body = `# Page\n\n${fence}\n`;
  expect(parseTakesFence(body).reservedRowNums).toEqual([2]);
  await engine.executeRaw(`INSERT INTO take_purges(source_id, subject, claim_hash) VALUES ('default', '*', gbrain_fact_fingerprint($1))`, ['Purge this claim']);

  const out = await dropPurgedFenceRows(engine, 'default', body, 'people/alice-example');
  const parsed = parseTakesFence(out);
  expect(parsed.warnings).toEqual([]);
  expect(parsed.takes.map(t => [t.rowNum, t.claim])).toEqual([[1, 'Keep this claim'], [4, 'Keep this one too']]);
  expect(parsed.reservedRowNums.sort()).toEqual([2, 3]);
  expect(out).not.toContain('Purge this claim');
});

// Purge ledgers hash the stored (redacted) claim; a user-authored fence row keeps its raw secret.
const RAW = 'Deploy key is ghp_' + 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8';
const secretFence = `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | ${RAW} | fact | 1.0 | world | medium | 2026-01-01 |  | chat |  |
<!--- gbrain:facts:end -->`;

test('a fence row holding a raw secret is dropped by the purge of its redacted claim', async () => {
  expect(redactStoredText(RAW)).not.toBe(RAW);
  await engine.executeRaw(`INSERT INTO fact_purges(source_id, visibility, subject, fact_hash) VALUES ('default', 'world', '*', gbrain_fact_fingerprint($1))`, [redactStoredText(RAW)]);
  const out = await dropPurgedFenceRows(engine, 'default', `# Page\n\n${secretFence}\n`, 'people/alice-example');
  expect(out).not.toContain('ghp_');
  expect(out).not.toContain('Deploy key');
});

test('fenceClaimHashes covers the ledger fingerprint of a raw-secret fence row', async () => {
  const [{ fp }] = await engine.executeRaw<{ fp: string }>('SELECT gbrain_fact_fingerprint($1) AS fp', [redactStoredText(RAW)]);
  expect(fenceClaimHashes([secretFence])).toContain(fp);
});
