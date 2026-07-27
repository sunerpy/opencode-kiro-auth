import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../plugin/storage/sqlite.js'

const WORKER_COUNT = 5
const ITERATIONS_PER_WORKER = 20
const CHILD_TIMEOUT_MS = 60_000
const ACCOUNT_PREFIX = 'sqlite-stress-'

type WorkerReport = {
  readonly workerId: number
  readonly errorCount: number
  readonly errors: readonly string[]
}

type AccountRow = {
  readonly id: string
  readonly refresh_token: string
  readonly access_token: string
}

async function waitForFile(path: string): Promise<void> {
  const deadline = Date.now() + CHILD_TIMEOUT_MS
  while (!existsSync(path)) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for barrier: ${path}`)
    await Bun.sleep(5)
  }
}

function parseWorkerReport(json: string): WorkerReport {
  const value: unknown = JSON.parse(json)
  if (typeof value !== 'object' || value === null) throw new Error('Worker report is not an object')
  const workerId = Reflect.get(value, 'workerId')
  const errorCount = Reflect.get(value, 'errorCount')
  const errors = Reflect.get(value, 'errors')
  if (
    typeof workerId !== 'number' ||
    typeof errorCount !== 'number' ||
    !Array.isArray(errors) ||
    !errors.every((error) => typeof error === 'string')
  ) {
    throw new Error('Worker report has invalid fields')
  }
  return { workerId, errorCount, errors }
}

const workerSource = `
  import { existsSync, writeFileSync } from 'node:fs'
  import { join } from 'node:path'
  import { KiroDatabase } from './src/plugin/storage/sqlite.ts'

  const path = process.env.SHARED_DB_PATH
  const barrierDir = process.env.BARRIER_DIR
  const workerId = Number(process.env.WORKER_ID)
  if (!path || !barrierDir || !Number.isInteger(workerId)) throw new Error('Missing worker inputs')

  const readyPath = join(barrierDir, 'ready-' + workerId)
  const startPath = join(barrierDir, 'start')
  writeFileSync(readyPath, 'ready')
  const barrierDeadline = Date.now() + ${CHILD_TIMEOUT_MS}
  while (!existsSync(startPath)) {
    if (Date.now() >= barrierDeadline) throw new Error('Timed out waiting for worker start')
    await Bun.sleep(5)
  }

  const database = new KiroDatabase(path)
  const errors = []
  const recordFailure = (operation, error) => {
    const message = error instanceof Error ? error.message : String(error)
    errors.push(operation + ': ' + message)
  }

  try {
    for (let iteration = 0; iteration < ${ITERATIONS_PER_WORKER}; iteration++) {
      const id = '${ACCOUNT_PREFIX}' + (iteration % 4)
      const generation = workerId * 1000 + iteration
      const candidate = {
        id,
        email: id + '@example.com',
        authMethod: 'idc',
        region: 'us-east-1',
        refreshToken: 'r-' + id + '-g' + generation,
        accessToken: 'a-' + id + '-g' + generation,
        expiresAt: 1_000_000 + generation,
        rateLimitResetTime: 0,
        isHealthy: true,
        failCount: 0,
        usedCount: generation,
        limitCount: 10_000,
        lastSync: generation
      }

      try {
        if (iteration % 2 === 0) await database.upsertAccount(candidate)
        else await database.batchUpsertAccounts([candidate])
      } catch (error) {
        recordFailure('upsert-' + iteration, error)
      }

      if (iteration % 3 === 0) {
        try {
          await database.markAccountsUnhealthy([id], 'stress-' + workerId)
        } catch (error) {
          recordFailure('mark-' + iteration, error)
        }
      }

      try {
        await database.nextAssignmentIndex()
      } catch (error) {
        recordFailure('assignment-' + iteration, error)
      }
    }
  } finally {
    database.close()
  }

  console.log(JSON.stringify({ workerId, errorCount: errors.length, errors }))
`

describe('KiroDatabase five-process write stress', () => {
  test(
    'mixed runtime writes complete without crashes, errors, or torn token triples',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'kiro-sqlite-stress-'))
      const sharedPath = join(dir, 'kiro.db')
      const startPath = join(dir, 'start')

      try {
        const children = Array.from({ length: WORKER_COUNT }, (_, workerId) => {
          const child = Bun.spawn({
            cmd: [process.execPath, '-e', workerSource],
            cwd: process.cwd(),
            env: {
              ...process.env,
              BARRIER_DIR: dir,
              SHARED_DB_PATH: sharedPath,
              WORKER_ID: String(workerId),
              XDG_CONFIG_HOME: join(dir, `worker-home-${workerId}`)
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

        await Promise.all(
          Array.from({ length: WORKER_COUNT }, (_, workerId) =>
            waitForFile(join(dir, `ready-${workerId}`))
          )
        )
        writeFileSync(startPath, 'start')

        const reports = await Promise.all(
          children.map(async (child) => {
            const [exitCode, stderr, stdout] = await Promise.all([
              child.exitCode,
              child.stderr,
              child.stdout
            ])
            expect(exitCode).toBe(0)
            expect(stderr).toBe('')
            return parseWorkerReport(stdout.trim())
          })
        )

        expect(reports).toHaveLength(WORKER_COUNT)
        for (const report of reports) {
          expect(report.errorCount).toBe(0)
          expect(report.errors).toEqual([])
        }

        const verifier = createDatabase(sharedPath)
        const accountRows: AccountRow[] = verifier.getAccounts()
        const rows = accountRows.filter((row) => row.id.startsWith(ACCOUNT_PREFIX))
        verifier.close()

        expect(rows).toHaveLength(4)
        for (const row of rows) {
          const match = row.refresh_token.match(/^(r-(sqlite-stress-\d+)-g(\d+))$/)
          expect(match).not.toBeNull()
          if (!match) throw new Error(`Malformed refresh token: ${row.refresh_token}`)
          expect(row.access_token).toBe(`a-${match[2]}-g${match[3]}`)
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    },
    CHILD_TIMEOUT_MS + 10_000
  )
})
