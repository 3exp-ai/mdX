use std::path::PathBuf;
use std::sync::Mutex;
use std::time::SystemTime;
use tauri::{AppHandle, Emitter, Manager, RunEvent, WebviewWindow, WindowEvent};
use tauri_plugin_dialog::DialogExt;

// =============================================================
// Syntect 全局实例 —— 惰性初始化，只加载一次语法定义
// =============================================================
use std::sync::OnceLock;
static SYNTAX_SET: OnceLock<syntect::parsing::SyntaxSet> = OnceLock::new();

fn syntax_set() -> &'static syntect::parsing::SyntaxSet {
    SYNTAX_SET.get_or_init(syntect::parsing::SyntaxSet::load_defaults_newlines)
}

// =============================================================
// 应用全局状态 —— 所有文件相关的可变状态集中在此
//
// 设计原则:
//   - 前端不维护任何文件路径或保存状态
//   - 所有决策在 Rust 侧做出，前端只负责渲染和触发
//   - Mutex 保护并发访问，每个 command 中短暂持有锁
// =============================================================
pub struct AppState {
    /// 当前文件路径。None 表示草稿模式（尚未关联真实文件）。
    current_file_path: Mutex<Option<PathBuf>>,
    /// 上次保存/读取时的文件 mtime，用于冲突检测。
    last_modified_time: Mutex<Option<SystemTime>>,
    /// 保存锁：防止并发 IPC 保存请求导致文件损坏。
    is_saving: Mutex<bool>,
    /// 退出标记：当用户点击关闭窗口时设为 true，等待前端 flush。
    pending_close: Mutex<bool>,
}

impl AppState {
    fn new() -> Self {
        Self {
            current_file_path: Mutex::new(None),
            last_modified_time: Mutex::new(None),
            is_saving: Mutex::new(false),
            pending_close: Mutex::new(false),
        }
    }

    /// 原子设置文件路径和对应的 mtime
    fn set_file(&self, path: PathBuf) {
        let mtime = get_file_mtime(&path);
        let mut p = self.current_file_path.lock().unwrap();
        let mut m = self.last_modified_time.lock().unwrap();
        *p = Some(path);
        *m = mtime;
    }

    /// 获取当前文件路径的克隆
    fn file_path(&self) -> Option<PathBuf> {
        self.current_file_path.lock().unwrap().clone()
    }

    /// 获取上次记录的 mtime
    fn last_mtime(&self) -> Option<SystemTime> {
        *self.last_modified_time.lock().unwrap()
    }

    /// 尝试获取保存锁。返回 true 表示成功获得锁。
    fn try_lock_save(&self) -> bool {
        let mut lock = self.is_saving.lock().unwrap();
        if *lock {
            false
        } else {
            *lock = true;
            true
        }
    }

    /// 释放保存锁
    fn unlock_save(&self) {
        *self.is_saving.lock().unwrap() = false;
    }

    /// 检查是否正在等待关闭
    fn is_pending_close(&self) -> bool {
        *self.pending_close.lock().unwrap()
    }

    /// 设置/清除退出标记
    fn set_pending_close(&self, v: bool) {
        *self.pending_close.lock().unwrap() = v;
    }
}

// =============================================================
// 保存状态枚举 —— 序列化后返回前端
// =============================================================
#[derive(serde::Serialize, Clone, Debug)]
#[serde(tag = "status")]
pub enum SaveStatus {
    /// 保存成功
    Saved { path: String, timestamp: String },
    /// 文件被外部修改，存在冲突
    Conflict { message: String },
    /// 草稿模式，尚未关联文件
    Draft { message: String },
    /// 已有保存请求在处理中
    Busy,
    /// 保存失败
    Error { message: String },
}

/// 文档元信息 —— 前端启动时同步状态
#[derive(serde::Serialize, Clone, Debug)]
pub struct DocumentInfo {
    pub path: Option<String>,
    pub is_draft: bool,
    pub last_saved: Option<String>,
}

// =============================================================
// 工具函数
// =============================================================

/// 获取文件的修改时间
fn get_file_mtime(path: &std::path::Path) -> Option<SystemTime> {
    std::fs::metadata(path).ok()?.modified().ok()
}

/// 将 SystemTime 格式化为 HH:mm:ss 字符串
fn fmt_time(t: SystemTime) -> String {
    let datetime: chrono::DateTime<chrono::Local> = t.into();
    datetime.format("%H:%M:%S").to_string()
}

/// 原子写入文件 —— 先写临时文件，再 rename 覆盖。
/// 这是防止断电/崩溃导致文件损坏的核心机制。
fn atomic_write(path: &std::path::Path, content: &str) -> Result<(), String> {
    // 1. 确定临时文件路径（同目录下的隐藏文件）
    let parent = path.parent().ok_or("Invalid path: no parent directory")?;
    let file_name = path.file_name().ok_or("Invalid path: no file name")?;
    let tmp_name = format!(".mdx_tmp_{}", file_name.to_string_lossy());
    let tmp_path = parent.join(&tmp_name);

    // 2. 写入临时文件
    std::fs::write(&tmp_path, content).map_err(|e| format!("Write tmp failed: {}", e))?;

    // 3. 原子 rename 覆盖原文件（OS 保证这是原子操作）
    std::fs::rename(&tmp_path, path).map_err(|e| format!("Rename failed: {}", e))?;

    Ok(())
}

/// 清理可能残留的临时文件（启动时调用）
fn cleanup_tmp_files(dir: &std::path::Path) {
    if let Ok(entries) = std::fs::read_dir(dir) {
        for entry in entries.flatten() {
            let name = entry.file_name();
            let name_str = name.to_string_lossy();
            if name_str.starts_with(".mdx_tmp_") {
                let _ = std::fs::remove_file(entry.path());
            }
        }
    }
}

// =============================================================
// IPC Commands
// =============================================================

/// 读取文件内容
#[tauri::command]
fn read_file(path: String) -> Result<String, String> {
    std::fs::read_to_string(&path).map_err(|e| e.to_string())
}

/// 获取 CLI 传入的文件路径
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

// =============================================================
// 文件树节点 —— 懒加载只返回直接子节点
// =============================================================
#[derive(serde::Serialize, Clone, Debug)]
pub struct DirNode {
    pub name: String,
    pub path: String,
    pub is_dir: bool,
}

/// 读取目录的直接子节点（只读一层，绝不递归）。
///
/// 过滤规则:
///   - 跳过以 `.` 开头的隐藏文件/目录
///   - 文件只保留 `.md` / `.markdown` / `.mdown` 后缀
///   - 目录无后缀限制
#[tauri::command]
fn read_dir_tree(target_path: String) -> Result<Vec<DirNode>, String> {
    let path = std::path::Path::new(&target_path);
    let mut nodes = Vec::new();

    let entries = std::fs::read_dir(path).map_err(|e| format!("读取目录失败: {}", e))?;

    for entry in entries.flatten() {
        let name = entry.file_name();
        let name_str = name.to_string_lossy();

        // 跳过隐藏文件/目录
        if name_str.starts_with('.') {
            continue;
        }

        let metadata = entry.metadata().ok();
        let is_dir = metadata.as_ref().map(|m| m.is_dir()).unwrap_or(false);
        let entry_path = entry.path();
        let path_str = entry_path.to_string_lossy().to_string();

        if is_dir {
            // 目录：无条件保留
            nodes.push(DirNode {
                name: name_str.to_string(),
                path: path_str,
                is_dir: true,
            });
        } else {
            // 文件：只保留 Markdown 后缀
            let ext = entry_path
                .extension()
                .and_then(|e| e.to_str())
                .map(|e| e.to_lowercase());
            let is_md = matches!(ext.as_deref(), Some("md") | Some("markdown") | Some("mdown"));
            if is_md {
                nodes.push(DirNode {
                    name: name_str.to_string(),
                    path: path_str,
                    is_dir: false,
                });
            }
        }
    }

    // 排序：目录在前，文件在后，各自按名称字母序
    nodes.sort_by(|a, b| {
        match (a.is_dir, b.is_dir) {
            (true, false) => std::cmp::Ordering::Less,
            (false, true) => std::cmp::Ordering::Greater,
            _ => a.name.to_lowercase().cmp(&b.name.to_lowercase()),
        }
    });

    Ok(nodes)
}

/// 在指定父目录下创建新的 Markdown 文件。
/// 如果文件名不含 `.md` 后缀，自动补齐。
#[tauri::command]
fn create_new_file(parent_path: String, filename: String) -> Result<String, String> {
    let parent = std::path::Path::new(&parent_path);
    let mut name = filename.trim().to_string();

    // 自动补齐 .md 后缀
    let lower = name.to_lowercase();
    if !lower.ends_with(".md") && !lower.ends_with(".markdown") && !lower.ends_with(".mdown") {
        name.push_str(".md");
    }

    // 清理非法字符（基础防护）
    let safe_name: String = name
        .chars()
        .filter(|c| !matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|'))
        .collect();

    if safe_name.is_empty() {
        return Err("文件名不能为空".to_string());
    }

    let file_path = parent.join(&safe_name);

    // 如果文件已存在，追加数字后缀
    let final_path = if file_path.exists() {
        let stem = file_path.file_stem().unwrap_or_default().to_string_lossy();
        let ext = file_path.extension().unwrap_or_default().to_string_lossy();
        let mut counter = 1;
        loop {
            let candidate = parent.join(format!("{}_{}.{}", stem, counter, ext));
            if !candidate.exists() {
                break candidate;
            }
            counter += 1;
            if counter > 999 {
                return Err("无法生成唯一文件名".to_string());
            }
        }
    } else {
        file_path
    };

    std::fs::write(&final_path, "")
        .map_err(|e| format!("创建文件失败: {}", e))?;

    Ok(final_path.to_string_lossy().to_string())
}

/// 设置窗口标题
#[tauri::command]
fn set_window_title(title: String, window: WebviewWindow) {
    let _ = window.set_title(&title);
}

/// 核心 Markdown 解析引擎
#[tauri::command]
fn parse_markdown_to_html(content: String) -> String {
    use pulldown_cmark::{Parser, Event, Tag, CodeBlockKind};

    let mut html = String::with_capacity(content.len() * 3 / 2);
    let parser = Parser::new(&content);

    let mut tag_stack: Vec<String> = Vec::new();
    let mut in_code_block: Option<String> = None;
    let mut code_buffer: String = String::new();

    for event in parser {
        match event {
            Event::Start(tag) => {
                let name = tag_name_str(&tag);
                tag_stack.push(name.to_string());
                if let Tag::CodeBlock(CodeBlockKind::Fenced(lang)) = &tag {
                    in_code_block = Some(lang.to_string());
                    code_buffer.clear();
                }
                html.push('<');
                html.push_str(name);
                if let Some(cls) = tag_to_class(&tag) {
                    html.push_str(" class=\"");
                    html.push_str(cls);
                    html.push('"');
                }
                append_tag_attrs(&tag, &mut html);
                html.push('>');
            }
            Event::End(_tag_end) => {
                if in_code_block.is_some() {
                    if let Some(lang) = in_code_block.take() {
                        let highlighted = highlight_code_to_html(&lang, &code_buffer);
                        html.push_str(&highlighted);
                        code_buffer.clear();
                    }
                }
                if let Some(name) = tag_stack.pop() {
                    html.push_str("</");
                    html.push_str(&name);
                    html.push('>');
                }
            }
            Event::Text(text) => {
                if in_code_block.is_some() {
                    code_buffer.push_str(&text);
                } else {
                    escape_html_into(&text, &mut html);
                }
            }
            Event::Code(code) => {
                html.push_str("<code class=\"mdx-code\">");
                escape_html_into(&code, &mut html);
                html.push_str("</code>");
            }
            Event::Html(raw) => html.push_str(&raw),
            Event::SoftBreak => {
                if in_code_block.is_some() {
                    code_buffer.push('\n');
                } else {
                    html.push('\n');
                }
            }
            Event::HardBreak => html.push_str("<br class=\"mdx-br\">"),
            Event::Rule => html.push_str("<hr class=\"mdx-hr\">"),
            _ => {}
        }
    }
    html
}

// =============================================================
// 保存引擎核心 Commands
// =============================================================

/// 保存文档 —— 工业级双轨保存的核心。
///
/// 流程:
///   1. 获取保存锁（防止并发）
///   2. 检查 current_file_path
///      - None → 返回 Draft（提示用户用 save_as）
///   3. 冲突检测：比较磁盘 mtime 与记录的 last_modified_time
///      - 外部修改且 force=false → 返回 Conflict
///   4. 原子写入：.mdx_tmp → rename → 目标文件
///   5. 更新 last_modified_time
///   6. 释放保存锁
#[tauri::command]
fn save_document(
    content: String,
    force: bool,
    state: tauri::State<AppState>,
) -> SaveStatus {
    // 1. 获取保存锁
    if !state.try_lock_save() {
        return SaveStatus::Busy;
    }

    // 2. 检查是否有文件路径
    let path = match state.file_path() {
        Some(p) => p,
        None => {
            state.unlock_save();
            return SaveStatus::Draft {
                message: "当前为草稿模式，请使用 Cmd+Shift+S 另存为".to_string(),
            };
        }
    };

    // 3. 冲突检测
    if !force {
        if let Some(disk_mtime) = get_file_mtime(&path) {
            if let Some(last_mtime) = state.last_mtime() {
                if disk_mtime > last_mtime {
                    state.unlock_save();
                    return SaveStatus::Conflict {
                        message: format!(
                            "文件已被外部修改 ({})",
                            fmt_time(disk_mtime)
                        ),
                    };
                }
            }
        }
    }

    // 4. 原子写入
    let result = atomic_write(&path, &content);

    // 5. 更新 mtime 或处理错误
    match result {
        Ok(()) => {
            let new_mtime = get_file_mtime(&path);
            if let Some(mtime) = new_mtime {
                *state.last_modified_time.lock().unwrap() = Some(mtime);
            }
            state.unlock_save();
            SaveStatus::Saved {
                path: path.to_string_lossy().to_string(),
                timestamp: new_mtime.map(fmt_time).unwrap_or_default(),
            }
        }
        Err(e) => {
            state.unlock_save();
            SaveStatus::Error { message: e }
        }
    }
}

/// 另存为 —— 调起系统文件对话框，选择新路径后原子写入。
#[tauri::command]
fn save_as(
    content: String,
    state: tauri::State<AppState>,
    app_handle: AppHandle,
) -> SaveStatus {
    // 获取保存锁
    if !state.try_lock_save() {
        return SaveStatus::Busy;
    }

    // 调起保存对话框（阻塞式，等待用户选择）
    let path_result = app_handle
        .dialog()
        .file()
        .add_filter("Markdown", &["md", "markdown", "mdown"])
        .blocking_save_file();

    let file_path = match path_result {
        Some(p) => p,
        None => {
            state.unlock_save();
            return SaveStatus::Error {
                message: "未选择保存路径".to_string(),
            };
        }
    };

    let path = match file_path.into_path() {
        Ok(p) => p,
        Err(_) => {
            state.unlock_save();
            return SaveStatus::Error {
                message: "无效的文件路径".to_string(),
            };
        }
    };

    if path.as_os_str().is_empty() {
        state.unlock_save();
        return SaveStatus::Error {
            message: "未选择保存路径".to_string(),
        };
    }

    // 原子写入
    match atomic_write(&path, &content) {
        Ok(()) => {
            let new_mtime = get_file_mtime(&path);
            *state.last_modified_time.lock().unwrap() = new_mtime;
            *state.current_file_path.lock().unwrap() = Some(path.clone());
            state.unlock_save();
            SaveStatus::Saved {
                path: path.to_string_lossy().to_string(),
                timestamp: new_mtime.map(fmt_time).unwrap_or_default(),
            }
        }
        Err(e) => {
            state.unlock_save();
            SaveStatus::Error { message: e }
        }
    }
}

/// 获取文档元信息 —— 前端启动时调用，同步 Rust 侧状态。
#[tauri::command]
fn get_document_info(state: tauri::State<AppState>) -> DocumentInfo {
    let path = state.file_path();
    let mtime = state.last_mtime();
    let is_draft = path.is_none();
    DocumentInfo {
        path: path.map(|p| p.to_string_lossy().to_string()),
        is_draft,
        last_saved: mtime.map(fmt_time),
    }
}

/// 前端确认 flush 完成 —— 触发实际窗口关闭。
#[tauri::command]
fn acknowledge_flush(state: tauri::State<AppState>, app_handle: AppHandle) {
    state.set_pending_close(false);
    // 关闭所有窗口，触发应用退出
    for window in app_handle.webview_windows().values() {
        let _ = window.close();
    }
}

// =============================================================
// 语法高亮
// =============================================================
fn highlight_code_to_html(language: &str, code: &str) -> String {
    let ss = syntax_set();
    let syntax = ss.find_syntax_by_token(language)
        .or_else(|| ss.find_syntax_by_name(language))
        .or_else(|| ss.find_syntax_by_extension(language))
        .unwrap_or_else(|| ss.find_syntax_plain_text());

    let mut html_generator = syntect::html::ClassedHTMLGenerator::new_with_class_style(
        syntax,
        ss,
        syntect::html::ClassStyle::SpacedPrefixed { prefix: "syn-" },
    );

    for line in code.lines() {
        let line_with_nl = format!("{}\n", line);
        let _ = html_generator.parse_html_for_line_which_includes_newline(&line_with_nl);
    }

    html_generator.finalize()
}

// =============================================================
// Markdown 解析辅助函数
// =============================================================
fn tag_to_class(tag: &pulldown_cmark::Tag) -> Option<&'static str> {
    use pulldown_cmark::Tag;
    match tag {
        Tag::Paragraph => Some("mdx-p"),
        Tag::Heading { level, .. } => match level {
            pulldown_cmark::HeadingLevel::H1 => Some("mdx-h1"),
            pulldown_cmark::HeadingLevel::H2 => Some("mdx-h2"),
            pulldown_cmark::HeadingLevel::H3 => Some("mdx-h3"),
            pulldown_cmark::HeadingLevel::H4 => Some("mdx-h4"),
            pulldown_cmark::HeadingLevel::H5 => Some("mdx-h5"),
            pulldown_cmark::HeadingLevel::H6 => Some("mdx-h6"),
        },
        Tag::BlockQuote(_) => Some("mdx-blockquote"),
        Tag::CodeBlock(_) => Some("mdx-pre"),
        Tag::List(_) => Some("mdx-ul"),
        Tag::Item => Some("mdx-li"),
        Tag::Emphasis => Some("mdx-em"),
        Tag::Strong => Some("mdx-strong"),
        Tag::Strikethrough => Some("mdx-strike"),
        Tag::Link { .. } => Some("mdx-a"),
        Tag::Image { .. } => Some("mdx-img"),
        Tag::Table(_) => Some("mdx-table"),
        Tag::TableHead => Some("mdx-thead"),
        Tag::TableRow => Some("mdx-tr"),
        Tag::TableCell => Some("mdx-td"),
        _ => None,
    }
}

fn tag_name_str(tag: &pulldown_cmark::Tag) -> &'static str {
    use pulldown_cmark::Tag;
    match tag {
        Tag::Paragraph => "p",
        Tag::Heading { level, .. } => match level {
            pulldown_cmark::HeadingLevel::H1 => "h1",
            pulldown_cmark::HeadingLevel::H2 => "h2",
            pulldown_cmark::HeadingLevel::H3 => "h3",
            pulldown_cmark::HeadingLevel::H4 => "h4",
            pulldown_cmark::HeadingLevel::H5 => "h5",
            pulldown_cmark::HeadingLevel::H6 => "h6",
        },
        Tag::BlockQuote(_) => "blockquote",
        Tag::CodeBlock(_) => "pre",
        Tag::List(_) => "ul",
        Tag::Item => "li",
        Tag::Emphasis => "em",
        Tag::Strong => "strong",
        Tag::Strikethrough => "del",
        Tag::Link { .. } => "a",
        Tag::Image { .. } => "img",
        Tag::Table(_) => "table",
        Tag::TableHead => "thead",
        Tag::TableRow => "tr",
        Tag::TableCell => "td",
        Tag::FootnoteDefinition(_) => "div",
        _ => "span",
    }
}

fn append_tag_attrs(tag: &pulldown_cmark::Tag, html: &mut String) {
    use pulldown_cmark::Tag;
    match tag {
        Tag::Link { dest_url, title, .. } => {
            html.push_str(" href=\"");
            escape_attr_into(dest_url, html);
            html.push('"');
            if !title.is_empty() {
                html.push_str(" title=\"");
                escape_attr_into(title, html);
                html.push('"');
            }
        }
        Tag::Image { dest_url, title, .. } => {
            html.push_str(" src=\"");
            escape_attr_into(dest_url, html);
            html.push('"');
            if !title.is_empty() {
                html.push_str(" alt=\"");
                escape_attr_into(title, html);
                html.push('"');
            }
        }
        _ => {}
    }
}

fn escape_html_into(text: &str, out: &mut String) {
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(ch),
        }
    }
}

fn escape_attr_into(text: &str, out: &mut String) {
    for ch in text.chars() {
        match ch {
            '&' => out.push_str("&amp;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&#x27;"),
            _ => out.push(ch),
        }
    }
}

// =============================================================
// 启动逻辑
// =============================================================

/// 初始化文件路径：优先 CLI 参数，否则指向临时草稿文件。
fn init_file_path(state: &AppState) {
    let args: Vec<String> = std::env::args().collect();
    let cli_file = args.iter().skip(1).find(|arg| {
        std::path::Path::new(arg)
            .extension()
            .and_then(|ext| ext.to_str())
            .map(|ext| {
                let ext = ext.to_lowercase();
                ext == "md" || ext == "markdown" || ext == "mdown"
            })
            .unwrap_or(false)
    });

    match cli_file {
        Some(path_str) => {
            let path = PathBuf::from(path_str);
            state.set_file(path);
        }
        None => {
            // 草稿模式：指向临时目录下的 mdx_draft.md
            let draft_path = std::env::temp_dir().join("mdx_draft.md");
            // 文件不存在则创建空文件
            if !draft_path.exists() {
                let _ = std::fs::write(&draft_path, "");
            }
            state.set_file(draft_path);
        }
    }
}

/// 预加载初始内容
fn preload_initial_content(state: &AppState) -> String {
    match state.file_path() {
        Some(path) => std::fs::read_to_string(&path).unwrap_or_default(),
        None => String::new(),
    }
}

// =============================================================
// 应用入口
// =============================================================
pub fn run() {
    // 创建全局状态
    let app_state = AppState::new();

    // 初始化文件路径（在 Builder 构建之前）
    init_file_path(&app_state);

    // 预加载内容
    let initial_content = preload_initial_content(&app_state);
    let script = format!(
        "window.__INITIAL_MD_CONTENT__ = {};",
        serde_json::to_string(&initial_content).unwrap_or_else(|_| "\"\"".to_string())
    );

    // 清理可能残留的临时文件
    if let Some(path) = app_state.file_path() {
        if let Some(parent) = path.parent() {
            cleanup_tmp_files(parent);
        }
    }

    // 构建 Tauri 应用
    let app = tauri::Builder::default()
        .manage(app_state)
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            read_file,
            get_cli_file,
            set_window_title,
            parse_markdown_to_html,
            save_document,
            save_as,
            get_document_info,
            acknowledge_flush,
            read_dir_tree,
            create_new_file,
        ])
        .setup(move |app| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.eval(&script);
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    // 运行事件循环，拦截关闭请求
    app.run(|app_handle, event| {
        if let RunEvent::WindowEvent { label, event: WindowEvent::CloseRequested { api, .. }, .. } = event {
            if label == "main" {
                // 获取状态
                let state = app_handle.state::<AppState>();

                // 如果已经在等待关闭，直接放行
                if state.is_pending_close() {
                    return;
                }

                // 阻止默认关闭行为
                api.prevent_close();

                // 标记等待关闭
                state.set_pending_close(true);

                // 向前端发送 flush 请求
                if let Some(window) = app_handle.get_webview_window("main") {
                    let _ = window.emit("req-flush-save", ());
                }

                // 设置超时：5秒后前端无响应，强制关闭
                let app_handle_clone = app_handle.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(5));
                    let state = app_handle_clone.state::<AppState>();
                    if state.is_pending_close() {
                        // 强制关闭
                        for window in app_handle_clone.webview_windows().values() {
                            let _ = window.close();
                        }
                    }
                });
            }
        }
    });
}
