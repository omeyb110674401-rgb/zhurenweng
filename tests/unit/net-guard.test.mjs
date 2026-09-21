import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { isAllowedCrawlUrl } from '../../src/lib/net-guard.ts';

/**
 * 抓取出网守卫（issue #52）的表驱动测试。
 *
 * 这个函数是「第三方页面能指挥 worker 去请求什么」的唯一判据，所以两侧都要钉死：
 * 该拦的（内网 / 元数据 / 非 http(s) / 内部主机名）一个都不能漏，
 * 该放的（真实源的公网地址、http→https 升级、fixture 源站 origin）一个都不能误伤 ——
 * 误伤等于让正常源静默退化成列表层数据（#30 / #51 反复对抗的失败模式）。
 */

/** 断言被拒绝，并回报实际理由便于排查。 */
function assertBlocked(url, message) {
  const verdict = isAllowedCrawlUrl(url);
  assert.equal(verdict.ok, false, `${message ?? url} 应被拒绝，实际放行`);
  return verdict.reason;
}

describe('isAllowedCrawlUrl：公网 http(s) 目标放行', () => {
  it('真实源站的地址一律放行', () => {
    const allowed = [
      'https://www.mot.gov.cn/hudong/yijianzhengji/index.html',
      // 交通运输部列表跨域混排：民航局 / 国家铁路局必须放行（不能用同源白名单收口）
      'https://www.caac.gov.cn/HDJL/YJZJ/202609/t20260910_1.html',
      'https://www.nra.gov.cn/xxgk/xxx/',
      'https://yyglxxbsgw.ndrc.gov.cn/sa.html#/sdgsglbf',
      'http://www.moj.gov.cn/pub/sfbgw/',
      // 附件域名（发改委 file-submission）
      'https://yyglxxbs.ndrc.gov.cn/file-submission/2026/09/x.docx',
    ];
    for (const url of allowed) {
      assert.deepEqual(isAllowedCrawlUrl(url), { ok: true }, `${url} 应放行`);
    }
  });

  it('http→https 同主机升级与显式端口不算内网', () => {
    assert.deepEqual(isAllowedCrawlUrl('http://www.moj.gov.cn/x'), { ok: true });
    assert.deepEqual(isAllowedCrawlUrl('https://www.mot.gov.cn:8443/x'), { ok: true });
  });

  it('公网 IPv6 放行（守卫只拦私网段，不是「凡是 IPv6 就拦」）', () => {
    assert.deepEqual(isAllowedCrawlUrl('http://[2606:4700::1111]/x'), { ok: true });
  });

  it('allowedOrigins 里的 origin 放行（E2E 的 fixture 源站在环回地址上）', () => {
    const fixture = 'http://127.0.0.1:54321';
    assert.deepEqual(isAllowedCrawlUrl(`${fixture}/npc/list.html`, [fixture]), { ok: true });
    // 只放行该 origin，同主机的其它端口仍拦（端口不同即不同 origin）
    assertBlocked('http://127.0.0.1:1/x', 'allowedOrigins 之外的端口');
  });
});

describe('isAllowedCrawlUrl：内网 / 本机目标一律拒绝', () => {
  it('IPv4 私网、环回、链路本地、CGNAT 与保留段', () => {
    const blocked = [
      'http://127.0.0.1/x',
      'http://127.1.2.3:3000/x',
      'http://10.0.0.5/x',
      'http://172.16.3.4/x',
      'http://192.168.1.1/x',
      'http://169.254.169.254/latest/meta-data/', // 云元数据（SSRF 的经典目标）
      'http://100.100.100.200/latest/meta-data/', // 阿里云元数据
      'http://0.0.0.0/x',
      'http://198.18.0.1/x',
      'http://203.0.113.9/x',
      'http://224.0.0.1/x',
      'http://255.255.255.255/x',
    ];
    for (const url of blocked) assertBlocked(url);
  });

  it('末尾带点的 IP 字面量不能绕过（10.0.0.1. 是合法 FQDN 写法）', () => {
    assertBlocked('http://10.0.0.1./x', '末尾点绕过');
    assertBlocked('http://169.254.169.254./x', '末尾点绕过（元数据）');
  });

  it('IPv6 私网 / 环回 / 链路本地 / 组播 / 未指定', () => {
    const blocked = [
      'http://[::1]/x',
      'http://[::]/x',
      'http://[fd00::1]/x',
      'http://[fe80::1]/x',
      'http://[ff02::1]/x',
    ];
    for (const url of blocked) assertBlocked(url);
  });

  it('IPv4 映射 / 兼容写法按内嵌 IPv4 判定（::ffff:192.168.1.1 是直通内网的旁路）', () => {
    assertBlocked('http://[::ffff:192.168.1.1]/x', 'IPv4 映射私网');
    assertBlocked('http://[::ffff:10.0.0.1]/x', 'IPv4 映射私网');
    assertBlocked('http://[::ffff:127.0.0.1]/x', 'IPv4 映射环回');
    assertBlocked('http://[::ffff:169.254.169.254]/x', 'IPv4 映射元数据');
    assertBlocked('http://[::192.168.1.1]/x', 'IPv4 兼容私网');
  });

  it('内部主机名：localhost / 内部后缀 / 单标签主机名', () => {
    const blocked = [
      'http://localhost/x',
      'http://LOCALHOST:3000/x',
      'http://foo.local/x',
      'http://x.internal/x',
      'http://db.home.arpa/x',
      'http://metadata/x', // 单标签：容器 / 内网里常由搜索域解析到内部地址
      'http://intranet:8080/x',
      'http://[fe80::1%25eth0]/x',
    ];
    for (const url of blocked) assertBlocked(url);
  });

  it('非 http(s) 协议与不可解析地址', () => {
    const blocked = [
      'ftp://www.mot.gov.cn/x',
      'file:///etc/passwd',
      'javascript:alert(1)',
      'data:text/html,<script>x</script>',
      '',
      'not a url',
      '/relative/path',
    ];
    for (const url of blocked) assertBlocked(url);
  });

  it('拒绝理由带目标主机名（worker 日志要能看出拦了什么）', () => {
    assert.match(assertBlocked('http://169.254.169.254/x') ?? '', /169\.254\.169\.254/);
    assert.match(assertBlocked('ftp://x.gov.cn/y') ?? '', /ftp:/);
  });
});
