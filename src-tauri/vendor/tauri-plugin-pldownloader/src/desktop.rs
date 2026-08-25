use serde::de::DeserializeOwned;
use tauri::{plugin::PluginApi, AppHandle, Runtime};

use crate::models::*;

pub fn init<R: Runtime, C: DeserializeOwned>(
  app: &AppHandle<R>,
  _api: PluginApi<R, C>,
) -> crate::Result<Pldownloader<R>> {
  Ok(Pldownloader(app.clone()))
}

/// Access to the pldownloader APIs.
pub struct Pldownloader<R: Runtime>(AppHandle<R>);

impl<R: Runtime> Pldownloader<R> {
  pub fn ping(&self, payload: PingRequest) -> crate::Result<PingResponse> {
    Ok(PingResponse {
      value: payload.value,
    })
  }

  pub fn download_private(&self, _payload: DownloadPrivateRequest) -> crate::Result<DownloadResponse> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "download_private not implemented on desktop").into())
  }

  pub fn download_public(&self, _payload: DownloadPublicRequest) -> crate::Result<DownloadResponse> {
    Err(std::io::Error::new(std::io::ErrorKind::Unsupported, "download_public not implemented on desktop").into())
  }

  pub fn save_file_private_from_buffer(&self, payload: SaveFilePrivateFromBufferRequest) -> crate::Result<DownloadResponse> {
    // Mock implementation for desktop - return fake data
    let file_name = payload.file_name.clone();
    Ok(DownloadResponse {
      file_name: payload.file_name,
      path: Some(format!("/mock/private/{}", file_name)),
      uri: None,
    })
  }

  pub fn save_file_public_from_buffer(&self, payload: SaveFilePublicFromBufferRequest) -> crate::Result<DownloadResponse> {
    // Mock implementation for desktop - return fake data
    let file_name = payload.file_name.clone();
    Ok(DownloadResponse {
      file_name: payload.file_name,
      path: Some(format!("/mock/public/{}", file_name)),
      uri: None,
    })
  }

  pub fn save_file_public_from_path(&self, payload: SaveFilePublicFromPathRequest) -> crate::Result<DownloadResponse> {
    Ok(DownloadResponse {
      file_name: payload.file_name,
      path: Some(payload.path),
      uri: None,
    })
  }

  pub fn copy_file_path(&self, _src: String, dest: String) -> crate::Result<String> {
    // Mock implementation for desktop - return fake data
    Ok(dest)
  }
}
