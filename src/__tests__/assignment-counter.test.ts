import { afterEach, describe, expect, test } from 'bun:test'
import Database from 'libsql'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createDatabase } from '../plugin/storage/sqlite.js'

const tempDirectories: string[] = []

function tempDatabasePath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kiro-assignment-counter-'))
  tempDirectories.push(dir)
  return join(dir, 'kiro.db')
}

afterEach(() => {
  for (const dir of tempDirectories.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('KiroDatabase assignment counter', () => {
  test('migration creates the plugin_meta table idempotently', () => {
    const path = tempDatabasePath()
    const database = createDatabase(path)
    const inspector = new Database(path)

    try {
      const table = inspector
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='plugin_meta'")
        .get()

      expect(table).toMatchObject({ name: 'plugin_meta' })
    } finally {
      inspector.close()
      database.close()
    }
  })

  test('one database returns zero-based increasing assignment indices', async () => {
    const database = createDatabase(tempDatabasePath())

    try {
      const values = [
        await database.nextAssignmentIndex(),
        await database.nextAssignmentIndex(),
        await database.nextAssignmentIndex()
      ]

      expect(values).toEqual([0, 1, 2])
    } finally {
      database.close()
    }
  })

  test('two database instances sharing one path return distinct interleaved indices', async () => {
    const path = tempDatabasePath()
    const first = createDatabase(path)
    const second = createDatabase(path)

    try {
      const values = [
        await first.nextAssignmentIndex(),
        await second.nextAssignmentIndex(),
        await first.nextAssignmentIndex(),
        await second.nextAssignmentIndex()
      ]

      expect(values).toEqual([0, 1, 2, 3])
      expect(new Set(values).size).toBe(values.length)
    } finally {
      first.close()
      second.close()
    }
  })
})
