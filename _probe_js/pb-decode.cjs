// 验证 SEND_GIFT_V2 的 data.pb 是否为 protobuf，以及字段是否匹配 blivedm 的 schema
// 数据来源：gift-probe.cjs 在房间 7734200 抓到的真实 SEND_GIFT_V2 原始包
const base64 = process.argv[2];
if (!base64) {
  console.error("用法: node pb-decode.cjs <base64>");
  process.exit(1);
}
const buf = Buffer.from(base64, "base64");

/** 读 varint，返回 {value, next} */
function readVarint(b, pos) {
  let value = 0n;
  let shift = 0n;
  while (true) {
    const byte = b[pos++];
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) break;
    shift += 7n;
  }
  return { value, next: pos };
}

/** 最小 protobuf 解码：返回 [{field, wire, value}]，value 对嵌套/字符串/数值区分 */
function decodeRaw(b, pos, end) {
  const fields = [];
  while (pos < end) {
    const tag = readVarint(b, pos);
    pos = tag.next;
    const field = Number(tag.value >> 3n);
    const wire = Number(tag.value & 7n);
    if (wire === 0) {
      const v = readVarint(b, pos);
      pos = v.next;
      fields.push({ field, wire, value: v.value });
    } else if (wire === 2) {
      const len = readVarint(b, pos);
      pos = len.next;
      const sub = b.slice(pos, pos + Number(len.value));
      pos += Number(len.value);
      fields.push({ field, wire, value: sub });
    } else if (wire === 5) {
      fields.push({ field, wire, value: b.readUInt32LE(pos) });
      pos += 4;
    } else if (wire === 1) {
      fields.push({ field, wire, value: b.readBigUInt64LE(pos) });
      pos += 8;
    } else {
      throw new Error(`unknown wire=${wire} field=${field}`);
    }
  }
  return fields;
}

/** 便捷取值：fields 中取 field 的 varint 数值 */
function intOf(fields, field) {
  const f = fields.find((x) => x.field === field);
  if (!f) return undefined;
  return f.wire === 0 ? f.value : undefined;
}
/** 便捷取值：fields 中取 field 的字符串 */
function strOf(fields, field) {
  const f = fields.find((x) => x.field === field);
  if (!f || f.wire !== 2) return undefined;
  return Buffer.from(f.value).toString("utf8");
}
/** 便捷取值：fields 中取 field 的嵌套子字段 */
function msgOf(fields, field) {
  const f = fields.find((x) => x.field === field);
  if (!f || f.wire !== 2) return undefined;
  return decodeRaw(f.value, 0, f.value.length);
}

const top = decodeRaw(buf, 0, buf.length);
const giftList = top.filter((f) => f.field === 10);

console.log("=== SendGiftBroadcast ===");
console.log("uid        =", Number(intOf(top, 1)));
console.log("uname      =", strOf(top, 2));
console.log("face       =", strOf(top, 3));
console.log("guard_level=", Number(intOf(top, 5) ?? 0n));

const medal = msgOf(top, 8);
if (medal) {
  console.log("medal: level=%d name=%s targetId=%d roomId=%d",
    Number(intOf(medal, 5) ?? 0n), strOf(medal, 6), Number(intOf(medal, 1) ?? 0n), Number(intOf(medal, 4) ?? 0n));
}
const blind = msgOf(top, 9);
if (blind) {
  console.log("blindGift: name=%s price=%d", strOf(blind, 3), Number(intOf(blind, 6) ?? 0n));
}

console.log("=== gift_list (repeated field 10) 共 %d 条 ===", giftList.length);
for (const g of giftList) {
  const gf = decodeRaw(g.value, 0, g.value.length);
  const gi = msgOf(gf, 35);
  console.log({
    giftId: Number(intOf(gf, 1)),
    giftName: strOf(gf, 2),
    num: Number(intOf(gf, 3)),
    giftType: Number(intOf(gf, 4)),
    price: Number(intOf(gf, 5)),
    totalCoin: Number(intOf(gf, 7)),
    coinType: strOf(gf, 8),
    tid: strOf(gf, 9),
    timestamp: Number(intOf(gf, 10)),
    rnd: strOf(gf, 12),
    action: strOf(gf, 18),
    imgBasic: gi ? strOf(gi, 1) : undefined,
  });
}
