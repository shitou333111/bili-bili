use tauri::{AppHandle, command, Runtime};

use crate::models::*;
use crate::Result;
use crate::PldownloaderExt;

#[command]
pub(crate) async fn ping<R: Runtime>(
    app: AppHandle<R>,
    payload: PingRequest,
) -> Result<PingResponse> {
    app.pldownloader().ping(payload)
}

#[command]
pub(crate) async fn download_private<R: Runtime>(
    app: AppHandle<R>,
    payload: DownloadPrivateRequest,
) -> Result<DownloadResponse> {
    app.pldownloader().download_private(payload)
}

#[command]
pub(crate) async fn download_public<R: Runtime>(
    app: AppHandle<R>,
    payload: DownloadPublicRequest,
) -> Result<DownloadResponse> {
    app.pldownloader().download_public(payload)
}

#[command]
pub(crate) async fn save_file_private_from_buffer<R: Runtime>(
    app: AppHandle<R>,
    payload: SaveFilePrivateFromBufferRequest,
) -> Result<DownloadResponse> {
    app.pldownloader().save_file_private_from_buffer(payload)
}

#[command]
pub(crate) async fn save_file_public_from_buffer<R: Runtime>(
    app: AppHandle<R>,
    payload: SaveFilePublicFromBufferRequest,
) -> Result<DownloadResponse> {
    app.pldownloader().save_file_public_from_buffer(payload)
}

#[command]
pub(crate) async fn save_file_public_from_path<R: Runtime>(
    app: AppHandle<R>,
    payload: SaveFilePublicFromPathRequest,
) -> Result<DownloadResponse> {
    app.pldownloader().save_file_public_from_path(payload)
}
