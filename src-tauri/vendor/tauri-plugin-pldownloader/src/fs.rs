#[tauri::command]
pub async fn copy_file_path(src: &str, dest: &str) -> Result<String, String> {
    // Kiểm tra file nguồn tồn tại
    if let Err(e) = tokio::fs::metadata(src).await {
        return Err(format!("Source file not found or inaccessible: {}", e));
    }

    // Tạo thư mục đích nếu chưa tồn tại
    let dest_parent = match std::path::Path::new(dest).parent() {
        Some(dir) => dir,
        None => return Err("Destination path must include a parent directory".to_string()),
    };

    if let Err(e) = tokio::fs::create_dir_all(dest_parent).await {
        return Err(format!("Failed to create destination directory: {}", e));
    }

    // Sao chép file
    if let Err(e) = tokio::fs::copy(src, dest).await {
        return Err(format!("Failed to copy file: {}", e));
    }

    Ok(dest.to_string())
}
