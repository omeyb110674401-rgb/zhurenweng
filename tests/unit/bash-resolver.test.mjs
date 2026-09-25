import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { spawnSync } from 'node:child_process';
import { resetBashCache, resolveBash } from '../e2e/helpers/bash.mjs';

/**
 * 单元：e2e 用的 bash 解析（见 `tests/e2e/helpers/bash.mjs`）。
 *
 * 为什么值得单测：解析错了的表现不是报错，而是**一条与被测代码毫无关系的红**。
 * 2026-09-25 实测：同一条 `npm run e2e`，在 Git Bash 里全绿、在 PowerShell 里
 * `backup-failure-alert`（issue #71）必红 —— 因为 Windows 的 PATH 上排第一的
 * `bash.exe` 是 WSL 启动器，没装发行版时它直接以非零退出。
 *
 * 两条契约在这里钉住：
 * ① 自动探测**只认能跑通的**（探针真跑一次，不看文件名猜）；
 * ② 显式覆盖 `ZW_BASH` 写错了要**当场吵**，不悄悄退回自动探测 ——
 *    否则它就是一个「改了没效果」的假旋钮，正是这个仓库反复在删的东西。
 */

const originalZwBash = process.env.ZW_BASH;

afterEach(() => {
  if (originalZwBash === undefined) delete process.env.ZW_BASH;
  else process.env.ZW_BASH = originalZwBash;
  resetBashCache();
});

/** 独立复算一次探针，不信任被测代码自己的判断。 */
function reallyWorks(candidate) {
  const run = spawnSync(candidate, ['-c', 'echo zw-bash-probe-ok'], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return run.status === 0 && (run.stdout ?? '').includes('zw-bash-probe-ok');
}

describe('e2e 的 bash 解析：只认跑得通的', () => {
  it('解析出的 bash 真的能跑 sh 脚本（不是"看着像 bash"的名字）', () => {
    delete process.env.ZW_BASH;
    resetBashCache();
    const bash = resolveBash();
    assert.ok(
      reallyWorks(bash),
      `解析结果 ${bash} 必须自己就能跑通探针，否则用例会报出与被测代码无关的红`,
    );
  });

  it('结果被缓存：同一个进程里不重复探测', () => {
    delete process.env.ZW_BASH;
    resetBashCache();
    assert.equal(resolveBash(), resolveBash(), '两次调用应当是同一个值');
  });

  it('ZW_BASH 指到不可用的东西 ⇒ 抛错并点名 ZW_BASH，不静默退回自动探测', () => {
    process.env.ZW_BASH = 'definitely-not-a-bash-zw-test';
    resetBashCache();
    assert.throws(
      () => resolveBash(),
      (error) => {
        assert.match(error.message, /ZW_BASH/, '要指出是哪个环境变量写错了');
        assert.match(
          error.message,
          /definitely-not-a-bash-zw-test/,
          '要把写错的值原样带出来，否则人还得回去翻自己设了什么',
        );
        return true;
      },
    );
  });

  it('ZW_BASH 指到可用的 bash ⇒ 采用它（覆盖优先于自动探测）', () => {
    delete process.env.ZW_BASH;
    resetBashCache();
    const real = resolveBash();
    // 用一个绝对路径当覆盖值：自动探测绝不会挑到它，所以"被采用"这件事可证
    process.env.ZW_BASH = real;
    resetBashCache();
    assert.equal(resolveBash(), real);
  });
});
