#!/usr/bin/env node
/**
 * Lightweight repository privacy gate: scans tracked text files for credentials,
 * private keys and real-machine home paths. Synthetic fixture homes (`/home/u/`,
 * `/home/sessions/`, `/home/runner/`) are allowed; everything else is a finding.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' })
  .split('\0')
  .filter((file) => file !== '')
const skip = /\.(png|jpe?g|webp|gif|ico|zip|gz|tgz|zst|zstd|pdf)$/i
const patterns = [
  ['private key', /-----BEGIN (?:OPENSSH|RSA|EC|DSA) PRIVATE KEY-----/g],
  ['api token', /\b(?:ghp_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[A-Za-z0-9-]{10,})\b/g],
  ['assigned secret', /\b(?:DEEPSEEK_API_KEY|OPENAI_API_KEY|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN)\s*=\s*\S+/g],
  ['windows home', /[A-Za-z]:\\Users\\[^\\\s]+/g],
  ['real home path', /\/home\/(?!u(?:\/|$)|sessions(?:\/|$)|runner(?:\/|$))[A-Za-z0-9._-]+\//g],
]
const findings = []
for (const file of files) {
  if (skip.test(file)) continue
  const text = readFileSync(file, 'utf8')
  for (const [kind, pattern] of patterns) {
    for (const match of text.matchAll(pattern)) {
      findings.push({ file, kind, exce: match[0].slice(0, 120) })
    }
  }
}
if (findings.length === 0) {
  console.log('privacy-check: no credential, private-key or real-home findings')
  process.exit(0)
}
for (const finding of findings) {
  console.error(`privacy-check: ${finding.kind}: ${finding.file}: ${finding.exce}`)
}
process.exit(1)
