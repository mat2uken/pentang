// M1-03: 実FFIを呼ぶ2commandと公開範囲。shared libのrunから登録する。
// データプレーン拡張: corebin: scheme (raw binary)。
// 制御プレーン (core_get_info) はJSONのまま。
mod batch;
mod commands;
mod scheme;
#[cfg(target_os = "android")]
mod android;

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
        .register_uri_scheme_protocol("corebin", |_ctx, req| {
            crate::scheme::handle_corebin(req)
        })
        .invoke_handler(tauri::generate_handler![
            commands::core_get_info,
            commands::core_transform
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
