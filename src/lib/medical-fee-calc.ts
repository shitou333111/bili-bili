/**
 * 「发医药费」纯计算逻辑（前后端共用，不能引入 fs / 网络依赖）。
 *
 * 计算规则完全对齐「多人接力 PK 医药费」（components/MedicalFeeSettlement.tsx）：
 * - 参与人数 ≥ 7 且第二名票数 ≥ 1000 才算成局，否则流局（不展示）；
 * - 第二名默认为发医药费的人；
 * - 第二名票数 ≥ 55000 视为「打满」，医药费固定 552，吃医药费的是 3~6 名共 4 人；
 * - 未打满时医药费 = 第二名票数 ÷ 100 向下取整（> 10000 时后 3 位当作 0），
 *   吃医药费的是 3~7 名共 5 人；
 * - 人均 = 总额 ÷ 吃医药费人数，保留 1 位小数。
 */

export type FeeAnchor = {
  uid: number;
  name: string;
  votes: number;
  roomId: number;
};

export type FeeRoles = {
  /** 发医药费的主播 uid；0 表示尚未指定 */
  payerUid: number;
  receiverUids: number[];
};

export const FEE_VOID_THRESHOLD = 1000;
export const FEE_FULL_VOTES = 55000;
export const FEE_FULL_TOTAL = 552;

/** 记录有效期（小时），从 PK 开始时间起算 */
export const FEE_VALID_HOURS = 2;

/** 保留 1 位小数 */
export function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/** 医药费总额：打满固定 552；否则按分数折算 */
export function calcFeeTotal(score: number): number {
  const v = Math.max(0, Number(score) || 0);
  if (v >= FEE_FULL_VOTES) return FEE_FULL_TOTAL;
  const base = Math.floor(v / 100);
  return v > 10000 ? Math.floor(base / 10) * 10 : base;
}

/** 按票数从高到低排序（同票时按 uid 保证顺序稳定） */
export function sortAnchors<T extends { votes: number; uid: number }>(anchors: T[]): T[] {
  return [...anchors].sort((a, b) => b.votes - a.votes || a.uid - b.uid);
}

/** 流局判断：不足 7 人或第二名票数低于 1000 */
export function isFeeVoid(anchors: Array<{ votes: number }>): boolean {
  if (anchors.length < 7) return true;
  const sorted = sortAnchors(anchors.map((a, i) => ({ votes: a.votes, uid: i })));
  return (sorted[1]?.votes ?? 0) < FEE_VOID_THRESHOLD;
}

/** 默认收发角色：第二名发，随后 4 人（打满）/ 5 人（未打满）收 */
export function defaultFeeRoles(anchors: Array<{ uid: number; votes: number }>): FeeRoles {
  const sorted = sortAnchors(anchors);
  const payer = sorted[1];
  if (!payer) return { payerUid: 0, receiverUids: [] };
  const full = payer.votes >= FEE_FULL_VOTES;
  let count = full ? 4 : 5;
  const receiverUids: number[] = [];
  for (const a of sorted) {
    if (count <= 0) break;
    if (a.uid === sorted[0]?.uid || a.uid === payer.uid) continue;
    receiverUids.push(a.uid);
    count -= 1;
  }
  return { payerUid: payer.uid, receiverUids };
}

export type FeeSplit = {
  payerUid: number;
  payerScore: number;
  total: number;
  perPerson: number;
  receiverUids: number[];
  full: boolean;
};

/** 按当前角色 + 分数结算医药费（分数被修改后自动重算） */
export function calcFeeSplit(
  anchors: Array<{ uid: number; votes: number }>,
  roles: FeeRoles,
): FeeSplit {
  const payerScore = anchors.find((a) => a.uid === roles.payerUid)?.votes ?? 0;
  const full = payerScore >= FEE_FULL_VOTES;
  const total = calcFeeTotal(payerScore);
  const receiverUids = roles.receiverUids.filter((uid) => uid !== roles.payerUid);
  const perPerson = receiverUids.length ? round1(total / receiverUids.length) : 0;
  return {
    payerUid: roles.payerUid,
    payerScore,
    total,
    perPerson,
    receiverUids,
    full,
  };
}

export type WeChatGroup = {
  id: string;
  name: string;
  /** 群编号（从 1 开始，后台配置顺序） */
  index: number;
  /** 群截图 URL（admin 配置） */
  image?: string;
  /** 群成员 uid 列表（来自主播自行登记） */
  members: number[];
};

export type GroupPlan = {
  /** 选中的微信群（已按覆盖主播数从多到少排序） */
  groups: Array<{ group: WeChatGroup; receiverUids: number[] }>;
  /** 不在任何候选微信群里、无法被覆盖的收医药费主播 */
  missingReceiverUids: number[];
  /** 发医药费的主播不在任何微信群 */
  payerMissing: boolean;
};

/**
 * 计算「用最少的微信群把医药费发出去」的方案。
 *
 * 约束：每个选中的群都必须包含发医药费的主播（红包发在该群里）。
 * 目标：覆盖全部收医药费的主播且群数最少；
 * 群数相同时，优先「单个群覆盖收医药费主播人数最多」的方案
 * （例如 C 群 4 人 + D 群 1 人 优于 A 群 3 人 + B 群 2 人）。
 */
export function planFeeGroups(
  groups: WeChatGroup[],
  payerUid: number,
  receiverUids: number[],
): GroupPlan {
  const receivers = [...new Set(receiverUids.filter((u) => u > 0))];
  if (receivers.length === 0) {
    return { groups: [], missingReceiverUids: [], payerMissing: payerUid > 0 && !groupHas(groups, payerUid) };
  }
  const candidates = payerUid > 0 ? groups.filter((g) => g.members.includes(payerUid)) : [];
  const payerMissing = payerUid > 0 && candidates.length === 0;

  // 每个收医药费主播是否至少出现在一个候选群里
  const coveredAnywhere = new Set<number>();
  for (const g of candidates) {
    for (const uid of receivers) if (g.members.includes(uid)) coveredAnywhere.add(uid);
  }
  const missingReceiverUids = receivers.filter((uid) => !coveredAnywhere.has(uid));

  // 只有能被覆盖的收款人参与集合覆盖计算
  const target = receivers.filter((uid) => coveredAnywhere.has(uid));
  if (target.length === 0) {
    return { groups: [], missingReceiverUids, payerMissing };
  }
  const roomMask = (g: WeChatGroup) => {
    let mask = 0;
    target.forEach((uid, i) => {
      if (g.members.includes(uid)) mask |= 1 << i;
    });
    return mask;
  };
  const fullMask = (1 << target.length) - 1;

  type Plan = { picks: WeChatGroup[]; mask: number; maxGroupCount: number };
  /** 覆盖率向量（每个群的覆盖人数，降序），用于同群数时的优先级比较 */
  const coverageVector = (picks: WeChatGroup[]) =>
    picks
      .map((g) => g.members.filter((uid) => target.includes(uid)).length)
      .sort((a, b) => b - a);

  const better = (a: Plan, b: Plan | null): boolean => {
    if (!b) return true;
    if (a.picks.length !== b.picks.length) return a.picks.length < b.picks.length;
    if (a.maxGroupCount !== b.maxGroupCount) return a.maxGroupCount > b.maxGroupCount;
    const va = coverageVector(a.picks);
    const vb = coverageVector(b.picks);
    for (let i = 0; i < Math.max(va.length, vb.length); i += 1) {
      const x = va[i] ?? 0;
      const y = vb[i] ?? 0;
      if (x !== y) return x > y;
    }
    return false;
  };

  // 状态压缩 DP：2^n（n ≤ 5）状态，逐个群松弛
  const best: Array<Plan | null> = Array.from({ length: 1 << target.length }, () => null);
  best[0] = { picks: [], mask: 0, maxGroupCount: 0 };
  for (let iter = 0; iter < target.length; iter += 1) {
    for (let mask = 0; mask < best.length; mask += 1) {
      const cur = best[mask];
      if (!cur || cur.picks.length >= target.length) continue;
      for (const g of candidates) {
        if (cur.picks.includes(g)) continue;
        const gm = roomMask(g);
        if (gm === 0) continue;
        const next: Plan = {
          picks: [...cur.picks, g],
          mask: mask | gm,
          maxGroupCount: Math.max(
            cur.maxGroupCount,
            g.members.filter((uid) => target.includes(uid)).length,
          ),
        };
        if (better(next, best[next.mask])) best[next.mask] = next;
      }
    }
  }

  const plan = best[fullMask];
  if (!plan) {
    return { groups: [], missingReceiverUids: receivers, payerMissing };
  }
  const groupsWithReceivers = plan.picks
    .map((g) => ({
      group: g,
      receiverUids: target.filter((uid) => g.members.includes(uid)),
    }))
    .sort((a, b) => b.receiverUids.length - a.receiverUids.length);
  return { groups: groupsWithReceivers, missingReceiverUids, payerMissing };
}

function groupHas(groups: WeChatGroup[], uid: number): boolean {
  return groups.some((g) => g.members.includes(uid));
}
