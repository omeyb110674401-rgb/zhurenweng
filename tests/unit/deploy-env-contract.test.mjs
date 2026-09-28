import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { createLlmPort, createMailerPort } from '../../src/lib/ports.ts';
import { llmReady } from '../../src/lib/llm-availability.ts';
import { mailerReady } from '../../src/lib/mailer-availability.ts';
import { resolveSmtpOptions } from '../../src/lib/adapters/smtp-mailer.ts';
import { attachmentMode } from '../../src/lib/attachment-mode.ts';

/**
 * 单元：部署环境变量契约（compose ↔ .env.example ↔ docs ↔ 代码）。
 *
 * 背景（2026-09-20 线上核查发现）：docker-compose.yml 给 web / worker 传的是
 * `LLM_API_KEY`，而 .env.example 与 docs/deploy.md 让操作者填的是 `GLM_API_KEY`，
 * 代码读的也是 `GLM_API_KEY`（adapters/glm-llm.ts、lib/llm-availability.ts）。
 * 于是 `.env` 里填了 Key 也到不了容器 —— AI 摘要永远停在「暂未启用」，而且看不出
 * 原因。这类「配置洞」不报错、只静默失效，必须由测试钉死；同一批还有第二类：
 * compose 用 `${VAR:-}` 把「未设置」传成**空串**，代码若按 `!== undefined` 判空
 * 就会把空串当有效配置（SMTP 端口变 0、TLS 推断被覆盖）。
 *
 * 六条不变量：
 * 1. 无幽灵旋钮：compose 引用的每个 ${VAR} 都在 .env.example 里声明（否则操作者
 *    无从填写，只能靠猜）；
 * 2. 无断线旋钮：.env.example 声明的每个变量都被 compose 传进容器（否则「填了就
 *    生效」是假承诺）；
 * 3. 两个常驻服务都拿到端口配置：web（订阅确认信 / 摘要门控）与 worker（摘要生成 /
 *    截止提醒）都必须同时具备 LLM、SMTP、检索的全套变量；
 * 4. 文档不指向不存在的旋钮：docs/deploy.md 里点名的变量都在 .env.example 里；
 * 5. 门控与端口同口径：llmReady / mailerReady 说「可用」时端口必须真能构造，
 *    说「不可用」时必须真构造失败 —— 界面状态不得撒谎；
 * 6. compose 传空串 = 未配置：SMTP 端口 / TLS 走默认（465 直连），非法端口与
 *    半套凭据在构造期就报错，而不是等到发信时才炸。
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

function read(relPath) {
  return fs.readFileSync(path.join(repoRoot, relPath), 'utf8');
}

const composeText = read('docker-compose.yml');
const envExampleText = read('.env.example');
const deployDocText = read('docs/deploy.md');

/** compose 里被引用的变量名（`${VAR}` / `${VAR:-default}`）。 */
function referencedVars(text) {
  return new Set([...text.matchAll(/\$\{([A-Z][A-Z0-9_]*)/g)].map((m) => m[1]));
}

/** .env.example 声明的变量名（行首 `VAR=`）。 */
function declaredVars(text) {
  return new Set([...text.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((m) => m[1]));
}

/** 文档里点名（反引号包裹）的变量名。 */
function documentedVars(text) {
  return new Set([...text.matchAll(/`([A-Z][A-Z0-9_]{2,})`/g)].map((m) => m[1]));
}

/**
 * 按服务解析 compose 的 `environment` 键（含字面量与 ${VAR} 引用，二者都要算：
 * `LLM_PROVIDER: glm` 与 `GLM_API_KEY: ${GLM_API_KEY:-}` 都是容器实际拿到的键）。
 */
function serviceEnvKeys(text) {
  const services = new Map();
  let inServices = false;
  let inEnvironment = false;
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.trim().startsWith('#')) continue;
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      current = null;
      continue;
    }
    if (/^[A-Za-z]/.test(line)) {
      // 顶层键（services: / volumes:）—— 离开 services 块
      inServices = false;
      current = null;
      continue;
    }
    if (!inServices) continue;
    const service = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(line);
    if (service) {
      current = service[1];
      services.set(current, new Set());
      inEnvironment = false;
      continue;
    }
    if (!current) continue;
    if (/^ {4}environment:\s*$/.test(line)) {
      inEnvironment = true;
      continue;
    }
    if (!inEnvironment) continue;
    const key = /^ {6}([A-Z][A-Z0-9_]*):/.exec(line);
    if (key) services.get(current).add(key[1]);
    else if (/^ {4}\S/.test(line)) inEnvironment = false;
  }
  return services;
}

const composeVars = referencedVars(composeText);
const envVars = declaredVars(envExampleText);
const services = serviceEnvKeys(composeText);

/**
 * 按服务解析 `build.args` 里**被转发的变量名**（issue #84）。
 *
 * 为什么需要它：上面两条不变量查的是"compose 里出现过 ${VAR}"，而 compose 里 NPM_REGISTRY
 * 出现在 web 与 worker 两个 `build.args` 里 —— 只要还有一个在转发，全集检查就照样为绿，
 * 而实际后果是一个镜像照旧从被限速的源拉依赖（"改了没反应"的幽灵旋钮那一族）。
 * 判据必须是**引用形式**（`${NPM_REGISTRY…}`）而不是"键出现过"：写成字面量同样到不了 .env。
 */
function serviceBuildVars(text) {
  const result = new Map();
  let inServices = false;
  let current = null;
  let inBuild = false;
  let inArgs = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (line.trim().startsWith('#')) continue;
    if (/^services:\s*$/.test(line)) {
      inServices = true;
      current = null;
      continue;
    }
    if (/^[A-Za-z]/.test(line)) {
      inServices = false;
      current = null;
      continue;
    }
    if (!inServices) continue;
    const service = /^ {2}([a-z][a-z0-9_-]*):\s*$/.exec(line);
    if (service) {
      current = service[1];
      result.set(current, new Set());
      inBuild = false;
      inArgs = false;
      continue;
    }
    if (!current) continue;
    if (/^ {4}build:\s*$/.test(line)) {
      inBuild = true;
      continue;
    }
    if (/^ {4}\S/.test(line)) {
      inBuild = false;
      inArgs = false;
      continue;
    }
    if (!inBuild) continue;
    if (/^ {6}args:\s*$/.test(line)) {
      inArgs = true;
      continue;
    }
    if (!inArgs) continue;
    const arg = /^ {8}([A-Z][A-Z0-9_]*):\s*(.+)$/.exec(line);
    if (arg && /\$\{/.test(arg[2])) result.get(current).add(arg[1]);
  }
  return result;
}

const buildVars = serviceBuildVars(composeText);

/** web 与 worker 都需要的端口配置（少一个就在那个容器里静默失效）。 */
const SHARED_PORT_KEYS = [
  'GLM_API_KEY',
  'GLM_API_BASE',
  'GLM_MODEL',
  'LLM_API_KEY',
  'LLM_API_BASE',
  'LLM_MODEL',
  'LLM_EXTRA_HEADERS',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'SMTP_SECURE',
  'MAIL_FROM',
  'MEILI_URL',
  'MEILI_MASTER_KEY',
];

const ENV_KEYS = [
  'LLM_PROVIDER',
  'GLM_API_KEY',
  'LLM_API_KEY',
  'LLM_API_BASE',
  'LLM_MODEL',
  'LLM_EXTRA_HEADERS',
  'MAILER_PROVIDER',
  'SMTP_HOST',
  'SMTP_PORT',
  'SMTP_USER',
  'SMTP_PASS',
  'MAIL_FROM',
];

/** 在给定环境变量下执行，结束后精确还原（不污染同进程其它用例）。 */
function withEnv(overrides, fn) {
  const saved = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  try {
    for (const key of ENV_KEYS) delete process.env[key];
    for (const [key, value] of Object.entries(overrides)) {
      if (value !== undefined) process.env[key] = value;
    }
    return fn();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function canConstruct(fn) {
  try {
    fn();
    return true;
  } catch {
    return false;
  }
}

describe('部署环境变量契约（compose ↔ .env.example ↔ docs ↔ 代码）', () => {
  it('无幽灵旋钮：compose 引用的变量都在 .env.example 里声明', () => {
    const phantom = [...composeVars].filter((name) => !envVars.has(name));
    assert.deepEqual(
      phantom,
      [],
      `compose 引用了 .env.example 未声明的变量（操作者无从填写）：${phantom.join(', ')}`,
    );
  });

  it('无断线旋钮：.env.example 声明的变量都被 compose 传进容器', () => {
    const unplumbed = [...envVars].filter((name) => !composeVars.has(name));
    assert.deepEqual(
      unplumbed,
      [],
      `这些变量填了也到不了容器（「填了就生效」是假承诺）：${unplumbed.join(', ')}`,
    );
  });

  it('issue #83 的七个旋钮真的接上了（此前文档承诺可调、compose 一个都不传）', () => {
    // 2026-09-26 实测：这七个在代码里有缺省、在 README / FOLLOWUPS 里被当成可调项，
    // 而 `docker compose` 一个都不转发 —— 照文档改 `.env` 再重启，行为毫无变化、
    // 也没有任何地方报错。这条按"旋钮 → 该去哪个服务"逐条钉住转发关系：
    // 少一个都会让"填了就生效"重新变成假话（上面两条不变量查的是全集，查不出这种单点丢失）。
    const expected = {
      web: ['LIST_PAGE_SIZE', 'SEARCH_PAGE_SIZE'],
      worker: [
        'SUMMARY_MAX_RETRIES',
        'SUMMARY_RETRY_DELAY_MS',
        'ATTACHMENT_MAX_ATTEMPTS',
        'ATTACHMENT_NOTICES_PER_ROUND',
        'ATTACHMENT_PROBE_BYTES',
      ],
    };
    for (const [service, keys] of Object.entries(expected)) {
      const actual = services.get(service);
      assert.ok(actual, `compose 应有 ${service} 服务`);
      for (const key of keys) {
        assert.ok(actual.has(key), `${service} 没拿到 ${key}：文档说它可调，实际改了不生效`);
        assert.ok(envVars.has(key), `${key} 未在 .env.example 声明（操作者无从填写）`);
      }
    }
  });

  it('issue #84：构建期参数按服务逐条转发（少一个服务 = 那个镜像照旧走官方源）', () => {
    // NPM_REGISTRY 只影响构建期（依赖层从哪个 npm 源下载），不传进容器 —— 所以它不在
    // services（environment）里，上面那几条查不到它。生产实测官方源被限速到 ~140 KB/s
    // （一次 npm ci 半小时跑不完，表现是"构建卡死"），镜像源快两个数量级；而两个服务
    // 各自 COPY package.json + npm ci，任何一处没转发，那个镜像就仍旧拉不动。
    for (const service of ['web', 'worker']) {
      const keys = buildVars.get(service);
      assert.ok(keys, `compose 的 ${service} 应有 build 段`);
      assert.ok(
        keys.has('NPM_REGISTRY'),
        `${service} 的 build.args 没转发 \${NPM_REGISTRY}：在那台机器上构建会卡在 npm ci`,
      );
      assert.ok(envVars.has('NPM_REGISTRY'), 'NPM_REGISTRY 未在 .env.example 声明（操作者无从填写）');
    }
  });

  it('web 与 worker 都拿到 LLM / SMTP / 检索全套配置', () => {
    for (const service of ['web', 'worker']) {
      const keys = services.get(service);
      assert.ok(keys, `compose 应有 ${service} 服务`);
      const missing = SHARED_PORT_KEYS.filter((key) => !keys.has(key));
      assert.deepEqual(
        missing,
        [],
        `${service} 缺少配置，对应能力会在该容器内静默失效：${missing.join(', ')}`,
      );
    }
  });

  it('docs/deploy.md 点名的变量都在 .env.example 里（文档不指向不存在的旋钮）', () => {
    const missing = [...documentedVars(deployDocText)].filter((name) => !envVars.has(name));
    assert.deepEqual(missing, [], `部署手册提到但模板里没有的变量：${missing.join(', ')}`);
  });

  it('门控与端口同口径：llmReady 的判定必须与 LLM 端口能否构造一致', () => {
    const cases = [
      { env: { LLM_PROVIDER: 'stub' }, ready: true, label: '本地 stub（无需 Key）' },
      { env: { LLM_PROVIDER: 'glm', GLM_API_KEY: 'dummy-key' }, ready: true, label: 'glm + Key' },
      { env: { LLM_PROVIDER: 'glm', GLM_API_KEY: '' }, ready: false, label: 'glm 缺 Key' },
      { env: { LLM_PROVIDER: 'glm' }, ready: false, label: 'glm 未设置 Key' },
      { env: { LLM_PROVIDER: 'glm', GLM_API_KEY: '   ' }, ready: false, label: 'glm Key 只有空白' },
      { env: { LLM_PROVIDER: 'GLM', GLM_API_KEY: 'dummy-key' }, ready: false, label: 'provider 名拼错' },
      // 通用 OpenAI 兼容端点（issue #25）：三项都必填 —— 缺一项就不该对外说「可用」
      {
        env: {
          LLM_PROVIDER: 'openai',
          LLM_API_KEY: 'dummy-key',
          LLM_API_BASE: 'https://example.invalid/v1',
          LLM_MODEL: 'some-flash-model',
        },
        ready: true,
        label: 'openai 三项齐全',
      },
      {
        env: { LLM_PROVIDER: 'openai', LLM_API_KEY: 'dummy-key', LLM_API_BASE: 'https://example.invalid/v1' },
        ready: false,
        label: 'openai 缺 LLM_MODEL',
      },
      {
        env: { LLM_PROVIDER: 'openai', LLM_API_KEY: 'dummy-key', LLM_MODEL: 'm' },
        ready: false,
        label: 'openai 缺 LLM_API_BASE',
      },
      {
        env: { LLM_PROVIDER: 'openai', LLM_API_BASE: 'https://example.invalid/v1', LLM_MODEL: 'm' },
        ready: false,
        label: 'openai 缺 LLM_API_KEY',
      },
      {
        env: {
          LLM_PROVIDER: 'openai',
          LLM_API_KEY: 'dummy-key',
          LLM_API_BASE: 'https://example.invalid/v1',
          LLM_MODEL: 'm',
          LLM_EXTRA_HEADERS: '不是 JSON',
        },
        ready: false,
        label: 'openai 额外请求头不是合法 JSON（构造期就该失败，别等到调用）',
      },
      { env: {}, ready: true, label: '未设置 provider（默认 stub）' },
    ];
    for (const item of cases) {
      withEnv(item.env, () => {
        const ready = llmReady();
        const constructible = canConstruct(() => createLlmPort());
        assert.equal(ready, item.ready, `${item.label}：门控判定`);
        assert.equal(
          constructible,
          ready,
          `${item.label}：门控说可用但端口构造失败（界面在撒谎），或反之（功能被无谓隐藏）`,
        );
      });
    }
  });

  it('门控与端口同口径：mailerReady 的判定必须与邮件端口能否构造一致', () => {
    const cases = [
      { env: { MAILER_PROVIDER: 'stub' }, ready: true, label: '本地 stub（无需 SMTP）' },
      {
        env: { MAILER_PROVIDER: 'smtp', SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'no-reply@example.com' },
        ready: true,
        label: 'smtp 配置齐全',
      },
      { env: { MAILER_PROVIDER: 'smtp', SMTP_HOST: '', MAIL_FROM: 'no-reply@example.com' }, ready: false, label: 'smtp 缺 HOST（compose 空串）' },
      { env: { MAILER_PROVIDER: 'smtp', SMTP_HOST: 'smtp.example.com', MAIL_FROM: '' }, ready: false, label: 'smtp 缺 MAIL_FROM' },
      { env: { MAILER_PROVIDER: 'smtp', SMTP_HOST: '   ', MAIL_FROM: 'no-reply@example.com' }, ready: false, label: 'HOST 只有空白' },
      { env: {}, ready: true, label: '未设置 provider（默认 stub）' },
    ];
    for (const item of cases) {
      withEnv(item.env, () => {
        const ready = mailerReady();
        const constructible = canConstruct(() => createMailerPort());
        assert.equal(ready, item.ready, `${item.label}：门控判定`);
        assert.equal(
          constructible,
          ready,
          `${item.label}：门控说可用但端口构造失败（界面在撒谎），或反之（功能被无谓隐藏）`,
        );
      });
    }
  });

  it('compose 传空串 = 未配置：SMTP 端口与 TLS 走默认（465 直连）', () => {
    // 回归：曾按 `!== undefined` 判空，空串使端口变成 0、secure 被覆盖成 false
    const base = { SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'no-reply@example.com' };
    const noAuth = { user: undefined, pass: undefined };
    assert.deepEqual(
      resolveSmtpOptions({ ...base, SMTP_PORT: '', SMTP_SECURE: '', SMTP_USER: '', SMTP_PASS: '' }),
      { host: 'smtp.example.com', from: 'no-reply@example.com', port: 465, secure: true, ...noAuth },
      '空串应按未配置处理：465 + 隐式 TLS，且不启用认证',
    );
    assert.deepEqual(
      resolveSmtpOptions(base),
      { host: 'smtp.example.com', from: 'no-reply@example.com', port: 465, secure: true, ...noAuth },
      '完全未设置 SMTP_PORT / SMTP_SECURE 时同样走默认',
    );
    assert.deepEqual(
      resolveSmtpOptions({ ...base, SMTP_PORT: '587' }),
      { host: 'smtp.example.com', from: 'no-reply@example.com', port: 587, secure: false, ...noAuth },
      '非 465 端口按 STARTTLS 处理（secure=false）',
    );
    assert.deepEqual(
      resolveSmtpOptions({ ...base, SMTP_PORT: '587', SMTP_SECURE: '1' }),
      { host: 'smtp.example.com', from: 'no-reply@example.com', port: 587, secure: true, ...noAuth },
      'SMTP_SECURE=1 显式覆盖端口推断',
    );
    assert.deepEqual(
      resolveSmtpOptions({ ...base, SMTP_USER: 'bot@example.com', SMTP_PASS: 'secret' }),
      {
        host: 'smtp.example.com',
        from: 'no-reply@example.com',
        port: 465,
        secure: true,
        user: 'bot@example.com',
        pass: 'secret',
      },
      '凭据齐全时启用认证',
    );
  });

  it('配置错误在构造期就说清楚：非法端口与半套凭据', () => {
    const base = { SMTP_HOST: 'smtp.example.com', MAIL_FROM: 'no-reply@example.com' };
    assert.throws(() => resolveSmtpOptions({ ...base, SMTP_PORT: 'abc' }), /SMTP_PORT 不是合法端口/);
    assert.throws(() => resolveSmtpOptions({ ...base, SMTP_PORT: '0' }), /SMTP_PORT 不是合法端口/);
    assert.throws(() => resolveSmtpOptions({ ...base, SMTP_PORT: '70000' }), /SMTP_PORT 不是合法端口/);
    // SMTP_SECURE=true 是**最顺手**的写法（.env.example 曾这么写、生产 .env 里就躺着一条），
    // 但它按旧实现会被解析成 STARTTLS —— 对着 465 隐式 TLS 端口发 STARTTLS 必失败，
    // 且只在真正发信那一刻才炸。现在构造期就拒绝，并给出可执行的改法。
    assert.throws(
      () => resolveSmtpOptions({ ...base, SMTP_SECURE: 'true' }),
      /SMTP_SECURE 只能填 1（隐式 TLS 直连）或 0（STARTTLS）/,
    );
    assert.deepEqual(
      resolveSmtpOptions({ ...base, SMTP_SECURE: '0' }),
      {
        host: 'smtp.example.com',
        from: 'no-reply@example.com',
        port: 465,
        secure: false,
        user: undefined,
        pass: undefined,
      },
      'SMTP_SECURE=0 显式关闭直连（STARTTLS 端口用）',
    );
    assert.throws(
      () => resolveSmtpOptions({ ...base, SMTP_USER: 'bot@example.com' }),
      /SMTP_USER 与 SMTP_PASS 必须同时配置/,
    );
    assert.throws(
      () => resolveSmtpOptions({ ...base, SMTP_PASS: 'secret' }),
      /SMTP_USER 与 SMTP_PASS 必须同时配置/,
    );
  });
});

/** compose 里某个服务的文本块（到下一个两空格缩进的服务名为止）。 */
function serviceBlock(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.ok(start >= 0, `compose 应有 ${name} 服务`);
  const out = [];
  for (let i = start + 1; i < lines.length; i += 1) {
    if (/^ {2}[a-z]/.test(lines[i])) break;
    out.push(lines[i]);
  }
  return out.join('\n');
}

/**
 * 构建与部署卫生（issue #51 审计发现的两处「本机 / 部署环境」缺口）。
 *
 * 这两条都属于「配置与文件写错时不报错、只静默出事」，所以和上面的环境变量契约放在
 * 同一个文件里由测试钉死。
 */
describe('构建与部署卫生', () => {
  const dockerignoreText = read('.dockerignore');
  const dockerfileWeb = read('Dockerfile.web');

  it('.dockerignore 排除 .env（web 镜像整仓 COPY . .）', () => {
    // 不排除的后果：POSTGRES_PASSWORD / MEILI_MASTER_KEY / ADMIN_TOKEN / SMTP_PASS /
    // GLM_API_KEY 会随镜像层分发（镜像可导出、可 docker save，事后删文件也不会从层里
    // 消失），而 docs/deploy.md 第 3 节正是让人把 .env 建在仓库根目录。
    assert.match(dockerfileWeb, /COPY \. \./, '前提变了：web 镜像若不再整仓拷贝，本条可重新评估');
    const entries = dockerignoreText.split(/\r?\n/).map((line) => line.trim());
    assert.ok(entries.includes('.env'), '.dockerignore 必须逐项列出 .env（不靠通配符的巧合）');
  });

  it('compose 的命令最后一步 exec：PID 1 必须是 node，否则 SIGTERM 到不了进程', () => {
    // `sh -c "... && npm run worker"` 的 PID 1 是 sh，而非交互式 sh 不转发信号 ——
    // docker stop / `compose up -d` 重建时进程收不到 SIGTERM，只能在宽限期后被 SIGKILL，
    // worker 的优雅退出（等在途轮次收尾）因此形同虚设。
    for (const service of ['web', 'worker']) {
      const block = serviceBlock(composeText, service);
      assert.match(block, /command: sh -c ".*&& exec /, `${service} 的 command 应在最后一步 exec`);
      assert.match(block, /stop_grace_period: \d+s/, `${service} 应显式声明宽限期`);
    }
  });

  it('关键口令必填（issue #52）：缺配置当场失败，而不是静默用公开默认口令起服务', () => {
    // 从前是 ${POSTGRES_PASSWORD:-zhurenweng} / ${MEILI_MASTER_KEY:-zhurenweng-change-me} ——
    // 忘填 .env 时数据库与检索就以**公开已知口令**启动，且没有任何提示。
    // 改成 ${VAR:?} 后 compose 会带着这句说明直接拒绝启动。
    for (const key of ['POSTGRES_PASSWORD', 'MEILI_MASTER_KEY']) {
      assert.ok(
        composeText.includes(`\${${key}:?`),
        `${key} 应使用 \${VAR:?说明} 必填语法（缺配置当场失败）`,
      );
      assert.ok(
        !composeText.includes(`\${${key}:-`),
        `${key} 不该再有 :- 回退值（回退值 = 公开默认口令）`,
      );
    }
  });

  it('限流阈值是完整旋钮（issue #52）：.env.example 声明 + compose 传进 web', () => {
    const webKeys = services.get('web');
    for (const key of ['SUBSCRIBE_RATE_LIMIT_PER_HOUR', 'ADMIN_LOGIN_RATE_LIMIT_PER_HOUR']) {
      assert.ok(envVars.has(key), `${key} 应在 .env.example 里声明`);
      assert.ok(webKeys?.has(key), `${key} 应传进 web 容器（限流跑在 web 进程里）`);
    }
  });

  it('附件档位的三处缺省一致（代码 ↔ .env.example ↔ compose 回退值）', () => {
    // 为什么单挑这一个变量做三方比对：`on` 的语义是「摘要把附件文本当第二路输入」，而这条
    // 路径尚未接线（issue #57 第 5 步未完，`attachmentTextFeedsSummary()` 当时零调用者）。
    // 三处缺省里任何一处单独写 on，操作者改档位就毫无效果 —— 那正是 issue #58 删掉
    // `sources.schedule_config_json` 时定性的「幽灵旋钮」。缺省只能是真会生效的那一档；
    // 第 5 步接上后三处一起改回 on（改动面被本条断言绑死，不允许只改一处）。
    const exampleValue = /^ATTACHMENT_TEXT=(\S*)$/m.exec(envExampleText)?.[1];
    const composeDefault = /ATTACHMENT_TEXT: \$\{ATTACHMENT_TEXT:-([^}]*)\}/.exec(composeText)?.[1];
    const saved = process.env.ATTACHMENT_TEXT;
    let codeDefault;
    try {
      delete process.env.ATTACHMENT_TEXT;
      codeDefault = attachmentMode();
    } finally {
      if (saved === undefined) delete process.env.ATTACHMENT_TEXT;
      else process.env.ATTACHMENT_TEXT = saved;
    }
    assert.ok(exampleValue !== undefined, '.env.example 应声明 ATTACHMENT_TEXT');
    assert.ok(composeDefault !== undefined, 'compose 应给 ATTACHMENT_TEXT 一个 :- 回退值');
    assert.equal(exampleValue, codeDefault, '.env.example 写的档位与代码缺省不一致');
    assert.equal(composeDefault, codeDefault, 'compose 的 :- 回退值与代码缺省不一致');
  });

  it('每日备份的安装片段带 CRON_TZ=UTC（脚本头注 ↔ docs）（issue #68）', () => {
    // 为什么钉这一行：宿主机时区是 Asia/Shanghai，而 cron 的时间字段按**宿主机时区**解释。
    // 2026-09-24 装 cron 时片段里没有 CRON_TZ，注释却写着「19:30 UTC」，于是 `30 19` 实际是
    // 19:30 北京时间 —— "每天自动备份"装了之后一整天一次都没触发，而 `systemctl is-active crond`
    // 显示 active、crontab -l 看得到那一行，什么都"正常"。这一条不防运行期错误（cron 不报错就是
    // 不报错），防的是**下一次照抄安装命令的人**把时区那行抄丢，那与本次事故是同一个动作。
    const scriptText = read('deploy/daily-backup.sh');
    const installLines = (text) =>
      text
        .split(/\r?\n/)
        .filter((line) => /crontab\s+-\s*$|crontab\s+-l/.test(line) || /^\s*echo\s+'/.test(line))
        .join('\n');
    for (const [name, text] of [
      ['deploy/daily-backup.sh', scriptText],
      ['docs/deploy.md', deployDocText],
    ]) {
      const snippet = installLines(text);
      assert.match(snippet, /CRON_TZ=UTC/, `${name} 的安装片段少了 CRON_TZ=UTC（会按宿主机时区解释）`);
      assert.match(
        snippet,
        /30 19 \* \* \* \/bin\/bash \/opt\/zhurenweng\/deploy\/daily-backup\.sh/,
        `${name} 的安装片段与脚本路径不匹配`,
      );
    }
  });
});
