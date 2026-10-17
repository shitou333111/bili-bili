"use client";

/**
 * 礼物翻卡/抽奖 —— 揭晓卡（放大翻面展示，独立于 3D 轮转阵列渲染）。
 *
 * 由外部放在「画布根层」或「面板预览舞台」的 inset:0 容器中渲染：无论轮转阵列被拖到哪里、
 * 缩放到多大，揭晓卡都在该容器中心突出显示（面板/画布各自决定容器范围）。
 *
 * 分镜：pop（放大飘到中心、露出卡背 "?"）→ flip（翻面揭晓）→ hold（停留展示，含粉丝头像）
 * → restore（收起，随 phase 回 idle 后由父级卸载）。
 * 翻面后**始终**显示选项文字（不受"待机显示选项文字"开关影响），否则揭晓将无任何信息。
 */
import type { GiftFlipOption, GiftFlipPhase } from "@/lib/display/types";

/** 揭晓卡需要的数据：归属粉丝 + 命中选项下标 */
export interface GiftFlipActive {
  fan: { uid: number; uname: string; face: string };
  optionIndex: number;
}

/** 大卡文字自适应字号（字数越少越大，使文字成为卡片主体） */
function revealTextSize(text: string): number {
  const n = Array.from(text).length;
  return n <= 1 ? 132 : n <= 2 ? 112 : n <= 4 ? 88 : n <= 6 ? 72 : n <= 8 ? 58 : n <= 10 ? 50 : 44;
}

/** 选项 → 纯色底（无图片时；按序号取色相） */
function optionColor(i: number, n: number, light = 52): string {
  const hue = Math.round((i * 360) / Math.max(1, n));
  return `hsl(${hue} 62% ${light}%)`;
}

export default function GiftFlipReveal({
  phase,
  active,
  options,
}: {
  phase: GiftFlipPhase;
  active: GiftFlipActive | null;
  options: GiftFlipOption[];
}) {
  if (!active) return null;
  // spin（阵列旋转）/ flash（闪烁）/ idle 阶段不显示揭晓卡
  if (phase === "idle" || phase === "spin" || phase === "flash") return null;
  const flipped = phase === "flip" || phase === "hold" || phase === "restore";

  const count = Math.max(1, options.length);
  const index = Math.max(0, Math.min(count - 1, active.optionIndex));
  const opt = options[index] ?? { text: "", image: "" };

  return (
    <div className="gfr-layer">
      <div
        className={`gfr-big${phase === "pop" ? " gfr-pop" : ""}${
          phase === "restore" ? " gfr-out" : ""
        }`}
      >
        <div className="gfr-fan">
          {active.fan.face ? (
            <img className="gfr-fan-face" src={active.fan.face} alt="" />
          ) : (
            <div className="gfr-fan-face gfr-fan-ph">{(active.fan.uname || "?").slice(0, 1)}</div>
          )}
          <span className="gfr-fan-name">{active.fan.uname || "观众"}</span>
        </div>

        <div className="gfr-persp">
          <div className="gfr-flip" style={{ transform: `rotateY(${flipped ? 0 : 180}deg)` }}>
            <div
              className="gfr-face"
              style={{
                background: opt.image
                  ? "#1b1b22"
                  : `linear-gradient(150deg, ${optionColor(index, count, 58)}, ${optionColor(index, count, 40)})`,
              }}
            >
              {opt.image ? <img className="gfr-face-img" src={opt.image} alt="" /> : null}
              {opt.text ? (
                <>
                  <div className="gfr-scrim" />
                  <div className="gfr-text" style={{ fontSize: revealTextSize(opt.text) }}>
                    {opt.text}
                  </div>
                </>
              ) : null}
              {flipped && <div className="gfr-shine" />}
            </div>
            <div className="gfr-face gfr-face-back">
              <div className="gfr-quest">?</div>
            </div>
          </div>
        </div>
      </div>
      <style>{CSS}</style>
    </div>
  );
}

const CSS = `
.gfr-layer {
  position: absolute; inset: 0; z-index: 50; pointer-events: none;
  display: flex; align-items: center; justify-content: center;
}
.gfr-big { position: relative; width: 400px; height: 470px; }
.gfr-big.gfr-pop { animation: gfr-pop .72s cubic-bezier(.22,.9,.3,1) both; }
.gfr-big.gfr-out { animation: gfr-out .68s ease-in forwards; }
@keyframes gfr-pop {
  0% { transform: translateY(130px) scale(.5); opacity: 0; }
  35% { opacity: 1; }
  100% { transform: translateY(0) scale(1); opacity: 1; }
}
@keyframes gfr-out {
  0% { transform: translateY(0) scale(1); opacity: 1; }
  100% { transform: translateY(-30px) scale(.62); opacity: 0; }
}
.gfr-fan {
  position: absolute; top: -84px; left: 50%; transform: translateX(-50%);
  width: max-content; /* 绝对定位下 width:auto 会把宽度限制在「容器宽−left」，长昵称会被裁在胶囊外 */
  display: flex; align-items: center; gap: 10px; padding: 6px 20px 6px 6px;
  border-radius: 9999px; background: rgba(18,18,24,.78); border: 2px solid rgba(255,214,102,.75);
  box-shadow: 0 8px 24px rgba(0,0,0,.45); white-space: nowrap;
}
.gfr-fan-face {
  width: 50px; height: 50px; border-radius: 9999px; object-fit: cover;
  border: 2px solid rgba(255,255,255,.85); background: #444;
}
.gfr-fan-ph { display: flex; align-items: center; justify-content: center; color: #fff; font-size: 24px; font-weight: 800; }
.gfr-fan-name { color: #ffe08a; font-size: 28px; font-weight: 800; letter-spacing: 1px; text-shadow: 0 2px 8px rgba(0,0,0,.8); }
.gfr-persp { position: absolute; inset: 0; perspective: 1400px; }
.gfr-flip {
  position: absolute; inset: 0; transform-style: preserve-3d;
  transition: transform .76s cubic-bezier(.28,.8,.25,1);
}
.gfr-face { position: absolute; inset: 0; border-radius: 24px; overflow: hidden; backface-visibility: hidden; }
.gfr-face-img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; }
.gfr-scrim {
  position: absolute; inset: 0;
  background: linear-gradient(to top, rgba(0,0,0,.78), rgba(0,0,0,.4) 45%, rgba(0,0,0,.5));
}
.gfr-text {
  position: absolute; inset: 0; z-index: 1;
  display: flex; align-items: center; justify-content: center;
  padding: 22px 18px; text-align: center; color: #fff;
  font-weight: 800; line-height: 1.1; letter-spacing: 1px;
  text-shadow: 0 3px 14px rgba(0,0,0,.92), 0 0 5px rgba(0,0,0,.95);
  word-break: break-word; overflow-wrap: anywhere;
}
.gfr-face-back {
  transform: rotateY(180deg);
  display: flex; align-items: center; justify-content: center;
  background: linear-gradient(140deg, #35407a, #1b2145 48%, #43308a);
  box-shadow: inset 0 0 0 4px rgba(255,255,255,.28), inset 0 0 60px rgba(255,214,102,.28);
}
.gfr-quest {
  font-size: 190px; font-weight: 900; color: rgba(255,224,138,.92);
  text-shadow: 0 0 34px rgba(255,214,102,.85), 0 8px 20px rgba(0,0,0,.5);
}
.gfr-shine {
  position: absolute; inset: 0; pointer-events: none;
  background: linear-gradient(115deg, rgba(255,255,255,0) 32%, rgba(255,255,255,.75) 50%, rgba(255,255,255,0) 68%);
  background-size: 260% 260%;
  animation: gfr-shine 1.05s ease-out .35s both;
}
@keyframes gfr-shine {
  0% { background-position: 130% 0; opacity: 0; }
  20% { opacity: 1; }
  100% { background-position: -30% 0; opacity: 0; }
}
`;
