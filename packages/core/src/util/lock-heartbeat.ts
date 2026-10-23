export * as LockHeartbeat from "./lock-heartbeat"

import os from "os"
import { readlinkSync } from "fs"

export const pidNamespace = (() => {
  if (process.platform !== "linux") return
  try {
    return readlinkSync("/proc/self/ns/pid")
  } catch {
    return
  }
})()

export function make(staleMs: number, now = () => performance.now()) {
  const seen = new Map<string, { signature: string; since: number }>()
  return (file: string, signature: string) => {
    const previous = seen.get(file)
    if (previous?.signature === signature) return now() - previous.since > staleMs
    // Wall-clock corrections can move file timestamps in either direction.
    // Only elapsed time without a heartbeat change establishes staleness.
    seen.set(file, { signature, since: now() })
    return false
  }
}

export function deadOwner(owner: unknown) {
  if (
    typeof owner !== "object" ||
    owner === null ||
    !("hostname" in owner) ||
    owner.hostname !== os.hostname() ||
    !("pid" in owner) ||
    typeof owner.pid !== "number" ||
    !Number.isSafeInteger(owner.pid) ||
    owner.pid <= 0
  )
    return false
  // PIDs from another container/namespace cannot be probed with process.kill.
  // Older metadata without this identity falls back to heartbeat observation.
  if (
    process.platform === "linux" &&
    (!pidNamespace || !("pidNamespace" in owner) || owner.pidNamespace !== pidNamespace)
  )
    return false
  try {
    process.kill(owner.pid, 0)
    return false
  } catch (error) {
    return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH"
  }
}
