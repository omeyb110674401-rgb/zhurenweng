import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 本地 fixture 源站：按 `fixtures/<source>/<file>` 目录结构对外提供页面快照。
 * URL 映射：/<source>/<file> → <fixturesDir>/<source>/<file>
 * （拒绝路径穿越；文件缺失返回 404；.html/.json 返回对应 Content-Type。）
 *
 * E2E 场景用它替代真实官方源站；也可 `npm run fixtures` 独立启动用于本地联调。
 */

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

/**
 * @typedef {Object} FixtureServerOptions
 * @property {string} fixturesDir 快照根目录（一般是仓库内的 fixtures/）
 * @property {string} [host]
 * @property {number} [port] 默认 0 = 随机可用端口，适合并发测试
 *
 * @typedef {Object} FixtureServer
 * @property {() => Promise<{ port: number, url: string }>} start
 * @property {() => Promise<void>} stop
 */

/** @param {FixtureServerOptions} options @returns {FixtureServer} */
export function createFixtureServer({ fixturesDir, host = '127.0.0.1', port = 0 }) {
  const root = path.resolve(fixturesDir);
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
      const segments = decodeURIComponent(url.pathname)
        .split('/')
        .filter((segment) => segment.length > 0);
      if (segments.length === 0) {
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('zhurenweng fixture source server');
        return;
      }
      if (segments.some((segment) => segment === '.' || segment === '..')) {
        res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' });
        res.end('bad request');
        return;
      }
      const filePath = path.join(root, ...segments);
      const body = await readFile(filePath);
      const contentType = CONTENT_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';
      res.writeHead(200, { 'content-type': contentType });
      res.end(body);
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('fixture not found');
    }
  });

  return {
    start() {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => {
          server.removeListener('error', reject);
          const address = server.address();
          if (address === null || typeof address === 'string') {
            reject(new Error(`fixture 服务器监听异常：${String(address)}`));
            return;
          }
          resolve({ port: address.port, url: `http://${host}:${address.port}` });
        });
      });
    },
    stop() {
      return new Promise((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}
