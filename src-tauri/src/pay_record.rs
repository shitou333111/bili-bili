//! 消费记录后台拉取（Rust 原生线程，不受 WebView 后台暂停影响）
//!
//! 与 src/lib/pay-record-client.ts 逻辑对应，但运行在 Rust 原生线程中。
//! Android 端切到后台时 WebView 会暂停 JS 执行，导致串行翻页卡住。
//! 本模块将全量翻页逻辑移到 Rust，前端只负责发起请求和接收结果。

use md5;
use reqwest::Client;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::time::Duration;
use tauri::Emitter;

const DEFAULT_APP_KEY: &str = "1d8b6e7d45233436";
const DEFAULT_APP_SECRET: &str = "560c52ccd288fed045859ed18bffd973";
const PAGE_SIZE: u32 = 20;
const MAX_PAGES: u32 = 1000;
const REQUEST_TIMEOUT_SECS: u64 = 15;
const REQUEST_RETRY_COUNT: u32 = 3;
const REQUEST_BACKOFF_MS: u64 = 500;
const RATE_LIMIT_COOLDOWN_MS: u64 = 30_000;

// ---- 类型定义 ----

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PayRecordItem {
    pub id: i64,
    pub gift_num: i64,
    pub gift_num_unit: String,
    pub coin: String,
    pub pay_coin: String,
    pub ruid: i64,
    pub gift_id: i64,
    pub timestamp: i64,
    pub room_id: i64,
    pub r_uname: String,
    pub gift_name: String,
    pub gift_img: String,
    pub coin_type: String,
    pub is_guard: i64,
    pub is_discount: i64,
    pub bag_desc: String,
    pub discount_desc: String,
    pub status_msg: String,
    pub receive_title: String,
    pub refund_price: String,
    pub mtime: i64,
}

#[derive(Debug, Deserialize)]
struct PayRecordResponse {
    code: i32,
    message: String,
    data: Option<PayRecordData>,
}

#[derive(Debug, Deserialize)]
struct PayRecordData {
    list: Vec<PayRecordItem>,
    #[serde(default)]
    params: Option<PayRecordParams>,
}

#[derive(Debug, Deserialize)]
struct PayRecordParams {
    next_id: Option<i64>,
    #[serde(default)]
    month: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayRecordSnapshot {
    pub source: String,
    pub month: String,
    pub next_id: i64,
    pub total_records: usize,
    pub total_coins: i64,
    pub gift_catalog: Vec<GiftCatalogEntry>,
    pub records: Vec<PayRecordSnapshotItem>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GiftCatalogEntry {
    pub gift_name: String,
    pub gift_img: String,
    pub gift_id: i64,
    pub latest_timestamp: i64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PayRecordSnapshotItem {
    pub id: i64,
    pub gift_num: i64,
    pub gift_num_unit: String,
    pub coin: String,
    pub pay_coin: String,
    pub ruid: i64,
    pub gift_id: i64,
    pub timestamp: i64,
    pub room_id: i64,
    pub r_uname: String,
    pub gift_name: String,
    pub gift_img: String,
    pub coin_type: String,
    pub is_guard: i64,
    pub is_discount: i64,
    pub bag_desc: String,
    pub discount_desc: String,
    pub status_msg: String,
    pub receive_title: String,
    pub refund_price: String,
    pub mtime: i64,
    pub total_coins: i64,
    pub gift_name_key: String,
}

// ---- 签名 ----

fn sign_params(params: &[(&str, &str)]) -> String {
    let mut sorted: Vec<(&str, &str)> = params.to_vec();
    sorted.sort_by(|a, b| a.0.cmp(b.0));
    let query = sorted
        .iter()
        .map(|(k, v)| format!("{}={}", k, v))
        .collect::<Vec<_>>()
        .join("&");
    let input = format!("{}{}", query, DEFAULT_APP_SECRET);
    format!("{:x}", md5::compute(input.as_bytes()))
}

// ---- URL 构建 ----

fn build_pay_record_url(next_id: Option<i64>) -> String {
    let ts = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs()
        .to_string();

    let mut pairs: Vec<(&str, String)> = vec![
        ("actionKey", "appkey".into()),
        ("appkey", DEFAULT_APP_KEY.into()),
        ("build", "8870400".into()),
        ("c_locale", "zh-Hans_CN".into()),
        ("channel", "oppo".into()),
        ("coin_type", "gold".into()),
        ("device", "android".into()),
        ("disable_rcmd", "0".into()),
        ("mobi_app", "android".into()),
        ("page_size", PAGE_SIZE.to_string()),
        ("platform", "android".into()),
        ("s_locale", "zh-Hans_CN".into()),
        (
            "statistics",
            serde_json::json!({"appId":1,"platform":3,"version":"8.87.0","abtest":""}).to_string(),
        ),
        ("ts", ts.clone()),
        ("version", "8.87.0".into()),
    ];

    if let Some(nid) = next_id {
        pairs.push(("next_id", nid.to_string()));
    }

    // Build sign: need raw values (not URL-encoded)
    let sign_pairs: Vec<(&str, &str)> = pairs.iter().map(|(k, v)| (*k, v.as_str())).collect();
    let sign = sign_params(&sign_pairs);
    pairs.push(("sign", sign));

    let query: String = pairs
        .iter()
        .map(|(k, v)| {
            format!(
                "{}={}",
                urlencoding(k),
                urlencoding(v)
            )
        })
        .collect::<Vec<_>>()
        .join("&");

    format!(
        "https://api.live.bilibili.com/xlive/revenue/v2/giftStream/payRecord?{}",
        query
    )
}

fn urlencoding(s: &str) -> String {
    let mut result = String::with_capacity(s.len() * 3);
    for byte in s.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                result.push(byte as char);
            }
            _ => {
                result.push_str(&format!("%{:02X}", byte));
            }
        }
    }
    result
}

// ---- HTTP 请求 ----

async fn fetch_pay_record_page_with_retry(
    client: &Client,
    cookie: &str,
    next_id: Option<i64>,
) -> Result<PayRecordResponse, String> {
    let url = build_pay_record_url(next_id);
    let mut last_err = String::new();

    for attempt in 0..=REQUEST_RETRY_COUNT {
        let req = client
            .get(&url)
            .header("Cookie", cookie)
            .header("Referer", "https://live.bilibili.com/")
            .header(
                "User-Agent",
                "Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36",
            )
            .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS));

        match req.send().await {
            Ok(resp) => {
                let status = resp.status();
                if status.as_u16() == 412 {
                    let msg = format!("412 rate limited");
                    // 412 限流：冷却后重试
                    if attempt < REQUEST_RETRY_COUNT {
                        tokio::time::sleep(Duration::from_millis(RATE_LIMIT_COOLDOWN_MS)).await;
                    }
                    last_err = msg;
                    continue;
                }
                match resp.json::<PayRecordResponse>().await {
                    Ok(data) => return Ok(data),
                    Err(e) => {
                        last_err = format!("parse error: {}", e);
                        if attempt < REQUEST_RETRY_COUNT {
                            let delay = REQUEST_BACKOFF_MS * 2u64.pow(attempt);
                            tokio::time::sleep(Duration::from_millis(delay)).await;
                        }
                    }
                }
            }
            Err(e) => {
                last_err = format!("request error: {}", e);
                if attempt < REQUEST_RETRY_COUNT {
                    let delay = REQUEST_BACKOFF_MS * 2u64.pow(attempt);
                    tokio::time::sleep(Duration::from_millis(delay)).await;
                }
            }
        }
    }

    Err(last_err)
}

// ---- 数据处理 ----

fn get_max_id(records: &[PayRecordItem]) -> i64 {
    records.iter().map(|r| r.id).max().unwrap_or(0)
}

fn build_snapshot(records: &[PayRecordItem], month: &str) -> PayRecordSnapshot {
    let all_records: Vec<PayRecordSnapshotItem> = records
        .iter()
        .map(|r| {
            let total_coins: i64 = r
                .pay_coin
                .replace(',', "")
                .parse()
                .unwrap_or(0)
                .max(r.coin.replace(',', "").parse().unwrap_or(0));
            PayRecordSnapshotItem {
                id: r.id,
                gift_num: r.gift_num,
                gift_num_unit: r.gift_num_unit.clone(),
                coin: r.coin.clone(),
                pay_coin: r.pay_coin.clone(),
                ruid: r.ruid,
                gift_id: r.gift_id,
                timestamp: r.timestamp,
                room_id: r.room_id,
                r_uname: r.r_uname.clone(),
                gift_name: r.gift_name.clone(),
                gift_img: r.gift_img.clone(),
                coin_type: r.coin_type.clone(),
                is_guard: r.is_guard,
                is_discount: r.is_discount,
                bag_desc: r.bag_desc.clone(),
                discount_desc: r.discount_desc.clone(),
                status_msg: r.status_msg.clone(),
                receive_title: r.receive_title.clone(),
                refund_price: r.refund_price.clone(),
                mtime: r.mtime,
                total_coins,
                gift_name_key: r.gift_name.clone(),
            }
        })
        .collect();

    let mut catalog_map = std::collections::HashMap::new();
    for r in &all_records {
        let key = format!("{}_{}", r.gift_id, r.gift_name);
        catalog_map
            .entry(key)
            .or_insert(GiftCatalogEntry {
                gift_name: r.gift_name.clone(),
                gift_img: r.gift_img.clone(),
                gift_id: r.gift_id,
                latest_timestamp: r.timestamp,
            });
    }
    let gift_catalog: Vec<_> = catalog_map.into_values().collect();

    let total_coins = all_records.iter().map(|r| r.total_coins).sum();

    PayRecordSnapshot {
        source: "real".into(),
        month: month.to_string(),
        next_id: all_records.last().map(|r| r.id).unwrap_or(0),
        total_records: all_records.len(),
        total_coins,
        gift_catalog,
        records: all_records,
    }
}

// ---- 主函数 ----

/// 后台拉取消费记录（运行在 Rust 原生线程，不受 WebView 后台暂停影响）
///
/// 返回 JSON 字符串，与前端 `fetchPayRecords` 的返回格式一致。
#[tauri::command]
pub async fn fetch_pay_records_background(
    cookie: String,
    existing_records_json: String,
    app_handle: tauri::AppHandle,
) -> Result<String, String> {
    // 解析已有记录
    let existing_records: Vec<PayRecordItem> = if existing_records_json.is_empty() {
        vec![]
    } else {
        serde_json::from_str(&existing_records_json).unwrap_or_default()
    };

    let existing_max_id = get_max_id(&existing_records);

    // 回溯窗口：1 周
    let retrospent_seconds: i64 = 7 * 24 * 3600;
    let update_point_timestamp = existing_records
        .iter()
        .find(|r| r.id == existing_max_id)
        .map(|r| r.timestamp)
        .unwrap_or(0);
    let cutoff_timestamp = if update_point_timestamp > 0 {
        update_point_timestamp - retrospent_seconds
    } else {
        0
    };

    let client = Client::builder()
        .timeout(Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .build()
        .map_err(|e| format!("创建 HTTP 客户端失败: {}", e))?;

    let mut all_records: Vec<PayRecordItem> = Vec::new();
    let mut seen_ids: HashSet<i64> = HashSet::new();
    let mut next_id: Option<i64> = None;
    let mut month = String::new();
    let mut page_count: u32 = 0;

    loop {
        page_count += 1;
        if page_count > MAX_PAGES {
            break;
        }

        let response = fetch_pay_record_page_with_retry(&client, &cookie, next_id).await?;

        if response.code != 0 {
            return Err(response.message);
        }

        let data = match response.data {
            Some(d) => d,
            None => break,
        };

        if data.list.is_empty() {
            break;
        }

        if month.is_empty() {
            if let Some(ref params) = data.params {
                month = params.month.clone().unwrap_or_default();
            }
        }

        let mut has_new = false;
        let mut reached_cutoff = false;

        for item in &data.list {
            if cutoff_timestamp > 0 && item.timestamp < cutoff_timestamp {
                reached_cutoff = true;
                break;
            }
            if seen_ids.contains(&item.id) {
                continue;
            }
            seen_ids.insert(item.id);
            all_records.push(item.clone());
            has_new = true;
        }

        if reached_cutoff {
            break;
        }

        if !has_new {
            break;
        }

        next_id = data.params.as_ref().and_then(|p| p.next_id);

        let _ = app_handle.emit(
            "pay-record-progress",
            serde_json::json!({
                "page": page_count,
                "records": all_records.len(),
            }),
        );
    }

    // 合并：新记录在前，已有记录在后
    let mut merged = if existing_max_id > 0 {
        let mut m = all_records;
        m.extend(existing_records);
        m
    } else {
        all_records
    };

    // 去重
    let mut seen = HashSet::new();
    merged.retain(|r| seen.insert(r.id));

    let snapshot = build_snapshot(&merged, &month);

    serde_json::to_string(&snapshot).map_err(|e| format!("序列化失败: {}", e))
}