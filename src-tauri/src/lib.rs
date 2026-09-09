// M1-03: 実FFIを呼ぶ2commandと公開範囲。shared libのrunから登録する。
mod commands;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            commands::poc_get_info,
            commands::poc_transform
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
