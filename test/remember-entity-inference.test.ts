/**
 * #5836 — remember infers a missing entity from one exact mention before
 * admission, and falls back to the unattributed save (with a NO_ENTITY or
 * ENTITY_LINK_FAILED warning) whenever the inferred target would fail any
 * admission check. Inferred links dedup exact text only. PGLite, synthetic
 * names only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { operationsByName } from '../src/core/operations.ts';
import { parseFactsFence } from '../src/core/facts-fence.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { withCoordinatedWrite } from '../src/core/persistence/context.ts';
import { TEST_WRITE_ATTRIBUTION } from './helpers/write-attribution.ts';
import { registerLocalWriter } from '../src/core/persistence/identity.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { LEGACY_EMBEDDING_CONFIG } from './helpers/legacy-embedding-config.ts';
import { formatRememberResult } from '../src/cli/remember-format.ts';
import { writeFactsToFence } from '../src/core/facts/fence-write.ts';

let engine: PGLiteEngine;
const sourceId = 'remember-inference-test';
const context = (overrides: Partial<OperationContext> = {}): OperationContext => ({ engine, remote: false, sourceId,
  config: { engine: 'pglite' }, dryRun: false, logger: { info() {}, warn() {}, error() {} }, ...overrides });
const remember = (params: Record<string, unknown>, ctx = context()) =>
  operationsByName.remember!.handler(ctx, { provenance: 'chat 2026-09-30', ...params }) as Promise<Record<string, any>>;

async function putEntity(slug: string, title: string, type: string, body = `# ${title}`, frontmatter: Record<string, unknown> = {}) {
  await engine.transaction(tx => withCoordinatedWrite(tx, [sourceId], () =>
    tx.putPage(slug, { type, title, compiled_truth: body, frontmatter }, { sourceId }), TEST_WRITE_ATTRIBUTION));
}
async function factRow(id: string) {
  const [row] = await engine.executeRaw<{ entity_slug: string | null; context: string | null; row_num: number | null; expired_at: Date | null; superseded_by: number | null }>(
    'SELECT entity_slug,context,row_num,expired_at,superseded_by FROM facts WHERE id=$1', [Number(id)]);
  return row!;
}
async function fenceRows(slug: string) {
  return parseFactsFence((await engine.readPageSnapshot(slug, { sourceId }))!.page.compiled_truth).facts;
}

beforeAll(async () => {
  configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
  engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema();
  await engine.executeRaw('UPDATE persistence_brain SET enabled=false WHERE singleton=1');
  await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
  await registerLocalWriter(engine, 'cli'); await registerLocalWriter(engine, 'stdio');
  await engine.executeRaw('UPDATE persistence_brain SET enabled=true WHERE singleton=1');
  await putEntity('companies/acme-example', 'Acme Example', 'company');
  await putEntity('people/alice-example', 'Alice Example', 'person');
  await putEntity('people/dana-private-example', 'Dana Private-Example', 'person', '# Dana', { visibility: 'private' });
  await putEntity('companies/broken-fence-example', 'Broken Fence Example', 'company',
    '# Broken\n\n<!--- gbrain:facts:begin -->\n| # | claim |\n');
}, 60_000);
afterAll(async () => {
  await disposePersistenceConsumer(engine);
  await engine.disconnect();
  resetGateway();
});

describe('remember entity inference (#5836)', () => {
  test('a fact naming one entity links to it, notes the inference in row and fence, and prints it', async () => {
    const r = await remember({ fact: 'Acme Example raised a seed round' });
    expect(r).toMatchObject({ status: 'inserted', entity_slug: 'companies/acme-example', entity_inferred: 'mention' });
    expect(r.warnings).toBeUndefined();
    const row = await factRow(r.id);
    expect(row.entity_slug).toBe('companies/acme-example');
    expect(row.context).toBe('entity inferred from mention');
    expect(row.row_num).not.toBeNull();
    const cell = (await fenceRows('companies/acme-example')).find(f => f.claim === 'Acme Example raised a seed round');
    expect(cell?.context).toBe('entity inferred from mention');
    expect(formatRememberResult(r)).toContain('entity: companies/acme-example (inferred from mention)');
  });

  test('secret-shaped fact text, provenance and context are redacted in the row and fence; benign text is kept', async () => {
    // Synthetic, assembled at runtime so no literal token sits in the repo.
    const fake = ['ghp', '_', 'Zq7Xw2Lp9Rt4Vb8Nk3Hs6Jd1Fg5Mc0Ya2UeKx'].join('');
    const r = await remember({ entity: 'people/alice-example', fact: `Alice Example rotated ${fake} today`,
      provenance: `chat with ${fake}`, context: `commit abc123 token=${fake}` });
    expect(r.status).toBe('inserted');
    const [row] = await engine.executeRaw<{ fact: string; source: string; context: string }>(
      'SELECT fact,source,context FROM facts WHERE id=$1', [Number(r.id)]);
    const page = (await engine.readPageSnapshot('people/alice-example', { sourceId }))!.page.compiled_truth;
    for (const stored of [row!.fact, row!.source, row!.context, page]) expect(stored).not.toContain(fake);
    expect(row!.fact).toMatch(/^Alice Example rotated <REDACTED:[^>]+> today$/);
    expect(row!.context).toMatch(/^commit abc123 token=<REDACTED:[^>]+>$/);
    const cell = (await fenceRows('people/alice-example')).find(f => f.claim === row!.fact);
    expect(cell?.context).toBe(row!.context);
    const benign = await remember({ entity: 'people/alice-example', fact: 'Alice Example prefers tea', context: 'commit def456' });
    expect((await factRow(benign.id)).context).toBe('commit def456');
    await operationsByName.forget!.handler(context(), { id: benign.id, reason: `leaked ${fake}` });
    const forgotten = (await factRow(benign.id)).context!;
    expect(forgotten).not.toContain(fake);
    expect(forgotten).toMatch(/^commit def456 \| forgotten: leaked <REDACTED:[^>]+>$/);
  });

  test('managed fence writes (extract_facts lane) redact fact, source and context in the row and fence', async () => {
    const fake = ['ghp', '_', 'Mk4Rt8Wq2Zp6Xn1Lb5Vc9Hd3Js7Fg0Ya4UeQo'].join('');
    const res = await writeFactsToFence(engine, { sourceId, localPath: null, slug: 'companies/acme-example', resolutionSource: 'exact_page' } as never, [
      { fact: `Acme Example deploy key is ${fake}`, kind: 'fact', source: `extract ${fake}`, context: `ctx ${fake}`,
        visibility: 'world', notability: 'medium', embedding: null, sessionId: null }]);
    expect(res.inserted).toBe(1);
    const [row] = await engine.executeRaw<{ fact: string; source: string; context: string }>(
      'SELECT fact,source,context FROM facts WHERE id=$1', [res.ids[0]]);
    const page = (await engine.readPageSnapshot('companies/acme-example', { sourceId }))!.page.compiled_truth;
    for (const stored of [row!.fact, row!.source, row!.context, page]) expect(stored).not.toContain(fake);
    expect(row!.fact).toMatch(/^Acme Example deploy key is <REDACTED:[^>]+>$/);
    const journal = await engine.executeRaw<{ intent: unknown }>(`SELECT intent FROM persistence_requests WHERE operation='extract_facts'`);
    expect(JSON.stringify(journal)).not.toContain(fake);
  });

  test('ontology_propose redacts value and source, and a repeat stays a deterministic no-op', async () => {
    const fake = ['ghp', '_', 'Tn5Qw9Lr3Xk7Zm1Vb6Hc2Jd8Fs0Gy4Ya3UeRa'].join('');
    const propose = () => operationsByName.ontology_propose!.handler(context(),
      { entity: 'people/alice-example', dimension: 'role', value: `admin ${fake}`, source: `chat ${fake}` }) as Promise<Record<string, any>>;
    const first = await propose();
    expect(first.factId).toBeGreaterThan(0);
    const [row] = await engine.executeRaw<{ fact: string; value: string; source: string; source_markdown_slug: string }>(
      'SELECT fact,value,source,source_markdown_slug FROM facts WHERE id=$1', [first.factId]);
    for (const stored of Object.values(row!)) expect(stored).not.toContain(fake);
    expect(row!.fact).toMatch(/^role: admin <REDACTED:[^>]+>$/);
    expect((await propose()).action).toBe('noop');
  });

  test('an imported user-authored fence keeps its bytes while the derived fact rows are redacted', async () => {
    const fake = ['ghp', '_', 'Pz3Kw7Rn1Xq5Lm9Vb2Hc6Jd0Fs4Gt8Ya1UeWi'].join('');
    const content = `---\ntitle: Erin Example\ntype: person\n---\n# Erin Example\n\n## Facts\n\n<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Erin Example token ${fake} | fact | 1.0 | world | medium | 2026-09-01 |  | import ${fake} | note ${fake} |
| 2 | Erin Example likes tea | fact | 1.0 | world | medium | 2026-09-01 |  | fixture | plain |
<!--- gbrain:facts:end -->
`;
    await operationsByName.put_page!.handler(context(), { slug: 'people/erin-example', content });
    const rows = await engine.executeRaw<{ fact: string; source: string; context: string; row_num: number }>(
      `SELECT fact,source,context,row_num FROM facts WHERE source_id=$1 AND source_markdown_slug='people/erin-example' ORDER BY row_num`, [sourceId]);
    expect(rows.map(r => r.row_num)).toEqual([1, 2]);
    for (const v of [rows[0]!.fact, rows[0]!.source, rows[0]!.context]) { expect(v).not.toContain(fake); expect(v).toContain('<REDACTED:'); }
    expect([rows[1]!.fact, rows[1]!.source, rows[1]!.context]).toEqual(['Erin Example likes tea', 'fixture', 'plain']);
    // The canonical body is the user's file: it keeps the secret so file and DB page do not drift.
    expect((await engine.readPageSnapshot('people/erin-example', { sourceId }))!.page.compiled_truth).toContain(fake);
  });

  test('an unattributed save warns NO_ENTITY with a hint naming the entity field', async () => {
    const r = await remember({ fact: 'prefers dark mode in every editor' });
    expect(r.entity_slug).toBeNull();
    expect(r.warnings).toEqual(['NO_ENTITY']);
    expect(r.hint).toContain('`entity`');
    expect(r.entity_inferred).toBeUndefined();
    const printed = formatRememberResult(r);
    expect(printed).toContain('warning: NO_ENTITY');
    expect(printed).toContain('hint: ');
  });

  test('infer_entity:false stores the fact unattributed', async () => {
    const r = await remember({ fact: 'Acme Example opened a second office', infer_entity: false });
    expect(r.entity_slug).toBeNull();
    expect(r.warnings).toEqual(['NO_ENTITY']);
    expect((await factRow(r.id)).entity_slug).toBeNull();
  });

  test('the facts.entity_inference kill switch stores the fact unattributed', async () => {
    await engine.setConfig('facts.entity_inference', 'off');
    try {
      const r = await remember({ fact: 'Acme Example moved its offsite to May' });
      expect(r.entity_slug).toBeNull();
      expect(r.warnings).toEqual(['NO_ENTITY']);
    } finally { await engine.unsetConfig('facts.entity_inference'); }
  });

  test('an explicit entity is unchanged: no inference, no warning, no note', async () => {
    const r = await remember({ fact: 'Alice Example met Acme Example about pricing', entity: 'people/alice-example' });
    expect(r).toMatchObject({ status: 'inserted', entity_slug: 'people/alice-example' });
    expect(r.entity_inferred).toBeUndefined();
    expect(r.warnings).toBeUndefined();
    expect((await factRow(r.id)).context).toBeNull();
  });

  test('a client slug fence that excludes the inferred entity falls back without error', async () => {
    const clientId = `client-${randomUUID()}`;
    await engine.executeRaw(`INSERT INTO oauth_clients(client_id,client_secret_hash,client_name,scope,source_id,bound_slug_prefixes)
      VALUES($1,'fixture-hash','example-client','read write',$2,$3::text[])`, [clientId, sourceId, ['memory/']]);
    const ctx = context({ remote: true, auth: { token: 'fixture', clientId, principal: { kind: 'oauth_client', id: clientId },
      scopes: ['read', 'write'], sourceId, boundSlugPrefixes: ['memory/'] } as OperationContext['auth'] });
    const r = await remember({ fact: 'Acme Example signed a new lease' }, ctx);
    expect(r.entity_slug).toBeNull();
    expect(r.warnings).toEqual(['NO_ENTITY']);
    const control = await remember({ fact: 'Acme Example signed a second lease' }, context({ remote: true }));
    expect(control.entity_slug).toBe('companies/acme-example');
  });

  test('a subagent fence that excludes the inferred entity falls back without error', async () => {
    const r = await remember({ fact: 'Acme Example renewed the contract' },
      context({ viaSubagent: true, subagentId: 7, allowedSlugPrefixes: ['memory/*'] }));
    expect(r.entity_slug).toBeNull();
    expect(r.warnings).toEqual(['NO_ENTITY']);
  });

  test('a remote caller never links (or learns of) a private entity', async () => {
    const r = await remember({ fact: 'Dana Private-Example is relocating' }, context({ remote: true }));
    expect(r.entity_slug).toBeNull();
    expect(r.warnings).toEqual(['NO_ENTITY']);
    const local = await remember({ fact: 'Dana Private-Example is relocating soon', visibility: 'private' });
    expect(local.entity_slug).toBe('people/dana-private-example');
  });

  test('a malformed target fence warns ENTITY_LINK_FAILED and saves unattributed', async () => {
    const r = await remember({ fact: 'Broken Fence Example hired a CFO' });
    expect(r.entity_slug).toBeNull();
    expect(r.warnings).toEqual(['ENTITY_LINK_FAILED']);
    expect(formatRememberResult(r)).toContain('warning: ENTITY_LINK_FAILED');
    expect((await factRow(r.id)).entity_slug).toBeNull();
  });

  test('a replayed request id returns the original inferred link from the caller intent', async () => {
    const params = { fact: 'Acme Example hired a head of sales', request_id: randomUUID() };
    const first = await remember(params);
    expect(first).toMatchObject({ entity_slug: 'companies/acme-example', entity_inferred: 'mention' });
    await engine.setConfig('facts.entity_inference', 'off');
    try {
      expect(await remember(params)).toEqual(first);
    } finally { await engine.unsetConfig('facts.entity_inference'); }
  });

  test('an inferred link never supersedes a similar fact: both stay active', async () => {
    configureGateway({ embedding_model: 'openai:text-embedding-3-small', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test-inference' } });
    __setEmbedTransportForTests((async (opts: { values: string[] }) => ({ embeddings: opts.values.map(() => [1, ...new Array(1535).fill(0)]) })) as never);
    try {
      const first = await remember({ fact: 'Acme Example targets 40 percent gross margin', entity: 'companies/acme-example' });
      expect(first.status).toBe('inserted');
      const second = await remember({ fact: 'Acme Example targets 45 percent gross margin' });
      expect(second).toMatchObject({ status: 'inserted', entity_slug: 'companies/acme-example', entity_inferred: 'mention' });
      const [a, b] = [await factRow(first.id), await factRow(second.id)];
      expect(a.expired_at).toBeNull();
      expect(a.superseded_by).toBeNull();
      expect(b.expired_at).toBeNull();
      const fence = await fenceRows('companies/acme-example');
      expect(fence.find(f => f.claim === 'Acme Example targets 40 percent gross margin')?.active).toBe(true);
      const exact = await remember({ fact: 'Acme Example targets 45 percent gross margin' });
      expect(exact).toMatchObject({ status: 'duplicate', id: second.id });
    } finally {
      __setEmbedTransportForTests(null);
      configureGateway({ ...LEGACY_EMBEDDING_CONFIG, env: {} });
    }
  });

  test('facts.entity_inference is a registered config key', async () => {
    const { KNOWN_CONFIG_KEYS } = await import('../src/core/config.ts');
    expect(KNOWN_CONFIG_KEYS).toContain('facts.entity_inference');
  });
});
