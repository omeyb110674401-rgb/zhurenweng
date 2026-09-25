import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 找一个**真的能跑 sh 脚本**的 bash，供「要执行仓库里那份真 bash 脚本」的 e2e 用例使用。
 *
 * 为什么不直接 `spawnSync('bash', …)`：Windows 上 PATH 里排在前面的
 * `C:\Windows\System32\bash.exe` 是 **WSL 启动器**，Git Bash 反而排在它后面。没装 WSL
 * 发行版时前者打印「未安装用于 Linux 的 Windows 子系统」并以非零退出 —— 用例于是报出
 * 一条与被测代码毫无关系的红。2026-09-25 实测踩到：同一条 `npm run e2e` 在 Git Bash 里
 * 全绿，在 PowerShell 里必红，红的正是 `backup-failure-alert`（issue #71）。
 *
 * 顺序：显式覆盖（`ZW_BASH`）→ Git Bash 常见安装位置 → PATH 上的 `bash`。
 * 自动探测**能用才采用**（真跑一次探针验证）；一个都用不了就抛错并列出试过的候选 ——
 * 静默跳过等于把「没跑」当「通过」，那是这个仓库反复在防的事。
 * 显式覆盖是例外：**给了却不可用就当场报错**，不悄悄退回自动探测 ——
 * 写错的覆盖值应当吵，而不是变成一个「改了没效果」的旋钮。
 */

const PROBE = 'zw-bash-probe-ok';

/** Windows 上 Git Bash 的常见安装位置（PATH 上那个不可用时按这些位置兜底）。 */
function windowsCandidates() {
  const roots = [
    process.env.ProgramFiles,
    process.env['ProgramFiles(x86)'],
    process.env.ProgramW6432,
    process.env.LOCALAPPDATA === undefined
      ? undefined
      : path.join(process.env.LOCALAPPDATA, 'Programs'),
  ].filter((root) => typeof root === 'string' && root.length > 0);
  return roots.map((root) => path.join(root, 'Git', 'bin', 'bash.exe'));
}

function candidateList() {
  const list = [];
  if (process.platform === 'win32') list.push(...windowsCandidates());
  list.push('bash');
  return list;
}

/** 探测一个候选：真能跑出探针串才算数。 */
function works(candidate) {
  if (candidate !== 'bash' && !fs.existsSync(candidate)) return false;
  const run = spawnSync(candidate, ['-c', `echo ${PROBE}`], {
    encoding: 'utf8',
    timeout: 30_000,
  });
  return run.status === 0 && (run.stdout ?? '').includes(PROBE);
}

let resolved = null;

/** 只给测试用：清掉缓存，让下一次 resolveBash 重新探测。 */
export function resetBashCache() {
  resolved = null;
}

/**
 * 返回可用的 bash 可执行文件（路径或命令名）。
 * 找不到就抛错 —— 调用方不必自己兜底，错误消息里已有可执行的下一步。
 */
export function resolveBash() {
  if (resolved !== null) return resolved;

  const override = process.env.ZW_BASH;
  if (override !== undefined && override !== '') {
    if (!works(override)) {
      throw new Error(
        `ZW_BASH=${override} 不是一个可用的 bash（跑探针失败）。` +
          '它要么路径写错了，要么不是 sh 兼容的 shell。改对它，或清掉这个环境变量走自动探测。',
      );
    }
    resolved = override;
    return resolved;
  }

  const tried = candidateList();
  for (const candidate of tried) {
    if (works(candidate)) {
      resolved = candidate;
      return resolved;
    }
  }
  throw new Error(
    '找不到可用的 bash —— 本用例要跑仓库里那份真 bash 脚本（`deploy/daily-backup.sh`），' +
      '不能用别的 shell 替代。已试过：' +
      `${tried.join(' / ')}。` +
      'Windows 上 Git Bash 默认装在 `C:\\Program Files\\Git\\bin\\bash.exe`；' +
      '装在别处就用环境变量 `ZW_BASH` 指过去。',
  );
}
