import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { searchWorkspaceFiles } from '../file-search.mjs'

test('workspace search is deterministic, bounded, filtered, and skips dependency trees', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zwrm-file-search-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'src', 'chat'), { recursive: true })
  await mkdir(join(root, 'docs'), { recursive: true })
  await mkdir(join(root, 'node_modules'), { recursive: true })
  await writeFile(join(root, 'src', 'chat', 'Z.ts'), 'z')
  await writeFile(join(root, 'src', 'chat', 'A.ts'), 'a')
  await writeFile(join(root, 'src', 'chat', '00.bin'), 'unsupported')
  await writeFile(join(root, 'docs', 'readme'), 'docs')
  await writeFile(join(root, 'node_modules', 'chat.ts'), 'ignored')

  const chat = await searchWorkspaceFiles(root, '.', 'chat', '.ts', 'readme', { maxResults: 2 })
  assert.deepEqual(chat.map((entry) => entry.path), ['src/chat/A.ts', 'src/chat/Z.ts'])

  const extensionless = await searchWorkspaceFiles(root, '.', 'README', '.ts', 'readme')
  assert.deepEqual(extensionless.map((entry) => entry.path), ['docs/readme'])

  const everyFileType = await searchWorkspaceFiles(root, '.', 'chat', '', '')
  assert.deepEqual(everyFileType.map((entry) => entry.path), [
    'src/chat/00.bin',
    'src/chat/A.ts',
    'src/chat/Z.ts',
  ])
})

test('workspace search skips an unreadable nested directory but fails for an unreadable root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'zwrm-file-search-errors-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'gone'))
  await writeFile(join(root, 'match.txt'), 'ok')

  const readDirectory = async (dir) => {
    if (dir === join(root, 'gone')) throw new Error('directory disappeared')
    return readdir(dir)
  }
  const result = await searchWorkspaceFiles(root, '.', 'match', '', '', { readDirectory })
  assert.deepEqual(result.map((entry) => entry.path), ['match.txt'])

  await assert.rejects(
    searchWorkspaceFiles(root, '.', 'match', '', '', { readDirectory: async () => { throw new Error('root unavailable') } }),
    /root unavailable/,
  )
})
