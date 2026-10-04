import type { ImpactReviewInput, ImpactReviewPort } from '../../ports.ts';
import {
  isImpactReviewStatus,
  type ImpactReviewStatus,
  type ImpactReviewVerdict,
} from '../../impact-review.ts';

/**
 * stub 审读端口：`ImpactReviewPort` 的测试实现（ADR-0001 第 5 条；issue #47）。
 *
 * 它**逐字回显**每一条判读的 `quote` 与 `text`，再给一个可注入的结论 —— 于是
 * 「只减不加」的接受条件（`impactReviewRecordsFrom`）走的正是真实路径：模型回显与
 * 本仓手里的判读对不上号时，那条结论不会被采信。
 *
 * 缺省结论是 `passed`：E2E 里摘要管线照常跑一圈，而线上的可见结果**一条都不变**
 * （#47 是一刀零可见变化的切片）。要测"已改 / 剔除"那两条路径时用构造参数或
 * `IMPACT_REVIEW_STUB_STATUS` 注入。
 *
 * **它不能当生产缺省**：一枚永远说"通过"的橡皮章比没有审读更坏（页面看不出来），
 * 所以 `createImpactReviewPort()` 在 `IMPACT_REVIEW_PROVIDER` 为空时是抛错的、
 * 不回落到这里。
 */
export interface StubImpactReviewOptions {
  status?: ImpactReviewStatus;
  /** 「已改」时给出的审读后文本；缺省 = `【stub 审读】<原推断正文>` */
  revisedText?: string;
}

function statusFromEnv(raw: string | undefined): ImpactReviewStatus {
  if (raw === undefined || raw === '') return 'passed';
  if (isImpactReviewStatus(raw)) return raw;
  throw new Error(
    `非法的 IMPACT_REVIEW_STUB_STATUS "${raw}"（可选：passed | revised | rejected）`,
  );
}

export class StubImpactReview implements ImpactReviewPort {
  readonly provider = 'stub';
  readonly model = 'stub';

  private readonly status: ImpactReviewStatus;
  private readonly revisedText?: string;

  constructor(options: StubImpactReviewOptions = {}) {
    this.status = options.status ?? statusFromEnv(process.env.IMPACT_REVIEW_STUB_STATUS);
    this.revisedText = options.revisedText;
  }

  async review(input: ImpactReviewInput): Promise<ImpactReviewVerdict[]> {
    return input.items.map((item) => ({
      quote: item.quote,
      text: item.text,
      status: this.status,
      revisedText:
        this.status === 'revised' ? (this.revisedText ?? `【stub 审读】${item.text}`) : null,
    }));
  }
}
