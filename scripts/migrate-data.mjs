/**
 * 数据目录迁移脚本
 *
 * 目标：把旧的数据组织结构迁移到新结构
 *   旧：.data/uid_<mid>_<昵称>/...
 *   新：.data/uid_<mid>/...  （只用 uid，昵称会变，文件夹名保持不变）
 *
 * 同时生成 .data/users-list.json（每个用户一条记录：mid / uname / updatedAt），
 * 供服务器维护"使用用户表"。
 *
 * 运行方式（在项目根目录）：
 *   node scripts/migrate-data.mjs [--dry-run]
 *
 * --dry-run：只打印将要执行的操作，不实际改动
 */

import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", ".data");
const USERS_LIST_FILE = path.join(DATA_DIR, "users-list.json");

const dryRun = process.argv.includes("--dry-run");

/** 从文件夹名中提取 mid：匹配 uid_<mid> 或 uid_<mid>_<昵称> */
function parseFolderName(name) {
  const m = name.match(/^uid_(\d+)(?:_(.*))?$/);
  if (!m) return null;
  return { mid: m[1], rest: m[2] ?? null };
}

/** 归一化昵称，用于比较 */
function norm(s) {
  return (s || "").replace(/\s+/g, "").toLowerCase();
}

async function main() {
  console.log(`数据目录: ${DATA_DIR}`);
  console.log(`模式: ${dryRun ? "DRY-RUN（不实际改动）" : "执行"}\n`);

  let entries;
  try {
    entries = await fs.readdir(DATA_DIR, { withFileTypes: true });
  } catch (e) {
    console.error("无法读取 .data 目录:", e.message);
    process.exit(1);
  }

  // 收集所有用户文件夹（旧命名含昵称，或已是新命名）
  const userDirs = entries
    .filter((d) => d.isDirectory() && /^uid_\d+/.test(d.name))
    .map((d) => {
      const parsed = parseFolderName(d.name);
      return { oldName: d.name, parsed };
    })
    .filter((x) => x.parsed);

  // 分组：按 mid 归并（可能存在重复）
  const byMid = new Map(); // mid -> { dirs: [{oldName, rest}], keepName: string }
  for (const u of userDirs) {
    const mid = u.parsed.mid;
    if (!byMid.has(mid)) byMid.set(mid, []);
    byMid.get(mid).push({ oldName: u.oldName, rest: u.parsed.rest });
  }

  const allUsers = [];
  let renameCount = 0;
  let mergeCount = 0;

  for (const [mid, dirs] of byMid) {
    const target = path.join(DATA_DIR, `uid_${mid}`);
    // 目标已存在（新命名）的文件夹
    const hasTarget = dirs.some((d) => d.rest === null);

    // 需要重命名的旧文件夹（带昵称）
    const oldDirs = dirs.filter((d) => d.rest !== null);

    // 收集该 mid 的昵称（取 account-info.json 里的 uname，其次用文件夹里的昵称）
    let uname = "";
    let updatedAt = "";

    for (const d of dirs) {
      const abs = path.join(DATA_DIR, d.oldName);
      try {
        const info = JSON.parse(await fs.readFile(path.join(abs, "account-info.json"), "utf8"));
        if (info.uname) uname = info.uname;
        if (info.updated_at) updatedAt = info.updated_at;
      } catch { /* 无 account-info */ }
      // 兜底：从文件夹名取昵称
      if (!uname && d.rest) uname = d.rest;
    }

    if (hasTarget) {
      // 目标已存在：把旧文件夹里目标没有的文件搬进去，再删旧文件夹
      for (const d of oldDirs) {
        const src = path.join(DATA_DIR, d.oldName);
        const files = await fs.readdir(src);
        for (const f of files) {
          const destFile = path.join(target, f);
          const srcFile = path.join(src, f);
          if (await exists(destFile)) {
            console.log(`  跳过(已存在): ${f}`);
            continue;
          }
          if (dryRun) {
            console.log(`  [DRY] 移动: ${d.oldName}/${f} -> uid_${mid}/${f}`);
          } else {
            await fs.rename(srcFile, destFile);
          }
        }
        if (!dryRun) await fs.rm(src, { recursive: true, force: true });
        mergeCount++;
      }
    } else {
      // 目标不存在：若只有一个旧文件夹，直接重命名
      if (oldDirs.length === 1 && !dryRun) {
        await fs.rename(path.join(DATA_DIR, oldDirs[0].oldName), target);
        console.log(`  重命名: ${oldDirs[0].oldName} -> uid_${mid}`);
      } else if (oldDirs.length === 1) {
        console.log(`  [DRY] 重命名: ${oldDirs[0].oldName} -> uid_${mid}`);
      } else {
        // 多个同名 mid 的旧文件夹：合并到目标
        if (!dryRun) await fs.mkdir(target, { recursive: true });
        for (const d of oldDirs) {
          const src = path.join(DATA_DIR, d.oldName);
          const files = await fs.readdir(src);
          for (const f of files) {
            const destFile = path.join(target, f);
            if (await exists(destFile)) {
              console.log(`  跳过(已存在): ${f}`);
              continue;
            }
            if (dryRun) {
              console.log(`  [DRY] 移动: ${d.oldName}/${f} -> uid_${mid}/${f}`);
            } else {
              await fs.rename(path.join(src, f), destFile);
            }
          }
          if (!dryRun) await fs.rm(src, { recursive: true, force: true });
        }
      }
      renameCount++;
    }

    // 时间兜底：用文件夹里最新文件 mtime
    if (!updatedAt) {
      try {
        const files = await fs.readdir(target);
        let latest = 0;
        for (const f of files) {
          try {
            const st = await fs.stat(path.join(target, f));
            if (st.mtimeMs > latest) latest = st.mtimeMs;
          } catch {}
        }
        if (latest) updatedAt = new Date(latest).toISOString();
      } catch {}
    }

    allUsers.push({ mid: Number(mid), uname, updatedAt: updatedAt || new Date().toISOString() });
  }

  // 写入 users-list.json（按更新时间倒序，本机相关可后续标记）
  allUsers.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  if (dryRun) {
    console.log("\n[DRY] 将生成 users-list.json:");
    console.log(JSON.stringify(allUsers, null, 2));
  } else {
    await fs.mkdir(DATA_DIR, { recursive: true });
    await fs.writeFile(USERS_LIST_FILE, JSON.stringify(allUsers, null, 2), "utf8");
    console.log(`\n已生成 users-list.json（${allUsers.length} 个用户）`);
  }

  console.log(`\n完成: 重命名 ${renameCount} 个，合并 ${mergeCount} 个${dryRun ? "（DRY-RUN）" : ""}`);
}

async function exists(p) {
  try { await fs.access(p); return true; } catch { return false; }
}

main().catch((e) => {
  console.error("迁移失败:", e);
  process.exit(1);
});
