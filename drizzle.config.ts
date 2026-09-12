import { defineConfig } from 'drizzle-kit';

// SQLite（开发 / 测试方言，ADR-0001）。生成：npm run db:generate
export default defineConfig({
  dialect: 'sqlite',
  schema: './src/db/schema/sqlite.ts',
  out: './drizzle/sqlite',
});
