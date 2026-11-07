import assert from 'node:assert/strict'
import test from 'node:test'
import { Config } from '../index.js'

const validate = (value) => Config['~standard'].validate(value)

test('Config accepts the documented deployment settings', () => {
  const result = validate({
    maxImportBytes: 1024,
    maxExportBytes: 2048,
    includeAttachments: false,
    includeWorkspaceFiles: true,
    includeSubagents: true,
    restoreWorkspaceFiles: true,
    workspaceExclude: ['node_modules', '.git'],
    workspaceMaxBytes: 4096,
    trashDir: '/tmp/session-kit-trash',
    defaultMode: 'full',
  })
  assert.equal(result.issues, undefined)
})

test('Config accepts an empty or absent config', () => {
  assert.equal(validate(undefined).issues, undefined)
  assert.equal(validate({}).issues, undefined)
})

test('Config rejects unknown keys and the internal modules seam', () => {
  for (const key of ['unknown', 'modules']) {
    const result = validate({ [key]: {} })
    assert.ok(Array.isArray(result.issues), key)
    assert.match(result.issues[0].message, /unknown config key/)
  }
})

test('Config rejects wrong types and invalid ranges', () => {
  const cases = [
    { maxImportBytes: '1' },
    { maxExportBytes: 0 },
    { includeAttachments: 1 },
    { workspaceExclude: ['ok', ''] },
    { trashDir: '  ' },
    { defaultMode: 'partial' },
  ]
  for (const value of cases) {
    const result = validate(value)
    assert.ok(Array.isArray(result.issues), JSON.stringify(value))
  }
})
