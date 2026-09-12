#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createFixtureServer } from '../tests/e2e/helpers/fixture-server.mjs';

/**
 * 独立启动本地 fixture 源站（默认 127.0.0.1:4170），供本地联调与手动验证。
 * 环境变量：FIXTURES_DIR（快照根目录，默认仓库内 fixtures/）、FIXTURE_SERVER_PORT。
 */

const fixturesDir = process.env.FIXTURES_DIR
  ? path.resolve(process.env.FIXTURES_DIR)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'fixtures');
const port = Number(process.env.FIXTURE_SERVER_PORT ?? 4170);

const server = createFixtureServer({ fixturesDir, port });
const { url } = await server.start();
console.log(`[fixture-server] serving ${fixturesDir}`);
console.log(`[fixture-server] listening on ${url}`);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    console.log(`[fixture-server] 收到 ${signal}，退出`);
    void server.stop().then(() => process.exit(0));
  });
}
