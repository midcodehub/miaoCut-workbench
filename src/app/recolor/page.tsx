import { RecolorWorkbench } from "@/components/recolor-workbench";

export const metadata = { title: "精确换色 · MiaoCut", description: "涂出要换色的区域，一次预览多个颜色。保留原有的明暗和纹理，涂抹范围外的像素不变。在浏览器里完成，免费，不上传图片。" };
export default function RecolorPage() { return <RecolorWorkbench />; }
