import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

// Pure fixture tests and non-TTY refusal only: never invokes the secret display path.
test('Preview connection handoff: field aliases, defaults, constraints and TTY protections', () => {
  const script = path.resolve(import.meta.dirname, 'preview_connection_config_test.py')
  const result = spawnSync('python3', [script], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 0, result.stderr || 'Python fixture regressions failed')
  assert.match(result.stderr, /Ran 7 tests/)
  assert.match(result.stderr, /OK/)
})
