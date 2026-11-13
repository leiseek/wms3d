# ⚠️ 未在本机构建验证。多阶段：构建 admin 静态资源打进 Caddy 镜像（D38）。
FROM node:24-bookworm-slim AS admin
WORKDIR /app
RUN corepack enable
COPY . .
RUN pnpm install --frozen-lockfile --filter @wms3d/admin... && pnpm --filter @wms3d/admin build

FROM caddy:2
COPY --from=admin /app/apps/admin/dist /srv/admin
COPY infra/compose/Caddyfile /etc/caddy/Caddyfile
