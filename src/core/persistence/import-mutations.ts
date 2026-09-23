import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { BrainEngine } from '../engine.ts';
import { isImageFilePath, type ImportResult } from '../import-file.ts';
import { loadConfig } from '../config.ts';
import { OperationError, type OperationContext } from '../ops/contract.ts';
import { currentSubmissionAuthority } from '../minions/submission-authority.ts';
import { currentVerifiedLocalWriter, localHostId } from './identity.ts';
import { getWorktreeBinding } from './ownership.ts';
import { importWriteRequestId, initializeLocalPersistence, requestPrincipalForContext, submitPageMutation } from './page-mutations.ts';
import { getWriteRequest } from './journal.ts';
import { digest, sha256 } from './digest.ts';
import { assertImportPaths, managedImportContent, readImportBytes, type ImportPack, type ManagedImportIntent } from './import-prepare.ts';

type ManagedImportOptions = { sourceId?: string; noEmbed?: boolean; activePack?: ImportPack; signal?: AbortSignal; slugRoot?: string };
/** Trust, owner and path guards shared by every managed filesystem import. */
async function managedImportPreflight(engine: BrainEngine, filePath: string, sourcePath: string, opts: ManagedImportOptions) {
  const caller = currentSubmissionAuthority();
  if (caller && caller.kind !== 'application' || currentVerifiedLocalWriter()?.remote) {
    throw new OperationError('permission_denied', 'Managed filesystem import requires the trusted local CLI.');
  }
  opts.signal?.throwIfAborted();
  if (isImageFilePath(sourcePath) && process.env.GBRAIN_EMBEDDING_MULTIMODAL !== 'true') {
    throw new OperationError('invalid_params', 'Image import requires GBRAIN_EMBEDDING_MULTIMODAL=true.');
  }
  const sourceId = opts.sourceId ?? 'default';
  const binding = await getWorktreeBinding(engine, sourceId);
  if (!binding?.local_path || binding.owner_host_id !== localHostId() || binding.state !== 'active') {
    throw new OperationError('owner_unavailable', 'Managed import must run on the active canonical owner for the selected source.');
  }
  const root = join(binding.local_path, binding.relative_path);
  const inputPath = resolve(filePath);
  const canonicalRelative = relative(root, inputPath);
  const canonicalInput = canonicalRelative && !isAbsolute(canonicalRelative) && canonicalRelative !== '..' && !canonicalRelative.startsWith(`..${sep}`);
  if (canonicalInput && !opts.slugRoot) sourcePath = canonicalRelative;
  const path = canonicalInput ? canonicalRelative : sourcePath;
  const target = resolve(root, path);
  await assertImportPaths(engine, sourceId, root, inputPath, target);
  return { sourceId, binding, root, inputPath, sourcePath, path, target };
}
export async function importManagedFile(engine: BrainEngine, filePath: string, sourcePath: string,
  opts: ManagedImportOptions = {}): Promise<ImportResult> {
  const { sourceId, binding, root, inputPath, path, target, ...pre } = await managedImportPreflight(engine, filePath, sourcePath, opts);
  sourcePath = pre.sourcePath;
  const bytes = readImportBytes(inputPath);
  const inputHash = sha256(bytes);
  const { slug, content } = managedImportContent(sourcePath, bytes, opts.activePack);
  const ctx = { engine, remote: false, sourceId, config: loadConfig() ?? { engine: engine.kind } } as OperationContext;
  await initializeLocalPersistence(ctx);
  const principal = await requestPrincipalForContext(ctx);
  const key = digest({ principal, incarnation: binding.source_incarnation, inputPath, sourcePath, path, inputHash, noEmbed: !!opts.noEmbed, activePack: opts.activePack ?? null });
  const op = 'managed-file-import';
  const readPending = async () => {
    const [row] = await engine.executeRaw<{ completed_keys: [ManagedImportIntent & { request_id: string; source_id: string }] }>(
      'SELECT completed_keys FROM op_checkpoints WHERE op=$1 AND fingerprint=$2', [op, key]);
    return row?.completed_keys[0];
  };
  let params = await readPending();
  if (!params) {
    const snapshot = await engine.readPageSnapshot(slug, { sourceId, includeDeleted: true });
    params = { kind: 'managed_file_import', slug, content, sourcePath, path, inputPath, inputHash,
      targetHash: existsSync(target) ? sha256(readImportBytes(target)) : null,
      ownerEpoch: String(binding.owner_epoch), ...(snapshot ? { expected_revision: snapshot.revision } : {}),
      noEmbed: !!opts.noEmbed, ...(opts.activePack ? { activePack: opts.activePack } : {}), request_id: randomUUID(), source_id: sourceId };
    await engine.executeRaw('INSERT INTO op_checkpoints(op,fingerprint,completed_keys) VALUES($1,$2,$3::text::jsonb) ON CONFLICT DO NOTHING', [op, key, JSON.stringify([params])]);
    params = (await readPending())!;
  }
  try {
    const outcome = await submitPageMutation(ctx, { operation: 'put_page', params, waitMs: 30_000, managedFileImport: true });
    await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 AND completed_keys=$3::text::jsonb', [op, key, JSON.stringify([params])]);
    return { slug: String(outcome.slug), status: outcome.status as ImportResult['status'], chunks: Number(outcome.chunks ?? 0),
      ...(typeof outcome.error === 'string' ? { error: outcome.error } : {}),
      ...(outcome.type_warning ? { type_warning: outcome.type_warning as ImportResult['type_warning'] } : {}) };
  } catch (error) {
    if (error instanceof OperationError && error.writeRequest && ['failed', 'conflict', 'cancelled'].includes(error.writeRequest.state)) {
      await engine.executeRaw('DELETE FROM op_checkpoints WHERE op=$1 AND fingerprint=$2 AND completed_keys=$3::text::jsonb', [op, key, JSON.stringify([params])]);
    }
    throw error;
  }
}

/**
 * Same guards and normalised content as importManagedFile, but the page is published
 * without writing the canonical file: for mirrors of Markdown kept outside the source root.
 */
export async function importManagedDatabaseOnly(engine: BrainEngine, filePath: string, sourcePath: string,
  opts: ManagedImportOptions = {}): Promise<ImportResult> {
  const pre = await managedImportPreflight(engine, filePath, sourcePath, opts);
  if (!/\.mdx?$/i.test(pre.sourcePath)) throw new OperationError('invalid_params', 'Database-only import supports Markdown files only.');
  const normalised = managedImportContent(pre.sourcePath, readImportBytes(pre.inputPath), opts.activePack);
  // Same key the coordinator stores (submitPageMutation lowercases); a mixed-case frontmatter slug would miss its revision.
  const slug = normalised.slug.toLowerCase(), content = normalised.content;
  const ctx = { engine, remote: false, sourceId: pre.sourceId, config: loadConfig() ?? { engine: engine.kind } } as OperationContext;
  await initializeLocalPersistence(ctx);
  const snapshot = await engine.readPageSnapshot(slug, { sourceId: pre.sourceId, includeDeleted: true });
  // Creation (including after a purge) is always a new intent; only an existing revision may replay.
  let requestId = snapshot ? importWriteRequestId(pre.sourceId, slug, content, snapshot.revision) : randomUUID();
  const prior = snapshot ? await getWriteRequest(engine, await requestPrincipalForContext(ctx), requestId) : null;
  if (prior && ['failed', 'conflict', 'cancelled'].includes(prior.state)) requestId = randomUUID();
  const current = await getWorktreeBinding(engine, pre.sourceId);
  if (!current || current.state !== 'active' || String(current.owner_epoch) !== String(pre.binding.owner_epoch)) {
    throw new OperationError('owner_unavailable', 'The import owner changed.');
  }
  const r = await submitPageMutation(ctx, { operation: 'put_page', waitMs: 30_000, params: {
    request_id: requestId, source_id: pre.sourceId, slug, content, database_only: true, allow_empty: true, ingested_via: 'cli:import',
    ...(snapshot ? { expected_revision: snapshot.revision } : {}) } });
  return { slug: typeof r.slug === 'string' && r.slug ? r.slug : slug,
    status: r.noop === true || r.status === 'duplicate' ? 'skipped' : 'imported', chunks: Number(r.chunks ?? 0) };
}
