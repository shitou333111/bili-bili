/**
 * B站活动 H5 mock-shim（原生 WebView 注入脚本）
 *
 * 用途：原生客户端 WebView 加载真实 B站活动 H5 时，在"页面文档"这一层拦截请求，
 * 将本脚本注入到 HTML <head> 中返回。脚本在页面自身 origin 上下文运行，
 * 覆盖 window.fetch / XMLHttpRequest，命中 StarStone 三接口时直接返回本地 mock JSON，
 * 从而实现：真实 B站 UI + 本地数据 + 不登录 + 不扣费 + 不走服务器。
 *
 * 原生接入方式：
 *  - Android: WebViewClient.shouldInterceptRequest 命中活动 H5 的 HTML 请求时，
 *    读取该 HTML，在 <head> 前插入 <script src=".../mock-shim.js">（或内联本脚本），再返回。
 *  - iOS: WKURLSchemeHandler / URLProtocol 对活动 H5 文档请求做同样的注入。
 *
 * 可在注入前通过 window.__BILI_ACTIVITY_MOCK_CONFIG__ 覆盖下方配置。
 */
(function () {
  if (window.__BILI_ACTIVITY_MOCK__) return;
  window.__BILI_ACTIVITY_MOCK__ = true;

  // Web 镜像模式（/moniqi）：页面跑在自有域名上，无原生注入。
  // 仅需跳过 Tauri 专属「同步/推送」通道（本就没有 __TAURI_INTERNALS__，属显式短路），
  // 玩法/登录/钱包等 mock 逻辑与原生完全一致。
  var MIRROR = !!window.__BILI_MIRROR__;

  var CFG = window.__BILI_ACTIVITY_MOCK_CONFIG__ || {};

  var CONFIG = {
    // 算法类型：决定使用哪套 mock 算法拦截逻辑。由前端算法注册表(algorithms.ts)按活动配置注入。
    //  - stone-gongfang   ：晶石工坊（槽位抽取/替换/合成，下方默认值即该算法参数）
    //  - fans-autumn-2026 ：玲珑宝斋（占位：通用成功拦截，避免真实扣费，玩法实现后热更新补充）
    algorithmType: "stone-gongfang",
    act_id: 110558,
    activity_name: "山海工坊",
    start_time: 1786161600,
    end_time: 1786723199,
    slotCount: 6,
    slotMin: 1,
    slotMax: 7,
    draw_price: 3000,
    // replace_price 已改为动态计算（见 REPLACE_PRICE_MAP），此处不再使用固定值
    // 假账号 UID：所有"游戏内身份"（登录态 mid / ruid / change_ruid）统一替换为该值，
    // 避免用自己的真实账号(当前主播)操作被 B站 判定为"不能在自己直播间参与"，
    // 也避免对本人或其他账号产生任何真实扣费/操作风险（操作接口本来就全部本地 mock）。
    // 取 9 位数（在服务器可接受的 uid 数值范围内），几乎不可能是真实活跃账号。
    fake_uid: CFG.fake_uid !== undefined ? CFG.fake_uid : 900000000,
    // 是否把 api.live.bilibili.com 下未识别的请求也 mock 成通用成功
    // 默认 false：只拦截 StarStone 三接口，其余请求放行真实数据（页面才能正常渲染）。
    // 如个别环境因未登录导致其他接口报错，可通过注入配置置为 true。
    mockAllApi: CFG.mockAllApi !== undefined ? !!CFG.mockAllApi : false,
    // 当前可获得/可合成的礼物列表（与真实 StarStoneInfo 一致，页面据此渲染"合成礼物"区域）
    gift_info: [
      {
        gift_id: 35733,
        gift_name: "山河入画",
        gift_img: "https://i0.hdslb.com/bfs/live/e9e489cba04340cac38f74de9a5d8de3fd08b50e.png",
        gift_price: 3000000,
      },
      {
        gift_id: 35732,
        gift_name: "护城大王",
        gift_img: "https://i0.hdslb.com/bfs/live/5b347a79bd404f37d13f98e43f8bb74cde05d4df.png",
        gift_price: 300000,
      },
      {
        gift_id: 35731,
        gift_name: "城市倒影",
        gift_img: "https://i0.hdslb.com/bfs/live/d6671cfc5370dc49fcd0ca62350e05607d7dfbfe.png",
        gift_price: 80000,
      },
      {
        gift_id: 35730,
        gift_name: "海图一角",
        gift_img: "https://i0.hdslb.com/bfs/live/4e94e3f83d45d24c66b086d5c1ccdea711bd0c44.png",
        gift_price: 25000,
      },
      {
        gift_id: 35729,
        gift_name: "纸船渡海",
        gift_img: "https://i0.hdslb.com/bfs/live/064740d9cb3dcb3e5f8a17e918059caec74ce329.png",
        gift_price: 12000,
      },
      {
        gift_id: 35728,
        gift_name: "浪花一现",
        gift_img: "https://i0.hdslb.com/bfs/live/bec96f5e32036f47eeaf96d3280b1eff8ab44840.png",
        gift_price: 5000,
      },
    ],
    carousel_pool: [
      "恭喜Phoenix在山海工坊中获取护城大王",
      "恭喜AC4o2在山海工坊中获取山河入画",
      "恭喜Caictou在山海工坊中获取山河入画",
      "恭喜小羊嘎嘎嘎在山海工坊中获取护城大王",
      "恭喜某个优雅的男人在山海工坊中获取护城大王",
      "恭喜哦豁down在山海工坊中获取山河入画",
      "恭喜心寒的老父亲在山海工坊中获取护城大王",
      "恭喜Kono在山海工坊中获取山河入画",
    ],
    compose_gifts: [
      {
        minTotal: 24,
        gift: {
          gift_id: 35730,
          gift_name: "海图一角",
          gift_img: "https://i0.hdslb.com/bfs/live/4e94e3f83d45d24c66b086d5c1ccdea711bd0c44.png",
          gift_price: 25000,
        },
      },
      {
        minTotal: 0,
        gift: {
          gift_id: 35729,
          gift_name: "纸船渡海",
          gift_img: "https://i0.hdslb.com/bfs/live/064740d9cb3dcb3e5f8a17e918059caec74ce329.png",
          gift_price: 12000,
        },
      },
    ],
    // —— 同数间隔合成（星座回响）默认配置 ——
    // 玩法：8 个空槽顺时针填充星座；库存 9 种星座各 2 个；
    // 出现相同星座即结算：N = 两相同星座间的星座数量 + 1；8 个全不同 / 主动退出按已召唤数结算。
    res_slot_count: 8,
    // 已召唤数量(0..7) → 继续召唤价格（电池）。第 n+1 次召唤按"已召唤 n 个"查表。
    res_price_schedule: [50, 50, 85, 220, 420, 800, 1820, 3360],
    // 每局库存中每种星座的数量
    res_inventory_per_type: 2,
    // 9 种星座名称（id 1..9，与 HalfInit style_config_map 的 heart_1..heart_9 一一对应）
    res_constellations: [
      "双鱼座", "猎户座", "天琴座", "双子座", "狮子座",
      "射手座", "大熊座", "天蝎座", "英仙座",
    ],
    res_carousel_pool: [
      { user_name: "TOMAJX", gift_name: "星烙徽印" },
      { user_name: "榛子天堂", gift_name: "星烙徽印" },
      { user_name: "大帝-玉皇成仙中", gift_name: "长明星河" },
      { user_name: "琉璃家的王子", gift_name: "长明星河" },
      { user_name: "蘼芜已青_Official", gift_name: "长明星河" },
      { user_name: "小兔叽乖不乖", gift_name: "星烙徽印" },
      { user_name: "-㐓㤅", gift_name: "长明星河" },
      { user_name: "白嫖之路挺艰辛", gift_name: "长明星河" },
      { user_name: "StandinMizu", gift_name: "星烙徽印" },
      { user_name: "Sayunedmi", gift_name: "长明星河" },
    ],
    // N=1..8 → 奖励礼物（price/gift_value 单位为分 = 电池×100；gift_id 为真实礼物目录 id）。
    // 结算（Summon/ExitGame 的 prize）按 N 取本表，与 algorithms.ts 的 RESONANCE_PRIZES 保持一致。
    res_gift_ids: [35849, 35850, 35851, 35852, 35853, 35854, 35856, 35857],
    prize_config: [
      { n: 1, price: 5000, gift_value: 5000, gift_id: 35849, gift_name: "初遇引星", gift_img: "https://s1.hdslb.com/bfs/live/c66229300d107e844596d65c6ec4d00b6ae0233e.png" },
      { n: 2, price: 10000, gift_value: 10000, gift_id: 35850, gift_name: "驻听星语", gift_img: "https://s1.hdslb.com/bfs/live/2d7b22c2f6e18f085b82d286068718720ec40f81.png" },
      { n: 3, price: 20000, gift_value: 20000, gift_id: 35851, gift_name: "并蒂双星", gift_img: "https://s1.hdslb.com/bfs/live/e07053b8a91b36722c276de12cc87e985f37bec9.png" },
      { n: 4, price: 50000, gift_value: 50000, gift_id: 35852, gift_name: "欢跃星阵", gift_img: "https://s1.hdslb.com/bfs/live/78de897903ce5dc79f550ae9066bae7f988b3482.png" },
      { n: 5, price: 120000, gift_value: 120000, gift_id: 35853, gift_name: "引路同星", gift_img: "https://s1.hdslb.com/bfs/live/2a0b00ccfe94f8017725c76e2cac5f08429ce3c8.png" },
      { n: 6, price: 300000, gift_value: 300000, gift_id: 35854, gift_name: "守护星盾", gift_img: "https://s1.hdslb.com/bfs/live/e5176ff862e02474b1b9c3dae887ff531bacc790.png" },
      { n: 7, price: 880000, gift_value: 880000, gift_id: 35856, gift_name: "星烙徽印", gift_img: "https://s1.hdslb.com/bfs/live/8b1fbfe2b401d608cc32edf53a855aa397ed95c9.png" },
      { n: 8, price: 3000000, gift_value: 3000000, gift_id: 35857, gift_name: "长明星河", gift_img: "https://s1.hdslb.com/bfs/live/77ad18c4403ae1b89f10a5ca7dc52561ec1f21a4.png" },
    ],
  };
  if (CFG) {
    for (var k in CFG) if (k !== "mockAllApi" && CFG[k] !== undefined) CONFIG[k] = CFG[k];
  }

  // —— 图片本地化（moniqi 镜像页专用）——
  // 真实页面 remoteEntry 的 convertUrl 会把 style_config_map 里的 B站 CDN URL 去掉协议、
  // 拼上 @0e_80q.avif 后缀再请求 CDN；镜像环境（localhost 页面）首次加载这些请求会被浏览器
  // ORB 拦截，导致背景图/按钮图等资源缺失。设置 CONFIG.local_image_base（如 /moniqi/mirror/{id}）
  // 时，把全部 B站 CDN 图片 URL 改写为本地镜像同源路径：本地路径不匹配 isBfsImageUrl 正则，
  // 页面不会拼接后缀，同源请求也没有跨域/防盗链问题。原生端不设置该配置，保持 CDN 直连不变。
  function resLocalUrl(u) {
    if (!u || !CONFIG.local_image_base || typeof u !== "string") return u;
    var m = u.match(/^https?:\/\/([^/]+)\/(.+)$/);
    if (!m) return u;
    return CONFIG.local_image_base + "/" + m[1] + "/" + m[2];
  }
  if (CONFIG.local_image_base) {
    var _prizes = CONFIG.prize_config || [];
    for (var _pi = 0; _pi < _prizes.length; _pi++) {
      if (_prizes[_pi] && _prizes[_pi].gift_img) _prizes[_pi].gift_img = resLocalUrl(_prizes[_pi].gift_img);
    }
  }

  // 电池余额（gold 单位 = 分，gold/100 = 电池）。初始 1e7 分 = 10万电池。
  // 每次抽取/替换扣减对应 price，随操作递减，使页面电池显示更有真实感。
  // 注意：页面仅在加载时调用 myWallet 一次，后续不再刷新余额。
  // 因此用 setInterval 持续更新页面 .balance-amount 元素，使显示随操作递减。
  var batteryBalance = 10000000;

  // 格式化电池余额为显示文本（与页面格式一致：>= 1万时用"X.X万"，否则直接数字）
  function formatBattery(gold) {
    var battery = Math.floor(gold / 100);
    if (battery >= 10000) {
      return (battery / 10000).toFixed(1).replace(/\.0$/, "") + "万";
    }
    return battery.toString();
  }
  // 持续更新页面余额显示（Vue 重新渲染后会覆盖，interval 会再纠正）
  // 页面实际余额元素是 .balance-value（.balance-amount 为旧版选择器，兼容保留）
  setInterval(function () {
    try {
      var el = document.querySelector(".balance-value") || document.querySelector(".balance-amount");
      if (!el) return;
      var text = formatBattery(batteryBalance);
      if (el.textContent !== text) el.textContent = text;
    } catch (e) {}
  }, 300);

  function now() {
    return Math.floor(Date.now() / 1000);
  }
  function randInt(min, max) {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  function pickCarousel() {
    var pool = CONFIG.carousel_pool;
    var list = [];
    for (var i = 0; i < 5; i++) list.push(pool[randInt(0, pool.length - 1)]);
    return list;
  }

  // 槽位状态：初始为空（未抽取），从注入配置(本地文件)或 localStorage 恢复，跨打开保留。
  // slotState 形如 {"1":3,"2":5}：key 为槽位号(1..slotCount)，value 为原材料序号(1..slotMax)。
  var slotState = {};
  var initialSlots = CFG && CFG.slot_state;
  if (initialSlots && typeof initialSlots === "object" && !Array.isArray(initialSlots)) {
    slotState = initialSlots;
  } else {
    try {
      var saved = localStorage.getItem("bili_activity_slots");
      if (saved) slotState = JSON.parse(saved);
    } catch (e) {}
  }
  function saveSlots() {
    try {
      localStorage.setItem("bili_activity_slots", JSON.stringify(slotState));
    } catch (e) {}
  }
  // 打开页面时把初始槽位状态同步给前端（前端据此持久化到本地文件）
  notifyState();

  // 替换价格表：根据当前槽位中相同素材的最大数量(maxCount)动态定价。
  // 单位为 gold(分)，除以100=电池。maxCount=6 时替换禁用(价格为0)。
  var REPLACE_PRICE_MAP = {
    1: 5000,    // 全不同：50电池
    2: 2800,    // 2个相同：28电池
    3: 7800,    // 3个相同：78电池
    4: 31500,   // 4个相同：315电池
    5: 386000,  // 5个相同：3860电池
    6: 0,       // 全相同：替换禁用
  };
  // 计算当前槽位中相同素材的最大数量
  function calcMaxIdenticalCount() {
    var counts = {};
    for (var k in slotState) {
      var v = slotState[k];
      if (v === undefined || v === 0) continue;
      counts[v] = (counts[v] || 0) + 1;
    }
    var maxCount = 0;
    for (var m in counts) {
      if (counts[m] > maxCount) maxCount = counts[m];
    }
    return maxCount || 1;
  }
  // 根据当前槽位状态计算动态替换价格
  function calcReplacePrice() {
    var mc = calcMaxIdenticalCount();
    return REPLACE_PRICE_MAP[mc] !== undefined ? REPLACE_PRICE_MAP[mc] : 0;
  }

  function buildCommonData() {
    return {
      act_id: CONFIG.act_id,
      activity_name: CONFIG.activity_name,
      start_time: CONFIG.start_time,
      end_time: CONFIG.end_time,
      cur_timestamp: now(),
      carousel_list: pickCarousel(),
      draw_price: CONFIG.draw_price,
      // replace_price 随槽位状态动态变化：相同素材越多替换越贵
      replace_price: calcReplacePrice(),
      // 注意：用 CONFIG.gift_info（与真实 StarStoneInfo 一致的 6 个礼物完整列表），
      // 而不是已废弃的 CONFIG.draw_gift_info，否则页面只能渲染 1 个合成礼物。
      gift_info: CONFIG.gift_info,
      // slot_info 必须包含全部 6 个槽位（空槽位值为 0），
      // 否则页面的 O 函数只会为 JSON 中存在的 key 创建槽位，导致空槽位消失。
      slot_info: JSON.stringify(buildSlotInfo()),
    };
  }
  // 构建完整的槽位信息：1..slotCount，空槽位为 0，已抽取槽位为材料序号。
  function buildSlotInfo() {
    var info = {};
    for (var i = 1; i <= CONFIG.slotCount; i++) {
      info[String(i)] = slotState[String(i)] !== undefined ? slotState[String(i)] : 0;
    }
    return info;
  }

  // ===== 请求体解析（真实页面为 form-urlencoded：Draw 带 slot_ids/num，Replace 带 slot_id）=====
  function parseBody(body) {
    var params = {};
    if (!body) return params;
    try {
      if (typeof body === "string") {
        var s = body.trim();
        if (s.indexOf("{") === 0) {
          params = JSON.parse(s);
        } else if (s) {
          s.split("&").forEach(function (pair) {
            var kv = pair.split("=");
            if (kv.length < 2 || !kv[0]) return;
            var k = decodeURIComponent(kv[0]);
            var v = decodeURIComponent(kv.slice(1).join("="));
            if (k in params) {
              if (!Array.isArray(params[k])) params[k] = [params[k]];
              params[k].push(v);
            } else {
              params[k] = v;
            }
          });
        }
      } else if (body && typeof URLSearchParams !== "undefined" && body instanceof URLSearchParams) {
        body.forEach(function (v, k) {
          params[k] = v;
        });
      } else if (body && typeof FormData !== "undefined" && body instanceof FormData) {
        body.forEach(function (v, k) {
          params[k] = v;
        });
      } else if (body && typeof body === "object") {
        params = body;
      }
    } catch (e) {}
    return params;
  }
  // 解析 Draw 的槽位数组：slot_ids=[1,2,3] / slot_ids=1&slot_ids=2 / JSON 数组
  function parseSlotIds(params) {
    var raw = params["slot_ids"];
    if (raw === undefined || raw === null) return null;
    var arr = Array.isArray(raw) ? raw : [raw];
    var out = [];
    arr.forEach(function (v) {
      var s = String(v).trim();
      if (s.indexOf("[") === 0 && s.lastIndexOf("]") === s.length - 1) {
        s.slice(1, -1)
          .split(",")
          .forEach(function (x) {
            var n = parseInt(x, 10);
            if (n >= 1 && n <= CONFIG.slotCount) out.push(n);
          });
      } else {
        var n = parseInt(s, 10);
        if (n >= 1 && n <= CONFIG.slotCount) out.push(n);
      }
    });
    return out.length ? out : null;
  }
  // 解析 Replace 的槽位：slot_id=2
  function parseSlotId(params) {
    var raw = params["slot_id"];
    if (raw === undefined || raw === null) return null;
    var s = String(Array.isArray(raw) ? raw[0] : raw).trim();
    var n = parseInt(s, 10);
    return n >= 1 && n <= CONFIG.slotCount ? n : null;
  }

  // ===== 通过 Tauri 事件向前端同步状态 / 通知合成 =====
  function tauriEmit(event, payload) {
    if (MIRROR) return; // Web 镜像无原生通道，显式短路
    try {
      var t = window.__TAURI_INTERNALS__;
      if (t && typeof t.invoke === "function") {
        t.invoke("plugin:event|emit", { event: event, payload: payload });
      }
    } catch (e) {}
  }
  function notifyState() {
    tauriEmit("activity-slot-sync", { slots: slotState });
  }
  function notifyCompose(gift) {
    tauriEmit("activity-compose", { gift: gift });
  }

  // 抽取（Draw）：把请求里指定槽位(slot_ids)逐个填入随机原材料；未解析到槽位时抽取首个空槽位。
  function makeDraw(slotIds) {
    if (!slotIds || !slotIds.length) {
      var firstEmpty = null;
      for (var i = 1; i <= CONFIG.slotCount; i++) {
        if (slotState[String(i)] === undefined) {
          firstEmpty = i;
          break;
        }
      }
      slotIds = firstEmpty ? [firstEmpty] : [1];
    }
    for (var j = 0; j < slotIds.length; j++) {
      slotState[String(slotIds[j])] = randInt(CONFIG.slotMin, CONFIG.slotMax);
    }
    // 扣减电池余额（draw_price 单位与 gold 一致 = 分）
    batteryBalance = Math.max(0, batteryBalance - CONFIG.draw_price);
    saveSlots();
    notifyState();
    return { code: 0, message: "OK", ttl: 1, data: buildCommonData() };
  }
  // 替换（Replace）：仅替换请求指定的 slot_id 槽位，随机换一种原材料。
  function makeReplace(slotId) {
    if (!slotId) slotId = randInt(1, CONFIG.slotCount);
    // 先计算替换前的价格（基于当前槽位状态），扣减电池余额
    var price = calcReplacePrice();
    slotState[String(slotId)] = randInt(CONFIG.slotMin, CONFIG.slotMax);
    batteryBalance = Math.max(0, batteryBalance - price);
    saveSlots();
    notifyState();
    return { code: 0, message: "OK", ttl: 1, data: buildCommonData() };
  }
  function makeCompose() {
    // 合成规则：统计 6 个槽位中相同素材的最大数量(maxCount)。
    // gift_info 数组从高到低排列（gift_info[0] 最贵，gift_info[5] 最便宜）。
    // maxCount=6（全相同）→ gift_info[0]，maxCount=1（全不同）→ gift_info[5]。
    // 即 gift_info[gift_info.length - maxCount]。
    var counts = {};
    for (var k in slotState) {
      var v = slotState[k];
      counts[v] = (counts[v] || 0) + 1;
    }
    var maxCount = 0;
    for (var m in counts) {
      if (counts[m] > maxCount) maxCount = counts[m];
    }
    if (maxCount === 0) maxCount = 1;
    var gifts = CONFIG.gift_info;
    var idx = gifts.length - maxCount;
    if (idx < 0) idx = 0;
    if (idx >= gifts.length) idx = gifts.length - 1;
    var gift = gifts[idx];
    // 合成消耗全部槽位素材，并通知前端入库"包裹"
    slotState = {};
    saveSlots();
    notifyState();
    notifyCompose(gift);
    return { code: 0, message: "OK", ttl: 1, data: { gift_info: gift } };
  }
  function genericSuccess() {
    return { code: 0, message: "OK", ttl: 1, data: {} };
  }

  // 登录态查询接口：让页面以为已登录（且是假账号身份），从而跳过登录跳转 + 规避"自己直播间不能参与"。
  // 注意：mid 必须是假账号（不能是当前主播 uid），否则页面 isSelf 判断为真，会禁止在自家直播间操作。
  function fakeLoginNav() {
    return {
      code: 0,
      message: "0",
      ttl: 1,
      data: {
        isLogin: true,
        mid: CONFIG.fake_uid,
        uname: "模拟游客",
        money: 10000,
        level_info: { current_level: 6, current_min: 0, current_exp: 0, next_exp: 0 },
        vipStatus: 1,
        vipType: 2,
        vipDueDate: 0,
        face: "https://i0.hdslb.com/bfs/face/noface.jpg",
      },
    };
  }

  // 钱包余额：gold 单位是"分"，gold/100 = 电池。
  // 返回当前 batteryBalance（随抽取/替换操作递减），使页面电池显示有真实感。
  function fakeWallet() {
    return {
      code: 0,
      message: "0",
      ttl: 1,
      data: {
        gold: batteryBalance,
        silver: 0,
        coupon_balance: 0,
        white_coupon_balance: 0,
        auto_charge: false,
        hint: "",
      },
    };
  }

  // 消费统计（userconsume）：统一返回"今日/累计消费 0"，避免页面弹出"已累计消费 X 万元"之类
  // 的理性消费提醒弹窗。data 里同时给常见数字字段，页面无论读哪个都取到 0。
  function fakeZeroConsume() {
    return {
      code: 0,
      message: "0",
      ttl: 1,
      data: { total: 0, today_cost: 0, today_total: 0, cost: 0, consume_today: 0, consume_total: 0 },
    };
  }

  // ===== 逐级开箱（玲珑宝斋）算法 =====
  // 玩法：分多级（默认5级）宝箱。只有成功开出上一级的"目标宝物"，才能开启下一级。
  // 每级6个宝箱，开一个花费 item_price（电池），开出目标材料则本级成功，得到本级礼物；
  // 最高一级开出大奖后游戏结束。
  // 配置来自 CONFIG.item_levels（每级一个：box_name/box_icon/item_name/item_price/
  // item_gift_value/item_gift_icon/target{id,name,icon}/materials[普通材料]，box_count）。
  // 解析 GET URL 查询参数（OpenBox 为 GET 请求，box_position 等放在 query 里）
  function parseQuery(url) {
    var q = {};
    var qi = url ? url.indexOf("?") : -1;
    if (qi < 0) return q;
    url.slice(qi + 1).split("&").forEach(function (p) {
      if (!p) return;
      var kv = p.split("=");
      var k = decodeURIComponent(kv[0]);
      var v = decodeURIComponent(kv.slice(1).join("="));
      if (k && v !== "") q[k] = v;
    });
    return q;
  }
  // 逐级开箱状态：持久化到 localStorage，跨打开保留
  // 版本号：每次修改状态结构时递增，旧版本状态自动清空以避免字段缺失导致的逻辑异常
  // V1: 初始版本，无 assign 字段
  // V2: 新增 assign 字段（每个宝箱预分配随机素材）
  // V3: 重置版本，强制清除所有旧状态，确保素材完全随机
  var LING_STATE_VERSION = 3;
  var lingState = {
    _v: LING_STATE_VERSION,
    current_item_level: (CONFIG.item_levels && CONFIG.item_levels[0]) ? 1 : 1,
    progress: {},
  };
  (function () {
    try {
      var saved = localStorage.getItem("bili_activity_linglong");
      if (saved) {
        var parsed = JSON.parse(saved);
        if (!parsed || parsed._v !== LING_STATE_VERSION) {
          console.log("[LING-MOCK] 检测到旧版本状态，清空重新初始化 (old_v=" + (parsed && parsed._v) + ")");
          localStorage.removeItem("bili_activity_linglong");
        } else {
          lingState = parsed;
        }
      }
    } catch (e) {}
    console.log("[LING-MOCK] shim loaded, state_v=" + LING_STATE_VERSION + ", items=" + (CONFIG.item_levels ? CONFIG.item_levels.length : 0));
  })();
  function saveLingState() {
    try {
      lingState._v = LING_STATE_VERSION;
      localStorage.setItem("bili_activity_linglong", JSON.stringify(lingState));
    } catch (e) {}
  }
  function lingLevelCfg(level) {
    var lv = CONFIG.item_levels || [];
    return lv[level - 1] || null;
  }
  // 初始化某层进度（首次访问该层时就完成"全部装箱分配"）：
  //  - 从 box_count 个宝箱中随机挑 1 个作为目标宝物所在宝箱；
  //  - 其余宝箱从材料池随机且不重复地抽取普通材料，每个宝箱的素材完全随机。
  function ensureLingLevel(level) {
    if (lingState.progress[level]) return lingState.progress[level];
    var cfg = lingLevelCfg(level);
    var boxCount = cfg ? (cfg.box_count || 6) : 6;
    var targetPos = cfg ? randInt(1, boxCount) : 1;
    var p = { target_obtained: false, target_pos: targetPos, opened: {}, assign: {} };
    if (cfg) {
      var pool = (cfg.materials || []).slice();
      for (var i = pool.length - 1; i > 0; i--) {
        var j = randInt(0, i);
        var tmp = pool[i]; pool[i] = pool[j]; pool[j] = tmp;
      }
      var used = 0;
      for (var b = 1; b <= boxCount; b++) {
        if (b === targetPos) continue;
        if (used < pool.length) {
          p.assign[b] = pool[used++];
        } else {
          var fallbackIdx = (b - 1) % pool.length;
          p.assign[b] = pool[fallbackIdx];
        }
      }
      console.log("[LING-MOCK] level=" + level + " target_pos=" + targetPos + " box_count=" + boxCount + " materials_assigned=" + used);
    }
    lingState.progress[level] = p;
    saveLingState();
    return p;
  }
  // 构建某层的一个宝箱项（返回完整 item 所需的 boxes 数组内元素）
  function lingBoxNode(level, pos) {
    var p = lingState.progress[level];
    var node = { position: pos };
    if (p && p.opened[pos]) {
      var m = p.opened[pos];
      node.is_opened = true;
      node.material_id = m.id;
      node.material_name = m.name;
      node.material_icon = m.icon;
      if (pos === p.target_pos) node.is_target = true;
    }
    return node;
  }
  // 规则4：收下礼物（结算）后游戏恢复到初始状态——清空所有宝箱开启记录、回到第 1 级
  function resetLingState() {
    lingState.progress = {};
    lingState.current_item_level = (CONFIG.item_levels && CONFIG.item_levels[0]) ? 1 : 1;
    saveLingState();
  }
  // 构建完整 GetGameState 响应
  function makeLingGetGameState() {
    var lv = CONFIG.item_levels || [];
    var items = lv.map(function (cfg) {
      var level = cfg.item_level;
      var p = ensureLingLevel(level);
      var boxes = [];
      for (var i = 1; i <= (cfg.box_count || 6); i++) {
        var node = lingBoxNode(cfg.item_level, i);
        boxes.push(node);
      }
      return {
        item_level: cfg.item_level,
        boxes: boxes,
        target_obtained: !!p.target_obtained,
        target_material_id: cfg.target.id,
        target_material_name: cfg.target.name,
        target_material_icon: cfg.target.icon,
        item_name: cfg.item_name,
        item_price: cfg.item_price,
        item_gift_value: cfg.item_gift_value,
        item_gift_icon: cfg.item_gift_icon,
        box_icon: cfg.box_icon,
        box_name: cfg.box_name,
      };
    });
    return {
      code: 0,
      message: "OK",
      ttl: 1,
      data: {
        game_status: 1,
        current_item_level: lingState.current_item_level,
        items: items,
        default_selected_item: lingState.current_item_level,
        end_time: CONFIG.end_time || 1788148799,
        current_time: now(),
        carousel: makeLingCarousel(),
      },
    };
  }
  function makeLingCarousel() {
    var lv = CONFIG.item_levels || [];
    if (!lv.length) return [];
    var picks = [];
    for (var i = 0; i < 10; i++) {
      var cfg = lv[randInt(0, lv.length - 1)];
      picks.push({ uid: randInt(1000000, 999999999), gift_name: cfg.item_name });
    }
    return picks;
  }
  // 开箱：读取 query 的 box_position（目标箱子序号），没有则开该层第一个未开的箱。
  function makeLingOpenBox(query) {
    var level = parseInt((query && query.item_level) || lingState.current_item_level, 10);
    var cfg = lingLevelCfg(level);
    if (!cfg) return { code: 0, message: "OK", ttl: 1, data: {} };
    var boxCount = cfg.box_count || 6;
    var p = ensureLingLevel(level);
    if (p.target_obtained) {
      // 页面端 verifyTargetObtained 会拦截并提示"已获取目标材料"，此处为兜底
      for (var i = 1; i <= boxCount; i++) {
        if (p.opened[i]) {
          var m0 = p.opened[i];
          return { code: 0, message: "OK", ttl: 1, data: { box_position: i, material_id: m0.id, material_name: m0.name, material_icon: m0.icon, current_item_level: level, is_target: false } };
        }
      }
      return { code: 0, message: "OK", ttl: 1, data: { current_item_level: level, is_target: false } };
    }
    var pos = parseInt(query && query.box_position, 10);
    if (!pos) {
      for (var i = 1; i <= boxCount; i++) {
        if (!p.opened[i]) { pos = i; break; }
      }
      if (!pos) pos = 1;
    }
    if (p.opened[pos]) {
      var m0 = p.opened[pos];
      return { code: 0, message: "OK", ttl: 1, data: { box_position: pos, material_id: m0.id, material_name: m0.name, material_icon: m0.icon, current_item_level: level, is_target: pos === p.target_pos } };
    }
    // 扣减电池余额（item_price 为电池数，batteryBalance 为 gold 分 → ×100）
    batteryBalance = Math.max(0, batteryBalance - cfg.item_price * 100);
    var final = level === CONFIG.item_levels.length;
    var material;
    var isTargetHit = false;
    if (pos === p.target_pos) {
      material = { id: cfg.target.id, name: cfg.target.name, icon: cfg.target.icon };
      p.target_obtained = true;
      isTargetHit = true;
      console.log("[LING-MOCK] TARGET HIT level=" + level + " pos=" + pos + " target=" + cfg.target.name + " final=" + final);
    } else {
      material = (p.assign && p.assign[pos]) || { id: cfg.target.id + pos, name: "材料" + pos, icon: "" };
    }
    p.opened[pos] = material;

    if (isTargetHit && final) {
      // 最终级目标命中：
      // 1. 调用 notifyCompose 把礼物推入包裹（页面 handleGameOver 不会调用 SettleGame API）
      // 2. 立即重置所有状态 → 页面 fetchGameData 会拿到 level 1 全未开的初始状态
      notifyCompose({
        gift_id: cfg.gift_id,
        gift_name: cfg.item_name,
        gift_img: cfg.item_gift_icon,
        gift_price: cfg.item_gift_value,
      });
      resetLingState();
    } else if (isTargetHit && !final) {
      // 非最终层目标命中：提前推进层级，配合页面 auto-advance 流程
      lingState.current_item_level = level + 1;
      saveLingState();
    } else {
      lingState.current_item_level = level;
      saveLingState();
    }

    var responseIsTarget = isTargetHit;

    var d = {
      box_position: pos,
      material_id: material.id,
      material_name: material.name,
      material_icon: material.icon,
      current_item_level: level,
      is_target: responseIsTarget,
    };

    if (isTargetHit && final) {
      d.is_game_over = true;
      d.reward_gift_name = cfg.item_name;
      d.reward_gift_value = cfg.item_gift_value;
      d.reward_gift_id = cfg.gift_id;
      d.reward_gift_icon = cfg.item_gift_icon;
    }

    console.log("[LING-MOCK] openBox level=" + level + " pos=" + pos + " material=" + material.name + " target=" + isTargetHit + " final=" + final);
    return { code: 0, message: "OK", ttl: 1, data: d };
  }
  // 结算（合成退出比赛）：玩家在某一层开出目标宝物后，选择"合成礼物退出"时调用。
  // 返回当前已获得的最高级礼物的信息（settled_item_level + 礼物 id/名称/价值/图标）。
  function makeLingSettleGame() {
    var lv = CONFIG.item_levels || [];
    // 从高到低找第一个已获得的层 = 可以获得并结算的最高礼物
    var settled = null;
    for (var i = lv.length; i >= 1; i--) {
      var p = lingState.progress[i];
      if (p && p.target_obtained) {
        var cfg = lingLevelCfg(i);
        settled = cfg || lingLevelCfg(1);
        break;
      }
    }
    if (!settled) {
      // 尚无任何层获得 → 结算当前可玩层（仍返回礼物，避免页面空数据）
      settled = lingLevelCfg(lingState.current_item_level) || lingLevelCfg(1);
    }
    if (!settled) {
      // 配置缺失（如注入失败）时返回空结算，避免空指针导致页面报错
      return { code: 0, message: "OK", ttl: 1, data: { settled_item_level: 0, gift_name: "", gift_value: 0, gift_id: 0, gift_icon: "" } };
    }
    // 收下礼物：通过共享的 activity-compose 事件把礼物推给前端，入库"礼物栏包裹"
    //（与晶石工坊 makeCompose 同一通道，所有合成活动共用）。
    notifyCompose({
      gift_id: settled.gift_id,
      gift_name: settled.item_name,
      gift_img: settled.item_gift_icon,
      gift_price: settled.item_gift_value,
    });
    // 规则4：收下礼物（结算）后，游戏状态恢复到初始状态（所有宝箱未开启、回到第 1 级）
    resetLingState();
    return {
      code: 0,
      message: "OK",
      ttl: 1,
      data: {
        settled_item_level: settled.item_level,
        gift_name: settled.item_name,
        gift_value: settled.item_gift_value,
        gift_id: settled.gift_id,
        gift_icon: settled.item_gift_icon,
      },
    };
  }

  // ===== 逐级点亮（成名之路）算法 =====
  // 玩法：5 档顺序点亮，从第 1 档开始；花费电池尝试点亮，概率成功。
  // 成功：点亮当前档位；失败：当前档位点亮失败，上一已点亮档位熄灭（1 档失败无惩罚）。
  // 每档独立【人气】，失败时该档人气 +1，人气达到上限后本局后续尝试该档必定成功。
  // 点亮第 5 档自动结束并发放对应礼物；至少点亮 1 档后可主动结算。
  var CHENG_STATE_VERSION = 1;
  var chengState = {
    _v: CHENG_STATE_VERSION,
    current_level: 0,
    lighted: {},
    pity: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
  };
  (function () {
    try {
      var saved = localStorage.getItem("bili_activity_chengming");
      if (saved) {
        var parsed = JSON.parse(saved);
        if (parsed && parsed._v === CHENG_STATE_VERSION) {
          chengState = parsed;
        } else {
          localStorage.removeItem("bili_activity_chengming");
        }
      }
    } catch (e) {}
  })();
  function saveChengState() {
    try {
      chengState._v = CHENG_STATE_VERSION;
      localStorage.setItem("bili_activity_chengming", JSON.stringify(chengState));
    } catch (e) {}
  }
  function resetChengState() {
    chengState.current_level = 0;
    chengState.lighted = {};
    chengState.pity = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
    saveChengState();
  }
  function chengmingLevelCfg(level) {
    var lv = CONFIG.chengming_levels || [];
    return lv[level - 1] || null;
  }
  function chengmingNotifyGift(levelCfg) {
    notifyCompose({
      gift_id: levelCfg.gift_id,
      gift_name: levelCfg.gift_name,
      gift_img: levelCfg.gift_icon,
      gift_price: levelCfg.gift_value,
    });
  }
  function makeChengCarousel() {
    var lv = CONFIG.chengming_levels || [];
    if (!lv.length) return [];
    var names = ["小羊嘎嘎嘎", "心寒的老父亲", "Kono", "哦豁down", "某个优雅的男人", "AC4o2", "Phoenix", "Caictou", "三条是大猛男", "在下香菜教主"];
    var picks = [];
    for (var i = 0; i < 10; i++) {
      var cfg = lv[randInt(0, lv.length - 1)];
      picks.push({ uid: randInt(1000000, 999999999), user_name: names[i] || "模拟用户", gift_name: cfg.gift_name });
    }
    return picks;
  }
  function makeChengGetGameState() {
    var lv = CONFIG.chengming_levels || [];
    var levels = lv.map(function (cfg) {
      return {
        item_level: cfg.item_level,
        level_name: cfg.level_name,
        level_icon: cfg.level_icon,
        gift_id: cfg.gift_id,
        gift_name: cfg.gift_name,
        gift_icon: cfg.gift_icon,
        gift_value: cfg.gift_value,
        price: cfg.price,
        success_rate: cfg.success_rate,
        pity_progress: chengState.pity[cfg.item_level] || 0,
        pity_limit: cfg.pity_limit,
        is_lighted: !!chengState.lighted[cfg.item_level],
      };
    });
    return {
      code: 0,
      message: "OK",
      ttl: 1,
      data: {
        end_time: CONFIG.end_time || 1788753599,
        current_time: now(),
        current_level: chengState.current_level,
        levels: levels,
        carousel: makeChengCarousel(),
      },
    };
  }
  function makeChengLightUp(query) {
    var targetLevel = parseInt((query && query.item_level) || (chengState.current_level + 1), 10);
    var cfg = chengmingLevelCfg(targetLevel);
    if (!cfg) {
      return {
        code: 0,
        message: "OK",
        ttl: 1,
        data: {
          is_success: false,
          is_pity_hit: false,
          current_level: chengState.current_level,
          pity_progress: Object.assign({}, chengState.pity),
          is_settled: false,
          code: 1,
          message: "点亮失败",
        },
      };
    }
    // 扣减电池余额（price 为电池数，batteryBalance 为 gold 分 → ×100）
    batteryBalance = Math.max(0, batteryBalance - cfg.price * 100);
    var pity = chengState.pity[targetLevel] || 0;
    var pityLimit = cfg.pity_limit || 999;
    var isPityHit = pity >= pityLimit;
    var roll = randInt(1, 10000);
    var isSuccess = isPityHit || roll <= cfg.success_rate;

    var data = {
      is_success: isSuccess,
      is_pity_hit: isPityHit,
      current_level: chengState.current_level,
      pity_progress: Object.assign({}, chengState.pity),
      is_settled: false,
      code: isSuccess ? 0 : 1,
      message: isSuccess ? "点亮成功" : "点亮失败",
    };

    if (isSuccess) {
      chengState.lighted[targetLevel] = true;
      chengState.current_level = targetLevel;
      data.current_level = targetLevel;
      if (targetLevel === 5) {
        chengmingNotifyGift(cfg);
        data.is_settled = true;
        resetChengState();
      }
    } else {
      chengState.pity[targetLevel] = pity + 1;
      data.pity_progress[targetLevel] = chengState.pity[targetLevel];
      if (targetLevel > 1 && chengState.lighted[targetLevel - 1]) {
        delete chengState.lighted[targetLevel - 1];
        var newLevel = 0;
        for (var i = targetLevel - 1; i >= 1; i--) {
          if (chengState.lighted[i]) {
            newLevel = i;
            break;
          }
        }
        chengState.current_level = newLevel;
        data.current_level = newLevel;
      }
    }

    saveChengState();
    console.log("[CHENG-MOCK] LightUp level=" + targetLevel + " success=" + isSuccess + " pity=" + pity + " current_level=" + data.current_level);
    return { code: 0, message: "OK", ttl: 1, data: data };
  }
  function makeChengSettle() {
    var settledLevel = chengState.current_level;
    if (settledLevel >= 1) {
      var cfg = chengmingLevelCfg(settledLevel);
      if (cfg) chengmingNotifyGift(cfg);
    }
    resetChengState();
    return { code: 0, message: "OK", ttl: 1, data: { item_level: settledLevel } };
  }
  // 页面初始化（HalfInit）返回整套页面样式/背景资源（style_config_map）+ 活动基础信息。
  // 必须返回完整数据：若被 mock 成空，页面缺少背景图等资源，会加载失败且初始化不完整，
  // 导致"当前档位点亮后无法自动跳到下一档"。这里用抓包到的真实资源 URL。
  function makeChengHalfInit() {
    return {
      code: 0,
      message: "OK",
      ttl: 1,
      data: {
        config_id: "FCK6EHCX",
        act_id: 110503,
        act_name: "成名之路",
        act_status: 1,
        timestamp: now(),
        start_time: CONFIG.start_time || 1788148800,
        end_time: CONFIG.end_time || 1788753599,
        color_map: {
          "current-name-text-color": "#CFFAFF",
          "desc-text-color": "#234FA1",
          "dropdown-bg-color": "#D6FBFC",
          "dropdown-text-color": "#446DA4",
          "highlight-btn-text-color": "#FFEAA7",
          "highlight-text-color": "#5DF6FF",
          "minor-text-color": "#4D79CB",
          "normal-text-color": "#FFFFFF",
          "pos-bg-color": "#FF89EF",
          "pos-tag-text-color": "#FFFFFF",
          "progress-bg-color": "#508DFF",
          "progress-color": "#FE8CF0",
        },
        rule_id: 4122,
        style_config_map: {
          activity_bg: "https://i0.hdslb.com/bfs/live/048ae887feff96ddf5cc03c2158d99388e663f00.png",
          add_icon: "https://i0.hdslb.com/bfs/live/161698f3fe0722b518b40081547fbee7ed004142.png",
          back_btn: "https://i0.hdslb.com/bfs/live/4d74c1fba689b4ec2429b19fa0e3a4dba72bcdf2.png",
          battery_large_icon: "https://i0.hdslb.com/bfs/live/2456d39c9f8436cf8415bf664c2881c47cd3f16b.png",
          bottom_panel_bg: "https://i0.hdslb.com/bfs/live/f25c721709495fc5feda8e99a3acc43290787ea7.png",
          cancel_btn: "https://i0.hdslb.com/bfs/live/e46cc73984111e1b7bb98322a8fb986881ea4d22.png",
          carousel_bg: "https://i0.hdslb.com/bfs/live/9b0bc964ea7580a56f5d6e2e67c770c72a23a8c8.png",
          check_box_selected_icon: "https://i0.hdslb.com/bfs/live/343b66f8ac68f3ad59fb9a4e22ef0afe14ffbd81.png",
          check_box_unselected_icon: "https://i0.hdslb.com/bfs/live/c89624a68ee2834137fade584884c6a3a3a8b67a.png",
          circular_progress: "https://i0.hdslb.com/bfs/live/f4e857b5b2b0695e7dafe6b3b17c865d13b60d44.png",
          circular_progress_bg: "https://i0.hdslb.com/bfs/live/1a2c6b34529a8023f0b0294a9a518a12a5cf44f1.png",
          confirm_btn: "https://i0.hdslb.com/bfs/live/1d6d38b086ba39d3d397450c582c20c42ee71fdc.png",
          congratulation_title: "https://i0.hdslb.com/bfs/live/78728ff9630377864dbf1522946b566e1fbee402.png",
          decoration_left_icon: "https://i0.hdslb.com/bfs/live/c989df268c5f1b503a6d919c9328e098d50507bb.png",
          decoration_right_icon: "https://i0.hdslb.com/bfs/live/ff59afc090246c2f41ce30f6946db656519db2db.png",
          drawer_bg: "https://i0.hdslb.com/bfs/live/532e90dd2f977ae3461e969632cbadd9af1ebb1d.png",
          exit_btn: "https://i0.hdslb.com/bfs/live/74a51645f74aef4eb23764e6f78e1776f5ee9431.png",
          exit_title: "https://i0.hdslb.com/bfs/live/4bdc9bd1359f1da62439fc6417e0091811bc833b.png",
          floating_ball_bg: "https://i0.hdslb.com/bfs/live/ccf11703c2508c5da40bd715a3afe1cecd1b42e0.png",
          gift_info_bg: "https://i0.hdslb.com/bfs/live/5fc879afdca44bd863049109e52cb292c25291b9.png",
          grid_lit_bg: "https://i0.hdslb.com/bfs/live/1a364efe715aec4822ed2d1ce3ff64f02c6a8d15.png",
          grid_selected_bg: "https://i0.hdslb.com/bfs/live/953f42d0603a303dc815e77cfcd35b5d0f01161b.png",
          grid_unlit_bg: "https://i0.hdslb.com/bfs/live/717b184d175a29c713b5d22c14789cf5888cf964.png",
          horn_icon: "https://i0.hdslb.com/bfs/live/d81ad3760db931ef78ff4b8b21b8700912da5285.png",
          kv: "https://i0.hdslb.com/bfs/live/dc8c3ef5672be684a812b14d689c99a67fb9cc0a.png",
          light_btn: "https://i0.hdslb.com/bfs/live/9cd4e976b3fd06c35349ddd75029d229d253e3ac.png",
          light_btn_disabled: "https://i0.hdslb.com/bfs/live/a66207257041694ac408dfaca9f06f7d9a466369.png",
          lock_icon: "https://i0.hdslb.com/bfs/live/c34871e11f7de14d41f3b4b67499276798d4c4dd.png",
          material_1: "https://i0.hdslb.com/bfs/live/88e7431ed11b9317727115b28ee319a275d4f9fa.png",
          material_2: "https://i0.hdslb.com/bfs/live/4b13a7977cea156994aaa67cbd14c7f6b1b0d87d.png",
          material_3: "https://i0.hdslb.com/bfs/live/a63a11611c4599dec175ddfe60f014ebd54a8c9e.png",
          material_4: "https://i0.hdslb.com/bfs/live/9719b2452be5cbd62af4696abd3826aadaa31a32.png",
          material_5: "https://i0.hdslb.com/bfs/live/4ca07c68348a6a2a113a8f2083cd65069b2dd961.png",
          not_eligible_btn: "https://i0.hdslb.com/bfs/live/df780c2c4cb2fccbaa9c53f9db9baee289373105.png",
          pop_up_bg: "https://i0.hdslb.com/bfs/live/4bb7f8b35cac0a49f0de374f14b670283758ac97.png",
          pop_up_gift_info_bg: "https://i0.hdslb.com/bfs/live/2396f02b5e8aab120ed2e3e87164c3ff431bd8df.png",
          question_icon: "https://i0.hdslb.com/bfs/live/52c194aa041bba022816de36f92489fe2b368402.png",
          record_btn: "https://i0.hdslb.com/bfs/live/ee741669eace1333fa6ea218e5b71b8ccda8b5c1.png",
          "record_btn-1": "https://i0.hdslb.com/bfs/live/3edf44ad4a203b10a5814ab5b86c54e4a447c45e.png",
          record_item_bg: "https://i0.hdslb.com/bfs/live/72abb0e3368fcaddbc695d1ca71ee502f958969d.png",
          record_title: "https://i0.hdslb.com/bfs/live/c22159eac51cb6f63d7df37dea78ec88a7df909c.png",
          rule_btn: "https://i0.hdslb.com/bfs/live/8d4a0388ced167b7a7b30f2917a20c389d947d79.png",
          rule_title: "https://i0.hdslb.com/bfs/live/0dec745332e6ea73c602646aa8405d337c418239.png",
          分类: "https://i0.hdslb.com/bfs/live/b1846cb224f0b0e7c329ea7e05d15b91dde05d8c.png",
          "分类-1": "https://i0.hdslb.com/bfs/live/2b2399503bb2235a07005d4040a84b7346d55842.png",
          "分类-2": "https://i0.hdslb.com/bfs/live/b93283496c4d07b4817bb1fd361bea9fbf2feb43.png",
          "分类-3": "https://i0.hdslb.com/bfs/live/682d930b7386c5132f3ba917a5b519e5e0116998.png",
          "分类-4": "https://i0.hdslb.com/bfs/live/bd9c6135c0d5a6c52517de7f4f7f5d3f56659a4f.png",
        },
      },
    };
  }

  // ===== 同数间隔合成（星座回响）算法 =====
  // 玩法：8 个空槽，每次付费从剩余库存随机抽 1 个【星座】顺时针填充空槽，库存中该星座数量 -1。
  // 库存固定：9 种星座各 2 个（共 18 个）。已召唤数量决定继续召唤的价格（见 res_price_schedule）。
  // 结束与结算（N 决定奖励，prize_config 按 N 取）：
  //   ① 出现 2 个相同星座 → 结束，N = 两相同星座间的星座数量 + 1；
  //   ② 主动退出 → N = 已召唤的星座数量；
  //   ③ 出现 8 个不同的星座 → N = 8；
  //   ④ 活动结束 → 按现有星座数量结算。
  // 接口（与真实 resonance/* 一致）：
  //   HalfInit(GET)：页面初始化配置（样式/文案/奖励表，下方 makeResHalfInit 为抓包原文）
  //   GameInfo(GET)：当前局状态（game_id=0 无局 / price 下次召唤价 / hearts 已召唤星座 id 数组）
  //   StartGame(POST)：新开一局并做第一次召唤（响应 heart = 本次抽到的星座 id 1..9）
  //   Summon(POST)：继续召唤（body 带 game_id/price/heart_cnt，heart_cnt = 当前已召唤数量）
  //   ExitGame(POST)：主动退出结算（body 带 game_id/heart_cnt，heart_cnt = 当前已召唤数量）
  //   PlayRecord(GET)：获奖记录（mock 空）
  // 价格单位：内部一律为分（电池×100）；res_price_schedule 为电池数。
  var RES_STATE_VERSION = 1;
  var resState = { _v: RES_STATE_VERSION, game_id: 0, hearts: [] };
  // "我要开无双"模式：开启后每次召唤不同星座，直接获得最终大奖（N=8）
  var resUnlimited = false;
  try {
    window.addEventListener("message", function (e) {
      if (e.data && e.data.type === "unlimited") {
        resUnlimited = !!e.data.value;
        console.log("[RES-MOCK] Unlimited mode:", resUnlimited ? "ON" : "OFF");
      }
    });
  } catch (e) {}
  (function () {
    try {
      var saved = localStorage.getItem("bili_activity_resonance");
      if (saved) {
        var parsed = JSON.parse(saved);
        if (parsed && parsed._v === RES_STATE_VERSION) {
          resState = parsed;
        } else {
          localStorage.removeItem("bili_activity_resonance");
        }
      }
    } catch (e) {}
  })();
  function saveResState() {
    try {
      resState._v = RES_STATE_VERSION;
      localStorage.setItem("bili_activity_resonance", JSON.stringify(resState));
    } catch (e) {}
  }
  function resetResState() {
    resState = { _v: RES_STATE_VERSION, game_id: 0, hearts: [] };
    saveResState();
  }
  function resIsActive() {
    return resState.game_id > 0 && resState.hearts.length > 0;
  }
  // 已召唤 filled 个星座后，继续召唤的价格（电池 → ×100 分）
  function resPriceOf(filled) {
    var sched = CONFIG.res_price_schedule || [50, 50, 85, 220, 420, 800, 1820, 3360];
    var idx = filled;
    if (idx < 0) idx = 0;
    if (idx >= sched.length) idx = sched.length - 1;
    return sched[idx] * 100;
  }
  function makeResCarousel() {
    var pool = CONFIG.res_carousel_pool || [];
    if (!pool.length) return [];
    var list = [];
    for (var i = 0; i < 10; i++) {
      var it = pool[randInt(0, pool.length - 1)];
      list.push({ user_name: it.user_name || "模拟用户", gift_name: it.gift_name || "星烙徽印" });
    }
    return list;
  }
  // N → 奖励（N=1..8）。返回与真实 Summon 响应 prize 一致的结构（gift_value 单位为分）。
  function resPrizeForN(n) {
    var prizes = CONFIG.prize_config || [];
    var cfg = prizes[n - 1] || null;
    if (!cfg) return null;
    return {
      n: cfg.n,
      gift_value: cfg.price,
      gift_name: cfg.gift_name,
      gift_img: cfg.gift_img,
    };
  }
  // 从剩余库存均匀随机抽 1 个星座 id（库存 = 9 种各 res_inventory_per_type 个，减去本局已召唤的）
  // "无双"模式：只从本局未出现过的星座中抽取，确保每次都不同，最终获得 N=8 大奖。
  function resDrawHeart() {
    var perType = CONFIG.res_inventory_per_type || 2;
    var inv = {};
    for (var i = 1; i <= 9; i++) inv[i] = perType;
    for (var j = 0; j < resState.hearts.length; j++) {
      inv[resState.hearts[j]] = (inv[resState.hearts[j]] || 0) - 1;
    }
    var pool = [];
    for (var t = 1; t <= 9; t++) {
      if (inv[t] > 0) pool.push(t);
    }
    if (resUnlimited) {
      // 无双模式：只从本局未出现过的星座中抽取
      var used = {};
      for (var k = 0; k < resState.hearts.length; k++) used[resState.hearts[k]] = true;
      var freshPool = pool.filter(function (id) { return !used[id]; });
      if (freshPool.length > 0) return freshPool[randInt(0, freshPool.length - 1)];
    }
    return pool[randInt(0, pool.length - 1)];
  }
  // 结算：把奖励礼物推入前端"包裹"（所有合成活动共用 activity-compose 通道）
  function resNotifyPrize(prize) {
    if (!prize) return;
    var giftId = (CONFIG.res_gift_ids && CONFIG.res_gift_ids[prize.n - 1]) || 0;
    notifyCompose({
      gift_id: giftId,
      gift_name: prize.gift_name,
      gift_img: prize.gift_img,
      gift_price: prize.gift_value,
    });
  }
  // 页面初始化：必须返回完整 style_config_map（背景/星座卡片/礼物图等全部 UI 资源），
  // 否则页面缺少背景图等资源无法完整加载。下方为抓包到的真实响应原文（config_id=3, act_id=110504）。
  function makeResHalfInit() {
    var d = {
      code: 0,
      message: "OK",
      ttl: 1,
      data: {
        config_id: 3,
        act_id: 110504,
        act_name: "星座回响",
        act_status: 1,
        timestamp: now(),
        start_time: CONFIG.start_time || 1788753600,
        end_time: CONFIG.end_time || 1789315199,
        prize_config: CONFIG.prize_config || [
          { n: 1, price: 5000, gift_value: 5000, gift_name: "初遇引星", gift_img: "https://s1.hdslb.com/bfs/live/c66229300d107e844596d65c6ec4d00b6ae0233e.png" },
          { n: 2, price: 10000, gift_value: 10000, gift_name: "驻听星语", gift_img: "https://s1.hdslb.com/bfs/live/2d7b22c2f6e18f085b82d286068718720ec40f81.png" },
          { n: 3, price: 20000, gift_value: 20000, gift_name: "并蒂双星", gift_img: "https://s1.hdslb.com/bfs/live/e07053b8a91b36722c276de12cc87e985f37bec9.png" },
          { n: 4, price: 50000, gift_value: 50000, gift_name: "欢跃星阵", gift_img: "https://s1.hdslb.com/bfs/live/78de897903ce5dc79f550ae9066bae7f988b3482.png" },
          { n: 5, price: 120000, gift_value: 120000, gift_name: "引路同星", gift_img: "https://s1.hdslb.com/bfs/live/2a0b00ccfe94f8017725c76e2cac5f08429ce3c8.png" },
          { n: 6, price: 300000, gift_value: 300000, gift_name: "守护星盾", gift_img: "https://s1.hdslb.com/bfs/live/e5176ff862e02474b1b9c3dae887ff531bacc790.png" },
          { n: 7, price: 880000, gift_value: 880000, gift_name: "星烙徽印", gift_img: "https://s1.hdslb.com/bfs/live/8b1fbfe2b401d608cc32edf53a855aa397ed95c9.png" },
          { n: 8, price: 3000000, gift_value: 3000000, gift_name: "长明星河", gift_img: "https://s1.hdslb.com/bfs/live/77ad18c4403ae1b89f10a5ca7dc52561ec1f21a4.png" },
        ],
        word_map: {
          material_name: "星座",
          play_not_start_word: "相同的星座之间，存在的星座越多，奖励越丰厚",
          play_start_word: "出现的相同的星座时，本局游戏结束",
          room_dm_word: "星座回响：恭喜用户#{user_name}获得#{gift_name}",
          top_word_desc: "获取的礼物自动放入包裹，仅能向#{anchor_name}赠送",
          win_broadcast_word: "恭喜#{user_name}获得礼物#{gift_name}",
        },
        color_map: {
          avatar_border_color: "#77CFFF",
          countdown_num_text: "#4AF5FF",
          desc_text_color: "#234FA1",
          highlight_btn_text_color: "#FFFFFF",
          highlight_text_color: "#FFEAA7",
          marquee_highlight_text: "#D2FBFD",
          marquee_plain_text: "#09C9FE",
          minor_text_color: "#4D79CB",
          normal_text_color: "#FFFFFF",
          notice_bar_bg: "#B3E9FF",
          plus_sign: "#FF5D96",
          pop_gift_name_bg: "#146EDF",
          rule_cont_bg: "#FEFEFE",
          secondary_tip_text: "rgba(197, 253, 254, 0.6)",
          sub_text_color: "#A3D6FF",
          switch_cur_name_color: "#CFFAFF",
          switch_name_color: "#446da4",
          tag_bg_color: "#FF89EF",
          tip_color: "#ffffff",
        },
        spec_rule_map: { play_notice_word: 4134 },
        rule_list: [{ id: 4134, title: "星座回响" }],
        style_config_map: {
          arrow_down_btn: "https://i0.hdslb.com/bfs/live/ffe08cef3d37e99b2f1a38defa6c521626ee4e27.png",
          award_btn: "https://i0.hdslb.com/bfs/live/3b802233434e416f9ff7798412136c2416ba0a7f.png",
          back_btn: "https://i0.hdslb.com/bfs/live/c548e2a3b11bb211f7a14f7e6f1c50d93739ed37.png",
          backlight: "https://i0.hdslb.com/bfs/live/a308597e6c05780ac80e0401c67caeb3a61260bc.png",
          battery_icon: "https://i0.hdslb.com/bfs/live/6b5d8a5e300a26481ce620416aee2b6c8a67c606.png",
          bg: "https://i0.hdslb.com/bfs/live/9ab5ce85cde8c6f6ad410e1960a042926dfefd1a.png",
          cancel_btn_bg: "https://i0.hdslb.com/bfs/live/f1c1a1b7a41f4da043c7ebc6af7b58eccef6ae66.png",
          checkbox_checked: "https://i0.hdslb.com/bfs/live/5275896c1dba0abcd12e1b8cf6a82297b9028a26.png",
          checkbox_unchecked: "https://i0.hdslb.com/bfs/live/e998c837b72782fff986703d2557e1ac50885dbc.png",
          confirm_btn_bg: "https://i0.hdslb.com/bfs/live/8f80a82cb53b56c053dfdada2859adc14831d965.png",
          continue_btn: "https://i0.hdslb.com/bfs/live/518686eff7dae2e668af47e8f2fe87389c25c809.png",
          drawer_bg: "https://i0.hdslb.com/bfs/live/b0c5425833e52abd81492247e3270c3e1632d918.png",
          exit: "https://i0.hdslb.com/bfs/live/fb0ef07eae484182b15367af3613b8c0926d56bc.png",
          exit_btn: "https://i0.hdslb.com/bfs/live/6da589e033e95219c72bb60f5d327a8e2c535a92.png",
          exit_confirm_title: "https://i0.hdslb.com/bfs/live/6b94dd57b6fc02003f46217756be7ca0908e8a48.png",
          floating_ball_bg: "https://i0.hdslb.com/bfs/live/07fbda6873e3a92fe753a9ae1f9ea88e05e51270.png",
          gift_1: "https://i0.hdslb.com/bfs/live/a0389a464f923d0514502a0307c72bea0bcb6c00.png",
          gift_2: "https://i0.hdslb.com/bfs/live/f0a919a288ad7d599bf070e3912abce4646cd148.png",
          gift_3: "https://i0.hdslb.com/bfs/live/4959db79b1d735d82bcd0047f4e5f1a94ca80e65.png",
          gift_4: "https://i0.hdslb.com/bfs/live/b9beb35f36d847ed6405ba903e54ab988d9c9955.png",
          gift_5: "https://i0.hdslb.com/bfs/live/e116c032559a4335b241c7a666797950e6969df0.png",
          gift_6: "https://i0.hdslb.com/bfs/live/57f5cca4879009a8c2d5f3605037daf1da1eaae2.png",
          gift_7: "https://i0.hdslb.com/bfs/live/bcca3b68b760d48dafa43c76c4050ed1dee5e3f6.png",
          gift_8: "https://i0.hdslb.com/bfs/live/019c3a78e1014cb9e48996dfd1eda040a4b835fa.png",
          gift_name_bg: "https://i0.hdslb.com/bfs/live/d36cc4cf11348406026072333508baae28b68500.png",
          goods_img: "https://i0.hdslb.com/bfs/live/a666bfb4e51e4dfb444073b3643156320530d528.png",
          heart_1: "https://i0.hdslb.com/bfs/live/092832a823cce343480b02331ed83adff28b82b3.png",
          heart_1_active: "https://i0.hdslb.com/bfs/live/58f1417069c1c01d77ee47f9cebea8b3c724d9bb.png",
          heart_2: "https://i0.hdslb.com/bfs/live/83db04b0e55262b5f45dbabe3c4a4567373ba50f.png",
          heart_2_active: "https://i0.hdslb.com/bfs/live/40d9f64f18484f6fdb8800343aef0d400796c986.png",
          heart_3: "https://i0.hdslb.com/bfs/live/f9860eceead8dd63febfc814fcf152078c33d7ef.png",
          heart_3_active: "https://i0.hdslb.com/bfs/live/5a598fe45981d431ae6a94ad150e76a75e6ea61b.png",
          heart_4: "https://i0.hdslb.com/bfs/live/1a360f6815108c569ef5ee765fba41ca54c30fe5.png",
          heart_4_active: "https://i0.hdslb.com/bfs/live/da1cd67c1d1d20ab6a9919485ca7563fa2ad08d9.png",
          heart_5: "https://i0.hdslb.com/bfs/live/f5434aac284ae18eebda646473da0d82b0178e87.png",
          heart_5_active: "https://i0.hdslb.com/bfs/live/c4f936c69718f83bf86a4509fc5261987d9c468a.png",
          heart_6: "https://i0.hdslb.com/bfs/live/38f8d290dbd660d87fb667b55d4caf2a5aa0bf55.png",
          heart_6_active: "https://i0.hdslb.com/bfs/live/f71d462b3b7b8f3b21f76f4ac1a0599b5f9af4a1.png",
          heart_7: "https://i0.hdslb.com/bfs/live/399824549accff5f09050472fb0ca8f15305697c.png",
          heart_7_active: "https://i0.hdslb.com/bfs/live/af5326a0b2b405102c06e8f13e427ece0233403e.png",
          heart_8: "https://i0.hdslb.com/bfs/live/be402569c2aa7ec2ecaeac4fec9fee9775f2cdb4.png",
          heart_8_active: "https://i0.hdslb.com/bfs/live/a6230f67b33c8593521b26d70d45558a2928609a.png",
          heart_9: "https://i0.hdslb.com/bfs/live/6cf40d4b90bec399472727588cc88f8531823495.png",
          heart_9_active: "https://i0.hdslb.com/bfs/live/8b7a252eec274cc5125ea46b4d7ffb92f3043250.png",
          horn_icon: "https://i0.hdslb.com/bfs/live/b5418047e05ed77e8b497c972e7a975a17853cf3.png",
          kv: "https://i0.hdslb.com/bfs/live/5ae4a49092cec7d20fdaa698755ce78d176055f9.png",
          left_icon: "https://i0.hdslb.com/bfs/live/bcae1fbb1f40d04c81e1b2cea7a180a86d6b2513.png",
          light_bg: "https://i0.hdslb.com/bfs/live/5e2cf01490f62e6a4c9eb616b7d260ede07907ff.png",
          platform: "https://i0.hdslb.com/bfs/live/124795cf93b729baeb2e0ad1d92ea85e0023e010.png",
          pop_bg: "https://i0.hdslb.com/bfs/live/e11e5d3f3253f0499a03a99f19a9a5053c36eeb2.png",
          radio_btn_selected: "https://i0.hdslb.com/bfs/live/916dc3cd00383d80981157b855f3945a1e2754ef.png",
          radio_btn_unselected: "https://i0.hdslb.com/bfs/live/9d40183064c540ab931fe32bc7b85e1e420febcf.png",
          record_arrow: "https://i0.hdslb.com/bfs/live/8a2baafec35be0ab4e93917c6a07e8c3338babb7.png",
          record_award_title: "https://i0.hdslb.com/bfs/live/a9e87cd66e39cac894216fbc2f3bb820a904fff7.png",
          record_item_bg: "https://i0.hdslb.com/bfs/live/e5fe0b362d2eab671e3b3a0794a82cf808e96396.png",
          record_rectangle_btn: "https://i0.hdslb.com/bfs/live/4d25df8e76ea34a5bdfedfb1d444cbf3eb5fdfd6.png",
          record_title: "https://i0.hdslb.com/bfs/live/554b3fa795689c76a66ac5093439d9d7345f4a05.png",
          right_icon: "https://i0.hdslb.com/bfs/live/dff248ce98aecaa806c7d05660df59c924971b81.png",
          rule_btn: "https://i0.hdslb.com/bfs/live/5653b6163618b51c8be607753f53f1513cb10d47.png",
          rule_header: "https://i0.hdslb.com/bfs/live/c3e47f0e88e878da49c7625a70fd1a9652bb22fb.png",
          rule_icon: "https://i0.hdslb.com/bfs/live/fec8f80a8df88aa9c251479b77dba726ea1b303a.png",
          rule_title: "https://i0.hdslb.com/bfs/live/09d900776e2480d0494c74d322953b5eabbd5ae0.png",
          start_btn: "https://i0.hdslb.com/bfs/live/518686eff7dae2e668af47e8f2fe87389c25c809.png",
        },
      },
    };
    // 镜像模式：style_config_map 全部 CDN 图片 URL 改写为本地镜像同源路径（见 resLocalUrl 注释）。
    if (CONFIG.local_image_base) {
      var scm = d.data.style_config_map;
      for (var kk in scm) scm[kk] = resLocalUrl(scm[kk]);
    }
    return d;
  }
  // 当前局状态查询
  // 页面的消费确认/退出确认弹窗从 state.prize 读取 gift_value 显示奖品价值；
  // state.prize 由 GameInfo 响应设置（null||{}=空对象会导致 gift_value=undefined→NaN）。
  // 因此返回当前局面的潜在奖品（prize_config 中按已召唤数 N 对应的奖品），
  // 让确认弹窗能正确显示"当前退出可获得的奖品价值"。
  function makeResGameInfo() {
    var active = resIsActive();
    var n = active ? resState.hearts.length : 0;
    return {
      code: 0,
      message: "OK",
      ttl: 1,
      data: {
        game_id: active ? resState.game_id : 0,
        price: resPriceOf(n),
        hearts: active ? resState.hearts.slice() : null,
        carousels: makeResCarousel(),
        prize: active && n >= 1 ? resPrizeForN(n) : null,
      },
    };
  }
  // 新开一局 + 第一次召唤：清空旧局，抽第一个星座（响应 heart = 本次星座 id）
  function makeResStartGame() {
    batteryBalance = Math.max(0, batteryBalance - resPriceOf(0));
    resState.game_id = randInt(30000, 99999);
    resState.hearts = [];
    var hid = resDrawHeart();
    resState.hearts.push(hid);
    // 页面设置 state.prize = data.prize || {}；若 prize 为 null 则变空对象，后续读 gift_value=undefined→NaN。
    // 返回当前潜在奖品（prize_config 中按已召唤数 N 对应的奖品），让确认弹窗能正确显示奖品价值。
    var d = {
      is_game_over: false,
      price: resPriceOf(1),
      heart: hid,
      prize: resPrizeForN(1),
      carousels: makeResCarousel(),
    };
    saveResState();
    console.log("[RES-MOCK] StartGame heart=" + hid + " price=" + d.price);
    return { code: 0, message: "OK", ttl: 1, data: d };
  }
  // 继续召唤：从剩余库存抽 1 个填下一个空槽；抽中相同星座或满 8 个不同即结束结算
  function makeResSummon() {
    var paid = resPriceOf(resState.hearts.length);
    batteryBalance = Math.max(0, batteryBalance - paid);
    var hid = resDrawHeart();
    var prevIdx = resState.hearts.indexOf(hid);
    resState.hearts.push(hid);
    var q = resState.hearts.length - 1;
    // 游戏未结束时返回当前潜在奖品（prize_config 中按已召唤数 N 对应的奖品），
    // 让页面 state.prize 保持有效，确认弹窗能正确显示 gift_value。
    var d = { is_game_over: false, price: resPriceOf(resState.hearts.length), heart: hid, prize: resPrizeForN(resState.hearts.length), carousels: makeResCarousel() };
    if (prevIdx >= 0) {
      // 情况①：出现相同星座 → N = 两相同星座间的星座数量 + 1 = q - prevIdx
      var n = q - prevIdx;
      d.is_game_over = true;
      d.prize = resPrizeForN(n);
      d.price = resPriceOf(0);
      resNotifyPrize(d.prize);
      resetResState();
      console.log("[RES-MOCK] Summon DUPLICATE heart=" + hid + " prev=" + prevIdx + " N=" + n);
    } else if (resState.hearts.length >= (CONFIG.res_slot_count || 8)) {
      // 情况③：8 个不同的星座 → N = 8
      d.is_game_over = true;
      d.prize = resPrizeForN(8);
      d.price = resPriceOf(0);
      resNotifyPrize(d.prize);
      resetResState();
      console.log("[RES-MOCK] Summon FULL-DIFF N=8");
    } else {
      saveResState();
    }
    return { code: 0, message: "OK", ttl: 1, data: d };
  }
  // 主动退出（情况②）：N = 已召唤的星座数量，按 N 结算并清局
  function makeResExitGame() {
    var n = resState.hearts.length;
    var prize = n >= 1 ? resPrizeForN(n) : null;
    var d = {
      is_game_over: true,
      price: resPriceOf(0),
      heart: n ? resState.hearts[n - 1] : 0,
      prize: prize,
      carousels: makeResCarousel(),
    };
    resNotifyPrize(prize);
    resetResState();
    console.log("[RES-MOCK] ExitGame N=" + n + " prize=" + (prize && prize.gift_name));
    return { code: 0, message: "OK", ttl: 1, data: d };
  }
  // 获奖记录：本地 mock 空列表
  function makeResPlayRecord() {
    return { code: 0, message: "OK", ttl: 1, data: { list: [] } };
  }

  // ===== 算法分派 =====
  // 不同 algorithmType 使用不同的拦截规则与 mock 逻辑（各活动玩法背后的算法）。
  // 新增算法类型：在此处补充分派分支，改完随前端热更新推送即可，无需原生包更新。
  function algType() {
    return CONFIG.algorithmType || "stone-gongfang";
  }

  // 通用登录态/钱包拦截（所有算法共享）
  function isLoginOrWallet(url) {
    return /x\/web-interface\/nav/i.test(url) || /xlive\/revenue\/v1\/wallet\/myWallet/i.test(url);
  }

  // 玲珑宝斋的消费/登录门禁接口：真实登录态缺失时这些接口会返回"未登录"，挡住玩法。
  // 只拦截"消费统计/今日消费"类门禁（userconsume），其余用户信息/昵称接口放行真实数据。
  function isLingLoginGate(url) {
    return /\/component\/userconsume\//i.test(url || "");
  }

  // —— 逐级开箱（玲珑宝斋）算法：拦截开箱/游戏状态/结算/登录/钱包；其余接口放行保证页面渲染。 ——
  // URL 兜底识别：即使前端注入的 algorithmType 缺失/过期，只要命中 linglong 接口也强制走本地 mock，
  // 避免误发真实请求导致"未登录"（与晶石工坊内嵌默认配置的思路一致，这里用 URL 作第二道防线）。
  function isLinglongUrl(url) {
    return /\/linglong\/LingLong/i.test(url || "");
  }
  // —— 逐级点亮（成名之路）算法：拦截玩法接口 + 页面初始化(HalfInit) + 登录/钱包；其余放行。 ——
  function isChengmingUrl(url) {
    return /\/chengming\//i.test(url || "");
  }
  // 仅有明确玩法/初始化接口才本地 mock；其他 chengming/*（如 GetGamerInfo、HalfInit 之外的
  // 各种查询）一律放行真实服务器。特别注意 HalfInit 必须返回完整 style_config_map，
  // 否则页面背景图等资源缺失、初始化不完整，导致"点亮当前档位后无法自动跳下一档"。
  function isChengGame(url) {
    return /\/chengming\/(GetGameState|LightUp|Settle|HalfInit|GetActivityConfig)/i.test(url || "");
  }
  function handleRequest(url, body) {
    var params = parseBody(body);
    // 镜像模式下 kv-frontend 配置查询必然跨域失败（api.bilibili.com 无 CORS 放行），
    // 本地返回空 namespace 让应用回退到默认配置，否则整页卡在"请刷新重试"。
    if (/\/x\/kv-frontend\/(namespace\/data|app\/batchupdates)/i.test(url)) {
      return { code: 0, message: "0", ttl: 1, data: {} };
    }
    if (algType() === "linglong-open-box" || isLinglongUrl(url)) {
      // OpenBox 真实请求把 box_position / item_level 等参数放在 POST body，query 里只有 csrf；
      // 合并 query + body，保证按用户点击的宝箱返回。
      var q = parseQuery(url);
      for (var _k in params) {
        if (params[_k] !== undefined && q[_k] === undefined) q[_k] = params[_k];
      }
      if (/\/linglong\/LingLongOpenBox/i.test(url)) return makeLingOpenBox(q);
      if (/\/linglong\/LingLongGetGameState/i.test(url)) return makeLingGetGameState();
      if (/\/linglong\/LingLongSettleGame/i.test(url)) return makeLingSettleGame();
      if (/x\/web-interface\/nav/i.test(url)) return fakeLoginNav();
      if (/xlive\/revenue\/v1\/wallet\/myWallet/i.test(url)) return fakeWallet();
      if (isLingLoginGate(url)) return fakeZeroConsume();
      return genericSuccess();
    }
    if (algType() === "progressive-light-up" || isChengmingUrl(url)) {
      var cq = parseQuery(url);
      for (var _ck in params) {
        if (params[_ck] !== undefined && cq[_ck] === undefined) cq[_ck] = params[_ck];
      }
      if (/\/chengming\/GetGameState/i.test(url)) return makeChengGetGameState();
      if (/\/chengming\/LightUp/i.test(url)) return makeChengLightUp(cq);
      if (/\/chengming\/Settle/i.test(url)) return makeChengSettle();
      // HalfInit / GetActivityConfig：返回完整页面样式资源，保证页面完整加载。
      if (/\/chengming\/(HalfInit|GetActivityConfig)/i.test(url)) return makeChengHalfInit();
    }
    // —— 同数间隔合成（星座回响）算法：拦截 resonance/* 全部玩法接口 + 登录/钱包；其余放行。 ——
    // URL 兜底识别：即使注入的 algorithmType 缺失/过期，只要命中 /resonance/ 接口也强制本地 mock，
    // 避免误发真实请求导致"未登录/扣费"。接口对应关系见 makeRes* 注释。
    if (algType() === "number_between_same" || /\/resonance\//i.test(url)) {
      if (/\/resonance\/HalfInit/i.test(url)) return makeResHalfInit();
      if (/\/resonance\/GameInfo/i.test(url)) return makeResGameInfo();
      if (/\/resonance\/StartGame/i.test(url)) return makeResStartGame();
      if (/\/resonance\/Summon/i.test(url)) return makeResSummon();
      if (/\/resonance\/ExitGame/i.test(url)) return makeResExitGame();
      if (/\/resonance\/PlayRecord/i.test(url)) return makeResPlayRecord();
      if (/x\/web-interface\/nav/i.test(url)) return fakeLoginNav();
      if (/xlive\/revenue\/v1\/wallet\/myWallet/i.test(url)) return fakeWallet();
      return genericSuccess();
    }
    if (/StarStoneDraw/i.test(url)) return makeDraw(parseSlotIds(params));
    if (/StarStoneReplace/i.test(url)) return makeReplace(parseSlotId(params));
    if (/StarStoneCompose/i.test(url)) return makeCompose();
    // 打开页面时查询当前槽位/材料状态（StarStone + 状态类关键词）：
    // 返回本地保存的槽位状态，实现「下次打开还能还原当前抽取状态」。
    if (/StarStone/i.test(url) && /(Get|Info|Status|State|Detail|Index|Init|Query|Home|My)/i.test(url)) {
      return { code: 0, message: "OK", ttl: 1, data: buildCommonData() };
    }
    if (/x\/web-interface\/nav/i.test(url)) return fakeLoginNav();
    // 钱包余额：返回 1e8 分（÷100 = 100万电池），保证活动页操作不会"电池余额不足"
    if (/xlive\/revenue\/v1\/wallet\/myWallet/i.test(url)) return fakeWallet();
    return genericSuccess();
  }
  function shouldMock(url) {
    if (!url) return false;
    // 镜像模式下 kv-frontend 配置查询跨域必然失败，本地拦截返回空配置
    if (MIRROR && /\/x\/kv-frontend\/(namespace\/data|app\/batchupdates)/i.test(url)) return true;
    // 逐级开箱（玲珑宝斋）算法：只拦截玩法接口（LingLong*）+ 登录态/钱包 + 消费门禁，
    // 其余请求（昵称、用户信息、背景配置等）放行真实服务器，否则把昵称之类接口 mock 成空
    // 会导致页面反复提示"昵称获取失败"。GetTodayCostTotal 等消费门禁接口会报"未登录"，
    // 因此一并拦截返回 code:0，其余一律放行。
    if (algType() === "linglong-open-box" || isLinglongUrl(url)) {
      return (
        isLinglongUrl(url) ||
        isLoginOrWallet(url) ||
        isLingLoginGate(url) ||
        (CONFIG.mockAllApi && /api\.live\.bilibili\.com/i.test(url))
      );
    }
    // 逐级点亮（成名之路）算法：只拦截明确的玩法/初始化接口（GetGameState/LightUp/Settle/
    // HalfInit/GetActivityConfig）+ 登录态/钱包 + 消费门禁，其余（含其他 chengming/* 查询、
    // 用户信息/昵称等）一律放行真实服务器。关键：HalfInit 若被 mock 成空会使页面背景图等资源
    // 缺失、初始化不完整，导致"点亮当前档位后无法自动跳到下一档"。
    if (algType() === "progressive-light-up" || isChengmingUrl(url)) {
      return (
        isChengGame(url) ||
        isLoginOrWallet(url) ||
        isLingLoginGate(url) ||
        (CONFIG.mockAllApi && /api\.live\.bilibili\.com/i.test(url))
      );
    }
    // 同数间隔合成（星座回响）算法：拦截 resonance/* 玩法接口 + 登录态/钱包，其余放行真实服务器。
    if (algType() === "number_between_same" || /\/resonance\//i.test(url)) {
      return (
        /\/resonance\//i.test(url) ||
        isLoginOrWallet(url) ||
        (CONFIG.mockAllApi && /api\.live\.bilibili\.com/i.test(url))
      );
    }
    // StarStone 动作接口 + 状态查询接口本地 mock：
    //   - StarStoneDraw / StarStoneReplace / StarStoneCompose：操作接口，本地 mock 防止真实扣费；
    //   - StarStoneInfo（状态查询）：返回本地保存的槽位状态，实现「下次打开还原抽取状态」。
    // StarStoneFrontConf / StarStoneRecord 放行真实服务器（不能 mock 成空数据）：
    //   - StarStoneFrontConf 返回 front_conf，包含槽位/抽取替换按钮/素材/背景图等全部 UI 图集，
    //     页面据此渲染抽奖游玩区；若被拦截返回空，活动页将无法完整加载。
    //   - StarStoneRecord 是"获奖/玩法记录"，页面里已隐藏对应入口，放行即可。
    if (/StarStone(Draw|Replace|Compose|Info)/i.test(url)) return true;
    // 登录态查询：返回 isLogin=true，跳过登录
    if (/x\/web-interface\/nav/i.test(url)) return true;
    // 钱包余额：返回 100万 电池，避免"电池余额不足~"
    if (/xlive\/revenue\/v1\/wallet\/myWallet/i.test(url)) return true;
    if (CONFIG.mockAllApi && /api\.live\.bilibili\.com/i.test(url)) return true;
    return false;
  }

  // ===== 假账号：改写 live 活动接口里的主播身份参数 =====
  // 页面的游戏/状态/开播等接口会带 ruid / change_ruid（当前主播 uid）。
  // 若不改写，服务器看到"主播在操作自己的直播间"会拒绝，提示"不能在自己的直播间参与哦~"。
  // 把这两个参数统一替换为假账号 uid，请求照常转发给真实服务器（不改动 room_id 等其他参数）。
  function rewriteLiveUrl(url) {
    if (!url || typeof url !== "string") return url;
    if (!/api\.live\.bilibili\.com/i.test(url)) return url;
    if (!(/(^|[?&])ruid=\d+/i.test(url) || /(^|[?&])change_ruid=\d+/i.test(url))) return url;
    return url
      .replace(/([?&])ruid=\d+/gi, function (m, p) {
        return p + "ruid=" + CONFIG.fake_uid;
      })
      .replace(/([?&])change_ruid=\d+/gi, function (m, p) {
        return p + "change_ruid=" + CONFIG.fake_uid;
      });
  }

  // ===== 假账号：覆盖页面读取登录态的全局变量 =====
  // B站活动 H5 通过 window.__BiliUser__ / window.__LIVE_USER_LOGIN_STATUS__ 读取当前登录身份，
  // 页面的 isSelf = (userInfo.uid === URL uid) 判断是否"自己直播间"。把这两个全局改成假账号，
  // 页面就会认为当前参与人是"游客"而非主播，从而放开"自己直播间"的限制。
  //
  // 说明：玲珑宝斋等活动的 getUserInfo 在原生 WebView 里被注册为 NATIVE 实现（走 window.BiliJsBridge
  // 原生桥的 auth.getUserInfo，不走 fetch / window.__BiliUser__），为此在下方额外提供：
  //  ① 强制 awesome-api 的 __AWESOME_API_POLYFILL_COMPILER__ = "WEB"，让它退回被上方 nav 拦截的
  //     fetch 路径（该路径已返回 isLogin:true）；
  //  ② 兜底伪造 window.BiliJsBridge，若确实走了原生桥也能返回已登录假用户。
  // 二者均为"伪造登录态"的同类做法，不会发起真实请求、不产生任何真实扣费/登录操作。
  function assertFakeLogin() {
    try {
      // 锁定 window.__BiliUser__：返回始终已登录的假对象，页面自身的 __BiliUser__ 无法覆盖它。
      // 部分 getUserInfo 变体会走 window.__BiliUser__.get()，稳定的登录态才能保证 isLogin:true。
      var fakeUserObj = {
        get: function () {
          return Promise.resolve({
            code: 0,
            data: { mid: CONFIG.fake_uid, uname: "模拟游客", face: "https://i0.hdslb.com/bfs/face/noface.jpg", isLogin: true },
          });
        },
        quickLogin: function (cb) { if (cb) cb({ code: -1 }); },
      };
      try {
        Object.defineProperty(window, "__BiliUser__", {
          configurable: true,
          enumerable: true,
          get: function () { return fakeUserObj; },
          set: function () {}, // 忽略页面/库覆盖，始终用假登录态
        });
      } catch (e) {
        try { window.__BiliUser__ = fakeUserObj; } catch (e2) {}
      }
      window.__LIVE_USER_LOGIN_STATUS__ = {
        uid: CONFIG.fake_uid,
        uname: "模拟游客",
        face: "https://i0.hdslb.com/bfs/face/noface.jpg",
        isLogin: true,
        isError: false,
      };
      // 部分页面从父窗口读取 __LIVE_USER_LOGIN_STATUS__，同步铺到 parent/top 以便被读到。
      if (window.parent && window.parent !== window) {
        window.parent.__LIVE_USER_LOGIN_STATUS__ = window.__LIVE_USER_LOGIN_STATUS__;
      }
      if (window.top && window.top !== window) {
        window.top.__LIVE_USER_LOGIN_STATUS__ = window.__LIVE_USER_LOGIN_STATUS__;
      }
      // 强制 awesome-api 把 getUserInfo 解析为 WEB 实现（fetch /x/web-interface/nav，已被上方拦截），
      // 从而绕过原生桥 BiliJsBridge，避免在纯 WebView 中原生桥不可用导致 isLogin=false。
      //
      // 关键：必须用 getter 把该值"锁死"为 "WEB"。光靠定时赋值不够——页面自身的 awesome-api
      // 初始化可能在 getUserInfo 首次被调用前把该值改写成 true/false，而首次注册会把它固化成
      // NATIVE 桥 实现（Li）并永久缓存进 O["NATIVE"]["getUserInfo"]，之后无论 nav 怎么拦都返回
      // 未登录。锁成 "WEB" 后，首次注册一定会选到 WEB 实现（fetch nav）并返回 isLogin:true。
      lockPolyfillFlag();
    } catch (e) {}
  }

  // 把 __AWESOME_API_POLYFILL_COMPILER__ 锁定为 "WEB"：页面/库无法再改写它。
  function lockPolyfillFlag() {
    try {
      var FLAG = "WEB";
      function lockOn(g) {
        try {
          Object.defineProperty(g, "__AWESOME_API_POLYFILL_COMPILER__", {
            configurable: true,
            enumerable: true,
            get: function () { return FLAG; },
            set: function () {}, // 忽略页面的任何改写
          });
        } catch (e) {
          try { g.__AWESOME_API_POLYFILL_COMPILER__ = FLAG; } catch (e2) {}
        }
      }
      if (typeof self !== "undefined") lockOn(self);
      if (typeof globalThis !== "undefined" && globalThis !== self) lockOn(globalThis);
      if (typeof window !== "undefined" && window !== self) lockOn(window);
    } catch (e) {}
  }
  assertFakeLogin();
  setInterval(assertFakeLogin, 800);

  // ===== 兜底：伪造 window.BiliJsBridge 原生桥 =====
  // 玲珑宝斋的 getUserInfo 在 WebView 中可能被注册为 NATIVE 实现（Li），其内部经 BiliJsBridge 调用
  // auth.getUserInfo。这里兜底覆盖 BiliJsBridge，使其 getUserInfo / auth.getUserInfo 返回已登录假用户，
  // 让 NATIVE 路径也能拿到 isLogin:true。仅在活动请求时同步读取，不触碰真实账号、无真实请求。
  function fabricateJsBridge() {
    try {
      var fakeUser = {
        uid: CONFIG.fake_uid,
        mid: CONFIG.fake_uid,
        uname: "模拟游客",
        userName: "模拟游客",
        face: "https://i0.hdslb.com/bfs/face/noface.jpg",
        isLogin: true,
        state: 1,
        isTourist: false,
      };
      // awesome-api 通过 BiliJsBridge 的原生桥协议调用（getUserInfo / auth.getUserInfo）。
      // 这里同时覆盖"直接方法"和"promise 风格"两种可能的读取方式。
      function resolveUser() {
        return Promise.resolve({ ...fakeUser });
      }
      function resolveAuthGetUserInfo() {
        return Promise.resolve({ data: { ...fakeUser }, params: {} });
      }
      var bridge = window.BiliJsBridge;
      if (!bridge) {
        bridge = {
          // 让 isSupportV2 判定为"非注入 v2"，从而走老通道，以便被 getUserInfo 覆盖命中
          noBiliInjectV2: false,
          getUserInfo: resolveUser,
        };
        bridge.auth = { getUserInfo: resolveAuthGetUserInfo };
        bridge.native = bridge;
        try {
          window.BiliJsBridge = bridge;
        } catch (e) {}
      } else {
        // 已有桥：强制替换登录态方法为假实现（可能已被 awesome-api 固化为 NATIVE 桥 getUserInfo，
        // 若不覆盖，getUserInfo 会走真实原生桥/或返回未登录）。仅覆盖登录态方法，保留桥的其他能力。
        try { bridge.getUserInfo = resolveUser; } catch (e) {}
        if (bridge.auth) {
          try { bridge.auth.getUserInfo = resolveAuthGetUserInfo; } catch (e) {}
        } else {
          try { bridge.auth = { getUserInfo: resolveAuthGetUserInfo }; } catch (e) {}
        }
      }
    } catch (e) {}
  }
  fabricateJsBridge();
  setInterval(fabricateJsBridge, 1000);

  // ===== 伪造登录 Cookie =====
  // B站活动 H5 的请求层 CSRF 中间件读取 document.cookie 中的 bili_jct（缺失时在客户端就直接
  // 报"未登录"，根本不会发出请求，网络拦截救不了），部分页面还校验 SESSDATA / DedeUserID。
  // 这里写入假 Cookie 让页面认为已登录。仅对当前页面 origin 生效，不触碰真实账号、不产生任何
  // 真实扣费/登录操作；写入的值是伪造串，真实服务器校验必失败（但玩法接口全部本地 mock）。
  function fakeCookies() {
    try {
      var exp = new Date(Date.now() + 7 * 86400e5).toUTCString();
      var uid = CONFIG.fake_uid || 900000000;
      document.cookie = "bili_jct=fakebili_jct" + uid + "; path=/; expires=" + exp;
      document.cookie = "SESSDATA=fakeSESSDATA" + uid + "abcdef0123456789; path=/; expires=" + exp;
      document.cookie = "DedeUserID=" + uid + "; path=/; expires=" + exp;
      document.cookie = "DedeUserID__ckMd5=0; path=/; expires=" + exp;
    } catch (e) {}
  }
  fakeCookies();
  setInterval(fakeCookies, 3000);

  // ===== 宽度自适应：让活动页主内容铺满整个 WebView（与主窗口等宽）=====
  // 活动页用 flexible rem 方案，根字号被钳制在 540（clientWidth>540 时），导致主内容只有 540px、
  // 两侧露出宽背景。改为根字号 = clientWidth/10，则 10rem 容器正好铺满视口；再强制 body/html 全宽。
  function assertFillWidth() {
    try {
      var html = document.documentElement;
      var w = html.clientWidth || window.innerWidth;
      if (!w) return;
      html.style.fontSize = w / 10 + "px";
      html.style.maxWidth = "100%";
      html.style.width = "100%";
      if (document.body) {
        document.body.style.maxWidth = "100%";
        document.body.style.width = "100%";
        document.body.style.margin = "0";
      }
    } catch (e) {}
  }
  assertFillWidth();
  setInterval(assertFillWidth, 400);

  // ===== 拦截 window.open 登录弹窗（有些页面用新窗口跳登录，导航拦截管不到）=====
  var origOpenWin = window.open;
  if (origOpenWin) {
    window.open = function (url, name, features) {
      if (
        url &&
        typeof url === "string" &&
        (/passport\.bilibili\.com/i.test(url) ||
          /passlogin/i.test(url) ||
          ((/bilibili\.com/i.test(url) || /biligame/i.test(url)) && /\/login/i.test(url)))
      ) {
        return null;
      }
      return origOpenWin(url, name, features);
    };
  }

  // ===== 隐藏"获奖记录"和"玩法记录"入口 =====
  // 这两处需要登录才能获取真实数据，直接隐藏。通过 front_conf 返回的图标 URL 定位：
  //   record_icon      -> "获奖记录"按钮
  //   play_record.title -> "玩法记录"标题
  var HIDE_IMG_FRAGS = [
    "0fa458d22ce9eca91e472aaaf89b4e7a2031e38c", // record_icon
    "6aafb2e49d20cf664dd55fe7421446a5b64ade25", // play_record title
  ];
  function hideEl(el) {
    if (el && el.style) {
      el.style.display = "none";
      el.style.visibility = "hidden";
    }
  }
  // 从图片向上找可点击的容器（a/button/带点击/光标手型），找不到就隐藏图片本身
  function clickableAncestor(img) {
    var el = img;
    for (var k = 0; k < 5 && el && el !== document.body; k++) {
      if (
        el.tagName === "A" ||
        el.tagName === "BUTTON" ||
        el.onclick ||
        (el.style && el.style.cursor === "pointer")
      ) {
        return el;
      }
      el = el.parentElement;
    }
    return img;
  }
  function hideRecordButtons() {
    try {
      var imgs = document.querySelectorAll("img");
      for (var i = 0; i < imgs.length; i++) {
        var src = imgs[i].getAttribute("src") || "";
        var hit = false;
        for (var j = 0; j < HIDE_IMG_FRAGS.length; j++) {
          if (src.indexOf(HIDE_IMG_FRAGS[j]) >= 0) {
            hit = true;
            break;
          }
        }
        if (!hit) continue;
        hideEl(clickableAncestor(imgs[i]));
      }
    } catch (e) {}
  }
  // 按文案隐藏：有些页面按钮的图标 URL 不在预期列表，直接按文本匹配
  var HIDE_TEXTS = ["获奖记录", "玩法记录"];
  function hideRecordButtonsByText() {
    try {
      var all = document.querySelectorAll("div,span,button,a,p,li");
      for (var i = 0; i < all.length; i++) {
        var el = all[i];
        if (!el || el.style && el.style.display === "none") continue;
        var txt = (el.textContent || "").trim();
        var isText = false;
        for (var j = 0; j < HIDE_TEXTS.length; j++) {
          if (txt === HIDE_TEXTS[j]) {
            isText = true;
            break;
          }
        }
        if (!isText) continue;
        // 只隐藏可点击容器，避免误伤普通文本
        var target = clickableAncestor(el);
        hideEl(target);
      }
    } catch (e) {}
  }
  function watchRecordButtons() {
    try {
      hideRecordButtons();
      hideRecordButtonsByText();
      if (!window.__BILI_ACTIVITY_RECORD_OBS__ && window.MutationObserver) {
        window.__BILI_ACTIVITY_RECORD_OBS__ = new MutationObserver(function () {
          hideRecordButtons();
          hideRecordButtonsByText();
        });
        window.__BILI_ACTIVITY_RECORD_OBS__.observe(document.documentElement, {
          childList: true,
          subtree: true,
        });
      }
    } catch (e) {}
  }
  watchRecordButtons();
  setInterval(watchRecordButtons, 800);

  // ===== Web 镜像代理 =====
  // 原生 WebView(MIRROR=false)页面 origin 与 api.live.bilibili.com 同源，背景接口直连即可。
  // Web 镜像(localhost/web 部署)下页面 origin 不是 bilibili，直连会被 CORS 拦：
  // 非 mock 的 B站 接口(uids/时间/房间等，APP 里本来就真实访问)改为走本地 /api/bili-proxy 转发，
  // 既拿到真实数据、又无 CORS，外壳才能完整初始化并正确切到目标玩法标签。
  function toProxy(url) {
    if (!MIRROR) return url;
    try {
      var h = new URL(url).host;
      if (h === "api.live.bilibili.com" || h === "api.bilibili.com" || h === "passport.bilibili.com") {
        return "/api/bili-proxy?url=" + encodeURIComponent(url);
      }
    } catch (e) {}
    return url;
  }

  // ===== 覆盖 fetch =====
  if (window.fetch) {
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : input && input.url;
      url = rewriteLiveUrl(url);
      if (shouldMock(url)) {
        // 命中的玩法接口：本地返回模拟数据（图片 URL 直接用真实 hdslb 地址，无改写）
        return Promise.resolve(
          new Response(JSON.stringify(handleRequest(url, init && init.body)), {
            status: 200,
            statusText: "OK",
            headers: { "Content-Type": "application/json; charset=utf-8" },
          })
        );
      }
      // 非 mock 的 B站 接口：镜像下改走本地代理转发真实数据
      return origFetch(toProxy(url), init);
    };
  }

  // ===== 覆盖 XMLHttpRequest =====
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    url = rewriteLiveUrl(url);
    this.__mockUrl = url;
    return origOpen.call(this, method, toProxy(url));
  };
  XMLHttpRequest.prototype.send = function (body) {
    var url = this.__mockUrl || "";
    if (shouldMock(url)) {
      var json = JSON.stringify(handleRequest(url, body));
      var self = this;
      setTimeout(function () {
        try {
          Object.defineProperty(self, "readyState", { value: 4, configurable: true, writable: true });
          Object.defineProperty(self, "status", { value: 200, configurable: true, writable: true });
          Object.defineProperty(self, "responseText", { value: json, configurable: true, writable: true });
          Object.defineProperty(self, "response", { value: json, configurable: true, writable: true });
          Object.defineProperty(self, "responseURL", { value: url, configurable: true, writable: true });
        } catch (e) {}
        if (self.onreadystatechange) self.onreadystatechange.call(self);
        if (self.onload) self.onload.call(self);
        if (self.onloadend) self.onloadend.call(self);
      }, 50);
      return;
    }
    return origSend.apply(this, arguments);
  };
})(window);
