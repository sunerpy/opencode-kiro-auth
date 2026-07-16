import { describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../plugin/storage/sqlite.js'

const WORKER_COUNT = 6
const CHILD_TIMEOUT_MS = 10_000

const childSource = `
  import { createDatabase } from './src/plugin/storage/sqlite.ts'

  const path = process.env.SHARED_DB_PATH
  const startAt = Number(process.env.START_AT)
  const openDelay = Number(process.env.OPEN_DELAY_MS)
  if (!path || !Number.isFinite(startAt) || !Number.isFinite(openDelay)) {
    throw new Error('Missing subprocess barrier inputs')
  }

  await Bun.sleep(openDelay)
  const database = createDatabase(path)
  try {
    while (Date.now() < startAt) await Bun.sleep(2)
    console.log(await database.nextAssignmentIndex())
  } finally {
    database.close()
  }
`

describe('KiroDatabase assignment counter across Bun processes', () => {
  test('barrier-started processes receive one contiguous set of distinct indices', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'kiro-assignment-subprocess-'))
    const sharedPath = join(dir, 'kiro.db')
    const startAt = Date.now() + 2_000

    try {
      createDatabase(sharedPath).close()
      const children = Array.from({ length: WORKER_COUNT }, (_, worker) => {
        const child = Bun.spawn({
          cmd: [process.execPath, '-e', childSource],
          cwd: process.cwd(),
          env: {
            ...process.env,
            OPEN_DELAY_MS: String(worker * 100),
            SHARED_DB_PATH: sharedPath,
            START_AT: String(startAt),
            XDG_CONFIG_HOME: join(dir, `worker-${worker}`)
          },
          stdout: 'pipe',
          stderr: 'pipe',
          timeout: CHILD_TIMEOUT_MS
        })

        return {
          exitCode: child.exited,
          stderr: new Response(child.stderr).text(),
          stdout: new Response(child.stdout).text()
        }
      })

      const values = await Promise.all(
        children.map(async (child) => {
          const [exitCode, stderr, stdout] = await Promise.all([
            child.exitCode,
            child.stderr,
            child.stdout
          ])
          if (exitCode !== 0) {
            throw new Error(`Assignment subprocess exited ${exitCode}: ${stderr.trim()}`)
          }

          const value = Number(stdout.trim())
          if (!Number.isInteger(value)) {
            throw new Error(`Assignment subprocess emitted a non-integer: ${stdout.trim()}`)
          }
          return value
        })
      )

      const sortedValues = [...values].sort((a, b) => a - b)
      expect(sortedValues).toEqual([0, 1, 2, 3, 4, 5])
      expect(new Set(values).size).toBe(WORKER_COUNT)

      const stableAccountIds = ['account-a', 'account-b', 'account-c']
      const derivedAccounts = sortedValues.map(
        (value) => stableAccountIds[value % stableAccountIds.length]
      )
      expect(derivedAccounts).toEqual([
        'account-a',
        'account-b',
        'account-c',
        'account-a',
        'account-b',
        'account-c'
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
