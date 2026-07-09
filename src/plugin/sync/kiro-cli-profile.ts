import Database from 'libsql'
import { existsSync } from 'node:fs'
import { getCliDbPath, safeJsonParse } from './kiro-cli-parser'

export function readActiveProfileArnFromKiroCli(): string | undefined {
  const dbPath = getCliDbPath()
  if (!existsSync(dbPath)) return undefined

  let cliDb: InstanceType<typeof Database> | undefined
  try {
    cliDb = new Database(dbPath, { readonly: true })
    cliDb.pragma('busy_timeout = 5000')

    const row = cliDb
      .prepare('SELECT value FROM state WHERE key = ?')
      .get('api.codewhisperer.profile') as any
    const parsed = safeJsonParse(row?.value)
    const arn = parsed?.arn || parsed?.profileArn || parsed?.profile_arn
    return typeof arn === 'string' && arn.trim() ? arn.trim() : undefined
  } catch {
    return undefined
  } finally {
    try {
      cliDb?.close()
    } catch {
      // ignore
    }
  }
}
