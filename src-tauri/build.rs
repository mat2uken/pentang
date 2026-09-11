fn main() {
    // 既存のTauri build処理にAppManifestのcommand登録を組み込む。
    // 独自commandの既定公開を権限管理の対象にする (docs/plan/02-architecture.md)。
    tauri_build::try_build(
        tauri_build::Attributes::new().app_manifest(
            tauri_build::AppManifest::new()
                .commands(&["poc_get_info", "poc_transform", "poc_transform_bin"]),
        ),
    )
    .expect("tauri build failed");
}
