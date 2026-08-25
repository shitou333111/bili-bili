use serde::de::DeserializeOwned;
use tauri::{
  plugin::{PluginApi, PluginHandle},
  AppHandle, Runtime,
};

use crate::models::*;

#[cfg(target_os = "ios")]
tauri::ios_plugin_binding!(init_plugin_pldownloader);

// initializes the Kotlin or Swift plugin classes
pub fn init<R: Runtime, C: DeserializeOwned>(
  _app: &AppHandle<R>,
  api: PluginApi<R, C>,
) -> crate::Result<Pldownloader<R>> {
  #[cfg(target_os = "android")]
  let handle = api.register_android_plugin("com.plugin.pldownloader", "DownloaderPlugin")?;
  #[cfg(target_os = "ios")]
  let handle = api.register_ios_plugin(init_plugin_pldownloader)?;
  Ok(Pldownloader(handle))
}

/// Access to the pldownloader APIs.
pub struct Pldownloader<R: Runtime>(PluginHandle<R>);

impl<R: Runtime> Pldownloader<R> {
  pub fn ping(&self, payload: PingRequest) -> crate::Result<PingResponse> {
    self
      .0
      .run_mobile_plugin("ping", payload)
      .map_err(Into::into)
  }

  pub fn download_private(&self, payload: DownloadPrivateRequest) -> crate::Result<DownloadResponse> {
    self
      .0
      .run_mobile_plugin("downloadPrivate", payload)
      .map_err(Into::into)
  }

  pub fn download_public(&self, payload: DownloadPublicRequest) -> crate::Result<DownloadResponse> {
    self
      .0
      .run_mobile_plugin("downloadPublic", payload)
      .map_err(Into::into)
  }

  pub fn save_file_private_from_buffer(&self, payload: SaveFilePrivateFromBufferRequest) -> crate::Result<DownloadResponse> {
    self
      .0
      .run_mobile_plugin("saveFilePrivateFromBuffer", payload)
      .map_err(Into::into)
  }

  pub fn save_file_public_from_buffer(&self, payload: SaveFilePublicFromBufferRequest) -> crate::Result<DownloadResponse> {
    self
      .0
      .run_mobile_plugin("saveFilePublicFromBuffer", payload)
      .map_err(Into::into)
  }

  pub fn save_file_public_from_path(&self, payload: SaveFilePublicFromPathRequest) -> crate::Result<DownloadResponse> {
    self
      .0
      .run_mobile_plugin("saveFilePublicFromPath", payload)
      .map_err(Into::into)
  }
}
