/** Fact vectors are computed from the redacted text the row stores, never from the secret. */
import { afterAll, expect, test } from 'bun:test';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { prepareFactEmbedding } from '../src/core/facts/single-prepare.ts';

afterAll(() => { __setEmbedTransportForTests(null); resetGateway(); });

test('prepareFactEmbedding embeds the redacted fact text', async () => {
  resetGateway();
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 4, env: { OPENAI_API_KEY: 'sk-test' } });
  const seen: string[] = [];
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    seen.push(...values);
    return { embeddings: values.map(() => [1, 0, 0, 0]), usage: { tokens: values.length } };
  }) as never);
  // Synthetic, assembled at runtime so no literal token sits in the repo.
  const fake = ['ghp', '_', 'Zq7Xw2Lp9Rt4Vb8Nk3Hs6Jd1Fg5Mc0Ya2UeKx'].join('');
  const r = await prepareFactEmbedding(`Alice rotated ${fake} today`);
  expect(r.degraded).toBe(false);
  expect(seen.length).toBeGreaterThan(0);
  for (const v of seen) { expect(v).not.toContain(fake); expect(v).toContain('<REDACTED:'); }
});
