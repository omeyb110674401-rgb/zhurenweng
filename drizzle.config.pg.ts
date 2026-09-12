import { defineConfig } from 'drizzle-kit';

// PostgreSQL（生产方言）。生成：npm run db:generate:pg
// 列名与类型与 sqlite schema 保持镜像，只使用双方言交集子集（JSON 存 TEXT）。
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema/postgres.ts',
  out: './drizzle/pg',
});
