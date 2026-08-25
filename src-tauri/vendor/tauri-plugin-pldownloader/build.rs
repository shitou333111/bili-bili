const COMMANDS: &[&str] = &["ping", "download_private", "download_public", "save_file_private_from_path", "save_file_public_from_path"];

fn main() {
  tauri_plugin::Builder::new(COMMANDS)
    .android_path("android")
    .ios_path("ios")
    .build();
}
