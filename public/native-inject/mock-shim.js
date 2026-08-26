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
  };
  if (CFG) {
    for (var k in CFG) if (k !== "mockAllApi" && CFG[k] !== undefined) CONFIG[k] = CFG[k];
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
  setInterval(function () {
    try {
      var el = document.querySelector(".balance-amount");
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

  // —— 晶石工坊（山海工坊）算法：6 槽位抽取/替换/合成 ——
  function handleRequest(url, body) {
    var params = parseBody(body);
    // 玲珑宝斋占位算法：玩法接口尚未实现。只处理登录态/钱包；
    // mockAllApi=true（占位算法默认）时其余 live 接口一律返回通用成功，杜绝真实扣费。
    if (algType() === "fans-autumn-2026") {
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
    // 玲珑宝斋占位算法：只拦截登录态/钱包（+可选 mockAllApi 全拦截），
    // 其余接口放行真实数据保证页面渲染；具体玩法接口待算法实现后在此补充。
    if (algType() === "fans-autumn-2026") {
      return isLoginOrWallet(url) || (CONFIG.mockAllApi && /api\.live\.bilibili\.com/i.test(url));
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
  function assertFakeLogin() {
    try {
      window.__BiliUser__ = {
        get: function () {
          return Promise.resolve({
            code: 0,
            data: { mid: CONFIG.fake_uid, uname: "模拟游客", face: "https://i0.hdslb.com/bfs/face/noface.jpg", isLogin: true },
          });
        },
      };
      window.__LIVE_USER_LOGIN_STATUS__ = {
        uid: CONFIG.fake_uid,
        uname: "模拟游客",
        face: "https://i0.hdslb.com/bfs/face/noface.jpg",
        isLogin: true,
        isError: false,
      };
    } catch (e) {}
  }
  assertFakeLogin();
  setInterval(assertFakeLogin, 800);

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

  // ===== 覆盖 fetch =====
  if (window.fetch) {
    var origFetch = window.fetch.bind(window);
    window.fetch = function (input, init) {
      var url = typeof input === "string" ? input : input && input.url;
      url = rewriteLiveUrl(url);
      if (shouldMock(url)) {
        var body = handleRequest(url, init && init.body);
        return Promise.resolve(
          new Response(JSON.stringify(body), {
            status: 200,
            statusText: "OK",
            headers: { "Content-Type": "application/json; charset=utf-8" },
          })
        );
      }
      // 改写后的 URL 可能包含假账号身份，用改写后的 URL 转发给真实服务器
      if (url !== (typeof input === "string" ? input : input && input.url)) {
        return origFetch(url, init);
      }
      return origFetch(input, init);
    };
  }

  // ===== 覆盖 XMLHttpRequest =====
  var origOpen = XMLHttpRequest.prototype.open;
  var origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    url = rewriteLiveUrl(url);
    this.__mockUrl = url;
    return origOpen.call(this, method, url);
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
