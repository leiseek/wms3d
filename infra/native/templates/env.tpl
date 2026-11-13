# wms3d API 运行配置（install.sh 首次安装生成，权限 600；重装不覆盖）。不要提交到 git。
NODE_ENV=production
HOST=127.0.0.1
PORT_API=@API_PORT@
DATABASE_URL=postgres://wms_app:@APP_PW@@127.0.0.1:@PG_PORT@/@DB@
MIGRATION_DATABASE_URL=postgres://wms_owner:@OWNER_PW@@127.0.0.1:@PG_PORT@/@DB@
WMS_MIGRATE_ON_START=1
JWT_SECRET=@JWT_SECRET@
JWT_KID=k1
# Caddy 在前：信任 X-Forwarded-For 取客户端 IP（登录限流按 IP）
TRUST_PROXY=1
# 夜间任务（对账/清理，ws-a2）
WMS_JOBS=1
