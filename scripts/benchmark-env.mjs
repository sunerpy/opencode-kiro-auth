// Per-mode filesystem isolation for the account-distribution benchmark (dev
// tool — NOT shipped in dist). Owns building the throwaway config/data/project
// tree each mode runs against, so benchmark-distribution.mjs can focus on the
// worker fan-out and result aggregation. The real ~/.config/opencode tree is
// only ever READ (to locate kiro.db); it is never modified.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { buildModeConfig } from './benchmark-lib.mjs'

/** Resolve the real OpenCode config dir (the source of the shared kiro.db). */
export function realConfigDir() {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'opencode')
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'opencode')
}

/**
 * Seed one mode's isolated environment under `baseRoot` and return the paths the
 * parent needs to launch workers. `repoRoot` is this repository's root, written
 * into the project opencode.json so workers load THIS plugin (not the npm build).
 */
export function seedModeEnv(baseRoot, mode, sharedDbFiles, workerCount, repoRoot) {
  const modeRoot = join(baseRoot, `mode-${mode}`)
  const xdgConfig = join(modeRoot, 'config')
  const projectDir = join(modeRoot, 'project')

  // isolated OpenCode config home (kiro.db + kiro.json + logs live here). This
  // is the SHARED account DB seam every worker in this mode reads/writes.
  const opencodeConfigDir = join(xdgConfig, 'opencode')
  mkdirSync(opencodeConfigDir, { recursive: true })

  // Seed the shared account dataset (copy of the real kiro.db, incl. WAL) so
  // every mode starts from the same accounts without touching the real DB.
  for (const [name, src] of sharedDbFiles) {
    copyFileSync(src, join(opencodeConfigDir, name))
  }

  // User-level kiro.json carrying this mode's distribution flags.
  const modeConfig = buildModeConfig(mode)
  mkdirSync(join(opencodeConfigDir, 'kiro-auth-plugin'), { recursive: true })
  writeFileSync(
    join(opencodeConfigDir, 'kiro-auth-plugin', 'kiro.json'),
    `${JSON.stringify(modeConfig, null, 2)}\n`
  )

  // Per-worker data homes: OpenCode keeps its OWN workspace/session state DB in
  // XDG_DATA_HOME. Sharing one across concurrent servers deadlocks on that
  // internal DB, so each worker gets an isolated data home (each carries the
  // placeholder auth entry so OpenCode invokes the plugin loader). The shared
  // account DB stays in the single config home above.
  const workerDataDirs = []
  for (let w = 0; w < workerCount; w++) {
    const xdgData = join(modeRoot, `data-w${w}`)
    const opencodeDataDir = join(xdgData, 'opencode')
    mkdirSync(opencodeDataDir, { recursive: true })
    writeFileSync(
      join(opencodeDataDir, 'auth.json'),
      `${JSON.stringify({ 'kiro-auth': { type: 'api', key: 'benchmark-placeholder' } }, null, 2)}\n`
    )
    workerDataDirs.push(xdgData)
  }

  // Project dir: loads THIS repo's plugin + repeats the mode flags as project
  // config so the plugin's project-config merge path is exercised too.
  const dotOpencode = join(projectDir, '.opencode')
  mkdirSync(dotOpencode, { recursive: true })
  writeFileSync(
    join(projectDir, 'opencode.json'),
    `${JSON.stringify({ $schema: 'https://opencode.ai/config.json', plugin: [repoRoot] }, null, 2)}\n`
  )
  writeFileSync(join(dotOpencode, 'kiro.json'), `${JSON.stringify(modeConfig, null, 2)}\n`)

  return { xdgConfig, workerDataDirs, projectDir, opencodeConfigDir }
}
