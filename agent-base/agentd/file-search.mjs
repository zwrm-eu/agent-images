import { lstat, readdir } from 'node:fs/promises'
import { resolve as pathResolve, extname, basename } from 'node:path'

export const MAX_FILE_SEARCH_RESULTS = 100
export const MAX_FILE_SEARCH_DIRS = 200

// Recursively searches workspace-relative paths without moving file contents
// across the CP-to-VM boundary. Traversal is deterministic and strictly
// bounded. A caller can provide a filename allowlist for another picker; an
// empty allowlist means every regular file is eligible for chat context.
export async function searchWorkspaceFiles(
  rootAbs,
  rootRel,
  query,
  extensions,
  basenames,
  {
    maxResults = MAX_FILE_SEARCH_RESULTS,
    maxDirs = MAX_FILE_SEARCH_DIRS,
    readDirectory = readdir,
  } = {},
) {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const allowedExtensions = new Set(extensions.split(',').filter(Boolean).map((value) => value.toLowerCase()))
  const allowedBasenames = new Set(basenames.split(',').filter(Boolean).map((value) => value.toLowerCase()))
  const allowAllFiles = allowedExtensions.size === 0 && allowedBasenames.size === 0
  const queue = [{ abs: rootAbs, rel: rootRel }]
  const entries = []
  let visited = 0
  while (queue.length > 0 && visited < maxDirs && entries.length < maxResults) {
    const dir = queue.shift()
    visited++
    let names
    try {
      names = await readDirectory(dir.abs)
    } catch (err) {
      // A missing/inaccessible root means the request itself failed. Nested
      // directories can disappear or lose access while a search is queued;
      // skip those without discarding results from the rest of the tree.
      if (dir.abs === rootAbs) throw err
      continue
    }
    for (const name of names.sort()) {
      try {
        const abs = pathResolve(dir.abs, name)
        const rel = dir.rel === '.' ? name : `${dir.rel.replace(/\/+$/, '')}/${name}`
        const st = await lstat(abs)
        if (st.isDirectory()) {
          if (!['.git', 'node_modules', '.cache'].includes(name) && visited + queue.length < maxDirs) {
            queue.push({ abs, rel })
          }
          continue
        }
        if (!st.isFile() || !rel.toLowerCase().includes(needle)) continue
        if (!allowAllFiles && !allowedExtensions.has(extname(name).toLowerCase()) && !allowedBasenames.has(basename(name).toLowerCase())) continue
        entries.push({ name, path: rel, type: 'file', size: st.size, modified: st.mtime.toISOString() })
        if (entries.length === maxResults) break
      } catch {
        // Concurrent delete or inaccessible entry — match non-recursive list.
      }
    }
  }
  return entries
}
