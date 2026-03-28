import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'

export class StorageManager {
  async ensureInstancePath(hostStatePath: string) {
    await mkdir(hostStatePath, { recursive: true })
    await mkdir(path.join(hostStatePath, 'state'), { recursive: true })
  }

  async writeFiles(input: {
    hostStatePath: string
    files: Array<{ relativePath: string; content: string }>
  }) {
    await this.ensureInstancePath(input.hostStatePath)

    for (const file of input.files) {
      const fullPath = path.join(input.hostStatePath, file.relativePath)
      await mkdir(path.dirname(fullPath), { recursive: true })
      await writeFile(fullPath, file.content, 'utf8')
    }
  }
}
