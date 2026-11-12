import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import { locked } from '../src/lock'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'devproxy-lock-'))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

test('runs one holder at a time, and the waiter hears it waits', async () => {
  const order: string[] = []
  let heard = 0
  const slow = locked(dir, async () => {
    order.push('a start')
    await Bun.sleep(300)
    order.push('a end')
  })

  await Bun.sleep(20)
  await locked(dir, async () => {
    order.push('b')
  }, { waiting: () => heard++ })
  await slow

  expect(order).toEqual(['a start', 'a end', 'b'])
  expect(heard).toBe(1)
})

test('releases the lock when the work throws', async () => {
  let thrown: unknown

  try {
    await locked(dir, async () => {
      throw new Error('boom')
    })
  }
  catch (error) {
    thrown = error
  }

  expect(thrown).toEqual(new Error('boom'))
  expect(await locked(dir, async () => 'free')).toBe('free')
})

test('breaks a lock left by a process that died holding it', async () => {
  const left = join(dir, '.lock')

  mkdirSync(left)
  utimesSync(left, new Date(Date.now() - 120_000), new Date(Date.now() - 120_000))

  expect(await locked(dir, async () => 'taken', { staleMs: 60_000 })).toBe('taken')
})

test('a restore meeting a lock taken meanwhile leaves it to its holder', async () => {
  const path = join(dir, '.lock')
  const old = new Date(Date.now() - 120_000)
  const order: string[] = []
  let other: Promise<void> | undefined

  mkdirSync(path)
  writeFileSync(join(path, 'owner'), 'dead')
  utimesSync(path, old, old)

  await locked(dir, async () => {
    order.push('mine')
  }, {
    staleMs: 60_000,
    // Another waiter broke the dead lock and took it between this one's check and its move, so the lock moved aside is fresh.
    beforeMove: () => {
      rmSync(path, { recursive: true })
      mkdirSync(path)
      writeFileSync(join(path, 'owner'), 'fresh')
    },
    // Meanwhile its holder found no lock to release, and a third caller took the free one.
    beforeRestore: () => {
      other = locked(dir, async () => {
        order.push('other start')
        await Bun.sleep(300)
        order.push('other end')
      })
    },
  })
  await other

  expect(order).toEqual(['other start', 'other end', 'mine'])
  expect(readdirSync(dir)).toEqual([])
})
