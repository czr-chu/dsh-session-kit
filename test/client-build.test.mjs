import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const bundle = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const map = JSON.parse(readFileSync(new URL('../lib/client.js.map', import.meta.url), 'utf8'))
const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))

test('the committed client bundle uses the official closure-factory handoff', () => {
  assert.match(bundle, /^window\.__ModuleLoader__\.load\(\{/)
  assert.match(bundle, /id: "dsh-session-kit"/)
  assert.match(bundle, /factory: \(require\) => \{/)
  assert.match(bundle, /return module\.exports;/)
  assert.equal(manifest.exports['./client'], './lib/client.js')
})

test('the client bundle carries the CSS Modules style injection', () => {
  assert.match(bundle, /data-plugin-css/)
  assert.match(bundle, /tag\.dataset\.plugin = "dsh-session-kit"/)
  assert.equal(map.file, 'client.js')
  assert.ok(map.sources.includes('../src/client/index.js'))
})

test('the client artifact does not embed build-machine absolute paths', () => {
  const artifacts = [bundle, JSON.stringify(map.sources), ...(map.sourcesContent ?? [])]
  for (const text of artifacts) {
    assert.doesNotMatch(text, /\/home\/[A-Za-z0-9._-]+\//)
    assert.doesNotMatch(text, /[A-Za-z]:\\\\Users\\\\/i)
  }
})
