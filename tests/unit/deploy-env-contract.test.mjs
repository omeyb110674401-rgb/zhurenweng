import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { createLlmPort, createMailerPort } from '../../src/lib/ports.ts';
import { llmReady } from '../../src/lib/llm-availability.ts';
import { mailerReady } from '../../src/lib/mailer-availability.ts';
import { resolveSmtpOptions } from '../../src/lib/adapters/smtp-mailer.ts';

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
});
