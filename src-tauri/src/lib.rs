// M1-03: 実FFIを呼ぶ2commandと公開範囲。shared libのrunから登録する。
mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default();

    // The embedded WebDriver server is intentionally debug-only. Release builds
    // must remain black-box and must not expose an automation HTTP endpoint.
    #[cfg(all(
        debug_assertions,
        any(target_os = "macos", target_os = "windows", target_os = "linux")
    ))]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());

    builder
        .invoke_handler(tauri::generate_handler![
            commands::poc_get_info,
            commands::poc_transform
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
