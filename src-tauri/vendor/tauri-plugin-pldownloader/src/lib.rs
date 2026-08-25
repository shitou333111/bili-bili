use tauri::{
  plugin::{Builder, TauriPlugin},
  Manager, Runtime,
};

pub use models::*;

#[cfg(desktop)]
mod desktop;
#[cfg(mobile)]
mod mobile;

mod commands;
mod error;
mod models;
mod fs;

pub use error::{Error, Result};

#[cfg(desktop)]
use desktop::Pldownloader;
#[cfg(mobile)]
use mobile::Pldownloader;

/// Extensions to [`tauri::App`], [`tauri::AppHandle`] and [`tauri::Window`] to access the pldownloader APIs.
pub trait PldownloaderExt<R: Runtime> {
  fn pldownloader(&self) -> &Pldownloader<R>;
}

impl<R: Runtime, T: Manager<R>> crate::PldownloaderExt<R> for T {
  fn pldownloader(&self) -> &Pldownloader<R> {
    self.state::<Pldownloader<R>>().inner()
  }
}

/// Initializes the plugin.
pub fn init<R: Runtime>() -> TauriPlugin<R> {
  Builder::new("pldownloader")
    .invoke_handler(tauri::generate_handler![
      commands::ping,
      commands::download_private,
      commands::download_public,
      commands::save_file_private_from_buffer,
      commands::save_file_public_from_buffer,
      commands::save_file_public_from_path,
      fs::copy_file_path
    ])
    .setup(|app, api| {
      #[cfg(mobile)]
      let pldownloader = mobile::init(app, api)?;
      #[cfg(desktop)]
      let pldownloader = desktop::init(app, api)?;
      app.manage(pldownloader);
      Ok(())
    })
    .build()
}
