import { mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const POLL_MS = 200
// An apply waits at most 15 s for nginx's verdict, so a lock this old was left by a process that died holding it.
const STALE_MS = 60_000

function taken(path: string): boolean {
  try {
    mkdirSync(path)

    return true
  }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST')
      throw error

    return false
  }
}

function stale(path: string, staleMs: number): boolean {
  const stat = statSync(path, { throwIfNoEntry: false })

  return stat !== undefined && Date.now() - stat.mtimeMs > staleMs
}

// One apply at a time on a state dir, so no caller reads the verdict on another's files as its own. A directory works across processes and containers sharing the dir, where pids mean nothing.
export async function locked<T>(dir: string, work: () => Promise<T>, waiting?: () => void, staleMs = STALE_MS): Promise<T> {
  const path = join(dir, '.lock')
  let told = false

  mkdirSync(dir, { recursive: true })

  while (!taken(path)) {
    if (stale(path, staleMs)) {
      rmSync(path, { recursive: true, force: true })

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
    rmSync(path, { recursive: true, force: true })
  }
}
