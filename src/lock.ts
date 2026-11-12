import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const POLL_MS = 200
// An apply waits at most 15 s for nginx's verdict, so a lock this old was left by a process that died holding it.
const STALE_MS = 60_000

// A rename onto a directory fails when it has entries, and every lock has its owner file.
function held(error: unknown): boolean {
  const { code } = error as NodeJS.ErrnoException

  return code === 'ENOTEMPTY' || code === 'EEXIST'
}

// Built aside then renamed into place, so a visible lock always has its owner inside and no rename can replace it.
function take(path: string, token: string): boolean {
  const draft = `${path}.${token}`

  mkdirSync(draft)
  writeFileSync(join(draft, 'owner'), token)

  try {
    renameSync(draft, path)

    return true
  }
  catch (error) {
    rmSync(draft, { recursive: true, force: true })

    if (!held(error))
      throw error

    return false
  }
}

function stale(path: string, staleMs: number): boolean {
  const stat = statSync(path, { throwIfNoEntry: false })

  return stat !== undefined && Date.now() - stat.mtimeMs > staleMs
}

export interface LockOptions {
  waiting?: () => void
  staleMs?: number
  // Test seams, run where another process can slip in while a stale lock is broken.
  beforeMove?: () => void
  beforeRestore?: () => void
}

// Moved aside first, which only one waiter wins; one found fresh once moved was taken in between, and goes back unless a newer lock took its place.
function breakStale(path: string, staleMs: number, { beforeMove, beforeRestore }: LockOptions) {
  const aside = `${path}.${randomUUID()}`

  beforeMove?.()

  try {
    renameSync(path, aside)
  }
  catch {
    return
  }

  if (!stale(aside, staleMs)) {
    beforeRestore?.()

    try {
      renameSync(aside, path)

      return
    }
    catch (error) {
      if (!held(error))
        throw error
    }
  }

  rmSync(aside, { recursive: true, force: true })
}

function owner(path: string): string | undefined {
  try {
    return readFileSync(join(path, 'owner'), 'utf8')
  }
  catch {
    return undefined
  }
}

// One apply at a time on a state dir, so no caller reads the verdict on another's files as its own. A directory works across processes and containers sharing the dir, where pids mean nothing.
export async function locked<T>(dir: string, work: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const { waiting, staleMs = STALE_MS } = options
  const path = join(dir, '.lock')
  const token = randomUUID()
  let told = false

  mkdirSync(dir, { recursive: true })

  while (!take(path, token)) {
    if (stale(path, staleMs)) {
      breakStale(path, staleMs, options)

      continue
    }

    if (!told) {
      told = true
      waiting?.()
    }

    await Bun.sleep(POLL_MS)
  }

  try {
    return await work()
  }
  finally {
    // A holder that overran the stale delay may have lost the lock to another, whose lock it must leave alone.
    if (owner(path) === token)
      rmSync(path, { recursive: true, force: true })
  }
}
