import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const POLL_MS = 200
// An apply waits at most 15 s for nginx's verdict, so a lock this old was left by a process that died holding it.
const STALE_MS = 60_000

function take(path: string, token: string): boolean {
  try {
    mkdirSync(path)
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      throw error

    return false
  }

  writeFileSync(join(path, 'owner'), token)

  return true
}

function stale(path: string, staleMs: number): boolean {
  const stat = statSync(path, { throwIfNoEntry: false })

  return stat !== undefined && Date.now() - stat.mtimeMs > staleMs
}

// Moved aside first, which only one waiter wins; one found fresh once moved was taken in between, and goes back.
function breakStale(path: string, staleMs: number) {
  const aside = `${path}.${randomUUID()}`

  try {
    renameSync(path, aside)
  }
  catch {
    return
  }

  if (stale(aside, staleMs))
    rmSync(aside, { recursive: true, force: true })
  else
    renameSync(aside, path)
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
export async function locked<T>(dir: string, work: () => Promise<T>, waiting?: () => void, staleMs = STALE_MS): Promise<T> {
  const path = join(dir, '.lock')
  const token = randomUUID()
  let told = false

  mkdirSync(dir, { recursive: true })

  while (!take(path, token)) {
    if (stale(path, staleMs)) {
      breakStale(path, staleMs)

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
