import { expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { PLUGIN_VERSION } from '../version.js'

test('plugin version matches the package version', () => {
  const packageJson = JSON.parse(
    readFileSync(new URL('../../package.json', import.meta.url), 'utf8')
  ) as { version: string }

  expect(PLUGIN_VERSION).toBe(packageJson.version)
})
