"use client";

/**
 * 信息面板：画布上方横向半透明长条（有一点圆角），位于「收到的礼物展示」上方。
 *
 * 包含四类可独立勾选的元素，按「停留秒数」轮换显示（只显示一个）：
 * 1. 榜一信息：昨日 / 本周 / 上周 / 本月 / 上月（每个日期单独一屏：时段 + 头像 + 昵称）
 * 2. PK任务：首胜状态 + 有效场次 + 有效胜场；随机PK时后两项替换为对方首胜状态
 * 3. 心动盲盒：周六~周四显示收集进度（到下一阶梯目标），周五显示开盒数/盈亏/城堡图标/爆率
 * 4. 加班机：下播倒计时（送礼增加 / 减少时长）
 * 5. 自定义标语：单行文字（最多 10 字，为空时不显示）
 *
 * 面板宽高固定（214×44），保证轮换时尺寸不跳动；首尾元素分别贴左右边，中间按语义分组排布。
 * 数据由主窗口弹幕服务拉取后经 WS 下发；本组件只负责渲染与轮换（切换时向上滑动）。
 */
import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import {
  INFO_PANEL_RANK_LABELS,
  OVERTIME_INITIAL_MINUTES,
  type InfoPanelConfig,
  type InfoPanelData,
  type InfoPanelRankKey,
} from "@/lib/display/types";

interface Props {
  config: InfoPanelConfig;
  data: InfoPanelData | null;
  /** 布局编辑模式：无数据时也显示占位内容，便于摆放 */
  placeholder?: boolean;
}

const RANK_KEYS: InfoPanelRankKey[] = [
  "yesterday",
  "thisWeek",
  "lastWeek",
  "thisMonth",
  "lastMonth",
];

const GREEN = "#35d07f"; // 明快绿（高对比）
const RED = "#ff5d5d"; // 明快红（高对比）
const GOLD = "#ffd166";
/** 榜一头像圆环：深黄色（第一名） */
const RANK_RING = "#d6a419";

/** 真实图标兜底（接口未返回时使用，避免出现渐变占位块） */
const BLIND_ICON_FALLBACK =
  "https://s1.hdslb.com/bfs/live/38f645d811537b50873718cecbfd84cd28af50ed.png";
const CASTLE_ICON_FALLBACK =
  "https://s1.hdslb.com/bfs/live/4ee13c275e13b0a7404bd8af035775db3c721b86.png";

/** 头像/图标加载失败时隐藏，避免出现破图 */
function hideOnError(e: SyntheticEvent<HTMLImageElement>) {
  e.currentTarget.style.visibility = "hidden";
}

/** 剩余分钟 → “06 : 08”（两位小时/分钟；冒号由外部控制闪烁） */
function clockParts(minutes: number): { hh: string; mm: string } {
  const total = Math.max(0, Math.round(minutes));
  const h = Math.floor(total / 60);
  const m = total % 60;
  return {
    hh: String(h).padStart(2, "0"),
    mm: String(m).padStart(2, "0"),
  };
}

/** 电池单位 → RMB（除以 10，仅本面板显示用，不带单位，只保留整数） */
function formatRmb(profit: number): string {
  const v = Math.round(profit / 10);
  return `${v >= 0 ? "+" : ""}${v}`;
}

/** 周五：开盒数与盈亏合计位数较多时缩小字号，保证两个数字都能完整显示。
 *  总位数 ≤ 8 用基准字号，每多 1 位缩 1px（最多缩 5px）。 */
function fridayNumberSizes(
  opened: number,
  profit: number,
): { openedSize: number; profitSize: number } {
  const digits =
    String(Math.abs(Math.round(opened))).length +
    String(Math.abs(Math.round(profit / 10))).length;
  const shrink = digits > 8 ? Math.min(5, digits - 8) : 0;
  return { openedSize: 15 - shrink, profitSize: 16 - shrink };
}

/** 城堡图标网格：3-4 个 2 列、5-6 个 3 列、7-9 个九宫格；更多时 4 列紧凑排布；图标随数量缩小 */
function castleLayout(total: number): { cols: number; size: number } {
  if (total <= 2) return { cols: total, size: 26 };
  if (total <= 4) return { cols: 2, size: 18 };
  if (total <= 6) return { cols: 3, size: 16 };
  if (total <= 9) return { cols: 3, size: 12 };
  return { cols: 4, size: 9 };
}

/** 自适应文字：超出可用宽度时按比例缩小字号，保证整段文字完整显示（不省略、不截断）。 */
function FitText({
  text,
  baseSize,
  style,
}: {
  text: string;
  baseSize: number;
  style?: CSSProperties;
}) {
  const ref = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState(baseSize);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // 先用基准字号测量容器可用宽度与文字完整宽度
    el.style.fontSize = `${baseSize}px`;
    const avail = el.clientWidth;
    if (!avail) return;
    if (el.scrollWidth <= avail) {
      setSize(baseSize);
      return;
    }
    // 二分查找能完整放下的最大字号（下限 6px，极端长昵称也保持完整）
    let lo = 6;
    let hi = baseSize;
    for (let i = 0; i < 12; i += 1) {
      const mid = (lo + hi) / 2;
      el.style.fontSize = `${mid}px`;
      if (el.scrollWidth > avail) hi = mid;
      else lo = mid;
    }
    setSize(Math.floor(lo * 10) / 10);
  }, [text, baseSize]);

  return (
    <span
      ref={ref}
      style={{
        ...TEXT,
        ...style,
        fontSize: size,
        whiteSpace: "nowrap",
        overflow: "hidden",
        textOverflow: "clip",
        minWidth: 0,
      }}
    >
      {text}
    </span>
  );
}

function Avatar({ src }: { src?: string }) {
  const ring = `2px solid ${RANK_RING}`;
  if (src) {
    return (
      <img
        src={src}
        alt=""
        onError={hideOnError}
        style={{
          width: 30,
          height: 30,
          borderRadius: "50%",
          objectFit: "cover",
          border: ring,
          boxShadow: "0 0 0 1px rgba(0,0,0,0.18)",
          flex: "0 0 auto",
        }}
      />
    );
  }
  return (
    <div
      style={{
        width: 30,
        height: 30,
        borderRadius: "50%",
        background: "linear-gradient(135deg, rgba(255,255,255,0.38), rgba(255,255,255,0.14))",
        border: ring,
        flex: "0 0 auto",
      }}
    />
  );
}

/** 礼物小图标（加班机增加/减少时长）；无图标时显示浅色占位方块 */
function GiftIcon({ src, sign }: { src?: string; sign: "up" | "down" }) {
  if (src) {
    return (
      <img
        src={src}
        alt=""
        onError={hideOnError}
        style={{ width: 26, height: 26, objectFit: "contain", flex: "0 0 auto" }}
      />
    );
  }
  return (
    <div
      style={{
        width: 26,
        height: 26,
        borderRadius: 7,
        background: "rgba(255,255,255,0.14)",
        border: "1px solid rgba(255,255,255,0.28)",
        color: sign === "up" ? GREEN : RED,
        fontSize: 15,
        fontWeight: 800,
        lineHeight: 1,
        transform: "translateY(0.05em)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        flex: "0 0 auto",
      }}
    >
      {sign === "up" ? "+" : "−"}
    </div>
  );
}

/** 面板内单行内容的基础布局：铺满整条，首尾元素分别贴左右边 */
const frameStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 8,
  width: "100%",
  height: "100%",
};

/** 文本光学垂直居中：CJK 字形在行盒内偏上（下留白更多），
 *  统一收紧行高并下沉约 0.05em 补偿，文字/数字才真正看起来居中。 */
const TEXT: CSSProperties = { lineHeight: 1, transform: "translateY(0.05em)" };

/** 加班机时钟：数字用 tabular-nums，冒号用两个圆点绘制——
 *  不再依赖字体冒号字形，避免冒号与数字竖直位置不一致 / 水平不齐。 */
function Clock({ hh, mm, colonOn }: { hh: string; mm: string; colonOn: boolean }) {
  const digit: CSSProperties = { lineHeight: 1, transform: "translateY(0.04em)" };
  return (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        fontSize: 20,
        fontWeight: 800,
        fontVariantNumeric: "tabular-nums",
        letterSpacing: 0.5,
        lineHeight: 1,
      }}
    >
      <span style={digit}>{hh}</span>
      <span
        style={{
          display: "inline-flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          gap: 4,
          width: 9,
          margin: "0 2px",
          opacity: colonOn ? 1 : 0.2,
          transition: "opacity 0.15s linear",
        }}
      >
        <span style={{ width: 3.5, height: 3.5, borderRadius: 999, background: "currentColor" }} />
        <span style={{ width: 3.5, height: 3.5, borderRadius: 999, background: "currentColor" }} />
      </span>
      <span style={digit}>{mm}</span>
    </span>
  );
}

export default function InfoPanel({ config, data, placeholder }: Props) {
  const opacity = Math.min(100, Math.max(0, Number(config.opacity) || 0));
  const bg: CSSProperties = {
    // 比最初更浅的中灰蓝，半透明可调
    background: `rgba(74, 82, 98, ${(opacity / 100).toFixed(2)})`,
    border: "1px solid rgba(255,255,255,0.16)",
    borderRadius: 10,
    backdropFilter: "blur(16px) saturate(1.4)",
    WebkitBackdropFilter: "blur(16px) saturate(1.4)",
    // 只保留外阴影：去掉顶部内高光，避免上边框看起来比下边框粗
    boxShadow: "0 6px 22px rgba(0,0,0,0.22)",
    color: "#fff",
    fontSize: 17,
    lineHeight: 1,
    whiteSpace: "nowrap",
    textShadow: "0 1px 2px rgba(0,0,0,0.35)",
    // 固定宽高：所有元素/状态使用同一条尺寸，轮换时不跳动
    // 高度收窄以减少上下留白（内容最高约 32px）
    width: 226,
    height: 44,
    padding: "0 6px",
    boxSizing: "border-box",
    overflow: "hidden",
  };

  // 冒号每秒闪烁一次，用于倒计时读秒
  const [colonOn, setColonOn] = useState(true);
  useEffect(() => {
    const timer = setInterval(() => setColonOn((v) => !v), 1000);
    return () => clearInterval(timer);
  }, []);

  const ranks = config.rank?.enabled
    ? RANK_KEYS.filter((k) => config.rank[k]).map((k) => ({
        key: k,
        item: data?.ranks?.find((r) => r.key === k) ?? null,
      }))
    : [];
  const pk = config.pk ? data?.pk ?? null : null;
  const blind = config.blindBox ? data?.blindBox ?? null : null;
  const ot = config.overtime?.enabled ? config.overtime : null;
  const overtime = ot ? data?.overtime ?? null : null;
  const fridaySizes =
    blind?.mode === "friday" ? fridayNumberSizes(blind.opened, blind.profit) : null;

  const frames: Array<{ key: string; node: ReactNode }> = [];

  // ---- 榜一：每个勾选的日期各占一屏（左侧时段只占最窄宽度，右侧头像+昵称在剩余空间内水平居中） ----
  for (const { key, item } of ranks) {
    frames.push({
      key: `rank:${key}`,
      node: (
        <div style={frameStyle}>
          {/* 左：时段（只容纳文字本身，不参与拉伸） */}
          <span
            style={{
              ...TEXT,
              fontSize: 14,
              opacity: 0.8,
              letterSpacing: 0.5,
              flex: "0 0 auto",
              marginRight: 4,
            }}
          >
            {INFO_PANEL_RANK_LABELS[key]}
          </span>
          {/* 右：头像 + 昵称作为整体，在剩余空间内水平居中 */}
          <span
            style={{
              display: "flex",
              alignItems: "center",
              gap: 8,
              flex: "1 1 0",
              minWidth: 0,
              overflow: "hidden",
              justifyContent: "center",
            }}
          >
            <Avatar src={item?.face} />
            <FitText
              text={item?.name || (placeholder ? "虚位以待" : "无")}
              baseSize={18}
              style={{ flex: "0 1 auto", fontWeight: 700 }}
            />
          </span>
        </div>
      ),
    });
  }

  // ---- PK任务（只显示数字，不显示「有效 / 胜场」文字） ----
  if (config.pk) {
    frames.push({
      key: "pk",
      node: (
        // 左右两组向中间靠拢（缩小首胜信息与右侧数字之间的空隙）
        <div style={{ ...frameStyle, justifyContent: "center", gap: 26 }}>
          {/* 左：PK 图标 + 自己的首胜状态 */}
          <span style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
            <img
              src="/pk.png"
              alt="PK"
              onError={hideOnError}
              style={{ width: 26, height: 26, objectFit: "contain", flex: "0 0 auto" }}
            />
            {pk ? (
              <span style={{ ...TEXT, color: pk.selfFirstWin ? GREEN : RED, fontWeight: 700, flex: "0 0 auto" }}>
                {pk.selfFirstWin ? "首胜已打" : "首胜未打"}
              </span>
            ) : (
              <span style={{ ...TEXT, opacity: 0.8 }}>未查询到PK任务</span>
            )}
          </span>
          {/* 右：随机PK 显示对方首胜；平常显示「有效场次 / 胜场」数字（作为一个整体靠右） */}
          {pk ? (
            pk.mode === "random" ? (
              <span
                style={{
                  ...TEXT,
                  color: pk.opponent?.firstWin ? GREEN : RED,
                  fontWeight: 700,
                  flex: "0 0 auto",
                }}
              >
                {pk.opponent?.firstWin ? "对方已打" : "对方未打"}
              </span>
            ) : (
              <span
                style={{
                  ...TEXT,
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  flex: "0 0 auto",
                  opacity: 0.92,
                  fontVariantNumeric: "tabular-nums",
                }}
              >
                <span>
                  {pk.validNum}/{pk.validNeed}
                </span>
                <span>
                  {pk.winNum}/{pk.winNeed}
                </span>
              </span>
            )
          ) : null}
        </div>
      ),
    });
  }

  // ---- 心动盲盒 ----
  if (config.blindBox) {
    frames.push({
      key: "blind",
      node:
        blind?.mode === "friday" ? (
          <div style={frameStyle}>
            {/* 左：盲盒图标 + 倍率 + 开盒数 + 盈亏（作为一个整体靠左） */}
            <span style={{ display: "flex", alignItems: "center", gap: 5, minWidth: 0 }}>
              <img
                src={blind.icon || BLIND_ICON_FALLBACK}
                alt="心动盲盒"
                onError={hideOnError}
                style={{ width: 32, height: 32, objectFit: "contain", flex: "0 0 auto" }}
              />
              {/* 倍率两行显示（上行倍数、下行「倍」），紧跟在盲盒图标右侧 */}
              <span
                style={{
                  ...TEXT,
                  display: "flex",
                  flexDirection: "column",
                  alignItems: "center",
                  fontSize: 13,
                  fontWeight: 700,
                  color: GOLD,
                  flex: "0 0 auto",
                }}
              >
                <span>{blind.multiple}</span>
                <span>倍</span>
              </span>
              <span
                style={{
                  ...TEXT,
                  // 固定左边界：个数很少时盈亏数字也不会贴着图标往左跑
                  minWidth: 42,
                  fontSize: fridaySizes?.openedSize ?? 15,
                  opacity: 0.86,
                  flex: "0 0 auto",
                }}
              >
                {blind.opened}个
              </span>
              <span
                style={{
                  ...TEXT,
                  color: blind.profit >= 0 ? GREEN : RED,
                  fontWeight: 700,
                  fontSize: fridaySizes?.profitSize ?? 16,
                  fontVariantNumeric: "tabular-nums",
                  flex: "0 0 auto",
                }}
              >
                {formatRmb(blind.profit)}
              </span>
            </span>
            {/* 右：城堡图标（靠右） */}
            <span style={{ display: "flex", alignItems: "center", gap: 6, flex: "0 0 auto" }}>
              {(() => {
                // 至少显示 1 个城堡槽位：限额为 0（尚未解锁）时也展示灰色「浪漫城堡」，避免整块缺失
                const total = Math.max(1, blind.limit, blind.castleCount);
                const { cols, size } = castleLayout(total);
                  return (
                    <div
                      style={{
                        display: "grid",
                        gridTemplateColumns: `repeat(${cols}, ${size}px)`,
                        gap: 2,
                        alignContent: "center",
                        flex: "0 0 auto",
                      }}
                    >
                      {Array.from({ length: total }).map((_, i) => {
                        const opened = i < blind.castleCount;
                        // 只有真实开出的城堡（彩色）超出限额时才标记，灰色占位不标记
                        const extra = opened && i >= blind.limit;
                        // 城堡是透明 PNG：直接渲染图片本身，不额外加方形底色；
                        // 未开出的仅做灰度 + 略暗处理（白色过亮会糊成一片）。
                        return (
                          <span
                            key={i}
                            style={{
                              position: "relative",
                              width: size,
                              height: size,
                              flex: "0 0 auto",
                            }}
                          >
                            <img
                              src={blind.castleImg || CASTLE_ICON_FALLBACK}
                              alt="城堡"
                              onError={hideOnError}
                              style={{
                                width: "100%",
                                height: "100%",
                                objectFit: "contain",
                                display: "block",
                                filter: opened ? "none" : "grayscale(1) brightness(0.8)",
                                opacity: opened ? 1 : 0.9,
                              }}
                            />
                            {extra && (
                              <span
                                aria-hidden
                                style={{
                                  position: "absolute",
                                  // 紧贴并压住图标右上角（空间狭窄，星号向内收）
                                  top: -1,
                                  right: -1,
                                  fontSize: Math.max(7, Math.round(size * 0.45)),
                                  lineHeight: 1,
                                  fontWeight: 900,
                                  color: "#ff2d2d",
                                  textShadow: "0 0 2px rgba(0,0,0,0.5)",
                                  pointerEvents: "none",
                                }}
                              >
                                ✱
                              </span>
                            )}
                          </span>
                        );
                      })}
                    </div>
                  );
                })()}
            </span>
          </div>
        ) : (
          <div style={{ ...frameStyle, gap: 10 }}>
            <img
              src={blind?.icon || BLIND_ICON_FALLBACK}
              alt="心动盲盒"
              onError={hideOnError}
              style={{ width: 32, height: 32, objectFit: "contain", flex: "0 0 auto" }}
            />
            <div
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 4,
                flex: "1 1 auto",
                minWidth: 0,
              }}
            >
              <div
                style={{
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  fontSize: 13,
                  gap: 8,
                }}
              >
                <span style={{ ...TEXT, opacity: 0.88, fontVariantNumeric: "tabular-nums" }}>
                  收集进度 {blind?.collected ?? 0}/{blind?.target ?? 20}
                </span>
                <span style={{ ...TEXT, color: GOLD, fontWeight: 700 }}>
                  {blind?.multiple ?? "4"}倍{blind?.limit ?? 1}个
                </span>
              </div>
              <div
                style={{
                  width: "100%",
                  height: 8,
                  borderRadius: 999,
                  background: "rgba(255,255,255,0.2)",
                  overflow: "hidden",
                }}
              >
                <div
                  style={{
                    width: `${
                      blind && blind.target > 0
                        ? Math.min(100, (blind.collected / blind.target) * 100)
                        : 0
                    }%`,
                    height: "100%",
                    borderRadius: 999,
                    background: "linear-gradient(90deg, #ff9a3c, #ffd166)",
                    transition: "width 0.4s ease",
                  }}
                />
              </div>
            </div>
          </div>
        ),
    });
  }

  // ---- 加班机（下播倒计时，冒号每秒闪烁） ----
  if (ot) {
    const { hh, mm } = clockParts(overtime?.remainMinutes ?? OVERTIME_INITIAL_MINUTES);
    frames.push({
      key: "overtime",
      node: (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr auto 1fr",
            alignItems: "center",
            width: "100%",
            height: "100%",
            gap: 6,
          }}
        >
          {/* 左：减少礼物（图标 + 扣减分钟），贴最左 */}
          <span
            style={{ display: "flex", alignItems: "center", gap: 5, justifySelf: "start", minWidth: 0 }}
          >
            <GiftIcon src={ot.decreaseGiftIcon} sign="down" />
            <span style={{ ...TEXT, color: RED, fontWeight: 700, fontSize: 16, flex: "0 0 auto" }}>
              -{ot.decreaseMinutes}分
            </span>
          </span>
          {/* 中：倒计时 */}
          <Clock hh={hh} mm={mm} colonOn={colonOn} />
          {/* 右：增加礼物（加分 + 图标），贴最右 */}
          <span
            style={{ display: "flex", alignItems: "center", gap: 5, justifySelf: "end", minWidth: 0 }}
          >
            <span style={{ ...TEXT, color: GREEN, fontWeight: 700, fontSize: 16, flex: "0 0 auto" }}>
              +{ot.increaseMinutes}分
            </span>
            <GiftIcon src={ot.increaseGiftIcon} sign="up" />
          </span>
        </div>
      ),
    });
  }

  // ---- 自定义标语（勾选且内容非空时参与轮换；单行水平居中） ----
  const slogan = (config.slogan ?? "").trim();
  if (config.sloganEnabled && slogan) {
    frames.push({
      key: "slogan",
      node: (
        <div style={{ ...frameStyle, justifyContent: "center" }}>
          <span
            style={{
              ...TEXT,
              fontSize: 17,
              fontWeight: 700,
              letterSpacing: 0.5,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "clip",
              maxWidth: "100%",
            }}
          >
            {slogan}
          </span>
        </div>
      ),
    });
  }

  // ---- 首胜提醒：随机 PK 最后 30 秒，未取得首胜且己方领先（严格大于）并低于阈值时强提醒 ----
  // 数据来自 PK 弹幕包（pkLive：结束时间 + 双方票数），每秒随冒号闪烁重算一次；
  // 票数实时变化，条件一旦不满足（被追平/反超或达到阈值）警告立即消失。
  const live = data?.pkLive ?? null;
  const warnMsLeft = live ? live.endAt - Date.now() : 0;
  const warnThreshold = Math.max(0, Math.round(Number(config.pkFirstWinWarnVotes) || 0));
  /** 对方今日首胜是否已完成（警告条右侧展示） */
  const oppFirstWin = !!pk?.opponent?.firstWin;
  const pkWarn =
    !!config.pkFirstWinWarn &&
    !!pk &&
    pk.mode === "random" &&
    !pk.selfFirstWin &&
    !!live &&
    warnMsLeft > 0 &&
    warnMsLeft <= 30_000 &&
    live.selfVotes > live.oppVotes &&
    live.selfVotes < warnThreshold;
  if (pkWarn) {
    frames.push({
      key: "pk-warn",
      node: (
        // 左：本场首胜警告；右：对方首胜状态（颜色与 PK 屏一致：已打绿 / 未打红）
        <div style={frameStyle}>
          <span
            style={{
              ...TEXT,
              fontSize: 18,
              fontWeight: 800,
              color: "#ffd400",
              letterSpacing: 0.5,
              whiteSpace: "nowrap",
              animation: "ip-warn-blink 2s ease-in-out infinite",
            }}
          >
            ⚠️本场首胜⚠️
          </span>
          <span
            style={{
              ...TEXT,
              fontSize: 18,
              fontWeight: 800,
              color: oppFirstWin ? GREEN : RED,
              letterSpacing: 0.5,
              whiteSpace: "nowrap",
              animation: "ip-warn-blink 2s ease-in-out infinite",
            }}
          >
            {oppFirstWin ? "对方已打" : "对方未打"}
          </span>
        </div>
      ),
    });
  }

  // 轮换：每 dwellSeconds 秒切到下一个元素；只有一个元素时不动。
  // turn 同时记录上一条，用于播放「旧内容向上滑出、新内容从下方滑入」的动画。
  const count = frames.length;
  const dwell = Math.max(1, Math.round(Number(config.dwellSeconds) || 10));
  const [turn, setTurn] = useState({ idx: 0, prev: -1 });
  /** 每次强制跳转 +1，用于重置轮换计时（保证 PK 屏能完整停留一个周期） */
  const [cycle, setCycle] = useState(0);
  const current = count > 0 ? turn.idx % count : 0;
  const prev = count > 0 ? turn.prev % count : -1;
  /** 首胜警告帧下标（激活时追加在末尾）：激活期间冻结轮换，保持警告常驻直到 PK 结束 */
  const warnIdx = frames.findIndex((f) => f.key === "pk-warn");
  useEffect(() => {
    if (count <= 1 || warnIdx >= 0) return;
    const timer = setInterval(
      () => setTurn((t) => ({ idx: (t.idx + 1) % count, prev: t.idx % count })),
      dwell * 1000,
    );
    return () => clearInterval(timer);
  }, [count, dwell, cycle, warnIdx]);

  // PK 开始（识别到对方首胜状态）时立即切到 PK 屏，不等到下一次轮换
  const pkIdx = frames.findIndex((f) => f.key === "pk");
  const pkActive = !!data?.pk?.opponent;
  useEffect(() => {
    if (!pkActive || pkIdx < 0) return;
    setTurn((t) => {
      const cur = count > 0 ? t.idx % count : 0;
      return cur === pkIdx ? t : { idx: pkIdx, prev: cur };
    });
    setCycle((c) => c + 1);
  }, [pkActive, pkIdx, count]);

  // 首胜警告激活 → 立即切到警告屏（并重置停留计时）
  useEffect(() => {
    if (warnIdx < 0) return;
    setTurn((t) => {
      const cur = count > 0 ? t.idx % count : 0;
      return cur === warnIdx ? t : { idx: warnIdx, prev: cur };
    });
    setCycle((c) => c + 1);
  }, [warnIdx, count]);

  if (count === 0) {
    if (!placeholder) return null;
    return (
      <div style={bg}>
        <div style={{ ...frameStyle, justifyContent: "center" }}>
          <span style={{ ...TEXT, opacity: 0.7, fontSize: 13 }}>请在面板勾选要显示的元素</span>
        </div>
      </div>
    );
  }

  return (
    <div style={bg}>
      {/* 轮换动画：旧内容向上滑出，新内容从下方滑入 */}
      <style>{`
        @keyframes ip-slide-in {
          from { transform: translateY(100%); opacity: 0; }
          to { transform: translateY(0); opacity: 1; }
        }
        @keyframes ip-slide-out {
          from { transform: translateY(0); opacity: 1; }
          to { transform: translateY(-100%); opacity: 0; }
        }
        @keyframes ip-warn-blink {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.1; }
        }
      `}</style>
      {/* 用 grid 把所有元素叠在同一格：宽高固定，轮换时面板尺寸不跳动 */}
      <div
        style={{
          display: "grid",
          // 单列强制为容器宽度：避免长昵称把隐式列撑到 max-content（内部横向溢出）
          gridTemplateColumns: "minmax(0, 1fr)",
          width: "100%",
          height: "100%",
        }}
      >
        {frames.map((f, i) => (
          <div
            key={f.key}
            aria-hidden={i !== current}
            style={{
              gridArea: "1 / 1",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              minWidth: 0,
              height: "100%",
              overflow: "hidden",
              transform: "translateY(100%)",
              opacity: 0,
              pointerEvents: "none",
              animation:
                i === current
                  ? "ip-slide-in 0.45s cubic-bezier(0.4, 0, 0.2, 1) forwards"
                  : i === prev
                    ? "ip-slide-out 0.45s cubic-bezier(0.4, 0, 0.2, 1) forwards"
                    : "none",
            }}
          >
            {f.node}
          </div>
        ))}
      </div>
    </div>
  );
}
