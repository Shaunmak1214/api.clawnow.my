# ClawNow Platform

Monorepo for the ClawNow control plane and the Node.js host-agent.

## Apps

- `apps/api`: Fastify + Prisma control-plane API
- `apps/host-agent`: Node.js VM agent that polls the API and manages Docker
- `packages/core`: shared types, constants, and operation definitions

## Architecture

- `clawnow.my` talks to `api.clawnow.my`
- `api.clawnow.my` stores state, schedules work, and creates jobs
- each VM runs `host-agent`
- `host-agent` manages OpenClaw Docker containers on that VM
- each OpenClaw instance has its own persistent state path

## Quick Start

1. Copy env files:

```bash
cp apps/api/.env.example apps/api/.env
cp apps/host-agent/.env.example apps/host-agent/.env
```

2. Install dependencies:

```bash
npm install
```

3. Start infrastructure:

```bash
docker compose up -d
```

Local note: this repo uses non-generic host ports by default:

- API: `43180`
- Postgres: `45433`
- Redis: `46379`

4. Generate Prisma client:

```bash
npm run prisma:generate --workspace @clawnow/api
```

5. Run the API:

```bash
npm run build --workspace @clawnow/host-agent
npm run dev --workspace @clawnow/api
```

6. Run the host-agent:

```bash
npm run dev --workspace @clawnow/host-agent
```

## Notes

- The API uses a shared agent secret in v1 for agent authentication.
- The host-agent only runs allowlisted operations.
- The control plane models one active VM placement per OpenClaw instance plus full placement history.
- Real droplet bootstrap downloads the bundled host-agent from `/downloads/host-agent.mjs`, so build the host-agent before provisioning.
