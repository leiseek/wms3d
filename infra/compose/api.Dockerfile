# ⚠️ 未在本机构建验证。Node 24 原生剥离类型运行 TS 源码；workspace 包为符号链接（不在 node_modules 实体目录内）。
FROM node:24-bookworm-slim AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml tsconfig.base.json ./
COPY apps/api/package.json apps/api/
COPY packages/contracts/package.json packages/contracts/
COPY packages/domain/package.json packages/domain/
COPY packages/labels/package.json packages/labels/
RUN pnpm install --frozen-lockfile --prod --filter @wms3d/api... --config.confirmModulesPurge=false

FROM node:24-bookworm-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=deps /app ./
COPY apps/api/src apps/api/src
COPY packages/contracts/src packages/contracts/src
COPY packages/contracts/openapi.json packages/contracts/openapi.json
COPY packages/domain/src packages/domain/src
COPY packages/labels/src packages/labels/src
USER node
WORKDIR /app/apps/api
EXPOSE 3000
CMD ["node", "--experimental-strip-types", "src/main.ts"]
