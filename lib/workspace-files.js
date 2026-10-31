/**
 * dsh-session-kit -- workspace file collection for export.
 *
 * Two jobs:
 *  - deriveTouchedFiles(): read one session log and recover the workspace
 *    paths the conversation actually touched (presented deliverables, tool
 *    targets, working-directory hints), so an export can carry the files the
 *    user cares about instead of an entire tree.
 *  - collectWorkspaceTree(): walk a workspace directory safely for a full-tree
 *    export. The walk never follows symbolic links, skips dependency and build
 *    directories, refuses credential-shaped paths, and enforces file-count,
 *    per-file, and total-size budgets.
 *
 * Every collected file carries the archive path it will occupy, so the export
 * layer only appends bytes. Nothing here writes to disk.
 *
 * @module dsh-session-kit/workspace-files
 */

import { createHash } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve as resolvePath, sep } from 'node:path';

/** Directory names a workspace walk never descends into (dependency/build/VCS caches). */
export const DEFAULT_EXCLUDED_DIRS = Object.freeze([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  'dist',
  'build',
  '.next',
  'target',
  '__pycache__',
  '.cache',
  '.pnpm-store',
  '.yarn',
  '.idea',
  '.vscode',
]);

/** Credential-shaped file globs and directory names a workspace walk never packs. */
export const DEFAULT_SENSITIVE_PATTERNS = Object.freeze([
  '.env',
  '.env.*',
  '*.pem',
  '*.key',
  '*.p12',
  '*.keystore',
  'id_rsa*',
  'id_ed25519*',
  '.npmrc',
  '.netrc',
  '.git-credentials',
  'credentials*',
  'secrets*',
  '.DS_Store',
  '.ssh',
  '.aws',
  '.gnupg',
  '.config/gcloud',
]);

/** Regexp metacharacters escaped when compiling a sensitive glob. */
const REGEXP_SPECIALS = new Set(['\\', '^', '$', '.', '|', '?', '*', '+', '(', ')', '[', ']', '{', '}']);

/** Sensitive directory names matched against any path segment. */
const SENSITIVE_DIR_NAMES = Object.freeze(['.ssh', '.aws', '.gnupg']);

/** Sensitive two-segment directory sequence. */
const SENSITIVE_DIR_SEQUENCES = Object.freeze([Object.freeze(['.config', 'gcloud'])]);

/** Maximum traversal depth used when parsing nested tool arguments. */
const MAX_ARGUMENT_DEPTH = 8;

/** Tool-argument keys whose string value names a filesystem target. */
const TOOL_PATH_KEYS = new Set([
  'file_path',
  'filePath',
  'path',
  'target',
  'targetPath',
  'dest',
  'destPath',
]);

/** Working-directory change event type. */
const WORKING_DIR_EVENT = 'working-directory/change';

/** Presented-deliverables event type. */
const PRESENTED_EVENT = 'deliverables/presented';

/** True for a plain JSON object. */
function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One-line message of an arbitrary thrown value. */
function errorText(error) {
  if (error instanceof Error) return error.message.split('\n')[0];
  return String(error);
}

/** Normalize a relative path to forward slashes without a leading or trailing slash. */
function normalizeRelative(relPath) {
  if (typeof relPath !== 'string') return '';
  return relPath
    .replaceAll('\\', '/')
    .split('/')
    .filter((segment) => segment !== '' && segment !== '.')
    .join('/');
}

/** Compile one sensitive glob (supports only * and ?) into a case-insensitive matcher. */
function compileGlob(pattern) {
  let source = '';
  for (const char of String(pattern)) {
    if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else source += REGEXP_SPECIALS.has(char) ? '\\' + char : char;
  }
  return new RegExp('^' + source + '$', 'iu');
}

/** Normalize a caller-supplied name list (array, Set, or single string) into lowercase names. */
function nameList(value, fallback) {
  if (value === undefined || value === null) return [...fallback];
  const source = typeof value === 'string' ? [value] : (Array.isArray(value) ? value : [...value]);
  const names = [];
  for (const entry of source) {
    if (typeof entry !== 'string') continue;
    const name = entry.trim().toLowerCase();
    if (name !== '') names.push(name);
  }
  return names;
}

/** Build the effective sensitive matchers: default patterns plus caller additions. */
function sensitiveMatchers(extraPatterns) {
  const patterns = [...DEFAULT_SENSITIVE_PATTERNS, ...nameList(extraPatterns, [])];
  return patterns.map((pattern) => pattern.toLowerCase()).map(compileGlob);
}

/** Build the effective excluded-directory set: defaults plus caller additions. */
function excludedDirNames(extraDirs) {
  return new Set([...nameList(DEFAULT_EXCLUDED_DIRS, []), ...nameList(extraDirs, [])]);
}

/**
 * Whether a workspace-relative path names a credential-shaped file or directory.
 *
 * Any segment matching .ssh / .aws / .gnupg / .config/gcloud marks the path
 * sensitive, and each segment is matched against the sensitive globs so both a
 * sensitive file and a sensitive directory are refused.
 * @param {string} relPath - workspace-relative path (either separator style).
 * @param {string[] | Set<string>} [extraPatterns] - additional sensitive globs or directory names.
 * @returns {boolean} whether the path must never be packed.
 */
export function isSensitivePath(relPath, extraPatterns) {
  const normalized = normalizeRelative(relPath);
  if (normalized === '') return false;
  const segments = normalized.split('/').map((segment) => segment.toLowerCase());
  const matchers = sensitiveMatchers(extraPatterns);
  for (const [index, segment] of segments.entries()) {
    if (SENSITIVE_DIR_NAMES.includes(segment)) return true;
    if (matchers.some((matcher) => matcher.test(segment))) return true;
    for (const sequence of SENSITIVE_DIR_SEQUENCES) {
      if (segment !== sequence[0]) continue;
      let matches = true;
      for (const [offset, expected] of sequence.entries()) {
        if (segments[index + offset] !== expected) {
          matches = false;
          break;
        }
      }
      if (matches) return true;
    }
  }
  return false;
}

/**
 * Whether a workspace-relative path lies under an excluded directory.
 * @param {string} relPath - workspace-relative path (either separator style).
 * @param {string[] | Set<string>} [extraDirs] - additional excluded directory names.
 * @returns {boolean} whether any path segment names an excluded directory.
 */
export function isExcludedDir(relPath, extraDirs) {
  const normalized = normalizeRelative(relPath);
  if (normalized === '') return false;
  const names = excludedDirNames(extraDirs);
  return normalized.split('/').some((segment) => names.has(segment.toLowerCase()));
}

/**
 * Encode one absolute workspace path into a stable, filesystem-safe segment.
 * @param {string} workspacePath - absolute workspace directory.
 * @returns {string} path-safe segment (readable prefix plus a short digest).
 */
function encodeWorkspacePath(workspacePath) {
  const normalized = resolvePath(workspacePath).replaceAll('\\', '/');
  let readable = '';
  let separatorRun = false;
  for (const char of normalized) {
    if (char === '/' || char === '\\' || char === ':') {
      if (!separatorRun) readable += '-';
      separatorRun = true;
      continue;
    }
    separatorRun = false;
    if (/^[A-Za-z0-9._-]$/u.test(char)) readable += char;
    else readable += '~' + char.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0');
  }
  const digits = createHash('sha256').update(normalized).digest('hex').slice(0, 12);
  const base = readable.replace(/^-+|-+$/gu, '') || 'root';
  return base.slice(0, 160) + '-' + digits;
}

/**
 * Stable archive prefix for one workspace directory.
 *
 * Two calls with the same absolute path produce the same key on every run,
 * and different paths (including paths truncated by the readable bound) carry
 * different keys because the digest covers the complete path.
 * @param {string} rootPath - absolute workspace directory.
 * @returns {string} archive prefix, for example workspaces/demo-<digest>.
 * @throws {TypeError} when the path is not a non-empty string.
 */
export function workspaceArchiveKey(rootPath) {
  if (typeof rootPath !== 'string' || rootPath.trim() === '') {
    throw new TypeError('workspaceArchiveKey 需要工作区绝对路径');
  }
  return 'workspaces/' + encodeWorkspacePath(rootPath);
}

/** Resolve one candidate path against a base directory. */
function resolveCandidate(value, base) {
  if (typeof value !== 'string') return undefined;
  const candidate = value.trim();
  if (candidate === '' || candidate.includes('\u0000')) return undefined;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//u.test(candidate) || candidate.startsWith('data:')) return undefined;
  if (isAbsolute(candidate)) return resolvePath(candidate);
  return base === undefined ? undefined : resolvePath(base, candidate);
}

/**
 * Visit every path-shaped string inside one parsed tool argument value.
 * @param {unknown} value - parsed argument value.
 * @param {(candidate: unknown) => void} visit - receives one candidate path value.
 * @param {number} depth - remaining recursion budget.
 */
function visitToolArguments(value, visit, depth) {
  if (depth <= 0) return;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return;
    try {
      visitToolArguments(JSON.parse(trimmed), visit, depth - 1);
    } catch {
      // A non-JSON string argument names no nested filesystem target.
    }
    return;
  }
  if (Array.isArray(value)) {
    for (const member of value) visitToolArguments(member, visit, depth - 1);
    return;
  }
  if (!isRecord(value)) return;
  for (const [key, member] of Object.entries(value)) {
    if (key === 'files') {
      if (Array.isArray(member)) {
        for (const entry of member) {
          visit(isRecord(entry) ? (entry.path ?? entry.file ?? entry.filePath) : entry);
        }
      }
      continue;
    }
    if (TOOL_PATH_KEYS.has(key)) {
      visit(member);
      continue;
    }
    if (isRecord(member) || Array.isArray(member)) visitToolArguments(member, visit, depth - 1);
  }
}

/**
 * Recover the workspace paths one session log touched.
 *
 * Sources: deliverables/presented files, tool/result meta (path, cwd, diffs),
 * any tool/* argument value named file_path / path / target / dest / files[].path,
 * and working-directory/change cwds. Relative paths resolve against the session
 * cwd or the most recent working-directory change; a relative path with no
 * known absolute base is ignored rather than guessed.
 *
 * The result shape lets the export layer offer three choices per workspace:
 * only touched files, the touched files plus their cwd hints, or the whole tree.
 * @param {ReadonlyArray<object>} events - committed session events.
 * @param {string | undefined} sessionCwd - absolute working directory recorded on the header.
 * @returns {{paths: Set<string>, presented: Set<string>, toolTargets: Set<string>, cwdHints: Set<string>}} absolute path sets.
 */
export function deriveTouchedFiles(events, sessionCwd) {
  const paths = new Set();
  const presented = new Set();
  const toolTargets = new Set();
  const cwdHints = new Set();
  let currentCwd = typeof sessionCwd === 'string' && isAbsolute(sessionCwd) ? resolvePath(sessionCwd) : undefined;
  if (!Array.isArray(events)) return { paths, presented, toolTargets, cwdHints };

  for (const event of events) {
    if (!isRecord(event) || typeof event.type !== 'string') continue;
    if (event.type === WORKING_DIR_EVENT) {
      const cwd = event.data?.cwd;
      if (typeof cwd === 'string' && isAbsolute(cwd)) {
        currentCwd = resolvePath(cwd);
        cwdHints.add(currentCwd);
      }
      continue;
    }
    if (event.type === PRESENTED_EVENT) {
      const files = event.data?.files;
      if (!Array.isArray(files)) continue;
      for (const entry of files) {
        const resolved = resolveCandidate(isRecord(entry) ? entry.path : entry, currentCwd);
        if (resolved === undefined) continue;
        presented.add(resolved);
        paths.add(resolved);
      }
      continue;
    }
    if (event.type === 'tool/result') {
      const meta = event.data?.meta;
      if (isRecord(meta)) {
        const base = typeof meta.cwd === 'string' && isAbsolute(meta.cwd) ? resolvePath(meta.cwd) : currentCwd;
        const target = resolveCandidate(meta.path, base);
        if (target !== undefined) {
          paths.add(target);
          toolTargets.add(target);
        }
        const diffs = meta.diffs;
        if (Array.isArray(diffs)) {
          for (const diff of diffs) {
            const resolved = resolveCandidate(isRecord(diff) ? (diff.path ?? diff.file ?? diff.filePath) : diff, base);
            if (resolved === undefined) continue;
            paths.add(resolved);
            toolTargets.add(resolved);
          }
        }
      }
    }
    if (!event.type.startsWith('tool/')) continue;
    const args = event.data?.arguments;
    if (args === undefined || args === null) continue;
    visitToolArguments(args, (candidate) => {
      const resolved = resolveCandidate(candidate, currentCwd);
      if (resolved === undefined) return;
      paths.add(resolved);
      toolTargets.add(resolved);
    }, MAX_ARGUMENT_DEPTH);
  }
  return { paths, presented, toolTargets, cwdHints };
}

/** Read one positive integer option with a documented fallback. */
function positiveInteger(value, fallback, label) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(label + ' 必须是正整数');
  }
  return value;
}

/** Sort directory entries deterministically by name. */
function compareNames(left, right) {
  if (left.name < right.name) return -1;
  if (left.name > right.name) return 1;
  return 0;
}

/**
 * Check that one path is an existing real workspace directory.
 * @param {string} rootPath - candidate workspace directory.
 * @returns {Promise<string>} its resolved absolute path.
 * @throws {TypeError} for a missing path argument.
 * @throws {Error} when the path is missing, a file, or a symbolic link.
 */
async function assertWorkspaceRoot(rootPath) {
  if (typeof rootPath !== 'string' || rootPath.trim() === '') {
    throw new TypeError('工作区目录路径不能为空');
  }
  const root = resolvePath(rootPath);
  let info;
  try {
    info = await lstat(root);
  } catch (error) {
    throw new Error('工作区目录不存在：' + root + '（' + errorText(error) + '）');
  }
  if (info.isSymbolicLink()) throw new Error('工作区路径不能是符号链接：' + root);
  if (!info.isDirectory()) throw new Error('工作区路径不是目录：' + root);
  return root;
}

/**
 * Shared collection state for both workspace entry points: budgets, exclusion
 * policy, deterministic file list, and skip/warning reports.
 * @param {string} root - resolved workspace directory.
 * @param {object} options - caller limits and additional exclusions.
 * @returns {object} mutable collection state.
 */
function createCollectionState(root, options) {
  const state = {
    key: workspaceArchiveKey(root),
    limits: {
      maxFiles: positiveInteger(options.maxFiles, 20_000, 'maxFiles'),
      maxFileBytes: positiveInteger(options.maxFileBytes, 32 * 1024 * 1024, 'maxFileBytes'),
      maxTotalBytes: positiveInteger(options.maxTotalBytes, 1.5 * 1024 ** 3, 'maxTotalBytes'),
    },
    excluded: excludedDirNames(options.excludeDirs),
    extraPatterns: nameList(options.excludePatterns, []),
    /** @type {Array<{absPath: string, relPath: string, size: number, archivePath: string}>} */
    files: [],
    /** @type {string[]} */
    warnings: [],
    /** @type {Array<{path: string, reason: string}>} */
    skipped: [],
    /** @type {Set<string>} */
    collected: new Set(),
    totalBytes: 0,
    truncated: false,
  };
  return state;
}

/** Record one skipped entry, optionally with a user-visible warning. */
function noteSkip(state, rel, reason, warning) {
  state.skipped.push({ path: rel, reason });
  if (warning !== undefined) state.warnings.push(warning);
}

/**
 * Admit one regular file into the collection, applying every policy check.
 * @param {object} state - collection state.
 * @param {string} absolute - resolved absolute path.
 * @param {string} rel - workspace-relative POSIX path.
 * @param {number} size - byte length from lstat.
 * @returns {'ok' | 'skip' | 'stop'} whether the file was added, skipped, or a budget ended the walk.
 */
function admitFile(state, absolute, rel, size) {
  if (state.collected.has(absolute)) return 'skip';
  if (isSensitivePath(rel, state.extraPatterns)) {
    noteSkip(state, rel, 'sensitive', '已排除敏感文件：' + rel);
    return 'skip';
  }
  if (size > state.limits.maxFileBytes) {
    noteSkip(state, rel, 'too-large', '已跳过大文件：' + rel + '（' + size + ' 字节，上限 ' + state.limits.maxFileBytes + '）');
    return 'skip';
  }
  if (state.files.length >= state.limits.maxFiles) {
    noteSkip(state, rel, 'max-files', '文件数超过上限 ' + state.limits.maxFiles + '，后续文件未打包：' + rel);
    state.truncated = true;
    return 'stop';
  }
  if (state.totalBytes + size > state.limits.maxTotalBytes) {
    noteSkip(state, rel, 'max-total-bytes', '工作区文件总大小超过上限 ' + state.limits.maxTotalBytes + ' 字节，后续文件未打包：' + rel);
    state.truncated = true;
    return 'stop';
  }
  state.totalBytes += size;
  state.collected.add(absolute);
  state.files.push({
    absPath: absolute,
    relPath: rel,
    size,
    archivePath: state.key + '/' + rel.split(sep).join('/'),
  });
  return 'ok';
}

/**
 * Recursively walk one directory inside the workspace.
 * @param {object} state - collection state.
 * @param {string} absoluteDir - directory to read.
 * @param {string} relDir - its workspace-relative POSIX spelling ('' for the root).
 */
async function walkWorkspace(state, absoluteDir, relDir) {
  let entries;
  try {
    entries = await readdir(absoluteDir, { withFileTypes: true });
  } catch (error) {
    const rel = relDir === '' ? '.' : relDir;
    noteSkip(state, rel, 'unreadable', '目录读取失败，已跳过：' + rel + '（' + errorText(error) + '）');
    return;
  }
  entries.sort(compareNames);
  for (const entry of entries) {
    if (state.truncated) return;
    const rel = relDir === '' ? entry.name : relDir + '/' + entry.name;
    if (isSensitivePath(rel, state.extraPatterns)) {
      noteSkip(state, rel, 'sensitive', '已排除敏感文件：' + rel);
      continue;
    }
    if (entry.isSymbolicLink()) {
      noteSkip(state, rel, 'symlink', '已跳过符号链接：' + rel);
      continue;
    }
    const absolute = join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      if (state.excluded.has(entry.name.toLowerCase())) {
        noteSkip(state, rel, 'excluded-dir');
        continue;
      }
      await walkWorkspace(state, absolute, rel);
      continue;
    }
    if (!entry.isFile()) {
      noteSkip(state, rel, 'not-a-file');
      continue;
    }
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      noteSkip(state, rel, 'unreadable', '文件读取失败，已跳过：' + rel + '（' + errorText(error) + '）');
      continue;
    }
    if (!info.isFile() || info.isSymbolicLink()) {
      noteSkip(state, rel, 'not-a-file');
      continue;
    }
    if (admitFile(state, absolute, rel, info.size) === 'stop') return;
  }
}

/** The public collection result of one state. */
function collectionResult(state) {
  return {
    files: state.files,
    totalBytes: state.totalBytes,
    warnings: state.warnings,
    skipped: state.skipped,
  };
}

/**
 * Collect the safe files of one workspace tree for a full-tree export.
 *
 * Symbolic links are never followed (a link can leave the workspace); they are
 * skipped with a warning. Excluded directories, credential-shaped paths, files
 * above maxFileBytes, files beyond maxFiles, and bytes beyond maxTotalBytes are
 * skipped with a reason in skipped. Traversal is deterministic (name-sorted
 * depth-first) so two exports of an unchanged tree produce identical entries.
 * @param {string} rootPath - workspace directory to walk.
 * @param {object} [options] - limits and additional exclusions.
 * @param {string[] | Set<string>} [options.excludeDirs] - extra directory names to skip.
 * @param {string[] | Set<string>} [options.excludePatterns] - extra sensitive globs.
 * @param {number} [options.maxFiles] - file-count budget (default 20000).
 * @param {number} [options.maxFileBytes] - per-file byte budget (default 32 MiB).
 * @param {number} [options.maxTotalBytes] - total byte budget (default 1.5 GiB).
 * @returns {Promise<{files: Array<{absPath: string, relPath: string, size: number, archivePath: string}>,
 *   totalBytes: number, warnings: string[], skipped: Array<{path: string, reason: string}>}>} collected files.
 * @throws {Error} when the workspace directory does not exist or is not a directory.
 */
export async function collectWorkspaceTree(rootPath, options = {}) {
  const root = await assertWorkspaceRoot(rootPath);
  const state = createCollectionState(root, options);
  await walkWorkspace(state, root, '');
  return collectionResult(state);
}

/**
 * Collect only the touched paths of one workspace (the default export mode).
 *
 * Each candidate is resolved against the workspace; anything outside it, a
 * symbolic link, an excluded directory, a credential-shaped path, or a path
 * that no longer exists is skipped with a reason. A candidate directory is
 * walked with the same safe traversal as a whole-tree export, so a touched
 * directory contributes its files under the same budgets. Duplicate and
 * overlapping candidates are collected once.
 * @param {Iterable<string>} paths - absolute paths from deriveTouchedFiles (Set or array).
 * @param {object} options - same limits as collectWorkspaceTree plus the workspace root.
 * @param {string} options.rootPath - workspace directory the candidates belong to.
 * @returns {Promise<{files: Array<{absPath: string, relPath: string, size: number, archivePath: string}>,
 *   totalBytes: number, warnings: string[], skipped: Array<{path: string, reason: string}>}>} collected files.
 * @throws {TypeError} when rootPath is missing or not a string.
 * @throws {Error} when the workspace root is missing, a file, or a symbolic link.
 */
export async function collectTouchedFiles(paths, options = {}) {
  if (typeof options.rootPath !== 'string' || options.rootPath.trim() === '') {
    throw new TypeError('collectTouchedFiles 需要 rootPath（工作区目录）');
  }
  const root = await assertWorkspaceRoot(options.rootPath);
  const state = createCollectionState(root, options);
  const seeds = new Set();
  const source = paths instanceof Set ? [...paths] : (Array.isArray(paths) ? paths : []);
  for (const value of source) {
    if (typeof value !== 'string' || value.trim() === '') continue;
    seeds.add(resolvePath(value));
  }
  for (const absolute of [...seeds].sort()) {
    if (state.truncated) break;
    let relRaw;
    try {
      relRaw = relative(root, absolute);
    } catch {
      noteSkip(state, absolute, 'outside-workspace', '已跳过工作区外路径：' + absolute);
      continue;
    }
    const rel = relRaw.split(sep).join('/');
    if (rel === '') {
      await walkWorkspace(state, root, '');
      continue;
    }
    if (relRaw.startsWith('..') || isAbsolute(relRaw)) {
      noteSkip(state, relRaw, 'outside-workspace', '已跳过工作区外路径：' + absolute);
      continue;
    }
    if (isExcludedDir(rel, state.excluded)) {
      noteSkip(state, rel, 'excluded-dir');
      continue;
    }
    let info;
    try {
      info = await lstat(absolute);
    } catch (error) {
      noteSkip(state, rel, 'missing', '已跳过不存在的路径：' + rel + '（' + errorText(error) + '）');
      continue;
    }
    if (info.isSymbolicLink()) {
      noteSkip(state, rel, 'symlink', '已跳过符号链接：' + rel);
      continue;
    }
    if (info.isDirectory()) {
      await walkWorkspace(state, absolute, rel);
      continue;
    }
    if (!info.isFile()) {
      noteSkip(state, rel, 'not-a-file');
      continue;
    }
    if (admitFile(state, absolute, rel, info.size) === 'stop') break;
  }
  return collectionResult(state);
}
