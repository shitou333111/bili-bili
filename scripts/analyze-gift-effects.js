/**
 * 检测 gift_effects.json 中所有 web_mp4_json 的 aFrame/rgbFrame
 * 与参考值是否相同，输出统计结果和差异明细
 */
const fs = require("fs");
const path = require("path");
const https = require("https");
const http = require("http");

// 参考值（示例参数）
const REF_AFRAME = [724, 0, 360, 640];
const REF_RGBFRAME = [0, 0, 720, 1280];

function arraysEqual(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith("https") ? https : http;
    const req = mod.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "Referer": "https://live.bilibili.com/",
      },
      timeout: 10000,
    }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchJSON(res.headers.location).then(resolve).catch(reject);
      }
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error for ${url}: ${e.message}`)); }
      });
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function main() {
  console.log("读取 gift_effects.json...");
  const effectsPath = path.join(__dirname, "..", ".data", "gift_effects.json");
  const raw = fs.readFileSync(effectsPath, "utf-8");
  const data = JSON.parse(raw);

  const confList = data?.data?.full_sc_resource?.conf_list || [];
  console.log(`conf_list 共 ${confList.length} 条记录`);

  // 收集所有唯一的 web_mp4_json URL（过滤掉非礼物特效：bind_gift_ids 为空或只包含 0）
  function isValidGiftEffect(ids) {
    if (!ids || !Array.isArray(ids) || ids.length === 0) return false;
    // 所有ID都是0则认为是非礼物特效
    return ids.some(id => id !== 0);
  }

  const urlMap = new Map();
  let skippedNonGift = 0;
  for (const item of confList) {
    if (item.web_mp4_json) {
      if (!isValidGiftEffect(item.bind_gift_ids)) {
        skippedNonGift++;
        continue;
      }
      urlMap.set(item.web_mp4_json, {
        id: item.id,
        bind_gift_ids: item.bind_gift_ids,
        web_mp4: item.web_mp4,
      });
    }
  }
  console.log(`跳过非礼物特效记录: ${skippedNonGift} 条`);

  const urls = [...urlMap.keys()];
  console.log(`唯一 web_mp4_json 链接: ${urls.length} 个`);

  let same = 0;
  let diff = 0;
  let fail = 0;
  const diffEntries = [];
  const failEntries = [];

  // 并发限制：5个一组
  const CONCURRENCY = 5;
  let idx = 0;
  async function worker() {
    while (idx < urls.length) {
      const i = idx++;
      const url = urls[i];
      const meta = urlMap.get(url);
      process.stdout.write(`\r[${i + 1}/${urls.length}] ${url.slice(-50)}`);
      try {
        const json = await fetchJSON(url);
        const info = json?.info;
        if (!info) {
          fail++;
          failEntries.push({ url, reason: "no info field", meta });
          continue;
        }
        const aFrame = info.aFrame || [];
        const rgbFrame = info.rgbFrame || [];

        const aSame = arraysEqual(aFrame, REF_AFRAME);
        const rgbSame = arraysEqual(rgbFrame, REF_RGBFRAME);

        if (aSame && rgbSame) {
          same++;
        } else {
          diff++;
          diffEntries.push({
            url,
            web_mp4: meta.web_mp4,
            id: meta.id,
            gift_ids: meta.bind_gift_ids,
            aFrame,
            rgbFrame,
            w: info.w, h: info.h, scale: info.scale,
            videoW: info.videoW, videoH: info.videoH,
          });
        }
      } catch (err) {
        fail++;
        failEntries.push({ url, reason: err.message, meta });
      }
    }
  }

  const workers = [];
  for (let w = 0; w < CONCURRENCY; w++) workers.push(worker());
  await Promise.all(workers);
  process.stdout.write("\r\x1b[K");

  console.log("\n========== 统计结果 ==========");
  console.log(`总链接数:     ${urls.length}`);
  console.log(`完全相同:     ${same}`);
  console.log(`参数不同:     ${diff}`);
  console.log(`获取失败:     ${fail}`);

  if (diffEntries.length > 0) {
    console.log("\n========== 不同的条目 ==========");
    for (const e of diffEntries) {
      console.log(`\n[ID ${e.id}] gift_ids: ${e.gift_ids.join(",")}`);
      console.log(`  URL: ${e.url}`);
      console.log(`  w=${e.w}, h=${e.h}, scale=${e.scale}, videoW=${e.videoW}, videoH=${e.videoH}`);
      console.log(`  aFrame:     [${e.aFrame.join(", ")}]  ${arraysEqual(e.aFrame, REF_AFRAME) ? "✓" : "✗ 参考: [724,0,360,640]"}`);
      console.log(`  rgbFrame:   [${e.rgbFrame.join(", ")}]  ${arraysEqual(e.rgbFrame, REF_RGBFRAME) ? "✓" : "✗ 参考: [0,0,720,1280]"}`);
    }
  }

  if (failEntries.length > 0) {
    console.log(`\n========== 获取失败 (${failEntries.length}) ==========`);
    for (const e of failEntries) {
      console.log(`  ${e.url}  -> ${e.reason}`);
    }
  }

  // 保存结果到文件
  const result = {
    total: urls.length, same, diff, fail,
    reference: { aFrame: REF_AFRAME, rgbFrame: REF_RGBFRAME },
    diffEntries, failEntries,
  };
  const outPath = path.join(__dirname, "..", ".data", "gift_effects_analysis.json");
  fs.writeFileSync(outPath, JSON.stringify(result, null, 2), "utf-8");
  console.log(`\n结果已保存到: ${outPath}`);
}

main().catch(console.error);