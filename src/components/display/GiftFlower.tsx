"use client";

/**
 * 礼物展示：badge 条（横条/竖条可切换），沿滚动轴容纳 N 个礼物位（N 由宽度档位决定：短 3 / 中 4 / 长 5）。
 * 横条：礼物数 >= N 时列表补齐铺满后复制两份从左到右无缝循环滚动；
 * 竖条：整个条竖直，礼物从上到下无缝循环滚动。
 * < N 时静态居中展示。
 * 显示/隐藏裁剪由 badge 自身（.gift-bar 的 overflow:hidden + 圆角）完成，
 * 与 badge 形状（含圆角端头）完全对齐，礼物滚到 badge 边界才隐藏。
 * badge 样式：毛玻璃磨砂（半透明 + backdrop-filter + 细白边、中等圆角略方），
 * 背景叠一层横幅同款颜色滚动（低透明度）：横条 90° 横向、竖条 180° 纵向，与图标滚动同向配合。
 *
 * 醒目留言（SC）：无图标礼物，礼物位以圆形纯色背景（按电池价位取色）+ "SC"/电池数 两行文字呈现。
 *
 * 突出显示（主播在面板点选送礼粉丝后）：有选择的礼物 badge 内容整体替换为
 * "粉丝头像 + 昵称 + 礼物图标"高亮帧（静态不滚动）；多选时循环切换——
 * 竖条向左滑动（translateX）、横条向上滑动（translateY），无缝轮播。
 * 高亮帧昵称超过 6 个字时不再截断，而是在自己的区域内滚动显示：横条自左向右、竖条自上向下。
 *
 * highlightOnly（"单独条"模式）：只渲染高亮帧、不参与常规礼物滚动；无高亮且非编辑占位时不渲染。
 */
import { useEffect, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";
import type { DisplayGiftFan, DisplayGiftItem, GiftHighlight } from "@/lib/display/types";
import { GIFT_BAR_SLOTS, scBackgroundColor } from "@/lib/display/types";

const SLOT_SIZE = 96; // 每个礼物位沿滚动轴的尺寸
const SLOT_GAP = 4; // 礼物位间距（每项自带末尾边距，复制两份后两半长度相等，滚动无缝）
const BAR_LEN_EXTRA = 24; // 条长 = 礼物位数 × SLOT_SIZE + 该余量（比整数个礼物位多 24px，礼物可滚入两端）
const BAR_THICK = 100; // badge 垂直于滚动轴的厚度（扁一些）
const ICON = 84; // 礼物图标尺寸
const HL_ICON = 92; // 高亮帧礼物图标尺寸（数量移走后图标独占，放大以充分利用 badge 空间）
const HL_AVATAR = 84; // 高亮帧粉丝头像尺寸（横条）
const HL_AVATAR_V = 84; // 高亮帧粉丝头像尺寸（竖条）
/** 高亮帧数目（×N）与昵称之间的间距（数目按缩小后的字号与昵称并排/上下排列） */
const HL_COUNT_GAP = 4;
/** 高亮帧数目（×N）字号相对昵称字号的缩放：昵称是主要内容占大头，数目作为辅助信息缩小显示 */
const HL_COUNT_SCALE = 0.65;
/**
 * 高亮帧昵称字号填充系数：按实际字宽撑满空间后整体调小一点。
 * 西文/纯数字昵称（如 "I-2-3"）字宽折算后字号会撑得过大，多调小一点（0.72）；
 * 中文昵称（如 "B瓜爱西瓜"）字形密度高、同样填充下观感偏小，少调小一点（0.95）。
 */
const HL_NAME_FILL_CJK = 0.95;
const HL_NAME_FILL_OTHER = 0.72;
/**
 * 高亮帧昵称字号区间（收窄保留梯度）：上限压小短昵称的过大字号、下限抬高长昵称的过小字号，
 * 让不同长度昵称的字号更均匀。取值对应「中」档、中文昵称、有数量时的最终字号：
 * 竖条 1-4字=38 / 5字=37 / 6字=33；横条 1-4字=40 / 5字=38 / 6字=34。
 */
const HL_NAME_FONT_MAX_V = 38;
const HL_NAME_FONT_MIN_V = 33;
const HL_NAME_FONT_MAX_H = 40;
const HL_NAME_FONT_MIN_H = 34;
/** 高亮帧昵称超过该字数 → 在昵称区域内滚动显示（横条自左向右 / 竖条自上向下），不再截断 */
const HL_NAME_MARQUEE_MIN_CHARS = 6;
/** 滚动昵称两份之间的间距（px） */
const HL_NAME_MARQUEE_GAP = 28;
/** 滚动昵称的速度（px/s）：按内容长度换算每轮时长，长昵称也保持匀速易读 */
const HL_NAME_MARQUEE_SPEED = 70;
/** 高亮帧轮播每帧时长（秒）：停顿 70% + 滑动 30% */
const HL_FRAME_SEC = 5;

/** 礼物条厚度（垂直于滚动轴）。导出供画布计算"礼物飘入"落点（横条底边 / 竖条下端端点）。 */
export const GIFT_BAR_THICK = BAR_THICK;
/** 礼物条沿滚动轴长度（slots 个礼物位 + 两端余量）。导出供画布计算落点中心坐标。 */
export function giftBarLength(slots: number): number {
  return SLOT_SIZE * slots + BAR_LEN_EXTRA;
}

/** 吸收"膨胀"静止态投影：视觉上与 .gift-bar 的 box-shadow 一致，但拆成「两层外发光 + 内高光」
 *  三段、与峰值同结构（层数/inset 一致）。box-shadow 列表层数不同时无法插值，浏览器会在两帧
 *  中点直接跳变——这正是"光芒收起很突然"的成因。第二层外发光取全透明，视觉上等同单层投影。 */
const BAR_SHADOW_IDLE =
  "0 8px 28px rgba(0,0,0,0.28), 0 0 0 0 rgba(255,255,255,0), inset 0 1px 0 rgba(255,255,255,0.55)";
/** 吸收"膨胀"峰值：白色外围光芒（双层光晕）+ 保留内高光（与静止态同结构，收束时可平滑插值） */
const BAR_SHADOW_PEAK =
  "0 0 30px 8px rgba(255,255,255,0.92), 0 0 70px 28px rgba(255,255,255,0.4), inset 0 1px 0 rgba(255,255,255,0.55)";
/** 吸收"膨胀"时长（ms）：光芒消散与收缩同步走完，留足过渡时间（原 650ms 收得太急） */
const BAR_POP_MS = 900;

/** 是否含 CJK 字符（与 emWidth 的全角判定一致：码点 > 0x2E80） */
function hasCjk(s: string): boolean {
  for (const ch of s) {
    if ((ch.codePointAt(0) ?? 0) > 0x2e80) return true;
  }
  return false;
}

/**
 * 估算字符串宽度（em 单位）：高亮帧字号自适按实际字宽折算，而不是按字符个数。
 * 西文昵称（如 "I-2-3"）每个字符远窄于 1em，按 length 算会把字号压得过小、
 * 填不满头像与礼物图标之间的空间。CJK 全角=1，窄字形≈0.38，mwMW≈0.9，
 * A-Z≈0.72，a-z/0-9≈0.6，其他≈0.5。
 */
function emWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0;
    if (c > 0x2e80) w += 1;
    else if ("iljtfI.,-'|!".includes(ch)) w += 0.38;
    else if ("mwMW".includes(ch)) w += 0.9;
    else if (ch >= "A" && ch <= "Z") w += 0.72;
    else if ((ch >= "a" && ch <= "z") || (ch >= "0" && ch <= "9")) w += 0.6;
    else w += 0.5;
  }
  return w;
}

/**
 * 昵称滚动（长昵称在自己的区域内滚动）：计算"铺满容器"所需的重复份数 + 每轮时长。
 * 返回的 copies = base 复制两份（与礼物滚动同款：translate(-50% → 0) 位移正好一份长度，首尾无缝）；
 * 时长按内容长度换算，保持约 HL_NAME_MARQUEE_SPEED px/s 的匀速。
 */
function nameMarquee(
  name: string,
  nameUnits: number,
  fontSize: number,
  containerLen: number,
): { copies: string[]; sec: number } {
  const unitLen = Math.max(1, nameUnits * fontSize + HL_NAME_MARQUEE_GAP);
  const reps = Math.max(1, Math.ceil(containerLen / unitLen));
  const base = Array.from({ length: reps }, () => name);
  const sec = Math.max(6, Math.round((reps * unitLen) / HL_NAME_MARQUEE_SPEED));
  return { copies: [...base, ...base], sec };
}

/** 醒目留言（SC）图标：圆形纯色背景（按电池价位取色）+ "SC"/电池数 两行文字（无礼物图标）。 */
function ScIcon({ battery }: { battery: number }) {
  const n = Math.round(battery);
  const digits = String(n).length;
  // 数字越长字号越小，保证不超出圆内（最大 5 位：20000）
  const numSize = digits >= 5 ? 17 : digits >= 4 ? 19 : 21;
  return (
    <div
      className="relative flex items-center justify-center rounded-full drop-shadow-[0_4px_12px_rgba(0,0,0,0.20)]"
      style={{ width: ICON, height: ICON, background: scBackgroundColor(n) }}
    >
      <div className="flex flex-col items-center justify-center text-white" style={{ lineHeight: 1 }}>
        <span style={{ fontSize: 21, fontWeight: 800, letterSpacing: 0.5 }}>SC</span>
        <span style={{ fontSize: numSize, fontWeight: 800, marginTop: 2 }}>{n}</span>
      </div>
    </div>
  );
}

/** 单个礼物位：图标 + 右下角金色数量（紧贴图标右下角，数量为 1 时只显示图标）；
 *  醒目留言（SC）无图标 → 圆形纯色背景 + "SC"/电池数。 */
function GiftSlot({ gift, vertical }: { gift: DisplayGiftItem; vertical: boolean }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center"
      style={
        vertical
          ? { height: SLOT_SIZE, marginBottom: SLOT_GAP }
          : { width: SLOT_SIZE, marginRight: SLOT_GAP }
      }
    >
      {typeof gift.scBattery === "number" ? (
        <ScIcon battery={gift.scBattery} />
      ) : (
        <div className="relative" style={{ width: ICON, height: ICON }}>
          <img
            src={gift.img}
            alt={gift.giftName}
            className="object-contain drop-shadow-[0_4px_12px_rgba(0,0,0,0.20)]"
            style={{ width: ICON, height: ICON }}
          />
          {gift.count > 1 && (
            <span className="absolute right-0 bottom-0 text-[19px] font-bold leading-none text-[#ffd54a] [text-shadow:0_1px_3px_rgba(0,0,0,0.55)]">
              ×{gift.count}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

/** 空占位礼物位：白色礼物盒图标（编辑模式下摆放用，无数量） */
function EmptySlot({ vertical }: { vertical: boolean }) {
  return (
    <div
      className="flex shrink-0 items-center justify-center"
      style={
        vertical
          ? { height: SLOT_SIZE, marginBottom: SLOT_GAP }
          : { width: SLOT_SIZE, marginRight: SLOT_GAP }
      }
    >
      <svg
        viewBox="0 0 24 24 "
        style={{ width: ICON, height: ICON }}
        fill="none"
        stroke="white"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <rect x="3" y="8" width="18" height="13" rx="1.5" fill="white" stroke="none" opacity="0.95" />
        <path d="M3 8h18M12 8v13" strokeWidth="1.4" />
        <path d="M12 8c-2-3.5-5.5-4.2-7-1.6C3.6 9 7 9.5 12 8z" fill="white" stroke="none" />
        <path d="M12 8c2-3.5 5.5-4.2 7-1.6C20.4 9 17 9.5 12 8z" fill="white" stroke="none" />
      </svg>
    </div>
  );
}

/** 粉丝头像：有 face 用图片，缺头像回退昵称首字彩色圆底 */
function FanAvatar({ fan, size }: { fan: DisplayGiftFan; size: number }) {
  if (fan.face) {
    return (
      <img
        src={fan.face}
        alt={fan.uname}
        className="shrink-0 rounded-full object-cover ring-2 ring-white/70"
        style={{ width: size, height: size }}
      />
    );
  }
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full font-bold text-white ring-2 ring-white/70"
      style={{
        width: size,
        height: size,
        background: `hsl(${fan.uid % 360}, 65%, 55%)`,
        fontSize: size * 0.42,
      }}
    >
      {fan.uname.slice(0, 1)}
    </div>
  );
}

/** 高亮帧礼物图标：数量已移到昵称区域显示，图标独占（不再被数量遮挡/挤压）。
 *  醒目留言（SC）无礼物图标 → 与常规礼物位一致，用圆形纯色背景 + "SC"/电池数 呈现。 */
function HighlightGiftIcon({ gift }: { gift: DisplayGiftItem }) {
  if (typeof gift.scBattery === "number") {
    return <ScIcon battery={gift.scBattery} />;
  }
  return (
    <div className="relative shrink-0" style={{ width: HL_ICON, height: HL_ICON }}>
      <img
        src={gift.img}
        alt={gift.giftName}
        className="object-contain drop-shadow-[0_4px_12px_rgba(0,0,0,0.20)]"
        style={{ width: HL_ICON, height: HL_ICON }}
      />
    </div>
  );
}

/**
 * 突出显示帧：粉丝头像 + 昵称 + 礼物图标（整条替换礼物滚动内容，静态展示）。
 * 横条：头像在左、昵称在中、礼物图标在右；
 * 竖条：头像在上、昵称在中（竖排从上到下）、礼物图标在下。
 * 昵称图层置于头像和礼物图标之上（z-index），超宽时压在图标上方显示而不被遮挡。
 * 礼物数量（×N，该粉丝送出数量）放在昵称处：横条在昵称上方（两行），竖条在昵称右侧
 * （两列，×与数字上下竖直排列）；数量为 1 时不显示，礼物图标独占不被数量挤压。
 * 昵称字号自适：按实际字宽（em 折算）填满头像与礼物图标之间的空间（文字越少字号越大，
 * 西文昵称也能撑满），撑满后按填充系数调小一点（中文 0.95 稍大、其他 0.72 西文短名不过大），
 * 最后收窄进字号区间（竖条 33-38 / 横条 34-40，见 HL_NAME_FONT_* 常量）让各字数的字号更均匀；
 * 数目按缩小比例显示（HL_COUNT_SCALE，辅助信息不喧宾夺主），同时受条厚几何限制。
 * 昵称超过 6 个字：不再截断，改为在昵称区域内滚动（横条自左向右、竖条自上向下），
 * 此时字号按"6 字基准"取（长昵称只滚动、不缩小到看不清）。
 */
function HighlightFrame({
  gift,
  fan,
  vertical,
  barLen,
}: {
  gift: DisplayGiftItem;
  fan: DisplayGiftFan;
  vertical: boolean;
  /** badge 沿滚动轴的长度（由宽度档位决定，昵称可用空间随条长变化） */
  barLen: number;
}) {
  const name = fan.uname;
  const showCount = fan.count > 1;
  const scrollingName = Array.from(name).length > HL_NAME_MARQUEE_MIN_CHARS;
  // 字号上限：条长（宽度档位）超过「中」档时昵称字号不再继续增大（否则「长」档昵称过大），
  // 封顶到「中」档条长对应的字号；滚动铺满仍按真实条长计算。
  const capBarLen = SLOT_SIZE * GIFT_BAR_SLOTS.medium + BAR_LEN_EXTRA;
  const fontBarLen = Math.min(barLen, capBarLen);
  const nameStyle: CSSProperties = {
    // 昵称图层置于头像/礼物图标之上（容器 relative z-[2]），超宽时不裁剪、压在图标上方显示
    whiteSpace: "nowrap",
    fontWeight: 700,
    color: "#fff",
    textShadow: "0 1px 4px rgba(0,0,0,0.55)",
    lineHeight: 1,
  };
  // 数目样式：金色 + 阴影，与非高亮礼物位的数量观感一致
  const countStyle: CSSProperties = {
    fontWeight: 700,
    color: "#ffd54a",
    textShadow: "0 1px 3px rgba(0,0,0,0.55)",
    lineHeight: 1,
  };
  // 滚动昵称按"6 字基准"折算字宽，避免长昵称被压到过小；短昵称仍按实际字宽撑满
  const nameUnits = scrollingName ? Math.min(emWidth(name), HL_NAME_MARQUEE_MIN_CHARS) : emWidth(name);
  if (vertical) {
    // 可用高度 = 条长 - 上下 padding(8×2) - 头像 - 礼物 - 两段间距(10×2)
    const availH = barLen - 16 - HL_AVATAR_V - HL_ICON - 20;
    // 字号可用高度封顶到「中」档（「长」档字号不再增大）
    const fontAvailH = fontBarLen - 16 - HL_AVATAR_V - HL_ICON - 20;
    const countStr = `×${fan.count}`;
    // 字号自适填满头像与礼物图标之间的空间：按实际字宽（em 折算）排布，西文昵称也能撑满。
    // 长度方向只按昵称占格计算（数目缩小后不再挤占昵称字号）；
    // 厚度方向两列并排：昵称列宽 + 间距 + 数目列宽（≈昵称字号×HL_COUNT_SCALE）不超过条内容宽
    const units = Math.max(nameUnits, 0.5);
    // 撑满后按填充系数调小一点（中文 0.95 稍大、其他 0.72 西文/纯数字昵称不过大），最小 12 保证可读
    const fill = hasCjk(name) ? HL_NAME_FILL_CJK : HL_NAME_FILL_OTHER;
    const thickAvailV = BAR_THICK - 12 - (showCount ? HL_COUNT_GAP : 0);
    const thickDivV = showCount ? Math.floor(thickAvailV / (1 + HL_COUNT_SCALE)) : thickAvailV;
    const fitted = Math.floor(Math.min(Math.floor(fontAvailH / units), thickDivV) * fill);
    // 收窄字号区间：上限压小小字号的过大值、下限抬高大字号的过小值（保留字数梯度更均匀）；
    // 下限抬高不突破几何容量（短档/超长昵称仍按实际空间收缩，避免压到头像/礼物图标上）
    const fontSize = Math.max(
      12,
      Math.min(
        Math.ceil(fontAvailH / units),
        Math.min(HL_NAME_FONT_MAX_V, Math.max(HL_NAME_FONT_MIN_V, fitted)),
      ),
    );
    // 数目字号：昵称字号按比例缩小（辅助信息不喧宾夺主）；超大计数再按条长 clamp 防溢出
    const countFontSize = showCount
      ? Math.min(
          Math.round(fontSize * HL_COUNT_SCALE),
          Math.floor(fontAvailH / Math.max(countStr.length, 1)),
        )
      : 0;
    const mq = scrollingName ? nameMarquee(name, nameUnits, fontSize, availH) : null;
    return (
      <div
        className="flex shrink-0 flex-col items-center justify-center"
        style={{ width: BAR_THICK, height: "100%", gap: 10, padding: "8px 6px" }}
      >
        <FanAvatar fan={fan} size={HL_AVATAR_V} />
        {/* 昵称列 + 数目列：数目在昵称右侧（两列），×与数字上下竖直排列。昵称图层高于头像/礼物图标 */}
        <div
          className="relative z-[2] flex min-h-0 flex-1 items-center justify-center gap-1"
          style={{ width: "100%" }}
        >
          {/* 昵称字号直接作用在这一层（列宽 = lineHeight 1×字号） */}
          {scrollingName && mq ? (
            <div style={{ position: "relative", height: "100%", width: fontSize, overflow: "hidden" }}>
              <div
                className="flex flex-col"
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: "100%",
                  // -50% → 0：整份长度位移，content 自上向下移动、首尾无缝
                  animation: `gift-bar-marquee-v ${mq.sec}s linear infinite`,
                }}
              >
                {mq.copies.map((t, i) => (
                  <span
                    key={i}
                    style={{
                      ...nameStyle,
                      writingMode: "vertical-rl",
                      textAlign: "center",
                      fontSize,
                      display: "block",
                      marginBottom: HL_NAME_MARQUEE_GAP,
                    }}
                  >
                    {t}
                  </span>
                ))}
              </div>
            </div>
          ) : (
            <div
              style={{
                ...nameStyle,
                writingMode: "vertical-rl",
                textAlign: "center",
                fontSize,
              }}
            >
              {name}
            </div>
          )}
          {showCount && (
            <div
              className="flex flex-col items-center justify-center"
              style={{ ...countStyle, fontSize: countFontSize }}
            >
              {Array.from(`×${fan.count}`).map((ch, i) => (
                <span key={i}>{ch}</span>
              ))}
            </div>
          )}
        </div>
        <HighlightGiftIcon gift={gift} />
      </div>
    );
  }
  // 可用宽度 = 条长 - 左右 padding(8×2) - 头像 - 礼物 - 两段间距(8×2)
  const availW = barLen - 16 - HL_AVATAR - HL_ICON - 16;
  // 字号可用宽度封顶到「中」档（「长」档字号不再增大）
  const fontAvailW = fontBarLen - 16 - HL_AVATAR - HL_ICON - 16;
  const countStr = `×${fan.count}`;
  // 字号自适填满头像与礼物图标之间的空间：按实际字宽（em 折算）排布，西文昵称也能撑满。
  // 长度方向只按昵称占格计算（数目缩小后不再挤占昵称字号）；
  // 厚度方向两行堆叠：昵称行高 + 间距 + 数目行高（≈昵称字号×HL_COUNT_SCALE）不超过条厚
  const units = Math.max(nameUnits, 0.5);
  // 撑满后按填充系数调小一点（中文 0.95 稍大、其他 0.72 西文/纯数字昵称不过大），最小 12 保证可读
  const fill = hasCjk(name) ? HL_NAME_FILL_CJK : HL_NAME_FILL_OTHER;
  const thickAvailH = BAR_THICK - (showCount ? HL_COUNT_GAP : 0);
  const thickDivH = showCount ? Math.floor(thickAvailH / (1 + HL_COUNT_SCALE)) : thickAvailH;
  const fitted = Math.floor(Math.min(Math.floor(fontAvailW / units), thickDivH) * fill);
  // 收窄字号区间：上限压小小字号的过大值、下限抬高大字号的过小值（保留字数梯度更均匀）；
  // 下限抬高不突破几何容量（短档/超长昵称仍按实际空间收缩，避免压到头像/礼物图标上）
  const fontSize = Math.max(
    12,
    Math.min(
      Math.ceil(fontAvailW / units),
      Math.min(HL_NAME_FONT_MAX_H, Math.max(HL_NAME_FONT_MIN_H, fitted)),
    ),
  );
  // 数目字号：昵称字号按比例缩小（辅助信息不喧宾夺主）；超大计数再按条宽 clamp 防溢出
  const countFontSize = showCount
    ? Math.min(
        Math.round(fontSize * HL_COUNT_SCALE),
        Math.floor(fontAvailW / Math.max(emWidth(countStr), 1)),
      )
    : 0;
  const mq = scrollingName ? nameMarquee(name, nameUnits, fontSize, availW) : null;
  return (
    <div
      className="flex shrink-0 items-center"
      style={{ width: "100%", height: BAR_THICK, gap: 8, padding: "0 8px" }}
    >
      <FanAvatar fan={fan} size={HL_AVATAR} />
      {/* 昵称区：数目在昵称上方（两行、缩小字号），数量为 1 时不显示数目。昵称图层高于头像/礼物图标 */}
      <div className="relative z-[2] flex min-w-0 flex-1 flex-col items-center justify-center gap-1">
        {showCount && <div style={{ ...countStyle, fontSize: countFontSize }}>×{fan.count}</div>}
        {scrollingName && mq ? (
          <div style={{ position: "relative", width: "100%", height: fontSize, overflow: "hidden" }}>
            <div
              className="flex"
              style={{
                width: "max-content",
                // -50% → 0：整份长度位移，content 自左向右移动、首尾无缝
                animation: `gift-bar-marquee ${mq.sec}s linear infinite`,
              }}
            >
              {mq.copies.map((t, i) => (
                <span key={i} style={{ ...nameStyle, fontSize, marginRight: HL_NAME_MARQUEE_GAP }}>
                  {t}
                </span>
              ))}
            </div>
          </div>
        ) : (
          <div style={{ ...nameStyle, width: "100%", textAlign: "center", fontSize }}>{name}</div>
        )}
      </div>
      <HighlightGiftIcon gift={gift} />
    </div>
  );
}

export default function GiftFlower({
  gifts,
  emptyPlaceholder = false,
  orientation = "horizontal",
  highlight,
  slots = GIFT_BAR_SLOTS.short,
  highlightOnly = false,
  flash,
  badgeOpacity = 100,
}: {
  gifts: DisplayGiftItem[];
  /** 无礼物时也渲染占位条（供编辑模式摆放/预览） */
  emptyPlaceholder?: boolean;
  /** 条的方向：横条（礼物从左到右滚动）/ 竖条（礼物从上到下滚动） */
  orientation?: "horizontal" | "vertical";
  /** 突出显示选择（giftId → 选中 uid 列表，顺序 = 循环顺序）。编辑模式占位时忽略。 */
  highlight?: GiftHighlight;
  /** 沿滚动轴容纳的礼物位数（宽度档位：短 3 / 中 4 / 长 5）；条厚不变，整体缩放仍在画布中调整 */
  slots?: number;
  /** 单独条模式：仅渲染高亮帧（无高亮且非编辑占位时完全不渲染），不参与常规礼物滚动 */
  highlightOnly?: boolean;
  /** 吸收闪烁代际：值变化（每次 +1）时礼物条闪一下——收到礼物飘入后被吸收的特效 */
  flash?: number;
  /** badge 透明度 0-100：底色/边框/阴影按比例缩放（100 = 原观感），礼物/文字不受影响 */
  badgeOpacity?: number;
}) {
  const vertical = orientation === "vertical";
  const barLen = giftBarLength(slots);

  // 吸收"膨胀"特效：flash 变化 → 用 WAAPI 重放（放大 + 外围白色光芒）。
  // 不重挂根节点（否则内部礼物滚动轨道会被重启、出现跳动），动画首尾帧与静止态一致，结束无跳变。
  const barRef = useRef<HTMLDivElement | null>(null);
  const popAnimRef = useRef<Animation | null>(null);
  useEffect(() => {
    if (!flash || !barRef.current) return;
    popAnimRef.current = barRef.current.animate(
      [
        { transform: "scale(1)", boxShadow: BAR_SHADOW_IDLE },
        { transform: "scale(1.08)", boxShadow: BAR_SHADOW_PEAK, offset: 0.3 },
        { transform: "scale(1.045)", boxShadow: BAR_SHADOW_PEAK, offset: 0.5 },
        { transform: "scale(1)", boxShadow: BAR_SHADOW_IDLE, offset: 1 },
      ],
      { duration: BAR_POP_MS, easing: "ease-out" },
    );
    return () => {
      popAnimRef.current?.cancel();
      popAnimRef.current = null;
    };
  }, [flash]);

  // —— 突出显示帧：按选择顺序展平 (gift, fan) 对（只保留当前清单里存在且有该粉丝的）——
  const frames: Array<{ gift: DisplayGiftItem; fan: DisplayGiftFan }> = [];
  if (!emptyPlaceholder && highlight) {
    for (const [gid, uids] of Object.entries(highlight)) {
      const gift = gifts.find((g) => g.giftId === Number(gid));
      if (!gift?.fans?.length) continue;
      for (const uid of uids) {
        const fan = gift.fans.find((f) => f.uid === uid);
        if (fan) frames.push({ gift, fan });
      }
    }
  }
  const useHighlight = frames.length > 0;
  const n = frames.length;

  // 单独条：只展示高亮帧；无高亮且非编辑占位 → 不渲染（避免与常规条重复）
  if (highlightOnly && !emptyPlaceholder && !useHighlight) return null;
  if (!gifts.length && !emptyPlaceholder && !useHighlight) return null;

  const scrolling = gifts.length >= slots;
  // 滚动速度：每个礼物约 3.5s，最短 9s，避免礼物太少时转得太快
  const durSec = Math.max(9, gifts.length * 3.5);

  // 内容：有突出显示 → 高亮帧（单帧静态 / 多帧循环滑动）；
  // 否则 >= N 个礼物循环滚动；否则静态居中；无礼物渲染 N 个占位位
  let content: ReactNode;
  let innerClass: string;
  if (useHighlight) {
    innerClass = "relative z-[1] h-full w-full";
    if (n === 1) {
      // 单帧：静态占满 badge（头像与礼物不滚动）
      content = (
        <div className="absolute left-0 top-0 h-full w-full">
          <HighlightFrame gift={frames[0].gift} fan={frames[0].fan} vertical={vertical} barLen={barLen} />
        </div>
      );
    } else {
      // 多帧循环：轨道复制两份，逐帧停留——每帧停顿 70% 后只滑动一个帧位（BAR_THICK px）
      // 到下一帧再停，不连续滚动；按帧数 n 生成分段 keyframes（每步 100/n %，一步 = HL_FRAME_SEC）。
      // 滑到第 n 帧恰等于一份复制长度（-n×BAR_THICK），回到 0 时与首帧完全重合，首尾无缝。
      // 竖条 translateX 向左滑、横条 translateY 向上滑（keyframes 按方向+帧数命名，渲染在组件内 <style>）。
      const axis = vertical ? "x" : "y";
      const tf = vertical ? "translateX" : "translateY";
      const frames2 = [...frames, ...frames];
      const step = 100 / n;
      const kf: string[] = [];
      for (let i = 0; i < n; i++) {
        const a = (i * step).toFixed(3);
        const b = (i * step + step * 0.7).toFixed(3);
        const c = ((i + 1) * step).toFixed(3);
        kf.push(
          `${a}%,${b}%{transform:${tf}(${-i * BAR_THICK}px)}` +
            `${c}%{transform:${tf}(${-(i + 1) * BAR_THICK}px)}`,
        );
      }
      content = (
        <>
          <style>{`@keyframes gift-hl-cycle-${axis}-${n}{${kf.join("")}}`}</style>
          <div
            className={`absolute left-0 top-0 flex will-change-transform ${vertical ? "" : "flex-col"}`}
            style={
              vertical
                ? {
                    height: "100%",
                    width: "max-content",
                    animation: `gift-hl-cycle-x-${n} ${n * HL_FRAME_SEC}s linear infinite`,
                  }
                : {
                    width: "100%",
                    height: "max-content",
                    animation: `gift-hl-cycle-y-${n} ${n * HL_FRAME_SEC}s linear infinite`,
                  }
            }
          >
            {frames2.map((f, i) => (
              <HighlightFrame key={i} gift={f.gift} fan={f.fan} vertical={vertical} barLen={barLen} />
            ))}
          </div>
        </>
      );
    }
  } else if (!gifts.length) {
    innerClass = vertical
      ? "relative z-[1] flex h-full w-full flex-col items-center"
      : "relative z-[1] flex w-full items-center";
    content = stack(
      vertical,
      Array.from({ length: slots }, (_, i) => <EmptySlot key={i} vertical={vertical} />),
    );
  } else if (scrolling) {
    innerClass = vertical
      ? "relative z-[1] flex h-full w-full flex-col items-center"
      : "relative z-[1] flex w-full items-center";
    // 一份列表（base）：礼物太少铺不满 badge 可视长度时整组重复补齐，
    // 保证滚动全程（周期末尾位移一份长度时）窗口始终被礼物铺满、无空白；
    // 轨道 = base 复制两份 + translate(-50% → 0)：-50% 正好是一份 base 长度（max-content
    // 保证按内容长度算，否则按容器算会跳变），回到 0 时与首帧完全重合，首尾无缝。
    // 横条 translateX 从左到右；竖条 translateY 从上到下。
    const copyLen = gifts.length * (SLOT_SIZE + SLOT_GAP);
    const reps = Math.max(1, Math.ceil(barLen / copyLen));
    const base = Array.from({ length: reps }, () => gifts).flat();
    content = (
      <div
        className={`flex shrink-0 items-center will-change-transform ${vertical ? "flex-col" : ""}`}
        style={
          vertical
            ? {
                width: "100%",
                height: "max-content",
                animation: `gift-bar-marquee-v ${durSec}s linear infinite`,
              }
            : {
                width: "max-content",
                animation: `gift-bar-marquee ${durSec}s linear infinite`,
              }
        }
      >
        {[...base, ...base].map((g, i) => (
          <GiftSlot key={i} gift={g} vertical={vertical} />
        ))}
      </div>
    );
  } else {
    innerClass = vertical
      ? "relative z-[1] flex h-full w-full flex-col items-center"
      : "relative z-[1] flex w-full items-center";
    content = stack(vertical, gifts.map((g, i) => <GiftSlot key={i} gift={g} vertical={vertical} />));
  }

  return (
    <div
      ref={barRef}
      className={`gift-bar pointer-events-none relative flex items-center ${vertical ? "gift-bar-v flex-col" : ""}`}
      style={
        {
          ...(vertical
            ? { width: BAR_THICK, height: barLen }
            : { width: barLen, height: BAR_THICK }),
          // badge 透明度：.gift-bar 的底色/彩虹层/边框/阴影按此系数等比缩放（1 = 原观感）
          "--gift-bar-op": String(Math.min(100, Math.max(0, badgeOpacity)) / 100),
        } as CSSProperties
      }
    >
      {/* 滚动轨道靠起始端铺满（不居中，否则周期末尾另一端露空白）；
          裁剪由 .gift-bar 自身的 overflow:hidden + 圆角完成，礼物显示/隐藏边界与 badge 形状完全对齐；
          z-index:1 盖过 .gift-bar::before 颜色滚动层 */}
      <div className={innerClass}>{content}</div>
      {/* 吸收闪烁：收到礼物飘入后礼物条闪一下（白色整体闪层，被 .gift-bar 的 overflow/圆角裁剪）。
          key 变化重新挂载 → 重放动画；基础 opacity 为 0，动画结束后自动回到 0（不残留白层）。
          时长与膨胀/光芒一致（同为 BAR_POP_MS），三者同步收束不突兀。 */}
      {typeof flash === "number" && flash > 0 && (
        <div
          key={flash}
          className="pointer-events-none absolute inset-0 z-[5] bg-white"
          style={{ opacity: 0, animation: `gift-bar-absorb ${BAR_POP_MS}ms ease-out` }}
        />
      )}
    </div>
  );
}

/** 内容堆叠容器：沿滚动轴居中（静态展示用） */
function stack(vertical: boolean, items: ReactNode[]) {
  return (
    <div
      className={
        vertical
          ? "flex h-full w-full flex-col items-center justify-center"
          : "flex w-full items-center justify-center"
      }
    >
      {items}
    </div>
  );
}
