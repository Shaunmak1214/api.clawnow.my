import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { OperationRunner } from '../src/services/operation-runner.js'

test('config.write writes files into the instance state path', async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'clawnow-agent-'))
  const runner = new OperationRunner(
    {
      pullImage: async () => undefined,
      createContainer: async () => undefined,
      startContainer: async () => undefined,
      stopContainer: async () => undefined,
      restartContainer: async () => undefined,
      removeContainer: async () => undefined,
      exec: async () => ({ stdout: '', stderr: '' }),
      logs: async () => ({ stdout: '', stderr: '' }),
      inspect: async () => ({ stdout: '', stderr: '' }),
    } as never,
    {
      ensureInstancePath: async () => undefined,
      writeFiles: async ({ hostStatePath, files }: { hostStatePath: string; files: Array<{ relativePath: string; content: string }> }) => {
        for (const file of files) {
          const target = path.join(hostStatePath, file.relativePath)
          await import('node:fs/promises').then(({ mkdir, writeFile }) =>
            mkdir(path.dirname(target), { recursive: true }).then(() => writeFile(target, file.content, 'utf8')),
          )
        }
      },
    } as never,
  )

  await runner.run(
    {
      id: 'job-1',
      type: 'config.write',
      vmId: 'vm-1',
      instanceId: 'inst-1',
      payload: {
        instanceId: 'inst-1',
        hostStatePath: tempRoot,
        files: [
          {
            relativePath: 'state/openclaw.json',
            content: '{"ok":true}',
          },
        ],
      },
    },
    () => undefined,
  )

  const content = await readFile(path.join(tempRoot, 'state/openclaw.json'), 'utf8')
  assert.equal(content, '{"ok":true}')
})
