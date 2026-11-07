/**
 * Behavior tests for the workspace file collection module: safe whole-tree
 * traversal, sensitive/excluded filtering, limits, and touched-file derivation.
 * Every test uses throwaway temp directories; no real workspace is read.
 */
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import {
  DEFAULT_EXCLUDED_DIRS,
  DEFAULT_SENSITIVE_PATTERNS,
  collectTouchedFiles,
  collectWorkspaceTree,
  deriveTouchedFiles,
  isExcludedDir,
  isSensitivePath,
  workspaceArchiveKey,
} from '../lib/workspace-files.js'

/** Create one temp workspace root and its cleanup hook. */
function tempRoot(t, label) {
  const root = mkdtempSync(join(tmpdir(), 'dsk-' + label + '-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

/** Write one file, creating parent directories. */
function writeFile(root, relPath, content) {
  const absolute = join(root, relPath)
  mkdirSync(join(absolute, '..'), { recursive: true })
  writeFileSync(absolute, content)
  return absolute
}

/** Sorted relative paths of the collected files. */
function relPaths(collected) {
  return collected.files.map((file) => file.relPath)
}

/** Sorted reasons of the skipped entries. */
function skipReasons(collected) {
  return collected.skipped.map((entry) => entry.path + ':' + entry.reason).sort()
}

test('default exclusion and sensitive lists are the documented frozen allowlists', () => {
  assert.ok(Object.isFrozen(DEFAULT_EXCLUDED_DIRS))
  assert.ok(Object.isFrozen(DEFAULT_SENSITIVE_PATTERNS))
  for (const name of [
    'node_modules',
    '.git',
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
  ]) {
    assert.ok(DEFAULT_EXCLUDED_DIRS.includes(name), 'excluded dir ' + name)
  }
  for (const pattern of [
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
  ]) {
    assert.ok(DEFAULT_SENSITIVE_PATTERNS.includes(pattern), 'sensitive pattern ' + pattern)
  }
})

test('isSensitivePath refuses credential-shaped files and directories', () => {
  for (const sensitive of [
    '.env',
    '.env.local',
    'app/.env.production',
    '.ENV',
    'secret.pem',
    'a/b.key',
    'id_rsa',
    'id_rsa.pub',
    'id_ed25519',
    'credentials.json',
    'secrets.yaml',
    '.DS_Store',
    'app.p12',
    'store.keystore',
    '.npmrc',
    '.netrc',
    '.git-credentials',
    '.ssh/config',
    'sub/.aws/credentials',
    '.gnupg/private-keys-v1.d/x.key',
    '.config/gcloud/application_default_credentials.json',
    'C:\\work\\.env',
  ]) {
    assert.equal(isSensitivePath(sensitive), true, 'sensitive ' + sensitive)
  }
  for (const safe of [
    'env.txt',
    'environment.md',
    'pemfile',
    'keyboard.txt',
    'keymap.json',
    'secretary.txt',
    'credentials-notes.md'.replace('credentials-notes.md', 'notes.md'),
    'normal/file.txt',
    '.config/other/file',
    '.config/gcloud-backup/x',
    'src/.keep',
  ]) {
    assert.equal(isSensitivePath(safe), false, 'safe ' + safe)
  }
  // Caller additions extend the default list.
  assert.equal(isSensitivePath('app.local', ['*.local']), true)
  assert.equal(isSensitivePath('app.local'), false)
  assert.equal(isSensitivePath('.hidden-dir/x', new Set(['.hidden-dir'])), true)
})

test('isExcludedDir matches any excluded segment', () => {
  for (const excluded of [
    'node_modules',
    'app/node_modules',
    'node_modules/pkg/file.js',
    '.git',
    'a/.git/HEAD',
    'dist',
    'sub/build/out',
    'a/.venv/lib',
    'venv',
    '__pycache__/x.pyc',
    'nested/.yarn/cache',
  ]) {
    assert.equal(isExcludedDir(excluded), true, 'excluded ' + excluded)
  }
  for (const safe of [
    'nodemodules',
    'my-node_modules',
    'distribution',
    'build-scripts',
    'src/node_modules.txt',
    'venv2',
  ]) {
    assert.equal(isExcludedDir(safe), false, 'safe ' + safe)
  }
  assert.equal(isExcludedDir('cache', ['cache']), true, 'caller addition')
  assert.equal(isExcludedDir('cache'), false)
  assert.equal(isSensitivePath(''), false)
  assert.equal(isExcludedDir(''), false)
})

test('workspaceArchiveKey is stable, path-safe, and unique per path', () => {
  const root = mkdtempSync(join(tmpdir(), 'dsk-key-'))
  try {
    const first = join(root, 'demo project')
    const second = join(root, 'demo project 2')
    mkdirSync(first, { recursive: true })
    mkdirSync(second, { recursive: true })
    const keyOf = workspaceArchiveKey(first)
    assert.match(keyOf, /^workspaces\/[A-Za-z0-9._~-]+$/u)
    assert.equal(workspaceArchiveKey(first), keyOf, 'same path, same key')
    assert.notEqual(workspaceArchiveKey(second), keyOf, 'different path, different key')
    assert.ok(!keyOf.includes('..'), 'no traversal segment')
    // A long path keeps its readable prefix bounded but stays unique.
    const longName = 'x'.repeat(200)
    const longDir = join(root, longName)
    mkdirSync(longDir, { recursive: true })
    const longKey = workspaceArchiveKey(longDir)
    assert.ok(longKey.length < 200, 'bounded key length')
    assert.notEqual(longKey, keyOf)
    assert.equal(workspaceArchiveKey(longDir), longKey)
    // Non-ASCII and separators are encoded, never copied raw.
    const unicodeDir = join(root, '中文 目录')
    mkdirSync(unicodeDir, { recursive: true })
    const unicodeKey = workspaceArchiveKey(unicodeDir)
    assert.match(unicodeKey, /^workspaces\/[A-Za-z0-9._~-]+$/u)
    assert.ok(unicodeKey.includes('~'))
    assert.throws(() => workspaceArchiveKey(''), TypeError)
    assert.throws(() => workspaceArchiveKey(undefined), TypeError)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('collectWorkspaceTree packs only safe files and explains every skip', async (t) => {
  const root = tempRoot(t, 'tree')
  writeFile(root, 'a.txt', 'hello')
  writeFile(root, '.keep', 'abc')
  writeFile(root, 'sub/b.md', '# b')
  writeFile(root, 'node_modules/pkg/index.js', 'module.exports = 1;')
  writeFile(root, '.git/HEAD', 'ref: refs/heads/main')
  writeFile(root, 'dist/app.js', 'built')
  writeFile(root, '.env', 'SECRET=1')
  writeFile(root, 'keys/server.pem', 'PEM')
  writeFile(root, '.ssh/config', 'Host *')
  writeFile(root, '.config/gcloud/creds.json', '{}')
  writeFile(root, 'big.bin', 'x'.repeat(200))
  mkdirSync(join(root, 'emptydir'), { recursive: true })
  const outside = tempRoot(t, 'outside')
  writeFile(outside, 'leaked.txt', 'outside the workspace')

  const collected = await collectWorkspaceTree(root, { maxFileBytes: 50 })
  assert.deepEqual(relPaths(collected), ['.keep', 'a.txt', 'sub/b.md'])
  assert.deepEqual(
    collected.files.map((file) => file.size),
    [3, 5, 3],
  )
  assert.equal(collected.totalBytes, 11)
  const key = workspaceArchiveKey(root)
  for (const file of collected.files) {
    assert.equal(file.archivePath, key + '/' + file.relPath)
    assert.ok(file.absPath.startsWith(root))
    assert.ok(!file.archivePath.includes('\\'))
  }
  const reasons = skipReasons(collected)
  for (const expected of [
    '.env:sensitive',
    '.ssh:sensitive',
    'keys/server.pem:sensitive',
    '.config/gcloud:sensitive',
    'node_modules:excluded-dir',
    '.git:excluded-dir',
    'dist:excluded-dir',
    'big.bin:too-large',
  ]) {
    assert.ok(reasons.includes(expected), 'skipped ' + expected + ' in ' + reasons.join(','))
  }
  // The whole excluded directory is recorded once, not per descendant.
  assert.equal(collected.skipped.filter((entry) => entry.path === 'node_modules').length, 1)
  assert.ok(collected.warnings.some((warning) => warning.includes('敏感文件') && warning.includes('.env')))
  assert.ok(collected.warnings.some((warning) => warning.includes('大文件') && warning.includes('big.bin')))
  // The outside directory is not reachable through the tree.
  assert.equal(
    collected.files.some((file) => file.relPath.includes('leaked')),
    false,
  )
  // Two walks of an unchanged tree are byte-identical.
  const again = await collectWorkspaceTree(root, { maxFileBytes: 50 })
  assert.deepEqual(again.files, collected.files)
  assert.deepEqual(again.skipped, collected.skipped)
})

test('collectWorkspaceTree never follows symbolic links', async (t) => {
  const root = tempRoot(t, 'links')
  const outside = tempRoot(t, 'link-target')
  writeFile(root, 'real.txt', 'real')
  writeFile(outside, 'outside.txt', 'outside')
  try {
    symlinkSync(join(root, 'real.txt'), join(root, 'alias.txt'))
    symlinkSync(outside, join(root, 'escape'))
  } catch {
    t.skip('symbolic links are unavailable on this platform')
    return
  }
  const collected = await collectWorkspaceTree(root)
  assert.deepEqual(relPaths(collected), ['real.txt'])
  assert.equal(collected.totalBytes, 4)
  assert.deepEqual(skipReasons(collected), ['alias.txt:symlink', 'escape:symlink'])
  assert.ok(collected.warnings.every((warning) => warning.includes('符号链接')))
})

test('collectWorkspaceTree enforces file-count, per-file, and total-byte budgets', async (t) => {
  const root = tempRoot(t, 'limits')
  writeFile(root, 'a.txt', 'aa')
  writeFile(root, 'b.txt', 'bbb')
  writeFile(root, 'c.txt', 'cccc')
  writeFile(root, 'huge.bin', 'x'.repeat(100))

  const byCount = await collectWorkspaceTree(root, { maxFiles: 2, maxFileBytes: 1000 })
  assert.deepEqual(relPaths(byCount), ['a.txt', 'b.txt'])
  assert.ok(byCount.skipped.some((entry) => entry.reason === 'max-files'))
  assert.ok(byCount.warnings.some((warning) => warning.includes('文件数超过上限')))

  const bySize = await collectWorkspaceTree(root, { maxFileBytes: 5 })
  assert.deepEqual(relPaths(bySize), ['a.txt', 'b.txt', 'c.txt'])
  assert.equal(bySize.totalBytes, 9)
  assert.deepEqual(
    bySize.skipped.map((entry) => entry.path + ':' + entry.reason),
    ['huge.bin:too-large'],
  )

  const byTotal = await collectWorkspaceTree(root, { maxTotalBytes: 6, maxFileBytes: 1000 })
  assert.deepEqual(relPaths(byTotal), ['a.txt', 'b.txt'])
  assert.deepEqual(
    byTotal.skipped.map((entry) => entry.path + ':' + entry.reason),
    ['c.txt:max-total-bytes'],
  )
  assert.ok(byTotal.warnings.some((warning) => warning.includes('总大小超过上限')))

  await assert.rejects(collectWorkspaceTree(root, { maxFiles: 0 }), TypeError)
  await assert.rejects(collectWorkspaceTree(root, { maxFileBytes: 1.5 }), TypeError)
})

test('collectWorkspaceTree accepts caller additions to both exclusion lists', async (t) => {
  const root = tempRoot(t, 'extra')
  writeFile(root, 'keep.md', 'keep')
  writeFile(root, 'notes.txt', 'notes')
  writeFile(root, 'app.local', 'config')
  writeFile(root, 'cache/data.bin', 'cached')
  const collected = await collectWorkspaceTree(root, {
    excludeDirs: new Set(['cache']),
    excludePatterns: ['*.txt', '*.local'],
  })
  assert.deepEqual(relPaths(collected), ['keep.md'])
  const reasons = skipReasons(collected)
  assert.ok(reasons.includes('cache:excluded-dir'))
  assert.ok(reasons.includes('notes.txt:sensitive'))
  assert.ok(reasons.includes('app.local:sensitive'))
})

test('collectWorkspaceTree rejects missing, file, and symlinked roots', async (t) => {
  const root = tempRoot(t, 'bad')
  await assert.rejects(collectWorkspaceTree(join(root, 'missing')), /工作区目录不存在/u)
  const file = writeFile(root, 'plain.txt', 'x')
  await assert.rejects(collectWorkspaceTree(file), /工作区路径不是目录/u)
  await assert.rejects(collectWorkspaceTree(''), TypeError)
  const target = join(root, 'target')
  mkdirSync(target, { recursive: true })
  try {
    symlinkSync(target, join(root, 'link'))
  } catch {
    t.skip('symbolic links are unavailable on this platform')
    return
  }
  await assert.rejects(collectWorkspaceTree(join(root, 'link')), /符号链接/u)
})

test('collectTouchedFiles packs only the safe touched paths', async (t) => {
  const root = tempRoot(t, 'touched')
  writeFile(root, 'a.txt', 'aaa')
  writeFile(root, 'sub/b.md', 'bbbb')
  writeFile(root, 'nested/c.txt', 'ccccc')
  writeFile(root, '.env', 'SECRET=1')
  writeFile(root, 'node_modules/x.js', 'module.exports = 1;')
  writeFile(root, 'big.bin', 'x'.repeat(100))
  const outside = tempRoot(t, 'touched-outside')
  const outsideFile = writeFile(outside, 'leak.txt', 'leak')
  const aliasPath = join(root, 'alias.txt')
  let symlinked = true
  try {
    symlinkSync(join(root, 'a.txt'), aliasPath)
  } catch {
    symlinked = false
  }
  const seeds = new Set([
    join(root, 'a.txt'),
    join(root, 'a.txt'),
    join(root, 'sub'),
    join(root, 'sub/b.md'),
    join(root, 'nested'),
    join(root, '.env'),
    join(root, 'node_modules/x.js'),
    join(root, 'missing.txt'),
    join(root, 'big.bin'),
    outsideFile,
  ])
  if (symlinked) seeds.add(aliasPath)
  const collected = await collectTouchedFiles(seeds, { rootPath: root, maxFileBytes: 50 })
  assert.deepEqual(relPaths(collected), ['a.txt', 'nested/c.txt', 'sub/b.md'])
  assert.equal(collected.totalBytes, 12)
  const key = workspaceArchiveKey(root)
  for (const file of collected.files) assert.equal(file.archivePath, key + '/' + file.relPath)
  const reasons = skipReasons(collected)
  for (const expected of [
    '.env:sensitive',
    'node_modules/x.js:excluded-dir',
    'missing.txt:missing',
    'big.bin:too-large',
  ]) {
    assert.ok(reasons.includes(expected), 'skipped ' + expected + ' in ' + reasons.join(','))
  }
  if (symlinked) assert.ok(reasons.includes('alias.txt:symlink'))
  assert.ok(collected.skipped.some((entry) => entry.reason === 'outside-workspace' && entry.path.endsWith('leak.txt')))
  assert.ok(collected.warnings.some((warning) => warning.includes('工作区外路径')))
  // A duplicate or overlapping seed never collects a file twice.
  assert.equal(collected.files.filter((file) => file.relPath === 'sub/b.md').length, 1)
})

test('collectTouchedFiles validates its root and can seed the whole workspace', async (t) => {
  const root = tempRoot(t, 'touched-root')
  writeFile(root, 'a.txt', 'aa')
  writeFile(root, 'sub/b.md', 'bbb')
  await assert.rejects(collectTouchedFiles([join(root, 'a.txt')], {}), TypeError)
  await assert.rejects(collectTouchedFiles([], { rootPath: join(root, 'missing') }), /工作区目录不存在/u)
  const whole = await collectTouchedFiles(new Set([root]), { rootPath: root })
  const tree = await collectWorkspaceTree(root)
  assert.deepEqual(whole.files, tree.files)
  assert.deepEqual(whole.skipped, tree.skipped)
  // Budgets apply to touched paths exactly as they do to a full walk.
  const limited = await collectTouchedFiles([join(root, 'a.txt'), join(root, 'sub/b.md')], {
    rootPath: root,
    maxFiles: 1,
  })
  assert.deepEqual(relPaths(limited), ['a.txt'])
  assert.ok(limited.skipped.some((entry) => entry.reason === 'max-files'))
})

test('deriveTouchedFiles finds every recorded path source', () => {
  const events = [
    { type: 'working-directory/change', data: { cwd: '/work/proj' } },
    {
      type: 'tool/call',
      data: { arguments: JSON.stringify({ file_path: 'src/a.js', command: 'touch src/a.js', description: 'x' }) },
    },
    {
      type: 'tool/call',
      data: {
        arguments: {
          target: 'build/out',
          dest: '/abs/dest.txt',
          files: [{ path: 'z.txt' }, 'q.txt'],
          nested: { filePath: 'deep/n.js' },
        },
      },
    },
    { type: 'tool/result', data: { meta: { path: 'out.txt', cwd: '/work/other', diffs: [{ path: 'src/b.js' }] } } },
    { type: 'deliverables/presented', data: { files: [{ path: 'report.md' }, { path: '/abs/x.pdf' }, { path: 42 }] } },
    { type: 'working-directory/change', data: { cwd: '/work/later' } },
    { type: 'tool/call', data: { arguments: JSON.stringify({ path: 'after-cwd.txt' }) } },
    { type: 'user/message', data: { content: [{ type: 'text', text: 'not a path source' }] } },
    { type: 'tool/call', data: { arguments: 'not json' } },
    { type: 'tool/call', data: { arguments: JSON.stringify({ path: 'https://example.com/x' }) } },
    null,
  ]
  const derived = deriveTouchedFiles(events, '/work/base')
  assert.deepEqual([...derived.presented].sort(), ['/abs/x.pdf', '/work/proj/report.md'])
  assert.deepEqual([...derived.cwdHints].sort(), ['/work/later', '/work/proj'])
  const toolTargets = [...derived.toolTargets].sort()
  for (const expected of [
    '/abs/dest.txt',
    '/work/proj/src/a.js',
    '/work/proj/build/out',
    '/work/proj/z.txt',
    '/work/proj/q.txt',
    '/work/proj/deep/n.js',
    '/work/other/out.txt',
    '/work/other/src/b.js',
    '/work/later/after-cwd.txt',
  ]) {
    assert.ok(toolTargets.includes(expected), 'tool target ' + expected)
  }
  assert.equal(
    toolTargets.includes('/work/base/src/a.js'),
    false,
    'the working-directory change wins over the session cwd',
  )
  assert.ok(!toolTargets.some((path) => path.includes('example.com')), 'URLs are not filesystem paths')
  assert.ok(!toolTargets.some((path) => path.includes('not json')))
  assert.deepEqual([...derived.paths].sort(), [...new Set([...derived.presented, ...derived.toolTargets])].sort())
})

test('deriveTouchedFiles tolerates missing inputs and drops unresolvable relatives', () => {
  assert.deepEqual(deriveTouchedFiles(undefined, '/work/base'), {
    paths: new Set(),
    presented: new Set(),
    toolTargets: new Set(),
    cwdHints: new Set(),
  })
  const noCwd = deriveTouchedFiles(
    [
      { type: 'deliverables/presented', data: { files: [{ path: 'relative.md' }, { path: '/abs/keep.md' }] } },
      { type: 'tool/call', data: { arguments: JSON.stringify({ file_path: 'relative.js' }) } },
    ],
    undefined,
  )
  assert.deepEqual([...noCwd.presented], ['/abs/keep.md'])
  assert.equal(noCwd.toolTargets.size, 0)
  const relativeSessionCwd = deriveTouchedFiles([], 'relative/dir')
  assert.equal(relativeSessionCwd.cwdHints.size, 0)
  // The same file reached through two sources appears once.
  const deduped = deriveTouchedFiles(
    [
      { type: 'deliverables/presented', data: { files: [{ path: 'same.md' }] } },
      { type: 'tool/call', data: { arguments: JSON.stringify({ path: 'same.md' }) } },
    ],
    '/work/base',
  )
  assert.deepEqual([...deduped.paths], ['/work/base/same.md'])
})
