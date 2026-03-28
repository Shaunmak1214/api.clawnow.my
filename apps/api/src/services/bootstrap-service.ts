import { randomUUID } from 'node:crypto'

import { env } from '../config/env.js'

const serviceUnit = `[Unit]
Description=ClawNow Host Agent
After=network-online.target docker.service
Wants=network-online.target docker.service

[Service]
Type=simple
EnvironmentFile=/etc/clawnow-host-agent.env
WorkingDirectory=/opt/clawnow-host-agent
ExecStart=/usr/bin/node /opt/clawnow-host-agent/host-agent.mjs
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
`

const instanceLoginScript = `#!/usr/bin/env bash
set -euo pipefail

if [[ -z "\${USER:-}" ]]; then
  echo "Unable to determine the SSH user."
  exit 1
fi

exec sudo /usr/local/bin/clawnow-instance-shell
`

const instanceShellScript = `#!/usr/bin/env bash
set -euo pipefail

if [[ -z "\${SUDO_USER:-}" ]]; then
  echo "Missing instance login context."
  exit 1
fi

mapping="/etc/clawnow-instance-users/\${SUDO_USER}.env"

if [[ ! -f "\${mapping}" ]]; then
  echo "No OpenClaw instance is attached to \${SUDO_USER} yet."
  exit 1
fi

# shellcheck source=/dev/null
source "\${mapping}"

if [[ -z "\${CONTAINER_NAME:-}" ]]; then
  echo "Container mapping is incomplete for \${SUDO_USER}."
  exit 1
fi

if ! docker ps --format '{{.Names}}' | grep -Fxq "\${CONTAINER_NAME}"; then
  echo "OpenClaw container \${CONTAINER_NAME} is not running."
  exit 1
fi

exec docker exec -it "\${CONTAINER_NAME}" /bin/sh
`

const sudoersRule = `%clawnow-instance-users ALL=(root) NOPASSWD: /usr/local/bin/clawnow-instance-shell
`

function shellQuote(value: string) {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

export class BootstrapService {
  createBootstrapToken() {
    return randomUUID()
  }

  buildCloudInit(input: {
    bootstrapToken: string
    hostname: string
    region: string
    sizeSlug: string
    maxInstances: number
  }) {
    const bundleUrl = `${env.PUBLIC_API_BASE_URL}/downloads/host-agent.mjs`
    const envFile = [
      `API_BASE_URL=${env.PUBLIC_API_BASE_URL}`,
      `AGENT_SHARED_SECRET=${env.AGENT_SHARED_SECRET}`,
      `BOOTSTRAP_TOKEN=${input.bootstrapToken}`,
      `HOSTNAME=${input.hostname}`,
      `REGION=${input.region}`,
      `SIZE_SLUG=${input.sizeSlug}`,
      `MAX_INSTANCES=${input.maxInstances}`,
      `AGENT_VERSION=0.1.0`,
      `POLLING_INTERVAL_MS=5000`,
    ].join('\n')

    return `#cloud-config
package_update: true
package_upgrade: false
write_files:
  - path: /etc/clawnow-host-agent.env
    permissions: '0600'
    content: |
${envFile
  .split('\n')
  .map((line) => `      ${line}`)
  .join('\n')}
  - path: /etc/systemd/system/clawnow-host-agent.service
    permissions: '0644'
    content: |
${serviceUnit
  .split('\n')
  .map((line) => `      ${line}`)
  .join('\n')}
  - path: /usr/local/bin/clawnow-instance-login
    permissions: '0755'
    content: |
${instanceLoginScript
  .split('\n')
  .map((line) => `      ${line}`)
  .join('\n')}
  - path: /usr/local/bin/clawnow-instance-shell
    permissions: '0755'
    content: |
${instanceShellScript
  .split('\n')
  .map((line) => `      ${line}`)
  .join('\n')}
  - path: /etc/sudoers.d/clawnow-instance-shell
    permissions: '0440'
    content: |
${sudoersRule
  .split('\n')
  .map((line) => `      ${line}`)
  .join('\n')}
runcmd:
  - apt-get update
  - apt-get install -y ca-certificates curl openssh-server sudo
  - mkdir -p /opt/clawnow-host-agent
  - mkdir -p /etc/clawnow-instance-users
  - getent group clawnow-instance-users >/dev/null || groupadd --system clawnow-instance-users
  - systemctl enable --now ssh
  - systemctl restart ssh
  - apt-get install -y docker.io nodejs
  - systemctl enable --now docker
  - curl -fsSL ${shellQuote(bundleUrl)} -o /opt/clawnow-host-agent/host-agent.mjs
  - chmod 755 /opt/clawnow-host-agent/host-agent.mjs
  - systemctl daemon-reload
  - systemctl enable --now clawnow-host-agent
`
  }
}
