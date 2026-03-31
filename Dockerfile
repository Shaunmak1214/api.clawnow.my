FROM node:22-bookworm-slim AS build

WORKDIR /app

COPY package*.json ./
COPY tsconfig.base.json ./
COPY apps/api/package*.json apps/api/
COPY packages/core/package*.json packages/core/

RUN npm install

COPY apps/api apps/api
COPY packages/core packages/core

RUN npm run build --workspace @clawnow/core
RUN npx prisma generate --schema apps/api/prisma/schema.prisma
RUN npm run build --workspace @clawnow/api

FROM node:22-bookworm-slim AS runner

WORKDIR /app

COPY --from=build /app/package*.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/apps/api ./apps/api
COPY --from=build /app/packages/core ./packages/core

ENV NODE_ENV=production
ENV HOST=0.0.0.0

CMD ["sh", "-c", "npx prisma db push --schema apps/api/prisma/schema.prisma && node apps/api/dist/apps/api/src/index.js"]
