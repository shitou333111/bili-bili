fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["fetch_json", "debug_acl"]),
        ),
    )
    .expect("failed to build tauri app");

    // 原生构建日期戳（东八区 YYYYMMDD），以编译期常量 BILI_BUILD_DATE 注入。
    // 供 lib.rs 检测"原生包是否升级"：覆盖安装新包后若日期戳变化，则清空 AppData 里
    // 陈旧的 hotswap 热更新缓存（旧 OTA bundle 会顶掉新包内嵌前端，导致"当前版本显示
    // 旧日期 + 误报热更新"，详见 lib.rs 修复注释）。
    println!("cargo:rustc-env=BILI_BUILD_DATE={}", shanghai_yyyymmdd());
    println!("cargo:rerun-if-env-changed=BILI_BUILD_DATE");
}

/// 东八区当前日期 YYYYMMDD（Howard Hinnant civil_from_days 算法，无外部依赖）
fn shanghai_yyyymmdd() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
        + 8 * 3600;
    let (y, m, d) = civil_from_days(secs / 86400);
    format!("{:04}{:02}{:02}", y, m, d)
}

/// 自 Unix 纪元的天数 → (年, 月, 日)
fn civil_from_days(z: i64) -> (i64, i64, i64) {
    let z = z + 719468;
    let era = if z >= 0 { z } else { z - 146096 } / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    (if m <= 2 { y + 1 } else { y }, m, d)
}
