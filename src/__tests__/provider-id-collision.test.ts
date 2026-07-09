import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import pluginModule from '../index.js'

// Provider-id collision regression.
//
// This fork renamed the OpenCode provider id from the bare `kiro` to
// `kiro-auth` to avoid colliding with the upstream/native `kiro` provider.
// These tests are a source-level guard: if someone accidentally reverts the
// provider id back to `kiro`, they MUST go red. They read the raw source
// files (not the compiled/behavioural surface alone) so the guard catches a
// revert regardless of how the plugin is wired at runtime.

const testDir = dirname(fileURLToPath(import.meta.url))
const srcDir = join(testDir, '..')

function readSource(relativePath: string): string {
  return readFileSync(join(srcDir, relativePath), 'utf8')
}

describe('provider-id collision regression', () => {
  test('default export id is exactly kiro-auth (runtime surface)', () => {
    expect(pluginModule.id).toBe('kiro-auth')
    // Explicitly forbid the bare collision id at the runtime surface too.
    expect(pluginModule.id).not.toBe('kiro')
  })

  test('src/plugin.ts declares KIRO_PROVIDER_ID = kiro-auth and never bare kiro', () => {
    const source = readSource('plugin.ts')

    // The canonical constant must be present, quoted exactly as kiro-auth.
    expect(source).toContain("KIRO_PROVIDER_ID = 'kiro-auth'")

    // A revert to the bare id must fail this test. Match either quote style so
    // a reformatting cannot silently slip a bare id past the guard.
    expect(source).not.toContain("KIRO_PROVIDER_ID = 'kiro'")
    expect(source).not.toContain('KIRO_PROVIDER_ID = "kiro"')
  })

  test('src/index.ts default export registers the kiro-auth provider id', () => {
    const source = readSource('index.ts')

    // The default export must register id: 'kiro-auth'.
    expect(source).toContain("id: 'kiro-auth'")

    // And must not register the bare collision id (either quote style).
    expect(source).not.toContain("id: 'kiro'")
    expect(source).not.toContain('id: "kiro"')
  })
})
