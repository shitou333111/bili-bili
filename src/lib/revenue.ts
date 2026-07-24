export type RawGiftRecord = {
  id: number;
  gift_num: number;
  gift_num_unit: string;
  coin: string;
  pay_coin: string;
  ruid: number;
  gift_id: number;
  timestamp: number;
  room_id: number;
  r_uname: string;
  gift_name: string;
  gift_img: string;
  coin_type: string;
  is_guard: number;
  is_discount: number;
  bag_desc: string;
  discount_desc: string;
  status_msg: string;
  receive_title: string;
  refund_price: string;
  mtime: number;
};

export type PayRecordSnapshot = {
  source: "mock" | "real";
  month: string;
  nextId: number;
  totalRecords: number;
  totalCoins: number;
  giftCatalog: Array<{
    giftName: string;
    giftImg: string;
    giftId: number;
    latestTimestamp: number;
  }>;
  records: Array<RawGiftRecord & {
    totalCoins: number;
    giftNameKey: string;
  }>;
};

// === 假主播列表（ruid 使用 100000001-100000010，避免暴露真实用户隐私） ===
const FAKE_STREAMERS = [
  { ruid: 100000001, room_id: 1000000001, r_uname: "模拟主播-星辰" },
  { ruid: 100000002, room_id: 1000000002, r_uname: "模拟主播-清风" },
  { ruid: 100000003, room_id: 1000000003, r_uname: "模拟主播-小鹿" },
  { ruid: 100000004, room_id: 1000000004, r_uname: "模拟主播-月月" },
  { ruid: 100000005, room_id: 1000000005, r_uname: "模拟主播-晓晓" },
  { ruid: 100000006, room_id: 1000000006, r_uname: "模拟主播-阿言" },
  { ruid: 100000007, room_id: 1000000007, r_uname: "模拟主播-糖果" },
  { ruid: 100000008, room_id: 1000000008, r_uname: "模拟主播-小鱼" },
  { ruid: 100000009, room_id: 1000000009, r_uname: "模拟主播-阿狸" },
  { ruid: 100000010, room_id: 1000000010, r_uname: "模拟主播-小樱" },
  { ruid: 100000011, room_id: 1000000011, r_uname: "模拟主播-夜雨" },
  { ruid: 100000012, room_id: 1000000012, r_uname: "模拟主播-落雪" },
  { ruid: 100000013, room_id: 1000000013, r_uname: "模拟主播-墨染" },
  { ruid: 100000014, room_id: 1000000014, r_uname: "模拟主播-花落" },
  { ruid: 100000015, room_id: 1000000015, r_uname: "模拟主播-浮生" },
  { ruid: 100000016, room_id: 1000000016, r_uname: "模拟主播-梦回" },
  { ruid: 100000017, room_id: 1000000017, r_uname: "模拟主播-浅唱" },
  { ruid: 100000018, room_id: 1000000018, r_uname: "模拟主播-飞舞" },
  { ruid: 100000019, room_id: 1000000019, r_uname: "模拟主播-星辰" },
  { ruid: 100000020, room_id: 1000000020, r_uname: "模拟主播-晨曦" },
];

// 不同主播有不同的权重，模拟一些主播更常收到礼物
const STREAMER_WEIGHTS = [10, 9, 8, 7, 7, 6, 6, 5, 5, 4, 4, 3, 3, 3, 2, 2, 2, 1, 1, 1];

// === 真实礼物列表（礼物名和图片 URL 属于公开信息） ===
type GiftDef = {
  gift_id: number;
  gift_name: string;
  coin: string;
  bag_desc: string;
  gift_img: string;
};

const GIFT_CATALOG: GiftDef[] = [
  {
    gift_id: 31250,
    gift_name: "情书",
    coin: "52",
    bag_desc: "包裹道具",
    gift_img: "https://s1.hdslb.com/bfs/live/14dafbf217618f0931c08897e0b3eefc00d0da22.png",
  },
  {
    gift_id: 34977,
    gift_name: "告白花束",
    coin: "199",
    bag_desc: "包裹道具",
    gift_img: "https://s1.hdslb.com/bfs/live/a4aa89aaa24534cb77534680eaed1f5f2f9aa71f.png",
  },
  {
    gift_id: 31217,
    gift_name: "星愿水晶球",
    coin: "1,000",
    bag_desc: "包裹道具",
    gift_img: "https://s1.hdslb.com/bfs/live/288536798081e855e8f645bed6a2d2d27f411ee5.png",
  },
  {
    gift_id: 31036,
    gift_name: "小花花",
    coin: "1",
    bag_desc: "",
    gift_img: "https://s1.hdslb.com/bfs/live/5126973892625f3a43a8290be6b625b5e54261a5.png",
  },
  {
    gift_id: 31164,
    gift_name: "粉丝团灯牌",
    coin: "1",
    bag_desc: "",
    gift_img: "https://s1.hdslb.com/bfs/live/e051dfd4557678f8edcac4993ed00a0935cbd9cc.png",
  },
  {
    gift_id: 32251,
    gift_name: "心动盲盒",
    coin: "150",
    bag_desc: "",
    gift_img: "https://s1.hdslb.com/bfs/live/38f645d811537b50873718cecbfd84cd28af50ed.png",
  },
  {
    gift_id: 32132,
    gift_name: "浪漫城堡",
    coin: "45,000",
    bag_desc: "包裹道具",
    gift_img: "https://s1.hdslb.com/bfs/live/newLivePc/image/blindbox/castle.png",
  },
  {
    gift_id: 1,
    gift_name: "电池",
    coin: "1",
    bag_desc: "",
    gift_img: "",
  },
];

const GIFT_BY_ID = new Map(GIFT_CATALOG.map((g) => [g.gift_id, g]));

// 5 种普通礼物 ID
const NORMAL_GIFT_IDS = [31250, 34977, 31217, 31036, 31164];

// === 确定性伪随机数生成器（mulberry32 + 固定种子，保证每次刷新数据一致） ===
function createPrng(seed: number): () => number {
  let state = seed >>> 0;
  return function next() {
    state |= 0;
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRNG_SEED = 0x5eed1234;

// 时间范围：2025-07-01 00:00:00 (UTC+8) 到 2026-07-21 23:59:59 (UTC+8)，跨度超过一年
const TIME_START = Math.floor(new Date("2024-07-01T00:00:00+08:00").getTime() / 1000);
const TIME_END = Math.floor(new Date("2026-07-21T23:59:59+08:00").getTime() / 1000);

// ID 基址：使用安全整数范围内的递增 ID
const ID_BASE = 1_000_000_000_000;

function pickWeightedStreamer(rng: () => number) {
  const totalWeight = STREAMER_WEIGHTS.reduce((a, b) => a + b, 0);
  let r = rng() * totalWeight;
  for (let i = 0; i < FAKE_STREAMERS.length; i++) {
    r -= STREAMER_WEIGHTS[i];
    if (r <= 0) return FAKE_STREAMERS[i];
  }
  return FAKE_STREAMERS[FAKE_STREAMERS.length - 1];
}

function pickRandom<T>(rng: () => number, arr: readonly T[]): T {
  return arr[Math.floor(rng() * arr.length)];
}

function buildGiftRecord(
  rng: () => number,
  gift: GiftDef,
  idCounter: { value: number },
): RawGiftRecord {
  const streamer = pickWeightedStreamer(rng);
  const id = ID_BASE + idCounter.value;
  idCounter.value += 1;
  // 时间戳在 [TIME_START, TIME_END] 区间内均匀分布
  const timestamp = TIME_START + Math.floor(rng() * (TIME_END - TIME_START));
  return {
    id,
    gift_num: 1,
    gift_num_unit: "",
    coin: gift.coin,
    pay_coin: gift.coin,
    ruid: streamer.ruid,
    gift_id: gift.gift_id,
    timestamp,
    room_id: streamer.room_id,
    r_uname: streamer.r_uname,
    gift_name: gift.gift_name,
    gift_img: gift.gift_img,
    coin_type: "电池",
    is_guard: 0,
    is_discount: 0,
    bag_desc: gift.bag_desc,
    discount_desc: "",
    status_msg: "",
    receive_title: "主播：",
    refund_price: "0",
    mtime: timestamp,
  };
}

export function generateMockRecords(): RawGiftRecord[] {
  const rng = createPrng(PRNG_SEED);
  const idCounter = { value: 0 };
  const records: RawGiftRecord[] = [];

  // 1. 约 40000 条普通礼物消费（情书、告白花束、星愿水晶球、小花花、粉丝团灯牌）
  // 每种礼物有权重，模拟价格越便宜越常见
  const normalGiftPool: number[] = [];
  const normalGiftWeights: Array<[number, number]> = [
    [31250, 100], // 情书
    [31036, 80],  // 小花花
    [31164, 70],  // 粉丝团灯牌
    [34977, 40],  // 告白花束
    [31217, 20],  // 星愿水晶球
  ];
  for (const [id, w] of normalGiftWeights) {
    for (let i = 0; i < w; i++) normalGiftPool.push(id);
  }
  for (let i = 0; i < 40000; i++) {
    const giftId = pickRandom(rng, normalGiftPool);
    records.push(buildGiftRecord(rng, GIFT_BY_ID.get(giftId)!, idCounter));
  }

  // 2. 约 30000 条心动盲盒消费（gift_id: 32251, 150 电池）
  const blindBoxGift = GIFT_BY_ID.get(32251)!;
  for (let i = 0; i < 30000; i++) {
    records.push(buildGiftRecord(rng, blindBoxGift, idCounter));
  }

  // 3. 约 5000 条浪漫城堡产出（gift_id: 32132, bag_desc: "包裹道具"） - 模拟盲盒开出城堡
  const castleGift = GIFT_BY_ID.get(32132)!;
  for (let i = 0; i < 5000; i++) {
    records.push(buildGiftRecord(rng, castleGift, idCounter));
  }

  // 4. 约 20000 条电池消费（gift_id: 1, 1 电池） - 模拟合成材料
  const batteryGift = GIFT_BY_ID.get(1)!;
  for (let i = 0; i < 20000; i++) {
    records.push(buildGiftRecord(rng, batteryGift, idCounter));
  }

  // 4.5 约 8000 条合成产物记录（bag_desc: "包裹道具"） - 模拟合成产出
  const synthesisGiftPool = [31250, 31250, 34977, 34977, 31217];
  for (let i = 0; i < 8000; i++) {
    const giftId = pickRandom(rng, synthesisGiftPool);
    const gift = GIFT_BY_ID.get(giftId)!;
    records.push(buildGiftRecord(rng, gift, idCounter));
  }

  // 5. 约 55000 条其他礼物消费（混合所有礼物，盲盒和电池权重稍高）
  const mixedGiftPool: number[] = [
    ...NORMAL_GIFT_IDS,
    32251, 32251,
    1, 1, 1,
  ];
  for (let i = 0; i < 55000; i++) {
    const giftId = pickRandom(rng, mixedGiftPool);
    records.push(buildGiftRecord(rng, GIFT_BY_ID.get(giftId)!, idCounter));
  }

  // 按时间戳降序排列
  records.sort((a, b) => b.timestamp - a.timestamp);

  return records;
}

const MOCK_RECORDS: RawGiftRecord[] = generateMockRecords();

export function buildMockPayRecordSnapshot(): PayRecordSnapshot {
  const records = MOCK_RECORDS
    .map((record) => ({
      ...record,
      totalCoins: Number((record.pay_coin || record.coin).replace(/,/g, "")) || 0,
      giftNameKey: record.gift_name,
    }))
    .sort((a, b) => b.timestamp - a.timestamp);

  const giftCatalog = Array.from(
    records.reduce((map, record) => {
      if (!map.has(record.giftNameKey)) {
        map.set(record.giftNameKey, {
          giftName: record.gift_name,
          giftImg: record.gift_img,
          giftId: record.gift_id,
          latestTimestamp: record.timestamp,
        });
      }
      return map;
    }, new Map<string, { giftName: string; giftImg: string; giftId: number; latestTimestamp: number }>())
      .values(),
  );

  const totalCoins = records.reduce((sum, record) => sum + record.totalCoins, 0);

  return {
    source: "mock",
    month: "202607",
    nextId: records.at(-1)?.id ?? 0,
    totalRecords: records.length,
    totalCoins,
    giftCatalog,
    records,
  };
}
