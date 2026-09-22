import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { attachmentUrlCandidates } from '../../src/lib/attachment-url.ts';

/**
 * `attachmentUrlCandidates` 的表驱动测试（issue #57 的换域重试判据）。
 *
 * 这里定的是**安全边界**：多列一个候选只是多试一个地址，少列一个则 miit 那 14 份草案
 * 永远读不到；而把不相干的站点判成同站，等于允许 A 站的链接指挥 worker 去 B 站取同名
 * 路径。所以每条否定用例都要各自挡住一类越界，而不是只测「能拼出来」。
 */

const MIIT_PAGE = 'https://www.miit.gov.cn/gzcy/yjzj/art/2026/art_245934cf2b9540d0ba3ada961cd14866.html';
const MIIT_ATTACH = 'https://jyhwzhq.miit.gov.cn/cms_files/filemanager/1226211233/attach/20269/x.pdf';

describe('附件取回地址候选', () => {
  it('同 origin 只有一个候选（正常源站不因这一手多一个请求）', () => {
    const same = attachmentUrlCandidates('https://www.miit.gov.cn/a/b/draft.pdf', MIIT_PAGE);
    assert.equal(same.length, 1);
    assert.equal(same[0], 'https://www.miit.gov.cn/a/b/draft.pdf');
  });

  it('写明了默认端口也算同一处（去重比的是拼出来的地址，判据比的是 origin）', () => {
    const candidates = attachmentUrlCandidates(
      'https://www.miit.gov.cn:443/cms_files/a.pdf',
      MIIT_PAGE,
    );
    assert.deepEqual(candidates, ['https://www.miit.gov.cn:443/cms_files/a.pdf']);
  });

  it('同站子域被拒后，补一条「页面 origin + 同路径」', () => {
    const [first, second] = attachmentUrlCandidates(MIIT_ATTACH, MIIT_PAGE);
    assert.equal(first, MIIT_ATTACH, '页面里写着的地址要第一个试');
    assert.equal(second, 'https://www.miit.gov.cn/cms_files/filemanager/1226211233/attach/20269/x.pdf');
  });

  it('查询串跟着走（附件常带 `?file=` 之类的取回参数）', () => {
    const [, second] = attachmentUrlCandidates(
      'https://jyhwzhq.miit.gov.cn/cms_files/a.pdf?v=2&download=1',
      MIIT_PAGE,
    );
    assert.equal(second, 'https://www.miit.gov.cn/cms_files/a.pdf?v=2&download=1');
  });

  it('协议的继承以页面为准（页面是 https 就不会补出一个 http 候选）', () => {
    const [, second] = attachmentUrlCandidates(
      'http://jyhwzhq.miit.gov.cn/cms_files/a.pdf',
      MIIT_PAGE,
    );
    assert.ok(second.startsWith('https://'), `实际是 ${second}`);
  });

  it('只共享两段后缀不算同站（.com.cn / .gov.cn 这类公共后缀下两段会把不相干的站判成同站）', () => {
    const candidates = attachmentUrlCandidates(
      'https://files.sample.com/a.pdf',
      'https://www.sample.com/detail.html',
    );
    assert.equal(candidates.length, 1, `实际给了 ${candidates.join(' , ')}`);
  });

  it('后缀相同但站不同：`miit.gov.cn.evil.cn` 不是 miit 的子域', () => {
    const candidates = attachmentUrlCandidates(
      'https://miit.gov.cn.evil.cn/cms_files/a.pdf',
      MIIT_PAGE,
    );
    assert.equal(candidates.length, 1);
  });

  it('完全不相干的站不补候选', () => {
    const candidates = attachmentUrlCandidates('https://other-host.cn/files/a.pdf', MIIT_PAGE);
    assert.equal(candidates.length, 1);
  });

  it('同主机不同端口也算两处（e2e 就靠这个形状跑通先拒后取）', () => {
    const candidates = attachmentUrlCandidates(
      'http://127.0.0.1:9001/cms_files/a.pdf',
      'http://127.0.0.1:9002/detail/art_1.html',
    );
    assert.equal(candidates[1], 'http://127.0.0.1:9002/cms_files/a.pdf');
  });

  it('地址写坏时原样返回，不抛（附件 URL 来自第三方页面）', () => {
    assert.deepEqual(attachmentUrlCandidates('draft.pdf', MIIT_PAGE), ['draft.pdf']);
    assert.deepEqual(attachmentUrlCandidates(MIIT_ATTACH, 'not a url'), [MIIT_ATTACH]);
  });
});
