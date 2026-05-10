use tauri::{Manager, WebviewWindow};

#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    std::fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_cli_file() -> Option<String> {
    let args: Vec<String> = std::env::args().collect();
    args.iter().skip(1).find(|arg| {
        std::path::Path::new(arg)
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| {
                let ext = ext.to_lowercase();
                ext == "md" || ext == "markdown" || ext == "mdown"
            })
            .unwrap_or(false)
    }).cloned()
}

#[tauri::command]
fn set_window_title(title: String, window: WebviewWindow) {
    let _ = window.set_title(&title);
}

/// 从命令行参数中提取第一个 Markdown 文件路径，同步读取内容。
/// 若未传入有效路径，返回空字符串。
fn preload_initial_content() -> String {
    let args: Vec<String> = std::env::args().collect();
    let maybe_path = args.iter().skip(1).find(|arg| {
        std::path::Path::new(arg)
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| {
                let ext = ext.to_lowercase();
                ext == "md" || ext == "markdown" || ext == "mdown"
            })
            .unwrap_or(false)
    });

    match maybe_path {
        Some(path) => std::fs::read_to_string(path).unwrap_or_default(),
        None => String::new(),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let initial_content = preload_initial_content();
    let script = format!(
        "window.__INITIAL_MD_CONTENT__ = {};",
        serde_json::to_string(&initial_content).unwrap_or_else(|_| "\"\"".to_string())
    );

    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            get_cli_file,
            set_window_title
        ])
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval(&script);
            }
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
