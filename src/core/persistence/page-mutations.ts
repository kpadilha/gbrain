import { createHash, randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { OperationContext } from '../ops/contract.ts';
import { OperationError } from '../ops/contract.ts';
import { enforceClientSlugFence, enforceSubagentSlugFence, normalizeSlugPrefix, parseSourceIdParam, requireWritablePage, validatePageSlug } from '../ops/context.ts';
import { defaultSlug, detectBinaryNullByte, explicitCaptureType, mergeCaptureFrontmatter, normalizeForHash } from '../capture-content.ts';
import { computeContentHash } from '../ingestion/types.ts';
import { loadConfig } from '../config.ts';
import { assertPersistenceAccepting, waitForWrite, writeResponse } from './service.ts';
import { admitWrite, assertPageRequestIdentity, assertReplayIntent, getWriteRequest, intentDigest } from './journal.ts';
import { submissionAuthority, authorizeStoredRequest } from './authority.ts';
import { currentVerifiedLocalWriter, localHostId, readLocalWriter, registerLocalWriter } from './identity.ts';
import { claimWorktree, getWorktreeBinding, managedPersistenceEnabled } from './ownership.ts';
import { parseMutationPrecondition } from './preconditions.ts';
import { assertPurgeParams } from './purge-params.ts';
import type { Principal } from './model.ts';
import { normalizeSubagentPageInput } from './page-input.ts';
import { assertKnowledgePublicationAllowed } from '../shared-skills/knowledge-guard.ts';
import { WRITER_INSPECTION_HINT } from './admin-intent.ts';

export async function requestPrincipalForContext(ctx: OperationContext): Promise<Principal> {
  if (ctx.auth?.principal) return { ...ctx.auth.principal };
  const verified = currentVerifiedLocalWriter();
  if (verified) return verified.principal;
  const lane = ctx.remote === false ? 'cli' : 'stdio';
  const local = await readLocalWriter(ctx.engine, lane);
  return { kind: lane === 'cli' ? 'local_cli' : 'local_stdio', id: local.id };
}
/** A local installation registers once; revoked records are never silently replaced. */
export async function initializeLocalPersistence(ctx: OperationContext): Promise<void> {
  if (!ctx.auth && !currentVerifiedLocalWriter()) await registerLocalWriter(ctx.engine, ctx.remote === false ? 'cli' : 'stdio');
}
/** Validate explicit routing before any admission, including dry-run adapters. */
export function pageMutationSource(ctx: OperationContext, params: Record<string, unknown>, operation: string): string {
  const sourceId = parseSourceIdParam(params.source_id, operation) ?? ctx.sourceId ?? 'default';
  if (sourceId === '__all__') throw new OperationError('invalid_params', 'A mutation must target exactly one source.');
  if (ctx.remote !== false && sourceId !== (ctx.auth?.sourceId ?? ctx.sourceId ?? 'default')) {
    throw new OperationError('permission_denied', 'This source is outside the current write grant.');
  }
  return sourceId;
}
/** Trusted local CLI context for machine importers that submit through the coordinator. */
export function localWriteContext(engine: OperationContext['engine'], sourceId: string): OperationContext {
  return { engine, sourceId, config: loadConfig() ?? { engine: engine.kind },
    logger: { info() {}, warn() {}, error() {} }, dryRun: false, remote: false };
}
/**
 * Replay ID for a machine re-import: identical bytes over the same page revision
 * replay the retained receipt, so an unchanged rescan admits no new request.
 */
export function importWriteRequestId(sourceId: string, slug: string, content: string, revision: string | null): string {
  return derivedRequestId(`import-v1\0${sourceId}\0${slug}\0${revision ?? ''}\0${content}`);
}
function derivedRequestId(material: string): string {
  const hex = createHash('sha256').update(material).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${((parseInt(hex[16], 16) & 3) | 8).toString(16)}${hex.slice(17, 20)}-${hex.slice(20)}`;
}
/** Legacy `gbrain import` semantics (database-only replacement), admitted through the coordinator. */
export async function importContentThroughWriter(engine: OperationContext['engine'], sourceId: string, slug: string,
  content: string): Promise<{ slug: string; status: 'imported' | 'skipped'; chunks: number }> {
  const ctx = localWriteContext(engine, sourceId);
  const key = slug.toLowerCase();
  const snapshot = await engine.readPageSnapshot(key, { sourceId, includeDeleted: true });
  // Creation (including after a purge) is always a new intent; only an existing revision may replay.
  let requestId = snapshot ? importWriteRequestId(sourceId, key, content, snapshot.revision) : randomUUID();
  const prior = snapshot ? await getWriteRequest(engine, await requestPrincipalForContext(ctx), requestId) : null;
  if (prior && ['failed', 'conflict', 'cancelled'].includes(prior.state)) requestId = randomUUID();
  const r = await submitPageMutation(ctx, { operation: 'put_page', waitMs: 60_000, params: {
    request_id: requestId, source_id: sourceId, slug: key, content, force: true, database_only: true,
    allow_empty: true, ingested_via: 'cli:import' } });
  return { slug: typeof r.slug === 'string' && r.slug ? r.slug : key, status: r.noop === true || r.status === 'duplicate' ? 'skipped' : 'imported',
    chunks: Number(r.chunks ?? 0) };
}
/** Replay ID for a tombstone purge: a rerun over the same revision resumes the same request. */
export function purgeWriteRequestId(sourceId: string, slug: string, revision: string): string {
  return derivedRequestId(`purge-v1\0${sourceId}\0${slug}\0${revision}`);
}
/**
 * Hard-deletes tombstones older than the cutoff. A managed brain fences the direct DELETE,
 * so each one goes through the coordinator as a trusted local `delete --purge`.
 * Archived sources are left to the source lifecycle purge; any failure throws after the sweep.
 */
export async function purgeExpiredPages(engine: OperationContext['engine'], olderThanHours: number): Promise<{ slugs: string[]; count: number }> {
  if (!(await managedPersistenceEnabled(engine))) return engine.purgeDeletedPages(olderThanHours);
  const rows = await engine.executeRaw<{ source_id: string; slug: string }>(`SELECT p.source_id, p.slug FROM pages p
    JOIN sources s ON s.id = p.source_id AND s.archived = false
    WHERE p.deleted_at IS NOT NULL AND p.deleted_at < now() - make_interval(hours => $1::int)
    ORDER BY p.deleted_at ASC, p.source_id ASC, p.slug ASC`, [Math.max(0, Math.floor(olderThanHours))]);
  const slugs: string[] = [];
  const failures: string[] = [];
  for (const { source_id: sourceId, slug } of rows) {
    try {
      const ctx = localWriteContext(engine, sourceId);
      const snapshot = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
      if (!snapshot?.page.deleted_at) continue;
      let requestId = purgeWriteRequestId(sourceId, slug, snapshot.revision);
      const prior = await getWriteRequest(engine, await requestPrincipalForContext(ctx), requestId);
      if (prior && ['failed', 'conflict', 'cancelled'].includes(prior.state)) requestId = randomUUID();
      const r = await submitPageMutation(ctx, { operation: 'delete_page', waitMs: 60_000, params: {
        request_id: requestId, source_id: sourceId, slug, expected_revision: snapshot.revision, purge: true } });
      if (r.status === 'purged') slugs.push(slug);
    } catch (error) {
      failures.push(`${sourceId}:${slug}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (failures.length) {
    throw new OperationError('storage_error', `Purged ${slugs.length} tombstone(s); ${failures.length} failed. First: ${failures[0]}`);
  }
  return { slugs, count: slugs.length };
}
export async function submitPageMutation(ctx: OperationContext,
  input: { operation: string; params: Record<string, unknown>; waitMs?: number; managedFileImport?: true }): Promise<Record<string, unknown>> {
  if (input.operation === 'put_page' && ['kind', 'preview', 'backup_reference'].some(key => Object.hasOwn(input.params, key))) {
    if (ctx.remote !== false || input.managedFileImport !== true || input.params.kind !== 'managed_file_import' ||
      ['preview', 'backup_reference'].some(key => Object.hasOwn(input.params, key))) {
      throw new OperationError('invalid_params', 'Reserved persistence fields cannot be submitted through put_page. Use trusted local reconciliation administration.');
    }
  }
  assertPersistenceAccepting(ctx.engine);
  const p: Record<string, unknown> = { ...input.params, ...parseMutationPrecondition(input.params) };
  const requestId = typeof p.request_id === 'string' ? p.request_id : randomUUID();
  const sourceId = pageMutationSource(ctx, p, input.operation);
  await initializeLocalPersistence(ctx);
  const principal = await requestPrincipalForContext(ctx);
  await assertPageRequestIdentity(ctx.engine, principal, requestId);
  const prior = await getWriteRequest(ctx.engine, principal, requestId);
  const callerIntent = { ...p };
  delete callerIntent.request_id;
  if (p.database_only === true && ctx.remote !== false) {
    throw new OperationError('permission_denied', 'Only a trusted local caller may request database-only persistence.');
  }
  if (prior) {
    await submissionAuthority(ctx, prior.operation, prior.source_id, prior.source_incarnation, prior.slug);
    await authorizeStoredRequest(ctx.engine, prior);
    assertReplayIntent(prior, intentDigest({ operation: input.operation, sourceId, slug: prior.slug, callerIntent }));
    return writeResponse(await waitForWrite(ctx.engine, prior, ctx.config, input.waitMs));
  }
  if (input.operation === 'delete_page') assertPurgeParams(p, ctx.remote);
  const [source] = await ctx.engine.executeRaw<{ incarnation: string; archived: boolean; local_path: string | null }>(
    'SELECT incarnation,archived,local_path FROM sources WHERE id=$1', [sourceId]);
  if (!source || source.archived) throw new OperationError('source_changed', 'The write source is not active.');
  let slug = typeof p.slug === 'string' ? p.slug.toLowerCase() : '';
  const intent = ['takes_add','takes_update','takes_supersede','takes_resolve'].includes(input.operation)
    ? await (await import('./takes-prepare.ts')).normalizeTakesIntent(ctx,p) : { ...p };
  delete intent.request_id;
  if (input.operation === 'put_page') await normalizeSubagentPageInput(ctx, intent);
  if (input.operation === 'capture') {
    if (typeof p.content !== 'string' || !normalizeForHash(p.content) || detectBinaryNullByte(Buffer.from(p.content)) !== -1) {
      throw new OperationError('invalid_params', 'Capture requires nonempty text without binary NUL bytes.');
    }
    const explicitType = explicitCaptureType(p.content, typeof p.type === 'string' ? p.type : undefined);
    if (explicitType) {
      const { loadActivePackForWriteVocabulary, packDeclaresPageType, undeclaredPageTypeMessage, undeclaredPageTypeSuggestion } = await import('../schema-pack/write-vocabulary.ts');
      const pack = await loadActivePackForWriteVocabulary(ctx);
      if (pack && !packDeclaresPageType(pack, explicitType)) throw new OperationError('invalid_params', undeclaredPageTypeMessage(explicitType, pack, 'capture'), undeclaredPageTypeSuggestion(pack));
    }
    const type = explicitType ?? 'note';
    if (!slug) {
      slug = defaultSlug(normalizeForHash(p.content), new Date(), type);
      if (ctx.auth?.boundSlugPrefixes?.length) slug = `${normalizeSlugPrefix(ctx.auth.boundSlugPrefixes[0]).replace(/\/$/, '')}/${slug}`;
    }
    intent.content = mergeCaptureFrontmatter(p.content, { type, capturedVia: ctx.remote === false ? 'capture-cli' : 'capture-mcp',
      ...Object.fromEntries(['who','what','where','kind','depth'].filter(key => typeof p[key] === 'string').map(key => [key, p[key]])) });
    intent.capture_hash = computeContentHash(normalizeForHash(p.content));
  }
  validatePageSlug(slug);
  enforceClientSlugFence(ctx, slug, input.operation);
  enforceSubagentSlugFence(ctx, slug, input.operation);
  // Preserve same-source diagnostics for new timeline writes without making
  // terminal replay depend on a page that may have since been purged.
  if (input.operation === 'add_timeline_entry') await requireWritablePage({ ...ctx, sourceId }, slug, input.operation, 'page');
  intent.slug = slug;
  if (ctx.remote !== false) Object.assign(intent, { source_kind: `mcp:${input.operation}`, source_uri: null, ingested_via: `mcp:${input.operation}` });
  const authority = await submissionAuthority(ctx, input.operation, sourceId, source.incarnation, slug);
  await assertKnowledgePublicationAllowed(ctx.engine, { source_id: sourceId, source_incarnation: source.incarnation, slug });
  const snapshot = await ctx.engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
  let binding = await getWorktreeBinding(ctx.engine, sourceId);
  const sandbox = ctx.viaSubagent === true && !(ctx.allowedSlugPrefixes?.length);
  const explicitDatabaseOnly = p.database_only === true;
  const configuredWriteThrough = !/^(false|0|off|no)$/i.test(await ctx.engine.getConfig('sync.write_through') ?? 'true');
  const writeThrough = configuredWriteThrough && !sandbox && !explicitDatabaseOnly;
  const root = source.local_path || (sourceId === 'default' ? await ctx.engine.getConfig('sync.repo_path') : null);
  if (sandbox) authority.databaseOnlyReason = 'subagent_sandbox';
  else if (explicitDatabaseOnly) authority.databaseOnlyReason = 'explicit_local_db_only';
  else if (!configuredWriteThrough) authority.databaseOnlyReason = 'disabled_by_config';
  else if (!root && !binding) authority.databaseOnlyReason = 'no_repo_configured';
  if (p.local_dir !== undefined) {
    // Checkout paths belong to a host binding; sources.local_path may name
    // another host's original checkout after a verified ownership transfer.
    const localRoot = binding ? binding.owner_host_id === localHostId() && binding.local_path
      ? join(binding.local_path, binding.relative_path) : null : root;
    let matches = false;
    if (ctx.remote === false && typeof p.local_dir === 'string' && localRoot) {
      try { matches = realpathSync(resolve(p.local_dir)) === realpathSync(resolve(localRoot)); } catch { /* missing local binding */ }
    }
    if (!matches) throw new OperationError('invalid_params', 'The CLI directory must match the selected source canonical root.',
      'Register the source canonical path, then omit --dir or use that same path.');
  }
  if (writeThrough && root && !binding) {
    if (ctx.engine.kind !== 'pglite') throw new OperationError('owner_unavailable', 'This source has no designated canonical owner.', WRITER_INSPECTION_HINT);
    binding = await claimWorktree(ctx.engine, sourceId, root);
  }
  const row = await admitWrite(ctx.engine, { principal, operation: input.operation, sourceId, sourceIncarnation: source.incarnation,
    slug, pageId: snapshot?.page.id ?? null, requestId, callerIntent, intent, authority,
    worktreeId: writeThrough ? binding?.worktree_id : null, topologyGeneration: writeThrough ? binding?.topology_generation : null });
  return writeResponse(await waitForWrite(ctx.engine, row, ctx.config, input.waitMs));
}
