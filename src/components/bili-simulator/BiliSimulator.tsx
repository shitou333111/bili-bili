"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import GiftPanel from "./GiftPanel";
import AlphaVideoPlayer from "./AlphaVideoPlayer";
import ComboNotification from "./ComboNotification";
import type { Gift, EffectConfig, GiftEffectInfo } from "./types";
import { useActivities } from "./activities/registry";
import { openActivityNative, closeActivityNative, isTauriRuntime } from "./activities/native";
import { readActivityState, writeActivityState, type BagGift } from "./activityState";
import LiveStreamBackground from "./LiveStreamBackground";
import type { StreamerInfo } from "./liveStream";

const COMBO_TIMEOUT = 5000; // 5秒连击窗口
const QUICK_GIFT_ID = 33988; // 人气票

export default function BiliSimulator({ onBack, userName, streamerInfo }: { onBack: () => void; userName?: string; streamerInfo?: StreamerInfo | null }) {
  const [giftPanelOpen, setGiftPanelOpen] = useState(false);
  const [currentGift, setCurrentGift] = useState<Gift | null>(null);
  const [comboGift, setComboGift] = useState<Gift | null>(null);
  const [comboHits, setComboHits] = useState(0);
  const [comboMultiplier, setComboMultiplier] = useState(1);
  const [comboProgress, setComboProgress] = useState(0);
  const [showFloatingCombo, setShowFloatingCombo] = useState(false);
  // 原生活动面板（桌面子 WebView 下方 3/4 / 移动端窗口）是否打开：仅此时显示顶部遮罩
  const [nativePanelOpen, setNativePanelOpen] = useState(false);
  const { activities: activityConfigs } = useActivities();
  const [gifts, setGifts] = useState<Gift[]>([]);
  const [tabGifts, setTabGifts] = useState<Record<string, Gift[] | BagGift[]>>({ gift: [], fans: [], voyage: [], bag: [], all: [] });
  const [effectInfoMap, setEffectInfoMap] = useState<Map<number, GiftEffectInfo>>(new Map());
  const [loading, setLoading] = useState(true);
  const [playingEffect, setPlayingEffect] = useState<{ src: string; config: EffectConfig | null } | null>(null);
  const [blindboxConfig, setBlindboxConfig] = useState<Record<string, any>>({});
  // 多条送礼横幅队列（最多3条同时显示；新礼物到达时顶出最早的横幅）
  const [notices, setNotices] = useState<{ uid: number; gift: Gift; count: number; visible: boolean; evicting: boolean }[]>([]);
  const noticeUidRef = useRef(0);

  const comboTimerRef = useRef<number | null>(null);
  const progressTimerRef = useRef<number | null>(null);
  const comboStartTimeRef = useRef<number>(0);
  const isPlayingEffectRef = useRef(false);
  // 活动（山海工坊）本地状态：槽位抽取状态 + 包裹合成礼物（用于持久化与还原）
  const slotStateRef = useRef<Record<string, number>>({});
  const bagGiftsRef = useRef<BagGift[]>([]);

  // 最终显示的连击数 = 连击次数 * 单次倍数
  const comboCount = comboHits * comboMultiplier;

  // 加载礼物数据和特效配置
  useEffect(() => {
    async function loadData() {
      try {
        const [giftListRes, effectsRes] = await Promise.all([
          fetch("/gift-list.json"),
          fetch("/gift-effects.json"),
        ]);
        const giftListData = await giftListRes.json();
        const effectsData = await effectsRes.json();

        // 解析礼物列表
        const list = giftListData?.data?.list || [];
        const parsedGifts: Gift[] = list.map((g: any) => ({
          id: g.id,
          name: g.name,
          price: g.price / 100,
          img: g.img_basic || g.webp || g.gif,
          effect_id: g.effect_id,
          corner_mark: g.corner_mark,
          corner_background: g.corner_background,
          bag_gift: g.bag_gift,
          coin_type: g.coin_type,
        }));
        setGifts(parsedGifts);

        // 构建礼物ID到礼物对象映射
        const giftById = new Map<number, Gift>();
        parsedGifts.forEach((g) => giftById.set(g.id, g));

        // 加载固定直播间的礼物面板数据
        let roomData: any = null;
        try {
          const roomRes = await fetch("/room-gift-list.json");
          if (roomRes.ok) roomData = await roomRes.json();
        } catch (e) {
          console.warn("加载直播间礼物列表失败:", e);
        }

        // 加载额外礼物ID配置（追加到"礼物"选项卡）
        let extraGiftIds: number[] = [];
        try {
          const extraRes = await fetch("/gift-extra-ids.json");
          if (extraRes.ok) extraGiftIds = await extraRes.json();
        } catch (e) {
          console.warn("加载额外礼物配置失败:", e);
        }

        const roomList = roomData?.data?.gift_data?.room_gift_list;
        const goldIds: number[] = (roomList?.gold_list || []).map((g: any) => g.gift_id);
        const fansIds: number[] = [];
        const voyageIds: number[] = [];
        // tab_list 在 data.gift_data.tab_list（不在 room_gift_list 下）
        (roomData?.data?.gift_data?.tab_list || []).forEach((tab: any) => {
          const ids = (tab.list || []).map((g: any) => g.gift_id);
          if (tab.tab_id === 9) fansIds.push(...ids);
          else if (tab.tab_id === 2) voyageIds.push(...ids);
        });

        const pickByIds = (ids: number[]): Gift[] =>
          ids.map((id) => giftById.get(id)).filter((g): g is Gift => !!g);
        const allGifts = parsedGifts.filter((g) => g.bag_gift === 1 && g.coin_type === "gold");

        // "礼物"选项卡 = gold_list 礼物 + 配置的额外礼物（去重）
        const giftTabGifts = pickByIds([...goldIds, ...extraGiftIds]);
        const giftTabIds = new Set(giftTabGifts.map((g) => g.id));

        setTabGifts({
          gift: giftTabGifts,
          fans: pickByIds(fansIds).filter((g) => !giftTabIds.has(g.id)),
          voyage: pickByIds(voyageIds),
          bag: [],
          all: allGifts,
        });

        // 加载盲盒配置
        try {
          const bbRes = await fetch("/gift-blindbox.json");
          if (bbRes.ok) setBlindboxConfig(await bbRes.json());
        } catch (e) {
          console.warn("加载盲盒配置失败:", e);
        }

        // 构建礼物ID到特效信息的映射（包含web_mp4_json）
        const eMap = new Map<number, GiftEffectInfo>();
        if (effectsData?.data?.full_sc_resource?.conf_list) {
          for (const conf of effectsData.data.full_sc_resource.conf_list) {
            if (conf.bind_gift_ids && conf.web_mp4) {
              for (const giftId of conf.bind_gift_ids) {
                eMap.set(giftId, {
                  web_mp4: conf.web_mp4,
                  web_mp4_json: conf.web_mp4_json,
                  effect_config: null,
                });
              }
            }
          }
        }

        // 批量获取特效JSON配置
        const jsonUrls = new Set<string>();
        eMap.forEach((info) => {
          if (info.web_mp4_json) jsonUrls.add(info.web_mp4_json);
        });

        const configMap = new Map<string, EffectConfig>();
        await Promise.all(
          [...jsonUrls].map(async (url) => {
            try {
              const res = await fetch(url);
              if (res.ok) {
                const config = await res.json();
                configMap.set(url, config);
              }
            } catch (e) {
              console.warn("获取特效配置失败:", url);
            }
          })
        );

        // 将配置写入map
        eMap.forEach((info, giftId) => {
          if (info.web_mp4_json && configMap.has(info.web_mp4_json)) {
            info.effect_config = configMap.get(info.web_mp4_json) || null;
          }
        });

        setEffectInfoMap(eMap);
      } catch (err) {
        console.error("加载礼物数据失败:", err);
      } finally {
        setLoading(false);
      }
    }
    loadData();
  }, []);

  // 合成礼物入库"包裹"选项卡（按 gift_id 去重，数量+1），并持久化到本地文件。
  const addComposedGift = useCallback(
    (g?: { gift_id: number; gift_name?: string; gift_img?: string; gift_price?: number }) => {
      if (!g || !g.gift_id) return;
      const found = gifts.find((x) => x.id === g.gift_id);
      const base: Gift = found || {
        id: g.gift_id,
        name: g.gift_name || "合成礼物",
        price: (g.gift_price || 0) / 100,
        img: g.gift_img || "",
        effect_id: 0,
      };
      const existing = bagGiftsRef.current.find((b) => b.id === base.id);
      let next: BagGift[];
      if (existing) {
        // 已有同款礼物，数量 +1
        next = bagGiftsRef.current.map((b) =>
          b.id === base.id ? { ...b, count: b.count + 1 } : b
        );
      } else {
        next = [...bagGiftsRef.current, { ...base, count: 1 }];
      }
      bagGiftsRef.current = next;
      setTabGifts((prev) => ({ ...prev, bag: next }));
      writeActivityState({ slot_state: slotStateRef.current, bag_gifts: next });
    },
    [gifts]
  );

  // 恢复活动本地状态（槽位抽取状态 + 包裹礼物），下次打开可还原
  useEffect(() => {
    if (loading || !isTauriRuntime()) return;
    (async () => {
      const st = await readActivityState();
      slotStateRef.current = st.slot_state;
      if (st.bag_gifts.length) {
        bagGiftsRef.current = st.bag_gifts;
        setTabGifts((prev) => ({ ...prev, bag: st.bag_gifts }));
      }
    })();
  }, [loading]);

  // 便捷礼物（人气票）
  const quickGift = useMemo(() => {
    return gifts.find(g => g.id === QUICK_GIFT_ID) || gifts[0];
  }, [gifts]);

  // 是否周五（本地时间）
  const isFriday = useMemo(() => {
    const d = new Date();
    return d.getDay() === 5;
  }, []);

  // 盲盒礼物卡片的 corner_mark 覆盖（非周五 mark / 周五 fridayMark）
  const cornerMarkOverride = useMemo(() => {
    const map: Record<number, string> = {};
    Object.entries(blindboxConfig).forEach(([id, cfg]) => {
      map[Number(id)] = isFriday ? cfg.fridayMark : cfg.mark;
    });
    return map;
  }, [blindboxConfig, isFriday]);

  // 根据盲盒概率抽取具体礼物
  const rollBlindbox = useCallback(
    (giftId: number): Gift | null => {
      const cfg = blindboxConfig[giftId];
      if (!cfg) return null;
      const rewards = isFriday ? cfg.fridayRewards : cfg.rewards;
      if (!rewards || rewards.length === 0) return null;
      const total = rewards.reduce((s: number, r: any) => s + r.prob, 0);
      let rand = Math.random() * total;
      let picked: any = rewards[rewards.length - 1];
      for (const r of rewards) {
        rand -= r.prob;
        if (rand <= 0) {
          picked = r;
          break;
        }
      }
      // 从目录中查找完整礼物信息（含图标），找不到则回退为仅 id/name
      const found = gifts.find((g) => g.id === picked.id);
      return (
        found || {
          id: picked.id,
          name: picked.name,
          price: 0,
          img: "",
          effect_id: 0,
        }
      );
    },
    [blindboxConfig, isFriday, gifts]
  );

  // 横幅队列：让未显示的横幅按顺序提升为可见，最多3条同时可见
  const promoteNotices = useCallback(
    (list: { uid: number; gift: Gift; count: number; visible: boolean; evicting: boolean }[]) => {
      let visible = list.filter((n) => n.visible && !n.evicting).length;
      if (visible >= 3) return list;
      return list.map((n) => {
        if (visible >= 3) return n;
        if (n.visible) return n;
        visible += 1;
        return { ...n, visible: true, evicting: false };
      });
    },
    []
  );

  // 新增或更新一条横幅（同礼物连击累加；新礼物在满3条时顶出最早的横幅）
  const addNotice = useCallback(
    (gift: Gift, count: number) => {
      setNotices((prev) => {
        const existing = prev.find((n) => n.gift.id === gift.id);
        if (existing) {
          return promoteNotices(
            prev.map((n) => (n.gift.id === gift.id ? { ...n, count: n.count + count } : n))
          );
        }
        let next = [
          ...prev,
          { uid: noticeUidRef.current++, gift, count, visible: false, evicting: false },
        ];
        // 已满3条：把最早的可见横幅置为顶出状态（滑出后移除）
        const visibleCount = next.filter((n) => n.visible && !n.evicting).length;
        if (visibleCount >= 3) {
          const oldestIdx = next.findIndex((n) => n.visible && !n.evicting);
          if (oldestIdx >= 0) {
            next[oldestIdx] = { ...next[oldestIdx], evicting: true };
          }
        }
        return promoteNotices(next);
      });
    },
    [promoteNotices]
  );

  // 移除一条横幅（自动腾出位置给排队中的下一条）
  const dismissNotice = useCallback(
    (uid: number) => {
      setNotices((prev) => promoteNotices(prev.filter((n) => n.uid !== uid)));
    },
    [promoteNotices]
  );

  // 清理连击计时器
  const clearComboTimers = useCallback(() => {
    if (comboTimerRef.current) {
      clearTimeout(comboTimerRef.current);
      comboTimerRef.current = null;
    }
    if (progressTimerRef.current) {
      cancelAnimationFrame(progressTimerRef.current);
      progressTimerRef.current = null;
    }
  }, []);

  // 重置连击状态
  const resetCombo = useCallback(() => {
    clearComboTimers();
    setComboHits(0);
    setComboProgress(0);
    setComboMultiplier(1);
    setShowFloatingCombo(false);
    setComboGift(null);
    setNotices([]);
  }, [clearComboTimers]);

  // 开始/更新连击（内部方法）
  const startComboProgress = useCallback((gift: Gift, multiplier: number, isNew: boolean) => {
    if (isNew) {
      setComboGift(gift);
      setComboHits(1);
      setComboMultiplier(multiplier);
    } else {
      setComboHits(h => h + 1);
    }

    comboStartTimeRef.current = Date.now();
    setComboProgress(1);

    const updateProgress = () => {
      const elapsed = Date.now() - comboStartTimeRef.current;
      const remaining = Math.max(0, 1 - elapsed / COMBO_TIMEOUT);
      setComboProgress(remaining);
      if (remaining > 0) {
        progressTimerRef.current = requestAnimationFrame(updateProgress);
      } else {
        // 倒计时结束，重置连击
        resetCombo();
      }
    };
    if (progressTimerRef.current) cancelAnimationFrame(progressTimerRef.current);
    progressTimerRef.current = requestAnimationFrame(updateProgress);

    if (comboTimerRef.current) clearTimeout(comboTimerRef.current);
    comboTimerRef.current = window.setTimeout(() => {
      resetCombo();
    }, COMBO_TIMEOUT);
  }, [resetCombo]);

  // 触发送礼（count: 单次数量）
  const triggerGift = useCallback((gift: Gift, count: number = 1) => {
    // 包裹礼物：送出后扣减库存，库存归零则从包裹移除
    const bagGift = bagGiftsRef.current.find((b) => b.id === gift.id);
    if (bagGift) {
      const newCount = Math.max(0, bagGift.count - count);
      const next = newCount > 0
        ? bagGiftsRef.current.map((b) => (b.id === gift.id ? { ...b, count: newCount } : b))
        : bagGiftsRef.current.filter((b) => b.id !== gift.id);
      bagGiftsRef.current = next;
      setTabGifts((prev) => ({ ...prev, bag: next }));
      writeActivityState({ slot_state: slotStateRef.current, bag_gifts: next });
    }
    // 连击身份始终是被点击的礼物（盲盒保持"盲盒连击"状态）
    const comboIdentity = gift;
    const isBlindbox = !!blindboxConfig[gift.id];

    let effectGift: Gift | null = null;

    if (isBlindbox && count > 1) {
      // 批量盲盒：送出的每一个礼物都独立按概率抽取，按爆出结果聚合，逐类生成横幅
      const popCounts = new Map<number, number>();
      for (let i = 0; i < count; i++) {
        const popped = rollBlindbox(gift.id);
        if (popped) {
          popCounts.set(popped.id, (popCounts.get(popped.id) || 0) + 1);
          // 记录第一个带专属动画的爆出礼物（用于播放特效/自动收起礼物栏）
          if (!effectGift && effectInfoMap.has(popped.id)) effectGift = popped;
        }
      }
      popCounts.forEach((n, pid) => {
        const pg = gifts.find((g) => g.id === pid);
        if (pg) addNotice(pg, n);
      });
    } else {
      // 单个盲盒：抽取一次；非盲盒：直接用原礼物
      let noticeGift = gift;
      if (isBlindbox) {
        const popped = rollBlindbox(gift.id);
        if (popped) noticeGift = popped;
      }
      effectGift = noticeGift;
      addNotice(noticeGift, count);
    }

    const hasEffect = effectGift ? effectInfoMap.has(effectGift.id) : false;
    const isNewCombo = !comboGift || comboGift.id !== comboIdentity.id;

    startComboProgress(comboIdentity, count, isNewCombo);

    // 清除选中状态
    setCurrentGift(null);

    // 大礼物特效逻辑：只播放一次，播放中不触发新的
    if (hasEffect && !isPlayingEffectRef.current) {
      isPlayingEffectRef.current = true;
      const effectInfo = effectInfoMap.get(effectGift!.id);
      setPlayingEffect({
        src: effectInfo!.web_mp4,
        config: effectInfo!.effect_config || null,
      });
      // 大礼物自动关闭礼物面板，显示悬浮连击按钮
      setGiftPanelOpen(false);
      setShowFloatingCombo(true);
    }
  }, [comboGift, effectInfoMap, startComboProgress, blindboxConfig, rollBlindbox, addNotice, gifts]);

  const handleEffectEnded = useCallback(() => {
    isPlayingEffectRef.current = false;
    setPlayingEffect(null);
  }, []);

  const selectGift = useCallback((gift: Gift) => {
    setCurrentGift(gift);
  }, []);

  // 发送指定礼物（长按数量/点击选中卡片投喂）
  const sendGiftFor = useCallback((gift: Gift, count: number) => {
    triggerGift(gift, count);
  }, [triggerGift]);

  // 连击状态下点击（继续连击）
  const handleComboClick = useCallback(() => {
    if (comboGift) {
      triggerGift(comboGift, comboMultiplier);
    }
  }, [comboGift, comboMultiplier, triggerGift]);

  const toggleGiftPanel = useCallback(() => {
    setGiftPanelOpen(o => !o);
  }, []);

  const handleQuickGiftClick = useCallback(() => {
    if (quickGift) {
      triggerGift(quickGift, 1);
    }
  }, [quickGift, triggerGift]);

  useEffect(() => {
    return () => clearComboTimers();
  }, [clearComboTimers]);

  // 当前活动（配置中第一个启用的活动，单活动不滑动）
  // 如果有主播信息，覆盖 room_id 和 uid 为当前主播的
  const activeActivity = useMemo(() => {
    const base = activityConfigs[0] ?? null;
    if (!base || !streamerInfo) return base;
    return {
      ...base,
      params: {
        ...base.params,
        roomId: streamerInfo.roomId,
        uid: streamerInfo.uid,
        anchorName: streamerInfo.uname,
      },
    };
  }, [activityConfigs, streamerInfo]);

  // 点击活动入口：仅原生客户端用原生 WebView 面板打开真实 H5（注入 mock）。
  // 浏览器/Web 不使用本地复刻方案（按需求不再维护复刻页），活动体验即"模拟"页面本身。
  const handleActivityCardClick = useCallback(async () => {
    if (!activeActivity) return;
    if (!isTauriRuntime()) return;
    // 把上次保存的槽位抽取状态传给原生层，活动页打开即可还原
    const opened = await openActivityNative(activeActivity, slotStateRef.current);
    if (opened) {
      // 原生面板打开后，前端只需显示顶部遮罩（点击关闭），底部面板由原生子 WebView 承载
      setNativePanelOpen(true);
    }
  }, [activeActivity]);

  // 关闭原生活动面板（顶部遮罩点击时调用）
  const handleCloseActivity = useCallback(async () => {
    setNativePanelOpen(false);
    await closeActivityNative();
  }, []);

  // 监听原生面板关闭事件（返回按钮 / 原生层主动关闭）同步前端状态
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      if (!isTauriRuntime()) return;
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen("activity-panel-closed", () => {
        setNativePanelOpen(false);
      });
    })();
    return () => {
      unlisten?.();
    };
  }, []);

  // 监听活动面板状态事件：
  //  - activity-slot-sync：槽位抽取/替换后同步状态，前端持久化到本地文件
  //  - activity-compose：合成成功后把礼物放入"包裹"选项卡并持久化
  useEffect(() => {
    if (!isTauriRuntime()) return;
    let unlisteners: Array<() => void> = [];
    (async () => {
      const { listen } = await import("@tauri-apps/api/event");
      const un1 = await listen<{ slots: Record<string, number> }>("activity-slot-sync", (e) => {
        slotStateRef.current = e.payload?.slots || {};
        writeActivityState({
          slot_state: slotStateRef.current,
          bag_gifts: bagGiftsRef.current,
        });
      });
      const un2 = await listen<{
        gift: { gift_id: number; gift_name?: string; gift_img?: string; gift_price?: number };
      }>("activity-compose", (e) => {
        addComposedGift(e.payload?.gift);
      });
      unlisteners = [un1, un2];
    })();
    return () => {
      unlisteners.forEach((u) => u());
    };
  }, [addComposedGift]);

  // 悬浮连击按钮环形进度
  const floatRingR = 25;
  const floatRingC = 2 * Math.PI * floatRingR;

  if (loading) {
    return (
      <div className="fixed inset-0 z-[9999] bg-[#2B1F2B] flex items-center justify-center" style={{ maxWidth: "var(--page-max-width)", margin: "0 auto" }}>
        <div className="text-white/60">加载中...</div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[9999] bg-[#2B1F2B] flex flex-col overflow-hidden" style={{ maxWidth: "var(--page-max-width)", margin: "0 auto", paddingTop: "var(--safe-top, 0px)" }}>
      {/* 直播流背景（最底层） */}
      {streamerInfo && <LiveStreamBackground roomId={streamerInfo.roomId} />}
      {!streamerInfo && <div className="absolute inset-0 bg-[#2B1F2B]" />}

      {/* 顶部栏 */}
      <div className="relative z-30 flex items-center px-3 pt-3 pb-2">
        <button
          onClick={onBack}
          className="w-8 h-8 flex items-center justify-center rounded-full bg-black/20 backdrop-blur-sm z-10"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" opacity="0.95">
            <path strokeLinecap="round" strokeLinejoin="round" d="M15 19l-7-7 7-7" />
          </svg>
        </button>

        {/* 主播胶囊badge - 使用当前主播头像和昵称 */}
        <div
          className="flex items-center rounded-full pl-0.5 pr-3 ml-2"
          style={{ backgroundColor: "rgba(119, 108, 112, 0.5)", height: "26px" }}
        >
          <div className="w-[22px] h-[22px] rounded-full overflow-hidden flex items-center justify-center bg-gradient-to-br from-pink-400 to-purple-500">
            {streamerInfo?.face ? (
              <img src={streamerInfo.face} alt="" className="w-full h-full object-cover" />
            ) : (
              <span className="text-white text-xs">📺</span>
            )}
          </div>
          <div className="ml-1.5">
            <div className="text-white text-[11px] font-medium leading-none">
              {streamerInfo?.uname || "主播昵称"}
            </div>
          </div>
        </div>
      </div>

      <div className="flex-1 relative z-10" />

      {/* 大礼物特效 - 在活动卡片/横幅之上，礼物面板之下，可遮住横幅 */}
      {playingEffect && (
        <div className="absolute inset-0 z-[25] pointer-events-none">
          <AlphaVideoPlayer
            src={playingEffect.src}
            config={playingEffect.config}
            onEnded={handleEffectEnded}
          />
        </div>
      )}

      {/* 连击长条通知队列 - 最多3条同时显示；新的从底部出现，旧的往上移，最老的从顶部隐去 */}
      {notices.filter((n) => n.visible).map((n, idx, arr) => (
        <ComboNotification
          key={n.uid}
          gift={n.gift}
          count={n.count}
          stackIndex={arr.length - 1 - idx}
          evicting={n.evicting}
          userName={userName}
          isPanelOpen={giftPanelOpen}
          isAnimating={!!playingEffect}
          onDismiss={() => dismissNotice(n.uid)}
        />
      ))}

      {/* 右下角悬浮连击按钮 - 在特效上方，可点击 */}
      {showFloatingCombo && comboGift && comboProgress > 0 && (
        <button
          onClick={handleComboClick}
          className="absolute right-4 bottom-24 z-50 w-[64px] h-[64px] flex items-center justify-center"
        >
          {/* 粉色填充圆 - 一体 */}
          <div
            className="absolute inset-0 rounded-full"
            style={{
              background: "linear-gradient(180deg, #FF7B9F 0%, #F04A7D 100%)",
            }}
          />
          {/* 单个白色倒计时光环 - 不贴边露出粉色边缘 */}
          <svg className="absolute inset-0 -rotate-90" width="64" height="64">
            <circle
              cx="32"
              cy="32"
              r={floatRingR}
              fill="none"
              stroke="white"
              strokeWidth="3.5"
              strokeLinecap="butt"
              strokeDasharray={floatRingC}
              strokeDashoffset={floatRingC * (1 - comboProgress)}
            />
          </svg>
          <img
            src={comboGift.img}
            alt={comboGift.name}
            className="relative z-10 w-8 h-8 object-contain"
          />
          <span className="absolute bottom-1.5 z-10 text-white text-[11px] font-bold drop-shadow-md">
            x{comboCount}
          </span>
        </button>
      )}

      {/* 活动入口卡片 - 单活动不滑动，仅显示图片；高度按图片宽高比自适应 */}
      <div className="absolute right-3 bottom-20 z-20" style={{ display: showFloatingCombo && comboGift ? "none" : "block" }}>
        {activeActivity && (
          <button
            className="relative block rounded-lg overflow-hidden shadow-lg bg-black/40"
            onClick={handleActivityCardClick}
          >
            <img
              src={activeActivity.entryImage}
              alt=""
              className="block w-20 h-auto object-contain"
            />
          </button>
        )}
      </div>

      {/* 底部栏 - 更扁 */}
      <div className="relative z-30 px-3 pb-2.5 pt-1.5">
        <div className="flex items-center gap-2">
          {/* 聊天输入框 */}
          <div className="flex-1 h-8 bg-white/10 backdrop-blur-sm rounded-full flex items-center px-3.5">
            <span className="text-white/50 text-xs">弹幕支持下～</span>
            <button className="ml-auto">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="#FFD700">
                <circle cx="12" cy="12" r="10" />
                <path d="M8 14s1.5 2 4 2 4-2 4-2" stroke="black" strokeWidth="1.5" fill="none" strokeLinecap="round" />
                <circle cx="9" cy="10" r="1" fill="black" />
                <circle cx="15" cy="10" r="1" fill="black" />
              </svg>
            </button>
          </div>

          {/* 便捷礼物按钮（人气票）- 连击状态下隐藏 */}
          {quickGift && !(showFloatingCombo && comboGift?.id === quickGift.id) && (
            <button
              onClick={handleQuickGiftClick}
              className="w-9 h-9 shrink-0 relative flex items-center justify-center"
            >
              <div className="absolute inset-0 rounded-full bg-white/15" />
              <img
                src={quickGift.img}
                alt={quickGift.name}
                className="w-6 h-6 object-contain relative z-10"
                style={{ filter: "drop-shadow(0 2px 4px rgba(0,0,0,0.3))" }}
              />
            </button>
          )}

          {/* 礼物按钮 */}
          <button
            onClick={toggleGiftPanel}
            className="w-9 h-9 shrink-0 flex items-center justify-center relative"
          >
            <div className="absolute inset-0 rounded-full bg-white/15" />
            <img
              src="/gift-icon.webp"
              alt="礼物"
              className="w-7 h-7 object-contain relative z-10"
            />
          </button>
        </div>
      </div>

      <GiftPanel
        isOpen={giftPanelOpen}
        onClose={() => setGiftPanelOpen(false)}
        tabGifts={tabGifts}
        selectedGift={currentGift}
        comboGift={!showFloatingCombo ? comboGift : null}
        comboProgress={comboProgress}
        comboCount={comboCount}
        onSelectGift={selectGift}
        onSendGiftFor={sendGiftFor}
        onComboClick={handleComboClick}
        balance={10000}
        cornerMarkOverride={cornerMarkOverride}
      />

      {/* 活动原生面板顶部遮罩 - 原生面板占据下方 3/4，遮罩覆盖上方 1/4，点击关闭（同礼物面板交互） */}
      {nativePanelOpen && (
        <div
          className="absolute inset-x-0 top-0 z-[40] transition-opacity duration-300"
          style={{ height: "25%", backgroundColor: "rgba(0,0,0,0.35)" }}
          onClick={handleCloseActivity}
        />
      )}
    </div>
  );
}
