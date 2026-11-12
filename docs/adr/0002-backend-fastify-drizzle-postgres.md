# ADR-0002 · 后端：Fastify 5 + Zod 契约 + Drizzle ORM + PostgreSQL 17
- 状态：已接受 · v2 2026-11-12（锁定版本：fastify 5.12、fastify-type-provider-zod 7.0、@fastify/swagger 9.9、zod 4.6、drizzle-orm 0.45 / drizzle-kit 0.31；drizzle 1.0 仍为 RC，不追）

## 选项
- **NestJS + Prisma**：结构化强，但装饰器/DI 样板多；Prisma 2026-11 npm `latest` 为 8.0 RC（稳定线 7.x 即将过渡），且库存引擎需要大量手写 SQL（`ON CONFLICT ... RETURNING`、条件 UPDATE、`FOR UPDATE`、触发器），Prisma 在这些场景依赖 raw SQL。
- **Fastify + Drizzle（选）**：轻、快；`fastify-type-provider-zod` 让 contracts 中的 Zod schema 直接驱动校验与 OpenAPI；Drizzle SQL-first，事务/原子更新表达自然，迁移为纯 SQL 可审阅。
- Go/Java 后端：性能更好但失去前后端类型共享，不适合本团队形态。

## 决策
Fastify 5 + Zod 4 + Drizzle + PG17；模块化分层（routes/service/repo），库存写入唯一入口。PostgreSQL 必选（行级锁、部分索引、JSONB、触发器）。

## 后果
+ 契约单一真相；SQL 可控；容易写并发测试。
− 无 Nest 式模块化框架 → 用目录约定 + eslint-boundaries 约束。
