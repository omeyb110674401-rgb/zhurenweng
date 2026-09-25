-- 体裁判定（issue #76）：修正案与新案需要的摘要是两种东西，先分体裁再选模板。
-- 与 sqlite 侧同结构。三列都可空 —— NULL 表示"本列上线前的存量，没判定过"，
-- 与 genre='unknown'（判过了，但标题与附件都没线索）是两回事，别混。
ALTER TABLE "notices" ADD COLUMN "genre" text;
--> statement-breakpoint
ALTER TABLE "notices" ADD COLUMN "genre_basis" text;
--> statement-breakpoint
ALTER TABLE "notices" ADD COLUMN "genre_evidence" text;
