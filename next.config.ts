import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // better-sqlite3 是原生模块，drizzle-orm 的迁移器在运行时读取 SQL 文件，
  // 二者都不能被打包进服务端 bundle，必须作为外部依赖在运行时 require。
  serverExternalPackages: ['better-sqlite3', 'drizzle-orm', 'pg'],
};

export default nextConfig;
