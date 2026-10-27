import { notFound } from "next/navigation";
import { BatchWorkbench } from "@/components/batch-workbench";

export const metadata = { title: "批量场景 · MiaoCut", description: "一次放进最多 20 件商品，逐张提取并检查主体，再套用同一个方案批量生成场景图。" };
// 与内部工作台相同：依赖账户登录和积分账本，只在内部测试环境开放。
export const dynamic = "force-dynamic";
export default function BatchPage() {
  if (process.env.WORKBENCH_INTERNAL_ENABLED !== "1") notFound();
  return <BatchWorkbench sessionKey={process.env.WORKBENCH_SESSION_STORAGE_KEY || "sb-kaqlfoxselrvriulvlsm-auth-token"} />;
}
