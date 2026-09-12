import { createServer } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 进程内启动 Next.js 生产构建（要求先 `next build`），供 E2E 从 HTTP 层驱动整个应用。
 * ADR-0001：E2E 不依赖任何外部服务 —— 通过环境变量注入 SQLite 文件库与 stub 端口
 * （LLM_PROVIDER=stub、MAILER_PROVIDER=stub 等），注入值由调用方通过 env 传入。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * @typedef {Object} AppServerOptions
 * @property {Record<string, string>} [env] 注入给应用的环境变量（DATABASE_URL、LLM_PROVIDER 等）
 * @property {number} [port] 监听端口，默认 0 = 随机可用端口
 *
 * @typedef {Object} AppServer
 * @property {number} port
 * @property {string} url
 * @property {() => Promise<void>} stop
 */

/** @param {AppServerOptions} [options] @returns {Promise<AppServer>} */
export async function startAppServer({ env = {}, port = 0 } = {}) {
  // 生产模式运行自定义服务器（Next 官方支持的方式）
  process.env.NODE_ENV = 'production';
  process.env.DB_DRIVER ??= 'sqlite';
  Object.assign(process.env, env);

  const { default: next } = await import('next');
  const app = next({ dev: false, dir: repoRoot });
  await app.prepare();
  const handler = app.getRequestHandler();

  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error(`应用服务器监听异常：${String(address)}`);
  }

  return {
    port: address.port,
    url: `http://127.0.0.1:${address.port}`,
    async stop() {
      await new Promise((resolve) => server.close(() => resolve()));
      await app.close();
    },
  };
}
