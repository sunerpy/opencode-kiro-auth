#!/usr/bin/env node
/**
 * coverage-gate.mjs — Parse LCOV coverage report and exit 1 if below threshold.
 * Reads coverage/lcov.info, sums LF: (lines found) and LH: (lines hit),
 * computes total line coverage %, prints result, exits non-zero if < 90%.
 */

import fs from 'fs'
import path from 'path'

const coveragePath = path.join(process.cwd(), 'coverage', 'lcov.info')

if (!fs.existsSync(coveragePath)) {
  console.error(`❌ Coverage file not found: ${coveragePath}`)
  process.exit(1)
}

const content = fs.readFileSync(coveragePath, 'utf8')
const lines = content.split('\n')

let totalLF = 0
let totalLH = 0

for (const line of lines) {
  if (line.startsWith('LF:')) {
    totalLF += parseInt(line.slice(3), 10)
  } else if (line.startsWith('LH:')) {
    totalLH += parseInt(line.slice(3), 10)
  }
}

const coverage = totalLF === 0 ? 0 : Math.floor((100 * totalLH) / totalLF)
const threshold = 90

console.log(`Coverage: ${coverage}% (threshold ${threshold}%)`)

if (coverage < threshold) {
  console.error(
    `❌ Coverage ${coverage}% is below threshold ${threshold}%`
  )
  process.exit(1)
}

console.log(`✅ Coverage ${coverage}% meets threshold`)
process.exit(0)
