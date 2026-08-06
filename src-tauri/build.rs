fn main() {
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new().commands(&["fetch_json", "debug_acl"]),
        ),
    )
    .expect("failed to build tauri app");
}