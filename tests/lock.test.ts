import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs'
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
  }, () => heard++)
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

  expect(await locked(dir, async () => 'taken', undefined, 60_000)).toBe('taken')
})
