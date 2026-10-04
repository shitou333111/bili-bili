/**
 * 直播姬浏览器源「一键添加」。
 *
 * 读写直播姬场景配置（<localData>/bililive/User Data/<UID>/Scene Collection/
 * support_group_collection.json），自动把 B瓜展示浏览器源加入直播姬场景
 * （置于所有元素最上层），免去手动添加步骤。仅 Windows 桌面端（Tauri）可用。
 *
 * 配置结构要点（以用户本地实例为蓝本）：
 * - 根级 `sources` 是所有源（场景 + 普通源）的扁平数组，场景元素挂在场景源的
 *   `settings.items` 里；`items` 数组末尾 = 渲染最上层，故新元素 append 到末尾。
 * - `settings.id_counter` 单调递增，元素 id = 自增后的值（旧 counter + 1）。
 * - 各源 `settings.source_id` 间隔 255 递增，新源取全局最大值 + 255，
 *   `hotkey_value` = `hotkey.source_<id>`。
 * - 场景 `hotkeys` 需为每个元素补 `libobs.show_scene_item.<id>` /
 *   `libobs.hide_scene_item.<id>` 两个空绑定。
 * - 文件为紧凑 JSON（无缩进），写回同样不带缩进；同目录 .bak 是直播姬自有备份，勿动。
 */
import { join, localDataDir } from "@tauri-apps/api/path";
import { copyFile, readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";

/** 写回配置前的备份后缀：`原文件名（含后缀）.bgua.bak`，同目录，每次覆盖旧备份 */
const BACKUP_SUFFIX = ".bgua.bak";

/** B瓜 浏览器源 URL 判定：本地 /display（端口任意）——按链接判断，不看名称（用户可能重命名） */
function isDisplayUrl(url: unknown): boolean {
  if (typeof url !== "string") return false;
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();
    return (
      (host === "127.0.0.1" || host === "localhost") &&
      u.pathname.replace(/\/+$/, "") === "/display"
    );
  } catch {
    return false;
  }
}

interface SceneConfig {
  /** 配置文件完整路径 */
  file: string;
  /** 解析后的场景配置对象（可变，调用方改完后自行写回） */
  config: any;
}

/** 配置里已有的 B瓜 浏览器源（id=browser_source 且 URL 指向本应用展示页） */
function displaySources(config: any): any[] {
  const sources: any[] = Array.isArray(config?.sources) ? config.sources : [];
  return sources.filter((s: any) => s?.id === "browser_source" && isDisplayUrl(s?.settings?.url));
}

/**
 * 按当前登录账号 UID 定位直播姬账号目录并读取其场景配置。
 * 用户数据目录下是 UID 命名的账号文件夹，直接取与当前登录账号 UID 同名的目录。
 */
async function loadSceneConfig(uid: number): Promise<SceneConfig> {
  const root = await join(await localDataDir(), "bililive", "User Data");
  const dir = await join(root, String(uid));
  const file = await join(dir, "Scene Collection", "support_group_collection.json");
  let text: string;
  try {
    text = await readTextFile(file);
  } catch {
    throw new Error(`未找到当前账号（UID ${uid}）的直播姬场景配置 support_group_collection.json`);
  }
  try {
    return { file, config: JSON.parse(text) };
  } catch {
    throw new Error("直播姬场景配置解析失败（文件可能损坏）");
  }
}

/** 某朝向的场景集合：竖屏场景名含 vertical/竖，横屏为默认 Scene N / horizontal /横；
 *  一个都匹配不到时（用户改过场景名）退回全部场景 */
function orientationScenes(config: any, portrait: boolean): any[] {
  const scenes: any[] = (Array.isArray(config?.sources) ? config.sources : []).filter(
    (s: any) => s?.id === "scene",
  );
  if (!scenes.length) throw new Error("直播姬配置中没有场景信息");
  const re = portrait ? /vertical|竖/i : /^scene\s*\d+$|horizontal|横/i;
  const candidates = scenes.filter((s: any) => re.test(String(s?.name || "")));
  return candidates.length ? candidates : scenes;
}

/** 某场景里是否已挂 B瓜 浏览器源元素（item 经 source_uuid 关联根级源） */
function sceneHasDisplayItem(config: any, scene: any): boolean {
  const uuids = new Set(displaySources(config).map((s: any) => String(s?.uuid || "")));
  const items: any[] = Array.isArray(scene?.settings?.items) ? scene.settings.items : [];
  return items.some((it: any) => uuids.has(String(it?.source_uuid || "")));
}

/** 某朝向是否已添加：该朝向的任一场景里挂有 B瓜 浏览器源元素 */
function orientationAdded(config: any, portrait: boolean): boolean {
  return orientationScenes(config, portrait).some((s: any) => sceneHasDisplayItem(config, s));
}

/**
 * 检测直播姬是否已添加 B瓜 浏览器源：横屏、竖屏场景都已有才算已添加。
 * 失败抛错（含未安装直播姬等）
 */
export async function detectBililiveSource(uid: number): Promise<boolean> {
  const { config } = await loadSceneConfig(uid);
  return orientationAdded(config, false) && orientationAdded(config, true);
}

/** 选目标场景：该朝向的场景里优先直播姬当前场景（current_scene），否则取第一个 */
function pickTargetScene(config: any, portrait: boolean): any {
  const pool = orientationScenes(config, portrait);
  const cur = String(config?.current_scene || "");
  return pool.find((s: any) => s?.name === cur) || pool[0];
}

/**
 * 一键添加：分别向横屏、竖屏场景添加 B瓜 浏览器源（横屏 1920x1080、竖屏 1080x1920），
 * 挂到各朝向目标场景所有元素最上层（items 末尾）。某朝向场景已有的跳过，
 * 只补缺失的朝向；源建过但元素缺失时复用同尺寸源。需在直播姬未运行时调用
 * （直播姬退出时会把内存配置写回、覆盖新写入的浏览器源），下次启动即生效。
 */
export async function addBililiveSource(uid: number, url: string): Promise<void> {
  const { file, config } = await loadSceneConfig(uid);
  const sources: any[] = config.sources;
  let changed = false;

  for (const portrait of [false, true]) {
    if (orientationAdded(config, portrait)) continue; // 该朝向已有，跳过
    const width = portrait ? 1080 : 1920;
    const height = portrait ? 1920 : 1080;

    // 复用同尺寸的既有 B瓜 源（源在、元素被删的情况），否则新建
    let src = displaySources(config).find(
      (s: any) => Number(s?.settings?.width) === width && Number(s?.settings?.height) === height,
    );
    if (!src) src = createDisplaySource(config, url, portrait, width, height);

    // 场景元素：挂到目标场景 items 末尾（最上层）
    const scene = pickTargetScene(config, portrait);
    const st = scene.settings || (scene.settings = {});
    const items: any[] = Array.isArray(st.items) ? st.items : (st.items = []);
    // id_counter 单调自增，元素 id = 自增后的值
    const itemId = (Number(st.id_counter) || 0) + 1;
    st.id_counter = itemId;
    // 元素模板：同参考源（scale_ref 固定 1920x1080，bounds 为朝向尺寸，铺满画布）
    items.push({
      name: src.name,
      source_uuid: src.uuid,
      visible: true,
      locked: false,
      rot: 0,
      scale_ref: { x: 1920, y: 1080 },
      align: 5,
      bounds_type: 0,
      bounds_align: 0,
      bounds_crop: false,
      crop_left: 0,
      crop_top: 0,
      crop_right: 0,
      crop_bottom: 0,
      id: itemId,
      group_item_backup: false,
      pos: { x: 0, y: 0 },
      scale: { x: 1, y: 1 },
      bounds: { x: width, y: height },
      scale_filter: "disable",
      blend_method: "default",
      blend_type: "normal",
      show_transition: { duration: 0 },
      hide_transition: { duration: 0 },
      private_settings: {},
    });
    // 场景 hotkeys 补新元素的显/隐空绑定
    const hk = scene.hotkeys || (scene.hotkeys = {});
    hk[`libobs.show_scene_item.${itemId}`] = [];
    hk[`libobs.hide_scene_item.${itemId}`] = [];
    changed = true;
  }

  if (!changed) return;
  // 改配置前先备份原文件（原文件名含后缀 + .bgua.bak，同目录，覆盖旧备份）
  try {
    await copyFile(file, `${file}${BACKUP_SUFFIX}`);
  } catch (e: any) {
    throw new Error(`备份直播姬配置失败：${e?.message || e}`);
  }
  try {
    await writeTextFile(file, JSON.stringify(config));
  } catch (e: any) {
    throw new Error(`写入直播姬配置失败：${e?.message || e}`);
  }
}

/** 新建 B瓜 浏览器源（根级 browser_source），返回新建的对象。名称带去重后缀 */
function createDisplaySource(
  config: any,
  url: string,
  portrait: boolean,
  width: number,
  height: number,
): any {
  const sources: any[] = config.sources;
  // 名称去重（用户可能已建过同名但不同 URL 的源）
  const baseName = portrait ? "B瓜展示面板（竖屏）" : "B瓜展示面板（横屏）";
  const names = new Set(sources.map((s: any) => String(s?.name || "")));
  let name = baseName;
  for (let i = 2; names.has(name); i++) name = `${baseName} ${i}`;

  // 新 source_id = 全局最大值 + 255（含根级音频源）
  let maxSourceId = 0;
  for (const s of [...sources, config["Desktop Audio"], config["Mic/Aux"]]) {
    const id = Number(s?.settings?.source_id);
    if (Number.isFinite(id) && id > maxSourceId) maxSourceId = id;
  }
  const sourceId = maxSourceId + 255;

  const uuid = crypto.randomUUID();
  // 浏览器源模板：照抄现有 B瓜 展示面板（横/竖屏）两条参考源
  const src = {
    prev_ver: 536870916,
    name,
    uuid,
    id: "browser_source",
    versioned_id: "browser_source",
    settings: {
      refresh_when_close_page: false,
      source_id: sourceId,
      hotkey_value: `hotkey.source_${sourceId}`,
      url,
      width,
      height,
      shutdown: false,
      restart_when_active: false,
      css: "body { background-color: rgba(0, 0, 0, 0); margin: 0px auto; overflow: visible; }",
    },
    mixers: 255,
    sync: 0,
    flags: 0,
    volume: 1,
    balance: 0.5,
    enabled: true,
    muted: false,
    "push-to-mute": false,
    "push-to-mute-delay": 0,
    "push-to-talk": false,
    "push-to-talk-delay": 0,
    hotkeys: {
      "libobs.mute": [],
      "libobs.unmute": [],
      "libobs.push-to-mute": [],
      "libobs.push-to-talk": [],
      "ObsBrowser.Refresh": [],
    },
    deinterlace_mode: 0,
    deinterlace_field_order: 0,
    monitoring_type: 0,
    private_settings: {},
  };
  sources.push(src);
  return src;
}
