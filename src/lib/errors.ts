/**
 * 错误 → 消息文本（issue #83 合并）。
 *
 * 这个两行的函数此前在 **5 个 worker 任务里各有一份**（逐字节相同的 `error instanceof
 * Error ? error.message : String(error)`），另有若干处内联的三元表达式。合并的理由不是
 * "少写两行"，而是**日志与告警句子的形状要统一**：任务失败时的告警邮件、worker 日志、
 * 后台的「当前错误信息」列全都在拼这句话，五份里任何一份被改宽或改窄（比如把
 * `String(error)` 换成 `JSON.stringify`），同一件故障在三个地方就会显示成三种样子 ——
 * 而这正是排查时唯一能对照的线索。
 *
 * 为什么用 `instanceof Error` 而不是 `typeof error === 'object'`：抛出的东西不一定是
 * Error（`throw 'string'`、Promise rejection 非 Error 都真实存在），非 Error 一律
 * `String()`，至少留下点东西，绝不返回 `[object Object]` 之外的谎话。
 */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
