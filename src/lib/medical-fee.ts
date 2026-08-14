/**
 * 多人接力 PK 医药费 - 服务器端记录管理
 *
 * 记录采用"全局唯一去重"策略，且只保留计算所需的最少字段，以控制全局文件体积：
 * - 每个操作者本地保存 medical-fee-records.json（最多最近 20 条），随统一上传发到服务器。
 * - 服务器将本地记录合并进全局 .data/medical-fee-records.json（不做跨用户目录写入，避免操作者篡改他人数据）。
 * - 一局对决所有人都可能录入同一条记录，按 recordId / bizSessionId 去重成"所有人统一的唯一一条"。
 *
 * 记录只保留：
 *   - 发医药费：laifuOwnerUid + totalAmount（统计某主播发放总额）
 *   - 收医药费：recipients[{uid, amount}]（统计某主播收到总额）
 *   - 去重/排序：recordId、bizSessionId、gameTimeTs
 *   - 展示：gameTime、perPersonAmount、昵称
 * 不再保存全部参与者明细（分数、角色、房间、操作者等）。
 */

import { promises as fs } from "fs";
import path from "path";

export type MedicalRecipient = { uid: number; uname: string; amount: number };

export type MedicalRecord = {
  recordId: string;
  gameTime: string; // 统一时间（最早记录时间）
  gameTimeTs: number;
  bizSessionId: string;
  laifuOwnerUid: number;
  laifuOwnerUname: string;
  totalAmount: number;
  perPersonAmount: number;
  recipients: MedicalRecipient[];
};

const DATA_DIR = path.join(process.cwd(), ".data");
const GLOBAL_FILE = path.join(DATA_DIR, "medical-fee-records.json");

async function ensureDir(dir: string) {
  await fs.mkdir(dir, { recursive: true });
}

/** 读取全局记录（不存在则返回空数组） */
export async function readGlobalRecords(): Promise<MedicalRecord[]> {
  try {
    const raw = await fs.readFile(GLOBAL_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed as MedicalRecord[];
    if (Array.isArray(parsed?.records)) return parsed.records as MedicalRecord[];
    return [];
  } catch {
    return [];
  }
}

async function writeGlobalRecords(records: MedicalRecord[]): Promise<void> {
  await ensureDir(DATA_DIR);
  await fs.writeFile(GLOBAL_FILE, JSON.stringify({ records }, null, 2), "utf-8");
}

/** 判断两条记录是否属于同一局：recordId 或 bizSessionId 相同即视为同一局 */
export function isSameGame(a: MedicalRecord, b: MedicalRecord): boolean {
  if (a.recordId && b.recordId && a.recordId === b.recordId) return true;
  if (a.bizSessionId && b.bizSessionId && a.bizSessionId === b.bizSessionId) return true;
  return false;
}

/**
 * 合并一批新记录到全局（去重）。返回合并后的全局记录列表。
 * 去重时保留更早的 gameTimeTs 作为统一时间。
 */
export async function mergeGlobalRecords(incoming: MedicalRecord[]): Promise<MedicalRecord[]> {
  if (!incoming || incoming.length === 0) return readGlobalRecords();
  const existing = await readGlobalRecords();
  const merged = [...existing];
  for (const rec of incoming) {
    const dupIndex = merged.findIndex((e) => isSameGame(e, rec));
    if (dupIndex >= 0) {
      // 同一局：统一时间取更早者
      if (rec.gameTimeTs > 0 && rec.gameTimeTs < merged[dupIndex].gameTimeTs) {
        merged[dupIndex] = { ...merged[dupIndex], gameTime: rec.gameTime, gameTimeTs: rec.gameTimeTs };
      }
      continue;
    }
    merged.push(rec);
  }
  // 按时间倒序
  merged.sort((a, b) => b.gameTimeTs - a.gameTimeTs);
  await writeGlobalRecords(merged);
  return merged;
}

/** 统计某用户有史以来发放（作为第二名）与收到（作为收医药费）的金额与次数 */
export function getStatsForUid(records: MedicalRecord[], uid: number) {
  let paid = 0;
  let paidCount = 0;
  let received = 0;
  let receivedCount = 0;
  for (const r of records) {
    if (r.laifuOwnerUid === uid) {
      paid += r.totalAmount;
      paidCount++;
    }
    const me = r.recipients?.find((x) => x.uid === uid);
    if (me) {
      received += me.amount;
      receivedCount++;
    }
  }
  return { paid, paidCount, received, receivedCount };
}
