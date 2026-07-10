// Bun test preload. Runs ONCE before any test module is evaluated.
//
// The `kiroDb` singleton in src/plugin/storage/sqlite.ts computes its DB_PATH
// from XDG_CONFIG_HOME at module-eval time. Point that at a throwaway temp dir
// BEFORE any test imports the singleton, so the suite never reads or writes the
// developer's real ~/.config/opencode/kiro.db.
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

if (!process.env.XDG_CONFIG_HOME || !process.env.XDG_CONFIG_HOME.includes('kiro-test-home-')) {
  process.env.XDG_CONFIG_HOME = mkdtempSync(join(tmpdir(), 'kiro-test-home-'))
}
