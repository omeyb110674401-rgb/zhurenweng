/**
 * 页脚 ICP 备案号（issue #13 上线收尾）。
 *
 * 工信部要求已备案站点在页面底部展示备案号并链接到 beian.miit.gov.cn，
 * 号码由环境变量 ICP_NUMBER 注入（生产在 .env 中配置，改后 restart 即生效——
 * 首页与搜索页均为 force-dynamic，不在构建期固化）。未配置时保留占位文案，
 * 使本地开发与测试不依赖该变量。
 */

const BEIAN_URL = 'https://beian.miit.gov.cn/';

export function IcpFiling() {
  const number = process.env.ICP_NUMBER?.trim();
  if (!number) {
    return <p>ICP 备案：待备案（占位）</p>;
  }
  return (
    <p>
      <a href={BEIAN_URL} target="_blank" rel="noopener noreferrer">
        {number}
      </a>
    </p>
  );
}
