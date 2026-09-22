/**
 * word-extractor 的类型声明（issue #57）。
 *
 * 这个包是 CommonJS 且不带 .d.ts，而本仓库以 `type: module` + Node 原生类型剥离运行，
 * 所以手写一份最小声明。刻意只声明用得到的那部分（getBody）：headers / footers /
 * footnotes 对「影响谁、条文要点」没有信息量，声明出来只会诱导以后往那儿加逻辑。
 */
declare module 'word-extractor' {
  export default class WordExtractor {
    extract(data: Buffer | Uint8Array): Promise<{ getBody(): string }>;
  }
}
