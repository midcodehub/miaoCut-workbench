import { PosterWorkbench } from "@/components/poster-workbench";

export const metadata = { title: "海报文字 · MiaoCut", description: "给商品图加上精确渲染的标题、卖点和价格，导出 PNG。文字在浏览器里生成，不使用 AI，不消耗积分。" };
export default function PosterPage() { return <PosterWorkbench />; }
