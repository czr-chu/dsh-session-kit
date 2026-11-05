/**
 * dsh-session-kit -- best-effort workspace files related to one session.
 *
 * DSH keeps no complete touched-files index, so this module derives a candidate
 * list from the session log (presented deliverables, tool result metadata, tool
 * arguments, working-directory changes), resolves it against the owning
 * workspace root, and keeps only existing regular files that the delete
 * operation can safely move into the trash. The derivation is approximate by
 * construction: shell redirections, PTC scripts, and files only mentioned in
 * prose are invisible here, and a shared file can be related to several
 * sessions. Every caller must show that caveat and require an explicit second
 * confirmation.
 *
 * @module dsh-session-kit/session-files
 */

import { lstat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';

import { errorText } from './attachments.js';
import { SessionPortFormatError } from './format.js';
import { deriveTouchedFiles } from './workspace-files.js';

/** Maximum evidence tokens one file can carry. */
const EVIDENCE_PRESENTED = 'deliverables/presented';
const EVIDENCE_TOOL_META = 'tool/result.meta';
const EVIDENCE_TOOL_ARGUMENTS = 'tool/arguments';

/** Resolve one optional composed service without throwing on a missing context. */
function serviceOf(ctx, name) {
  return ctx !== null && typeof ctx === 'object' && typeof ctx.get === 'function' ? ctx.get(name) : undefined;
}

/** True for a plain JSON object. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The Harness home used to exclude runtime state from the file plan. */
function dshHome() {
  const env = process.env.DSH_HOME;
  if (typeof env === 'string' && env.trim() !== '') return resolvePath(env.trim());
  return join(homedir(), '.dsh');
}

/** The trash root used to exclude already-trashed paths from the plan. */
function trashRootOf(options) {
  const explicit = options?.trashDir;
  if (typeof explicit === 'string' && explicit.trim() !== '') return resolvePath(explicit.trim());
  return join(dshHome(), 'session-kit-trash');
}

/** Whether one path is the same as or inside another directory. */
function isInside(child, parent) {
  const normalizedChild = resolvePath(child);
  const normalizedParent = resolvePath(parent);
  if (normalizedChild === normalizedParent) return true;
  const rel = relative(normalizedParent, normalizedChild);
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
}

/** Resolve one candidate path against a base directory (mirrors deriveTouchedFiles). */
function resolveCandidate(value, base) {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim();
  if (candidate === '' || candidate.includes('\u0000')) return undefined;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(candidate) || candidate.startsWith('data:')) return undefined;
  if (isAbsolute(candidate)) return resolvePath(candidate);
  return base === undefined ? undefined : resolvePath(base, candidate);
}

/**
 * Recover the tool/result meta targets (the strong tool evidence) the same way
 * workspace-files.deriveTouchedFiles resolves them. Derivation needs the
 * strong/weak split for its risk report, and the shared helper only returns the
 * merged target set.
 * @param {ReadonlyArray<object>} events - session events.
 * @param {string | undefined} sessionCwd - header cwd.
 * @returns {Set<string>} absolute paths named by tool/result meta.
 */
function scanToolMetaTargets(events, sessionCwd) {
  const targets = new Set();
  if (!Array.isArray(events)) return targets;
  let currentCwd = typeof sessionCwd === 'string' && isAbsolute(sessionCwd) ? resolvePath(sessionCwd) : undefined;
  for (const event of events) {
    if (!isRecord(event) || typeof event.type !== 'string') continue;
    if (event.type === 'working-directory/change') {
      const cwd = event.data?.cwd;
      if (typeof cwd === 'string' && isAbsolute(cwd)) currentCwd = resolvePath(cwd);
      continue;
    }
    if (event.type !== 'tool/result') continue;
    const meta = event.data?.meta;
    if (!isRecord(meta)) continue;
    const base = typeof meta.cwd === 'string' && isAbsolute(meta.cwd) ? resolvePath(meta.cwd) : currentCwd;
    const path = resolveCandidate(meta.path, base);
    if (path !== undefined) targets.add(path);
    if (!Array.isArray(meta.diffs)) continue;
    for (const diff of meta.diffs) {
      const resolved = resolveCandidate(isRecord(diff) ? (diff.path ?? diff.file ?? diff.filePath) : diff, base);
      if (resolved !== undefined) targets.add(resolved);
    }
  }
  return targets;
}

/** Read one stored session's complete event log through the persistence seam. */
async function readSessionLog(persistence, id) {
  const handle = await persistence.open(id, 'read');
  try {
    const slice = await handle.read(0, Number.MAX_SAFE_INTEGER);
    return { header: handle.header, events: Array.isArray(slice?.events) ? slice.events : [] };
  } finally {
    await handle.close();
  }
}

/** One owning workspace root per session id, falling back to the header cwd. */
function workspaceRoots(sessionIds, byId, workspaces) {
  const rootById = new Map();
  for (const id of sessionIds) {
    const header = byId.get(id)?.header;
    let root;
    for (const workspace of workspaces) {
      if (!Array.isArray(workspace?.sessionIds)) continue;
      if (workspace.sessionIds.map(String).includes(id) && typeof workspace.path === 'string' && workspace.path !== '') {
        root = resolvePath(workspace.path);
        break;
      }
    }
    if (root === undefined && typeof header?.cwd === 'string' && isAbsolute(header.cwd)) {
      root = resolvePath(header.cwd);
    }
    if (root !== undefined) rootById.set(id, root);
  }
  return rootById;
}

/** Format one path as a POSIX workspace-relative path. */
function relativePosix(root, absolutePath) {
  return relative(root, absolutePath).split(sep).join('/');
}

/**
 * Derive the best-effort file plan for one delete/preview operation.
 *
 * Reads the selected sessions and their origin='subagent' descendants (a fork
 * or seeded child is a user conversation, never a descendant here), runs the
 * shared touched-files derivation, resolves each path against the owning
 * workspace root, and keeps only existing regular, non-symlink files inside
 * that root. DSH_HOME, the trash root, and every stored session directory are
 * excluded so a move can never touch runtime state. Paths from several sessions
 * are merged, keeping all evidence and every related session id.
 * @param {object} ctx - the plugin context.
 * @param {string[]} sessionIds - selected sessions.
 * @param {{trashDir?: string}} [options] - trash root override used for exclusion.
 * @returns {Promise<{files: Array<object>, skipped: Array<{path: string, reason: string}>, warnings: string[], totalBytes: number}>} file plan.
 * @throws {SessionPortFormatError} code 'invalid-argument' | 'unavailable' | 'file-plan-failed'.
 */
export async function deriveSessionFilePlan(ctx, sessionIds, options = {}) {
  if (!Array.isArray(sessionIds)) {
    throw new SessionPortFormatError('invalid-argument', 'sessionIds 必须是会话 id 数组');
  }
  const selected = [...new Set(sessionIds
    .map((id) => (typeof id === 'string' ? id.trim() : ''))
    .filter((id) => id !== ''))];
  const warnings = [
    '文件列表为尽力推导：只能从会话事件中发现 presented 交付物、工具结果元数据与工具参数；shell 重定向、PTC 脚本和仅在文本中提到的文件无法发现，共享文件可能被一并移入回收站。',
  ];
  const skipped = [];
  const merged = new Map();
  let totalBytes = 0;
  const empty = () => ({ files: [], skipped, warnings, totalBytes: 0 });
  if (selected.length === 0) return empty();

  const persistence = serviceOf(ctx, 'sessionPersistence');
  if (persistence === null || persistence === undefined
    || typeof persistence.list !== 'function' || typeof persistence.open !== 'function') {
    throw new SessionPortFormatError('unavailable', '会话存储服务不可用，无法推导会话相关文件');
  }
  let snapshots;
  try {
    snapshots = await persistence.list();
  } catch (error) {
    throw new SessionPortFormatError('file-plan-failed', '读取会话存储列表失败：' + errorText(error));
  }
  const byId = new Map();
  for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
    const id = snapshot?.header?.id;
    if (typeof id === 'string' && id !== '') byId.set(id, snapshot);
  }

  // Same closure the delete uses: selected ids plus origin='subagent'
  // descendants, never traversing a user-visible fork/seeded child.
  const targets = new Map();
  for (const id of selected) {
    if (byId.has(id)) targets.set(id, byId.get(id));
    else warnings.push('找不到会话 ' + id + '，其相关文件未纳入计划');
  }
  let changed = true;
  while (changed) {
    changed = false;
    for (const [id, snapshot] of byId) {
      if (targets.has(id)) continue;
      const header = snapshot?.header;
      if (!isRecord(header) || header.origin !== 'subagent') continue;
      if (typeof header.parentSession === 'string' && targets.has(header.parentSession)) {
        targets.set(id, snapshot);
        changed = true;
      }
    }
  }

  const registry = serviceOf(ctx, 'workspaceRegistry');
  let workspaces = [];
  if (typeof registry?.list === 'function') {
    try {
      workspaces = (await registry.list()).filter((workspace) => workspace !== null && typeof workspace === 'object');
    } catch (error) {
      warnings.push('读取工作区列表失败，改用以会话 cwd 作为文件根：' + errorText(error));
    }
  }
  const roots = workspaceRoots([...targets.keys()], byId, workspaces);

  // Runtime state a delete must never move: DSH home, the trash root, and any
  // stored session directory.
  const home = dshHome();
  const trashRoot = trashRootOf(options);
  const storageDirs = new Set();
  for (const snapshot of byId.values()) {
    const locationPath = snapshot?.location?.path;
    if (typeof locationPath === 'string' && locationPath !== '') storageDirs.add(resolvePath(dirname(locationPath)));
  }
  const excluded = (absolutePath) => isInside(absolutePath, home)
    || isInside(absolutePath, trashRoot)
    || [...storageDirs].some((dir) => isInside(absolutePath, dir));

  for (const [id, snapshot] of targets) {
    const root = roots.get(id);
    if (root === undefined) {
      warnings.push('会话 ' + id + ' 没有工作区目录，无法推导其相关文件');
      continue;
    }
    let log;
    try {
      log = await readSessionLog(persistence, id);
    } catch (error) {
      warnings.push('读取会话 ' + id + ' 的事件失败，其相关文件未纳入计划：' + errorText(error));
      continue;
    }
    const cwd = typeof log.header?.cwd === 'string' ? log.header.cwd : snapshot?.header?.cwd;
    let derived;
    try {
      derived = deriveTouchedFiles(log.events, cwd);
    } catch (error) {
      warnings.push('推导会话 ' + id + ' 的相关文件失败：' + errorText(error));
      continue;
    }
    const metaTargets = scanToolMetaTargets(log.events, cwd);
    for (const candidate of derived.paths) {
      const absolutePath = resolvePath(candidate);
      if (!isInside(absolutePath, root)) {
        skipped.push({ path: absolutePath, reason: 'outside-workspace' });
        continue;
      }
      if (excluded(absolutePath)) {
        skipped.push({ path: absolutePath, reason: 'excluded-runtime-state' });
        continue;
      }
      let info;
      try {
        info = await lstat(absolutePath);
      } catch (error) {
        const code = error !== null && typeof error === 'object' ? error.code : undefined;
        skipped.push({ path: absolutePath, reason: code === 'ENOENT' ? 'missing' : 'unreadable' });
        continue;
      }
      if (info.isSymbolicLink()) {
        skipped.push({ path: absolutePath, reason: 'symlink' });
        continue;
      }
      if (!info.isFile()) {
        skipped.push({ path: absolutePath, reason: 'not-a-file' });
        continue;
      }
      const evidence = [];
      if (derived.presented.has(candidate)) evidence.push(EVIDENCE_PRESENTED);
      if (metaTargets.has(candidate)) evidence.push(EVIDENCE_TOOL_META);
      if (evidence.length === 0) evidence.push(EVIDENCE_TOOL_ARGUMENTS);
      const weak = evidence.length === 1 && evidence[0] === EVIDENCE_TOOL_ARGUMENTS;
      const existing = merged.get(absolutePath);
      if (existing === undefined) {
        merged.set(absolutePath, {
          path: absolutePath,
          relative: relativePosix(root, absolutePath),
          root,
          bytes: info.size,
          evidence,
          weak,
          sessionIds: [id],
        });
        totalBytes += info.size;
        continue;
      }
      existing.weak = existing.weak && weak;
      for (const token of evidence) if (!existing.evidence.includes(token)) existing.evidence.push(token);
      if (!existing.sessionIds.includes(id)) existing.sessionIds.push(id);
    }
  }

  const files = [...merged.values()]
    .map((file) => ({ ...file, evidence: [...file.evidence].sort(), sessionIds: [...file.sessionIds].sort() }))
    .sort((left, right) => left.path.localeCompare(right.path));
  skipped.sort((left, right) => left.path.localeCompare(right.path));
  return { files, skipped, warnings, totalBytes };
}
