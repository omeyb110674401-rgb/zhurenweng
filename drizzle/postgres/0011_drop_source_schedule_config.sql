-- 删除「幽灵旋钮」：列存在、repo 每次写 '{}'，但抓取任务从不读它 —— 看起来能按源配调度，
-- 实际改它没有任何效果。按源配置改由适配器在代码里声明（src/sources/registry.ts）。
ALTER TABLE "sources" DROP COLUMN "schedule_config_json";