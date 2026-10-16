/**
 * 机型代号 → 「品牌 市场名」解析（admin 展示用）。
 *
 * 数据源：Google Play 官方 supported_devices 列表（Retail Branding + Marketing Name + Model），
 * 由 scripts 一次性生成 device-models.json（Model 代号 → 「品牌 市场名」，共 4 万余条）。
 *
 * 仅服务端（admin API 路由）使用：设备上报时存的是机型代号（如 V2301A），
 * 这里在返回给 admin 页面时解析为「品牌 市场名」（如 Vivo iQOO Neo8），查不到则保留原代号。
 * 有意不引入任何客户端组件，避免全量表被打进客户端产物 / 单文件分发包。
 */
import deviceModelsRaw from "./device-models.json";

/** 全量表（服务端内存常驻；JSON 导入一次即被 Node 模块缓存复用） */
const deviceModels = deviceModelsRaw as unknown as Record<string, string>;

/** 机型代号（如 V2301A）→「品牌 市场名」（查不到返回 undefined，调用方回退原代号） */
export function resolveDeviceBrand(code?: string | null): string | undefined {
  if (!code) return undefined;
  const key = String(code).trim().toUpperCase();
  if (!key) return undefined;
  return deviceModels[key];
}
