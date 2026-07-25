import { readFileSync } from 'node:fs'

function readPluginVersion(): string {
  try {
    const packageJson = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8')
    ) as { version?: unknown }

    if (typeof packageJson.version === 'string' && packageJson.version.trim()) {
      return packageJson.version
    }
  } catch {
    // Keep authentication available if package metadata cannot be read.
  }

  return 'unknown'
}

export const PLUGIN_VERSION = readPluginVersion()
