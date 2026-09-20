/**
 * C3 (cost wave): the starter-surface tool list is re-sent to the model on
 * every turn, so its size is a cost every connected agent pays. This file
 * pins:
 *   - the served starter list (Cat 40 configuration: `gbrain serve --surface
 *     starter`, no skill grants) at 25,000 characters or less, with
 *     `mcp.publish_skills` on (fresh-init default) and off, and its cl100k
 *     token count;
 *   - the initialize instructions at their recorded size, so guidance cut
 *     from the schemas cannot move there instead;
 *   - a per-tool budget (the whole tool definition) for every starter op,
 *     under the hard caps of 1,200 characters per description and 200 per
 *     parameter description;
 *   - the minimum guidance each tool must keep (DX-14): purpose, required
 *     input, consequential defaults, the next call, the recovery move.
 * The longer pre-cut guidance lives in docs/mcp/TOOL_REFERENCE.md.
 *
 * Raising a number here needs a reason in the commit message and a check
 * that the served list still fits 25,000 characters. Measured on this
 * branch: 24,763 characters, 5,568 cl100k tokens (was 59,969 / 13,077).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operations, type Operation } from '../src/core/operations.ts';
import { filterOpsForSurface, STARTER_OPS } from '../src/mcp/surface.ts';
import { buildToolDefs } from '../src/mcp/tool-defs.ts';
import { stdioVisibleTools } from '../src/mcp/server.ts';
import { GBRAIN_MCP_INSTRUCTIONS } from '../src/mcp/instructions.ts';
import { cl100kAvailable, estimateTokens } from '../src/core/chunkers/token-estimate.ts';

const SERVED_STARTER_MAX_CHARS = 25_000;
const SERVED_STARTER_MAX_TOKENS = 5_700;
const INSTRUCTIONS_MAX_CHARS = 4_042;
const DESCRIPTION_HARD_CAP = 1_200;
const PARAM_DESCRIPTION_HARD_CAP = 200;

/** Per-tool budget: JSON.stringify of the served tool definition. */
const TOOL_BUDGETS: Record<string, number> = {
  add_timeline_entry: 630, cancel_job: 250, cancel_write_request: 330, capture: 1250, context_pack: 760,
  delete_skill: 810, delta: 830, edit_page: 1090, entity: 460, find_anomalies: 500, forget: 560, get_agent_job: 220,
  get_backlinks: 350, get_ingest_log: 200, get_page: 810, get_recent_salience: 630, get_skill: 910,
  get_skill_asset: 780, get_write_request: 300, join_brain: 560, leave_brain: 540, list_brain_skillpack: 200,
  list_link_sources: 190, list_pages: 1090, list_skills: 640, list_write_requests: 390, put_page: 1320,
  put_skill: 1420, query: 3220, recall: 1590, remember: 1490, request_tools: 560, resolve_slugs: 330, search: 1760,
  submit_agent: 750, sync_brain_skills: 770, synthesize: 550, traverse_graph: 660, whoami: 190,
};

/** DX-14: phrases each tool's description must keep. */
const MINIMUM_GUIDANCE: Record<string, string[]> = {
  search: ['no LLM expansion', 'top 20', 'NOT proof of coverage', '`query`', 'list_pages', 'return_unit', 'fields: "full"'],
  query: ['expansion', 'Still top-K', 'return_unit', 'list_pages', '`search` is cheaper', 'LLM call', 'fields: "full"'],
  put_page: ['REPLACES the whole page', 'get_page include_content:true', 'expected_revision', 'request_id', 'edit_page'],
  edit_page: ['prefer this over put_page', 'expected_revision', 'exactly once', 'all or none', 'revision_conflict'],
  get_page: ['include_content:true', 'put_page', 'edit_page'],
  list_pages: ['sort=updated_desc', 'Default 50', 'truncated', 'updated_after_slug'],
  capture: ['inbox/', 'idempotent', 'put_page', 'remember'],
  remember: ['provenance', '`entity`', '`status`', 'write_pending', 'get_write_request'],
  recall: ['entity', '`query`', 'world facts only', 'synthesize'],
  entity: ['zero LLM', 'found:false', 'create_safety', 'recall'],
  forget: ['fact_id', 'Idempotent'],
  synthesize: ['[EXPENSIVE', 'recall', 'entity'],
  context_pack: ['session start', 'compaction'],
  delta: ['session_id', 'since'],
  get_write_request: ['request_id', 'write_pending'],
  list_write_requests: ['newest first'],
  cancel_write_request: ['receipt'],
  request_tools: ['{tools', '{surface}'],
  list_skills: ['NOT executable code', 'get_skill', 'usable_tools', 'unavailable_tools'],
  get_skill: ['same-named MCP tool', 'nothing to execute', 'unavailable_tools'],
  get_recent_salience: ['Use this when the user asks', 'Do NOT run a semantic search'],
  find_anomalies: ['grouped by cohort', 'Cohort kinds: tag, type'],
  submit_agent: ['agent scope', 'get_agent_job'],
  get_agent_job: ['submit_agent', 'queue_position'],
  whoami: ['source_id', 'federated_read'],
  traverse_graph: ['depth'],
};

const size = (ops: Operation[]) => JSON.stringify(buildToolDefs(ops)).length - 2 - Math.max(0, ops.length - 1);

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 120_000);
afterAll(async () => { await engine?.disconnect(); });

async function served(publishSkills: boolean): Promise<Operation[]> {
  await engine.setConfig('mcp.publish_skills', String(publishSkills));
  return stdioVisibleTools(engine, filterOpsForSurface(operations, 'starter'));
}

describe('served starter tool list (Cat 40 configuration)', () => {
  test('publish_skills on (the fresh-init default): 34 tools within 25,000 characters', async () => {
    const ops = await served(true);
    expect(ops.map(o => o.name)).toContain('get_skill');
    expect(ops.length).toBe(34);
    expect(size(ops)).toBeLessThanOrEqual(SERVED_STARTER_MAX_CHARS);
  });

  test('publish_skills off: within 25,000 characters', async () => {
    const ops = await served(false);
    expect(ops.map(o => o.name)).not.toContain('get_skill');
    expect(size(ops)).toBeLessThanOrEqual(SERVED_STARTER_MAX_CHARS);
  });

  test('cl100k token ceiling', async () => {
    if (!cl100kAvailable()) return;
    expect(estimateTokens(JSON.stringify(buildToolDefs(await served(true))))).toBeLessThanOrEqual(SERVED_STARTER_MAX_TOKENS);
  });

  test('initialize instructions stay at or below their recorded size', () => {
    expect(GBRAIN_MCP_INSTRUCTIONS.length).toBeLessThanOrEqual(INSTRUCTIONS_MAX_CHARS);
  });
});

describe('per-tool schema budgets', () => {
  const starter = operations.filter(o => STARTER_OPS.has(o.name));

  test('every starter op has a budget', () => {
    expect(starter.map(o => o.name).sort()).toEqual(Object.keys(TOOL_BUDGETS).sort());
  });

  for (const op of operations.filter(o => STARTER_OPS.has(o.name))) {
    test(`${op.name} fits its budget and the hard caps`, () => {
      const [def] = buildToolDefs([op]);
      expect(JSON.stringify(def).length).toBeLessThanOrEqual(TOOL_BUDGETS[op.name]);
      expect(op.description.length).toBeLessThanOrEqual(DESCRIPTION_HARD_CAP);
      const walk = (p: { description?: string; items?: unknown; properties?: Record<string, unknown> }, path: string): void => {
        expect((p.description ?? '').length, path).toBeLessThanOrEqual(PARAM_DESCRIPTION_HARD_CAP);
        if (p.items) walk(p.items as never, `${path}[]`);
        for (const [k, v] of Object.entries(p.properties ?? {})) walk(v as never, `${path}.${k}`);
      };
      for (const [k, p] of Object.entries(op.params)) walk(p as never, `${op.name}.${k}`);
    });
  }
});

describe('minimum guidance (DX-14)', () => {
  for (const [name, phrases] of Object.entries(MINIMUM_GUIDANCE)) {
    test(name, () => {
      const op = operations.find(o => o.name === name)!;
      for (const phrase of phrases) expect(op.description, `${name}: ${phrase}`).toContain(phrase);
    });
  }

  test('every required input of a starter tool is declared in its schema', () => {
    for (const def of buildToolDefs(operations.filter(o => STARTER_OPS.has(o.name)))) {
      for (const key of def.inputSchema.required) expect(def.inputSchema.properties, `${def.name}.${key}`).toHaveProperty(key);
    }
  });
});
