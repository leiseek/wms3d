# Spike · M0a Docker 可行性（2026-11-12 PT）

## 结论
**部分可用**：Docker 官方静态二进制（29.9.3）+ 独立 docker-compose（v5.7.1）可以在本机运行，但**只能用 `host` / `none` 网络**——本机容器环境没有 iptables（apt 源不可达，装不上），dockerd 必须 `--iptables=false --ip6tables=false --bridge=none` 启动，默认 bridge 网络不可用。

| 检查 | 结果 |
|---|---|
| 下载 `download.docker.com/linux/static/stable/x86_64/docker-29.9.3.tgz` | ✅（https 可达） |
| dockerd 默认参数启动 | ❌ `userland-proxy-path` 未找到（PATH）；补 PATH 后因无 iptables 失败 |
| dockerd `--iptables=false --bridge=none` | ✅ overlayfs 存储、cgroup v2、buildkit 初始化成功 |
| `docker run --network none hello-world` | ✅ |
| `docker run --network host postgres:17` + `pg_isready` | ✅ 镜像可拉取，可接受连接 |
| 容器内访问外网（host 网络） | ✅ |
| `docker-compose version`（GitHub 发布的静态二进制） | ✅ v5.7.1 |

## 对计划的影响
- 部署路径 A（原生 systemd）仍是**主要已验证路径**（08 §5.1）。
- 路径 B（compose）可在 M6 做**有限验证**：用一个 `docker-compose.host.yml` 覆盖文件把所有服务改成 `network_mode: host`（端口不冲突即可），验证镜像构建、启动顺序、迁移、健康检查、备份容器；bridge 网络与端口映射仍无法在本机验证，交付报告如实说明。
- 二进制保存在 `/opt/tools/docker/`；复现：`bash scripts/docker-spike.sh`（需要 sudo，约 30 秒）。spike 结束后已停止 dockerd，不常驻（节省内存）。
