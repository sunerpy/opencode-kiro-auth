import { afterEach, describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { isInteractiveTty, ttyConfirm, ttySelect, wrapIndex } from '../core/auth/tty-menu.js'

// tty-menu drives raw-mode stdin + ANSI stdout. We swap process.stdin/stdout
// for a minimal fake (EventEmitter + setRawMode/resume/pause) and feed key byte
// sequences via emit('data', <buffer>) — no real TTY, no blocking, no hanging.
// Every override is restored in afterEach.

const KEY = {
  up: Buffer.from('\x1b[A'),
  down: Buffer.from('\x1b[B'),
  enter: Buffer.from('\r'),
  ctrlC: Buffer.from('\x03'),
  esc: Buffer.from('\x1b')
}

class FakeStdin extends EventEmitter {
  isTTY = true
  isRaw = false
  rawModeCalls: boolean[] = []
  resumed = false
  paused = false
  setRawMode(v: boolean): this {
    this.isRaw = v
    this.rawModeCalls.push(v)
    return this
  }
  resume(): this {
    this.resumed = true
    return this
  }
  pause(): this {
    this.paused = true
    return this
  }
}

class FakeStdout {
  isTTY = true
  written: string[] = []
  write(s: string): boolean {
    this.written.push(s)
    return true
  }
}

const realStdin = process.stdin
const realStdout = process.stdout
let fakeStdin: FakeStdin
let fakeStdout: FakeStdout

function installFakeTty(): void {
  fakeStdin = new FakeStdin()
  fakeStdout = new FakeStdout()
  Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true })
  Object.defineProperty(process, 'stdout', { value: fakeStdout, configurable: true })
}

afterEach(() => {
  Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true })
  Object.defineProperty(process, 'stdout', { value: realStdout, configurable: true })
})

// Feed a sequence of key buffers to the menu, one per macrotask tick so the
// menu's synchronous 'data' handler processes each before the next arrives.
function feed(keys: Buffer[]): void {
  let i = 0
  const pump = (): void => {
    if (i >= keys.length) return
    const k = keys[i++]
    if (fakeStdin.listenerCount('data') > 0) {
      fakeStdin.emit('data', k)
    }
    setTimeout(pump, 0)
  }
  setTimeout(pump, 0)
}

describe('wrapIndex', () => {
  test('wraps within [0, length) including negative and overflow', () => {
    expect(wrapIndex(0, 3)).toBe(0)
    expect(wrapIndex(3, 3)).toBe(0)
    expect(wrapIndex(-1, 3)).toBe(2)
    expect(wrapIndex(4, 3)).toBe(1)
    expect(wrapIndex(5, 0)).toBe(0)
  })
})

describe('isInteractiveTty', () => {
  test('true only when both stdin and stdout are TTYs', () => {
    installFakeTty()
    fakeStdin.isTTY = true
    fakeStdout.isTTY = true
    expect(isInteractiveTty()).toBe(true)
  })

  test('false when stdout is not a TTY', () => {
    installFakeTty()
    fakeStdin.isTTY = true
    fakeStdout.isTTY = false
    expect(isInteractiveTty()).toBe(false)
  })

  test('false when stdin is not a TTY', () => {
    installFakeTty()
    fakeStdin.isTTY = false
    fakeStdout.isTTY = true
    expect(isInteractiveTty()).toBe(false)
  })
})

describe('ttySelect', () => {
  test('returns null immediately for an empty item list', async () => {
    installFakeTty()
    const result = await ttySelect([], { message: 'pick' })
    expect(result).toBeNull()
  })

  test('enter on the initial cursor resolves the first item', async () => {
    installFakeTty()
    feed([KEY.enter])
    const result = await ttySelect(
      [
        { label: 'Alpha', value: 'a' },
        { label: 'Beta', value: 'b' }
      ],
      { message: 'pick' }
    )
    expect(result).toBe('a')
    // Raw mode was turned on, then restored to the prior (false) value.
    expect(fakeStdin.rawModeCalls[0]).toBe(true)
    expect(fakeStdin.rawModeCalls[fakeStdin.rawModeCalls.length - 1]).toBe(false)
    expect(fakeStdin.paused).toBe(true)
  })

  test('down then enter selects the next item', async () => {
    installFakeTty()
    feed([KEY.down, KEY.enter])
    const result = await ttySelect(
      [
        { label: 'Alpha', value: 'a' },
        { label: 'Beta', value: 'b' },
        { label: 'Gamma', value: 'c' }
      ],
      { message: 'pick' }
    )
    expect(result).toBe('b')
  })

  test('up from the top wraps to the last item', async () => {
    installFakeTty()
    feed([KEY.up, KEY.enter])
    const result = await ttySelect(
      [
        { label: 'Alpha', value: 'a' },
        { label: 'Beta', value: 'b' },
        { label: 'Gamma', value: 'c' }
      ],
      { message: 'pick' }
    )
    expect(result).toBe('c')
  })

  test('ctrl-c cancels and resolves null', async () => {
    installFakeTty()
    feed([KEY.ctrlC])
    const result = await ttySelect([{ label: 'Alpha', value: 'a' }], { message: 'pick' })
    expect(result).toBeNull()
  })

  test('bare escape cancels after the escape timeout', async () => {
    installFakeTty()
    feed([KEY.esc])
    const result = await ttySelect([{ label: 'Alpha', value: 'a' }], { message: 'pick' })
    expect(result).toBeNull()
  })

  test('resolves null and never enters raw mode when setRawMode throws', async () => {
    installFakeTty()
    fakeStdin.setRawMode = () => {
      throw new Error('not a real tty')
    }
    const result = await ttySelect([{ label: 'Alpha', value: 'a' }], { message: 'pick' })
    expect(result).toBeNull()
  })
})

describe('ttyConfirm', () => {
  test('defaults the cursor to No, so an immediate enter resolves false', async () => {
    installFakeTty()
    feed([KEY.enter])
    const result = await ttyConfirm('Proceed?')
    expect(result).toBe(false)
  })

  test('down then enter selects Yes -> true', async () => {
    installFakeTty()
    feed([KEY.down, KEY.enter])
    const result = await ttyConfirm('Proceed?')
    expect(result).toBe(true)
  })

  test('cancel (ctrl-c) resolves false', async () => {
    installFakeTty()
    feed([KEY.ctrlC])
    const result = await ttyConfirm('Proceed?')
    expect(result).toBe(false)
  })
})
