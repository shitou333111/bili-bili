"use client";

/**
 * 礼物搜索输入框（展示面板用）—— 输入名称 → 下拉匹配候选 → 点击选中返回 {id,name,img}。
 *
 * 候选来源 = 当前直播间的礼物列表（roomGiftList 的 gold_list，即直播间「礼物」选项卡）
 *  + 盲盒爆出礼物（不在直播间列表中，按 id 从全量礼物目录回查），列表条目仅含 gift_id，
 * 名称/图标一律按 id 从本地礼物目录回查。聚焦且未输入时展示几个常用默认候选
 * （心动盲盒 / 绮彩权杖 / 幸运盲盒 / 梦雾纸签 / 情书 / 告白花束 / 星愿水晶球）。
 * 选中后由父级写入 giftId / giftName / giftImg；未点选直接失焦则回退到当前已选礼物。
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { getPlatform } from "@/lib/platform";
import {
  ensureGiftCatalogLoaded,
  getGiftList,
  getRoomGiftData,
} from "@/lib/gift-catalog-client";

/** 默认候选礼物名（聚焦空输入时展示；在候选集中按名称精确匹配取 id/img）。
 *  「绮彩权杖」紧随「心动盲盒」、「梦雾纸签」紧随「幸运盲盒」——即这两款盲盒的爆出礼物。 */
const DEFAULT_CANDIDATES = [
  "心动盲盒",
  "绮彩权杖",
  "幸运盲盒",
  "梦雾纸签",
  "情书",
  "告白花束",
  "星愿水晶球",
];

/** 盲盒爆出的礼物（不在直播间礼物列表中，故需单独按 id 从全量礼物目录回查名称/图标并并入候选）。
 *  来源：public/gift-blindbox.json 两款盲盒的 rewards。 */
const BLINDBOX_GIFT_IDS = [
  32132, 35451, 32282, 32281, 32128, 32126, 32125, // 心动盲盒奖励
  35211, 35210, 35209, 35208, 35311, 35207, // 幸运盲盒奖励
];

/** 一条候选：id + 名称 + 图标（id=0 表示直播间列表中未找到同名礼物，仅展示不可触发） */
export interface GiftPick {
  id: number;
  name: string;
  img: string;
}

/** 扁平输入框（与展示面板里的数量输入框同高，纵向更矮） */
const inputBase =
  "w-full rounded-lg bg-white/70 px-2.5 py-0.5 text-sm text-black/80 outline-none transition focus:bg-white focus:ring-2 focus:ring-[#1f1c17]/15";

/**
 * 候选集：当前直播间礼物列表（roomGiftList 的 gold_list 顺序，gift_id）+ 盲盒爆出礼物，
 * 均按 id 从本地全量礼物目录回查名称与图标（列表条目本身不含名称/图标）。
 */
function roomPicks(): GiftPick[] {
  const byId = new Map<number, { name: string; img: string }>();
  for (const g of getGiftList()) {
    if (g.id && g.name && !byId.has(g.id)) {
      byId.set(g.id, { name: g.name, img: g.img_basic || g.webp || g.gif || "" });
    }
  }
  const out: GiftPick[] = [];
  const seen = new Set<number>();
  const add = (id: number) => {
    if (!id || seen.has(id)) return;
    const hit = byId.get(id);
    if (!hit) return; // 目录中无该 id 的名称/图标则跳过
    seen.add(id);
    out.push({ id, name: hit.name, img: hit.img });
  };
  const ids = getRoomGiftData()?.room_gift_list?.gold_list?.map((g) => g.gift_id) ?? [];
  for (const id of ids) add(id);
  // 盲盒爆出礼物不在直播间礼物列表中，单独按 id 从全量目录补充进可搜索候选
  for (const id of BLINDBOX_GIFT_IDS) add(id);
  return out;
}

/** 在直播间礼物列表中按名称精确/模糊匹配（最多 6 条） */
function searchByName(query: string): GiftPick[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const exact: GiftPick[] = [];
  const fuzzy: GiftPick[] = [];
  for (const g of roomPicks()) {
    const name = g.name.toLowerCase();
    if (name === q) exact.push(g);
    else if (name.includes(q)) fuzzy.push(g);
  }
  return [...exact, ...fuzzy].slice(0, 6);
}

/** 默认候选：按名称在直播间礼物列表中精确匹配（找不到的仍列出，但 id=0） */
function defaultCandidates(): GiftPick[] {
  const byName = new Map<string, GiftPick>();
  for (const g of roomPicks()) {
    if (!byName.has(g.name)) byName.set(g.name, g);
  }
  return DEFAULT_CANDIDATES.map((name) => byName.get(name) ?? { id: 0, name, img: "" });
}

export default function GiftSearchInput({
  giftName,
  onPick,
  placeholder = "输入礼物名称搜索",
  className = "",
}: {
  /** 当前已选礼物名称（受控显示值） */
  giftName: string;
  /** 点击候选后回调（父级据此写入 giftId / giftName / giftImg） */
  onPick: (g: GiftPick) => void;
  placeholder?: string;
  className?: string;
}) {
  // 输入框"编辑态"文本：输入即时跟随，未点选候选则失焦回退到已选礼物名
  const [text, setText] = useState(giftName);
  const [open, setOpen] = useState(false);
  const [ready, setReady] = useState(false);
  const pickedRef = useRef(false);

  // 外部（磁盘配置 / 其他入口）变更已选礼物时同步回输入框（渲染期派生，避免额外的 effect 往返）
  const [lastGiftName, setLastGiftName] = useState(giftName);
  if (lastGiftName !== giftName) {
    setLastGiftName(giftName);
    setText(giftName);
  }

  // 拉取本地礼物目录（12h TTL），就绪后刷新候选
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        await ensureGiftCatalogLoaded(await getPlatform());
        if (alive) setReady(true);
      } catch {
        /* 目录加载失败：无候选，用户仍可手输 */
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const options = useMemo(() => {
    if (!ready) return [];
    const q = text.trim();
    return q ? searchByName(q) : defaultCandidates();
  }, [ready, text]);

  const emptyHint = text.trim() ? "未找到匹配的礼物" : "";

  return (
    <div className={`relative ${className}`}>
      <input
        type="text"
        value={text}
        placeholder={placeholder}
        onChange={(e) => {
          pickedRef.current = false;
          setText(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => {
          setTimeout(() => {
            setOpen(false);
            // 未点选候选 → 放弃输入内容，回退到当前已选礼物
            if (!pickedRef.current) setText(giftName);
          }, 200);
        }}
        className={inputBase}
      />
      {open && (
        <div className="absolute left-0 right-0 z-20 mt-1 rounded-lg border border-black/10 bg-white shadow-lg max-h-56 overflow-y-auto">
          {!ready ? (
            <div className="px-2.5 py-2 text-xs text-black/40">礼物目录加载中…</div>
          ) : options.length > 0 ? (
            options.map((g) => (
              <button
                key={`${g.id}-${g.name}`}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  pickedRef.current = true;
                  onPick(g);
                  setText(g.name);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition hover:bg-black/5"
              >
                {g.img ? (
                  <img src={g.img} alt="" className="h-6 w-6 shrink-0 rounded" />
                ) : (
                  <span className="h-6 w-6 shrink-0 rounded bg-black/10" />
                )}
                <span className="truncate text-black/75">{g.name}</span>
                <span className="ml-auto shrink-0 text-[10px] text-black/35">
                  {g.id > 0 ? `id:${g.id}` : "未收录"}
                </span>
              </button>
            ))
          ) : (
            <div className="px-2.5 py-2 text-xs text-black/40">
              {emptyHint || "未找到匹配的礼物"}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
