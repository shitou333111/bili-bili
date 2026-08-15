"use client";

import { useEffect, useState } from "react";

// ==================== 宣传语轮播（打字机效果） ====================
// 七句话在同一位置依次"打字输入 → 停留 → 删除 → 下一句"，只占一行。
// 采用最流行的打字机实现（Typed.js 同款思路），无需引入额外依赖。
const SLOGANS = [
  "想回顾你和爱播的甜蜜送礼瞬间？",
  "与爱播闹崩，看花了多少冤枉钱？",
  "主播想统计收了什么，赚了多少？",
  "想看氪了多少，更好的防止剁手？",
  "想看盲盒盈亏，合成活动练练手？",
  "想解锁所有礼物，体验神豪视角？",
  "大哥大姐们想批量清理无关粉丝？",
];

const TYPE_SPEED = 90; // 打字速度（ms/字）
const DELETE_SPEED = 35; // 删除速度（ms/字）
const HOLD_TIME = 1800; // 打完一句后停留时间（ms）

export default function SloganRotator() {
  const [index, setIndex] = useState(0);
  const [text, setText] = useState("");
  const [deleting, setDeleting] = useState(false);

  useEffect(() => {
    const current = SLOGANS[index];

    let delay: number;
    if (!deleting) {
      delay = text.length < current.length ? TYPE_SPEED : HOLD_TIME;
    } else {
      delay = text.length > 0 ? DELETE_SPEED : 0;
    }

    const timer = setTimeout(() => {
      if (!deleting) {
        if (text.length < current.length) {
          setText(current.slice(0, text.length + 1));
        } else {
          setDeleting(true); // 打满后开始删除
        }
      } else if (text.length > 0) {
        setText(current.slice(0, text.length - 1));
      } else {
        setDeleting(false); // 删空后换下一句
        setIndex((i) => (i + 1) % SLOGANS.length);
      }
    }, delay);

    return () => clearTimeout(timer);
  }, [text, deleting, index]);

  return (
    <div className="mt-5 flex h-8 items-center justify-center text-[17px] font-medium text-[#4a4a4a] sm:h-9 sm:text-xl">
      <span>{text}</span>
      <span className="caret-blink ml-0.5 inline-block h-5 w-[2px] rounded-full bg-[#4a4a4a] sm:h-6" />
    </div>
  );
}
