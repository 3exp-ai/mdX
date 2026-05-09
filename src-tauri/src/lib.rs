use tauri::WebviewWindow;

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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            read_file,
            write_file,
            get_cli_file,
            set_window_title
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
