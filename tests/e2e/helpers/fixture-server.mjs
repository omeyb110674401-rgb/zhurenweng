import { createServer } from 'node:http';
import { existsSync } from 'node:fs';
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
  // 政府 CMS 常用扩展名（如生态环境部栏目内页 …/t20260914_1166201.shtml）：
  // 与 .html 同样按文本提供并做日期令牌替换
  '.shtml': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
};

const TEXT_EXTENSIONS = new Set(Object.keys(CONTENT_TYPES));

/**
 * 可选 WAF cookie 挑战（司法部站点真实行为）：源目录内放该标记文件即启用，
 * 挑战 cookie 名即标记文件名。见请求处理里的注释。
 */
const WAF_MARKER = 'waf-cookie-challenge';
const WAF_COOKIE = 'waf-cookie-challenge=ok';

/**
 * 可选「普通重定向」标记（司法部站点真实行为）：源目录内放该标记文件即启用。
 * 详情请求首包返回 302 + Location（同一路径加 ?redirected=1）且**不带** Set-Cookie
 * —— 与真实站点 http→https 的协议升级一致（实测：moj 列表里的详情链接是 http://，
 * 服务端 302 到 https 且无 cookie；带 CT6T/CT6TS 的是 https 首包）。
 * 抓取层必须区分「无 cookie 的普通重定向（要跟随）」与「带 cookie 的 WAF 挑战（要重放）」：
 * 把前者当成后者，该源全部详情会静默退化为列表层数据（截断标题、无正文、无截止日期）。
 */
const PLAIN_REDIRECT_MARKER = 'plain-redirect';
const REDIRECT_PARAM = 'redirected';

/**
 * 日期令牌：快照文件里的 {{DATE±N}} / {{CN_DATE±N}} 在服务时按「服务器启动时刻」
 * 替换为具体日期（N 天偏移）。锚定在启动时刻保证同一次测试运行内多次响应内容
 * 一致，使「征求意见中 / 已截止」状态与倒计时断言不随运行日期衰减。
 */
const DATE_TOKEN = /\{\{\s*(CN_)?DATE\s*([+-]\d+)?\s*\}\}/g;

/**
 * 毫秒时间戳令牌 {{EPOCH±N}}：替换为「当天 00:00 UTC」的毫秒时间戳。
 * 工业和信息化部列表用隐藏字段 `<span class="endtime">1792339200000</span>`
 * 承载截止日期（实测该站取当日 00:00 UTC），需要数值型令牌才能既表达相对日期
 * 又保持适配器的解析路径不变。
 */
const EPOCH_TOKEN = /\{\{\s*EPOCH\s*([+-]\d+)?\s*\}\}/g;

/** @param {string} text @param {Date} anchor @returns {string} */
function substituteDateTokens(text, anchor) {
  return text
    .replace(EPOCH_TOKEN, (_, offset) => {
      const date = new Date(anchor.getTime() + Number(offset ?? 0) * 24 * 60 * 60 * 1000);
      return String(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
    })
    .replace(DATE_TOKEN, (_, chinese, offset) => {
      const date = new Date(anchor.getTime() + Number(offset ?? 0) * 24 * 60 * 60 * 1000);
      if (chinese) {
        return `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
      }
      const month = String(date.getMonth() + 1).padStart(2, '0');
      const day = String(date.getDate()).padStart(2, '0');
      return `${date.getFullYear()}-${month}-${day}`;
    });
}

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
  /** 日期令牌锚点：start() 时固定，保证一次运行内响应一致 */
  let anchor = new Date();
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
      const basePath = path.join(root, ...segments);
      // 可选：模拟司法部站点的 WAF cookie 挑战（源目录内放 waf-cookie-challenge 标记文件）。
      // 命中标记时，**列表请求**（list.html / list.json）在未带 cookie 的条件下返回
      // 302 + Set-Cookie 且 Location 指回同一地址 —— 与真实站点一致；抓取层的
      // fetch.cookieChallenge 必须带该 cookie 重放才能拿到内容，否则整源抓取失败。
      // 仅挑战列表请求：详情请求与测试里的直接 fixture 读取保持无挑战，避免影响其他断言。
      if (
        existsSync(path.join(root, segments[0] ?? '', WAF_MARKER)) &&
        /\/list\.(html|json)$/.test(url.pathname) &&
        !(req.headers.cookie ?? '').includes(WAF_COOKIE)
      ) {
        res.writeHead(302, {
          location: url.toString(),
          'set-cookie': `${WAF_COOKIE}; Path=/`,
        });
        res.end();
        return;
      }
      // 可选：模拟「普通重定向」（源目录内放 plain-redirect 标记文件）。非列表请求
      // 首包返回 302 + Location（同路径加 ?redirected=1）且**不带** Set-Cookie ——
      // 对应真实站点 http→https 的协议升级（见 PLAIN_REDIRECT_MARKER 注释）。
      // 跟随一次后带 ?redirected=1 回到同一路径，返回正常内容。
      if (
        existsSync(path.join(root, segments[0] ?? '', PLAIN_REDIRECT_MARKER)) &&
        !/\/list\.(html|json)$/.test(url.pathname) &&
        !url.searchParams.has(REDIRECT_PARAM)
      ) {
        res.writeHead(302, { location: `${url.pathname}?${REDIRECT_PARAM}=1` });
        res.end();
        return;
      }
      // 目录式接口路径（真实站点以 …/flca/<id>/info/ 形式提供 JSON 数据）→
      // 目录下的 index.json / index.html；其余路径按文件精确匹配。
      const candidates = url.pathname.endsWith('/')
        ? [path.join(basePath, 'index.json'), path.join(basePath, 'index.html')]
        : [basePath];

      for (const filePath of candidates) {
        const ext = path.extname(filePath).toLowerCase();
        const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';
        try {
          if (TEXT_EXTENSIONS.has(ext)) {
            const body = substituteDateTokens(await readFile(filePath, 'utf8'), anchor);
            res.writeHead(200, { 'content-type': contentType });
            res.end(body);
            return;
          }
          const body = await readFile(filePath);
          res.writeHead(200, { 'content-type': contentType });
          res.end(body);
          return;
        } catch {
          // 该候选不存在：目录式路径继续试下一个，其余落到 404
        }
      }
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('fixture not found');
    } catch {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
      res.end('fixture not found');
    }
  });

  return {
    start() {
      return new Promise((resolve, reject) => {
        anchor = new Date();
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
