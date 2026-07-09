#!/usr/bin/env node
/**
 * Postbuild script: adds .js extensions to relative imports in dist/ files.
 * Fixes ESM compatibility for strict runtimes (Bun 1.3.13+, Node.js).
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'

const DIST_DIR = resolve(import.meta.dirname, '..', 'dist')

function walk(dir) {
  const results = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) {
      results.push(...walk(full))
    } else if (full.endsWith('.js') || full.endsWith('.d.ts')) {
      results.push(full)
    }
  }
  return results
}

// Match: from './foo' or from '../foo' (but NOT from './foo.js' or from 'zod')
const IMPORT_RE = /(from\s+['"])(\.[^'"]*?)(?<!\.[cm]?js)(['"])/g

function fixFile(filePath) {
  const original = readFileSync(filePath, 'utf-8')
  let changed = false

  const fixed = original.replace(IMPORT_RE, (match, prefix, specifier, suffix) => {
    if (specifier.endsWith('.js')) return match

    const dir = dirname(filePath)

    // Check if specifier points to a directory with index.js
    const asDir = resolve(dir, specifier)
    if (existsSync(join(asDir, 'index.js'))) {
      changed = true
      return `${prefix}${specifier}/index.js${suffix}`
    }

    // Check if specifier.js exists
    if (existsSync(resolve(dir, specifier + '.js'))) {
      changed = true
      return `${prefix}${specifier}.js${suffix}`
    }

    return match
  })

  if (changed) {
    writeFileSync(filePath, fixed, 'utf-8')
  }
  return changed
}

const files = walk(DIST_DIR)
let fixedCount = 0
for (const f of files) {
  if (fixFile(f)) fixedCount++
}
console.log(`fix-esm-imports: patched ${fixedCount}/${files.length} files in dist/`)
