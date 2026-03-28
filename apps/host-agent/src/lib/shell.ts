import { spawn } from 'node:child_process'

export interface CommandResult {
  stdout: string
  stderr: string
}

export function runCommand(command: string, args: string[], options?: { cwd?: string; input?: string }): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options?.cwd,
      stdio: 'pipe',
    })

    let stdout = ''
    let stderr = ''

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString()
    })

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString()
    })

    child.on('error', reject)

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr })
        return
      }

      reject(new Error(`${command} ${args.join(' ')} failed with code ${code}: ${stderr || stdout}`))
    })

    if (options?.input) {
      child.stdin.write(options.input)
      child.stdin.end()
    }
  })
}
