// =============================================================
// mdX 前端 —— 左右分屏双栏编辑器 + 懒加载文件树
// 架构原则: Fat Rust, Thin UI
//   - 左侧: CodeMirror 6 纯文本编辑区，只负责捕获输入
//   - 右侧: HTML 预览区，Rust 解析后的渲染结果直接注入
//   - 左侧边栏: 懒加载文件树，只读一层，点击展开
//   - Rust 负责: 所有文件 IO、状态管理、冲突检测、原子写入
//
// 核心机制:
//   1. CM6 updateListener → 防抖 IPC → Rust 解析 → innerHTML 注入
//   2. 双轨保存: 1000ms 自动保存 + Cmd+S 手动 + Cmd+Shift+S 另存为
//   3. 文件切换: setState 彻底重置 CM6，防止跨文件撤销
//   4. 懒加载树: 点击文件夹 → invoke read_dir_tree → 挂载子节点
//   5. 退出拦截: CloseRequested → flush 保存 → 关闭
// =============================================================

console.log("预注数据:", window.__INITIAL_MD_CONTENT__);

// 尽早记录启动时间戳（原 index.html 内联脚本）
window.__t0 = performance.now();

import {
  EditorView,
  keymap,
  drawSelection,
  ViewPlugin,
} from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import {
  defaultKeymap,
  history,
  historyKeymap,
} from "@codemirror/commands";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// =============================================================
// Tauri 环境检测
// =============================================================
const isTauri = typeof window !== "undefined" && !!window.__TAURI_INTERNALS__;

// =============================================================
// 全局保存锁与状态
// =============================================================
let isSaving = false;
let saveStatus = "idle";
let isDirty = false;
let isLoadingFile = false;
let autoSaveTimer = null;
const AUTO_SAVE_DELAY = 1000;

let docInfo = { path: null, isDraft: true, lastSaved: null };

// 当前活跃的文件路径（用于侧边栏高亮）
let activeFilePath = null;

// =============================================================
// CM6 扩展配置 —— 可复用的基础配置
// =============================================================
const cmExtensions = [
  history(),
  keymap.of([...defaultKeymap, ...historyKeymap]),
  drawSelection(),
  EditorView.lineWrapping,
  EditorView.theme({
    ".cm-content": {
      padding: "60px 28px 30vh",
      fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
      fontSize: "15px",
      lineHeight: "1.75",
      color: "var(--text)",
      caretColor: "var(--accent)",
    },
    ".cm-line": { padding: "0 2px" },
  }),
];

// 脏状态追踪插件
const dirtyTracker = ViewPlugin.fromClass(
  class {
    update(update) {
      if (update.docChanged && !isLoadingFile) {
        isDirty = true;
        updateTitle();
        scheduleAutoSave();
        triggerPreviewRender();
      }
    }
  }
);

// =============================================================
// 状态栏更新
// =============================================================
function updateStatusBar(status, detail = null) {
  const bar = document.getElementById("status-bar");
  const text = document.getElementById("status-text");
  if (!bar || !text) return;
  saveStatus = status;
  bar.className = "";
  bar.classList.add(status);
  switch (status) {
    case "saving": text.textContent = "保存中..."; break;
    case "saved":
      text.textContent = detail ? `已保存 ${detail}` : "已保存";
      setTimeout(() => {
        if (saveStatus === "saved") { bar.classList.remove("saved"); bar.classList.add("idle"); }
      }, 2000);
      break;
    case "draft": text.textContent = "草稿模式 — Cmd+Shift+S 另存为"; break;
    case "conflict": text.textContent = "⚠️ 外部修改冲突 — 请另存为或强制覆盖"; break;
    case "error": text.textContent = detail ? `保存失败: ${detail}` : "保存失败"; break;
    case "busy": text.textContent = "保存进行中..."; break;
    default:
      text.textContent = docInfo.isDraft
        ? "草稿模式 — Cmd+Shift+S 另存为"
        : docInfo.lastSaved ? `已保存 ${docInfo.lastSaved}` : "";
  }
}

// =============================================================
// 同步 Rust 文档信息
// =============================================================
async function syncDocumentInfo() {
  if (!isTauri) return;
  try {
    const info = await invoke("get_document_info");
    docInfo = { path: info.path || null, isDraft: info.is_draft, lastSaved: info.last_saved || null };
    activeFilePath = docInfo.path;
    updateTitle();
    highlightSidebarActive();
    if (docInfo.isDraft) updateStatusBar("draft");
  } catch (e) { console.error("Sync doc info failed:", e); }
}

// =============================================================
// 标题更新
// =============================================================
let lastTitle = "";
function updateTitle(force = false) {
  if (!isTauri) return;
  const name = docInfo.path ? docInfo.path.split(/[\\/]/).pop() : "未命名";
  const dirtyMark = isDirty ? " *" : "";
  const title = `${name}${dirtyMark} - mdX`;
  if (force || title !== lastTitle) { invoke("set_window_title", { title }); lastTitle = title; }
}

// =============================================================
// 核心保存函数
// =============================================================
async function performSave({ force = false, isAuto = false } = {}) {
  if (!isTauri) return;
  if (isSaving) { if (!isAuto) updateStatusBar("busy"); return; }
  const view = window.editorView;
  if (!view) return;
  const content = view.state.doc.toString();
  if (docInfo.isDraft && isAuto && !force) { updateStatusBar("draft"); return; }
  isSaving = true;
  updateStatusBar("saving");
  try {
    const result = await invoke("save_document", { content, force });
    switch (result.status) {
      case "Saved":
        isDirty = false;
        docInfo.path = result.path;
        docInfo.isDraft = false;
        docInfo.lastSaved = result.timestamp;
        activeFilePath = result.path;
        updateTitle();
        updateStatusBar("saved", result.timestamp);
        highlightSidebarActive();
        refreshSidebarList();
        break;
      case "Conflict": updateStatusBar("conflict"); break;
      case "Draft": updateStatusBar("draft"); break;
      case "Busy": updateStatusBar("busy"); break;
      case "Error": updateStatusBar("error", result.message); break;
    }
  } catch (e) { console.error("Save failed:", e); updateStatusBar("error", e.toString()); }
  finally { isSaving = false; }
}

// =============================================================
// 另存为
// =============================================================
async function performSaveAs() {
  if (!isTauri) return;
  if (isSaving) { updateStatusBar("busy"); return; }
  const view = window.editorView;
  if (!view) return;
  const content = view.state.doc.toString();
  isSaving = true;
  updateStatusBar("saving");
  try {
    const result = await invoke("save_as", { content });
    switch (result.status) {
      case "Saved":
        isDirty = false;
        docInfo.path = result.path;
        docInfo.isDraft = false;
        docInfo.lastSaved = result.timestamp;
        activeFilePath = result.path;
        updateTitle();
        updateStatusBar("saved", result.timestamp);
        highlightSidebarActive();
        refreshSidebarList();
        break;
      case "Error": updateStatusBar("error", result.message); break;
      case "Busy": updateStatusBar("busy"); break;
    }
  } catch (e) { console.error("Save as failed:", e); updateStatusBar("error", e.toString()); }
  finally { isSaving = false; }
}

// =============================================================
// 自动保存调度
// =============================================================
function scheduleAutoSave() {
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    if (isDirty) performSave({ force: false, isAuto: true });
  }, AUTO_SAVE_DELAY);
}

// =============================================================
// 安全文件切换 —— CM6 setState 彻底重置
//
// 关键：禁止用 view.dispatch({changes:...}) 切换文件！
// 因为 dispatch 会保留 undo 历史，用户 Cmd+Z 会撤销到上一个文件。
// 正确做法：EditorState.create() 全新状态 + view.setState() 整体替换。
// =============================================================
async function switchToFile(path) {
  if (!invoke || !path) return false;

  // 1. 如果有未保存的修改，先保存当前文件
  if (isDirty && docInfo.path) {
    await performSave({ force: true });
  }

  try {
    isLoadingFile = true;
    const content = await invoke("read_file", { path });

    // 2. 用 EditorState.create() 创建全新状态
    //    不保留任何历史、选择、undo/redo 栈
    const newState = EditorState.create({
      doc: content,
      selection: { anchor: 0, head: 0 },
      extensions: [...cmExtensions, dirtyTracker],
    });

    // 3. 用 setState() 彻底替换，旧状态完全销毁
    const view = window.editorView;
    view.setState(newState);

    // 4. 同步 Rust 状态
    await syncDocumentInfo();

    isDirty = false;
    isLoadingFile = false;
    activeFilePath = path;
    highlightSidebarActive();
    updateTitle();
    triggerPreviewRender();
    return true;
  } catch (e) {
    isLoadingFile = false;
    console.error("Failed to switch file:", e);
    return false;
  }
}

// 保留旧函数名用于 CLI 加载
async function loadFileFromPath(path) {
  return switchToFile(path);
}

// =============================================================
// 初始化
// =============================================================
if (isTauri) {
  (async () => {
    await syncDocumentInfo();
    const path = await invoke("get_cli_file");
    if (path) {
      await switchToFile(path);
    } else {
      updateTitle();
      if (docInfo.isDraft) updateStatusBar("draft");
    }
    // 初始化侧边栏
    initSidebar();
  })();
}

// =============================================================
// 快捷键绑定
// =============================================================
if (isTauri) {
  document.addEventListener("keydown", async (e) => {
    const meta = e.ctrlKey || e.metaKey;
    if (meta && e.key === "s") {
      e.preventDefault();
      if (e.shiftKey) await performSaveAs();
      else await performSave({ force: true });
    }
  });
}

// =============================================================
// 优雅退出监听
// =============================================================
if (isTauri) {
  listen("req-flush-save", async () => {
    console.log("[Exit] Received flush request from Rust");
    try {
      const view = window.editorView;
      if (view) {
        const content = view.state.doc.toString();
        await invoke("save_document", { content, force: true });
      }
      await invoke("acknowledge_flush");
    } catch (e) {
      console.error("[Exit] Flush save failed:", e);
      await invoke("acknowledge_flush");
    }
  });
}

// =============================================================
// 预览渲染
// =============================================================
let previewDebounceTimer = null;
const PREVIEW_DEBOUNCE_MS = 200;
let previewInFlight = false;
let pendingText = null;

function triggerPreviewRender() {
  const view = window.editorView;
  if (!view) return;
  pendingText = view.state.doc.toString();
  if (previewDebounceTimer) clearTimeout(previewDebounceTimer);
  previewDebounceTimer = setTimeout(() => {
    previewDebounceTimer = null;
    flushPreviewRender();
  }, PREVIEW_DEBOUNCE_MS);
}

async function flushPreviewRender() {
  if (previewInFlight || pendingText === null) return;
  const text = pendingText;
  pendingText = null;
  previewInFlight = true;
  try {
    const html = await invoke("parse_markdown_to_html", { content: text });
    const preview = document.getElementById("preview");
    if (preview) preview.innerHTML = html;
  } catch (e) { console.error("Preview render failed:", e); }
  finally {
    previewInFlight = false;
    if (pendingText !== null) flushPreviewRender();
  }
}

// =============================================================
// 预览区折叠/展开
// =============================================================
function initPreviewToggle() {
  const btn = document.getElementById("preview-toggle");
  const container = document.getElementById("split-container");
  if (!btn || !container) return;

  btn.addEventListener("click", () => {
    container.classList.toggle("preview-collapsed");
    btn.textContent = container.classList.contains("preview-collapsed")
      ? "显示预览"
      : "隐藏预览";
  });
}

// =============================================================
// 滚动同步
// =============================================================
function setupScrollSync() {
  const editorPane = document.querySelector("#editor-pane .cm-scroller");
  const previewPane = document.getElementById("preview");
  if (!editorPane || !previewPane) return;
  let isEditorScrolling = false;
  let isPreviewScrolling = false;
  let syncTimer = null;
  function syncScroll(source, target) {
    const sMax = source.scrollHeight - source.clientHeight;
    const tMax = target.scrollHeight - target.clientHeight;
    if (sMax <= 0 || tMax <= 0) return;
    target.scrollTop = (source.scrollTop / sMax) * tMax;
  }
  editorPane.addEventListener("scroll", () => {
    if (isPreviewScrolling) return;
    isEditorScrolling = true;
    syncScroll(editorPane, previewPane);
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { isEditorScrolling = false; }, 50);
  });
  previewPane.addEventListener("scroll", () => {
    if (isEditorScrolling) return;
    isPreviewScrolling = true;
    syncScroll(previewPane, editorPane);
    clearTimeout(syncTimer);
    syncTimer = setTimeout(() => { isPreviewScrolling = false; }, 50);
  });
}

// =============================================================
// 侧边栏: 扁平时间流文件列表
//
// 核心设计:
//   - 不显示文件夹层级，所有 .md 文件平铺展示
//   - 按修改时间降序排列（最新的在前）
//   - 每项显示: 文件名 + 所属文件夹名 + 修改时间
//   - 实时扫描: 每次调用 load_sidebar_stream 重新 walkdir
//   - 保存后自动刷新
// =============================================================

function initSidebar() {
  // [+] 添加文件夹
  const addWsBtn = document.getElementById("sidebar-add-workspace");
  if (addWsBtn) {
    addWsBtn.addEventListener("click", async () => {
      if (!isTauri) return;
      try {
        const result = await invoke("add_workspace");
        switch (result.status) {
          case "added":
            updateStatusBar("saved", result.message);
            setTimeout(() => { if (saveStatus === "saved") updateStatusBar("idle"); }, 2500);
            await refreshSidebarList();
            break;
          case "already_exists":
            updateStatusBar("draft");
            document.getElementById("status-text").textContent = result.message;
            setTimeout(() => updateStatusBar("idle"), 2500);
            break;
          case "cancelled":
            break;
        }
      } catch (e) {
        updateStatusBar("error", `添加文件夹失败: ${e}`);
        setTimeout(() => updateStatusBar("idle"), 3000);
      }
    });
  }

  // [+] 新建笔记
  const newNoteBtn = document.getElementById("sidebar-new-note");
  if (newNoteBtn) {
    newNoteBtn.addEventListener("click", async () => {
      const name = window.prompt("新笔记文件名:", "untitled.md");
      if (name && name.trim()) {
        await createNewNote(name.trim());
      }
    });
  }

  // 初始加载
  refreshSidebarList();
}

/// 从 Rust 加载扁平文件流并渲染
async function refreshSidebarList() {
  if (!isTauri) return;
  const container = document.getElementById("sidebar-list");
  if (!container) return;

  container.innerHTML = '<div class="sidebar-empty">加载中...</div>';

  try {
    const files = await invoke("load_sidebar_stream");
    renderSidebarList(files, container);
  } catch (e) {
    console.error("Load sidebar stream failed:", e);
    container.innerHTML = `<div class="sidebar-empty">加载失败<br><small>${e}</small></div>`;
  }
}

/// 渲染分组文件列表到容器
function renderSidebarList(groups, container) {
  container.innerHTML = "";

  if (!groups || groups.length === 0) {
    container.innerHTML = `
      <div class="sidebar-empty">
        暂无笔记<br>
        <small>点击「+ 新建笔记」开始写作</small>
      </div>
    `;
    return;
  }

  for (const group of groups) {
    const section = createSidebarGroup(group);
    container.appendChild(section);
  }
}

/// 创建目录分组 DOM（可折叠）
function createSidebarGroup(group) {
  const section = document.createElement("div");
  section.className = "sidebar-group";

  // 分组头部（点击折叠/展开）
  const header = document.createElement("div");
  header.className = "sidebar-group-header";

  const arrow = document.createElement("span");
  arrow.className = "sidebar-group-arrow";
  arrow.textContent = "▾";
  header.appendChild(arrow);

  const nameEl = document.createElement("span");
  nameEl.className = "sidebar-group-name";
  nameEl.textContent = group.dir_name;
  header.appendChild(nameEl);

  const countEl = document.createElement("span");
  countEl.className = "sidebar-group-count";
  countEl.textContent = group.files.length;
  header.appendChild(countEl);

  header.addEventListener("click", () => {
    section.classList.toggle("collapsed");
  });

  section.appendChild(header);

  // 文件列表
  const fileList = document.createElement("div");
  fileList.className = "sidebar-group-files";

  for (const file of group.files) {
    const el = createSidebarItem(file);
    fileList.appendChild(el);
  }

  section.appendChild(fileList);
  return section;
}

/// 创建单个文件项 DOM
function createSidebarItem(file) {
  const item = document.createElement("div");
  item.className = "sidebar-item";
  item.dataset.path = file.path;
  item.title = file.path;

  // 文件名
  const nameEl = document.createElement("div");
  nameEl.className = "item-name";
  nameEl.textContent = file.name;
  item.appendChild(nameEl);

  // 所属子文件夹名
  const parentEl = document.createElement("div");
  parentEl.className = "item-parent";
  parentEl.textContent = file.parent_name;
  item.appendChild(parentEl);

  // 修改时间
  const mtimeEl = document.createElement("div");
  mtimeEl.className = "item-mtime";
  mtimeEl.textContent = file.mtime_str;
  item.appendChild(mtimeEl);

  // 高亮当前活跃文件
  if (file.path === activeFilePath) {
    item.classList.add("active");
  }

  // 点击切换文件
  item.addEventListener("click", async () => {
    await switchToFile(file.path);
  });

  return item;
}

/// 高亮当前活跃文件
function highlightSidebarActive() {
  document.querySelectorAll(".sidebar-item").forEach((el) => {
    el.classList.remove("active");
  });
  if (!activeFilePath) return;
  const items = document.querySelectorAll(".sidebar-item");
  for (const item of items) {
    if (item.dataset.path === activeFilePath) {
      item.classList.add("active");
      break;
    }
  }
}

/// 查询 Claude Code CLI 安装状态，更新预览区指示器
async function initClaudeStatus() {
  if (!isTauri) return;
  const dot = document.getElementById("claude-dot");
  const text = document.getElementById("claude-model-text");
  const container = document.getElementById("claude-status");
  if (!dot || !text || !container) return;

  try {
    const status = await invoke("check_claude_status");
    if (status.installed) {
      dot.classList.add("installed");
      const modelInfo = status.model || "unknown model";
      const versionInfo = status.version || "";
      container.title = versionInfo
        ? `Claude Code ${versionInfo} — ${modelInfo}`
        : `Claude Code — ${modelInfo}`;
      text.textContent = modelInfo;
    } else {
      dot.classList.remove("installed");
      container.title = "Claude Code 未安装";
      text.textContent = "未安装";
    }
  } catch (e) {
    dot.classList.remove("installed");
    container.title = "无法检测 Claude Code 状态";
    text.textContent = "检测失败";
    console.error("Check claude status failed:", e);
  }
}

/// 侧边栏折叠/展开
function initSidebarToggle() {
  const btn = document.getElementById("sidebar-toggle");
  const sidebar = document.getElementById("sidebar");
  if (!btn || !sidebar) return;

  btn.addEventListener("click", () => {
    sidebar.classList.toggle("sidebar-collapsed");
    btn.textContent = sidebar.classList.contains("sidebar-collapsed")
      ? "显示目录"
      : "隐藏目录";
  });
}
async function createNewNote(filename) {
  if (!isTauri) return;
  try {
    const newPath = await invoke("create_new_note", { filename });
    console.log("Created note:", newPath);
    // 刷新列表并切换到新文件
    await refreshSidebarList();
    await switchToFile(newPath);
  } catch (e) {
    alert("创建笔记失败: " + e);
  }
}

// =============================================================
// 挂载 EditorView
// =============================================================
const initialDoc =
  typeof window.__INITIAL_MD_CONTENT__ === "string" &&
  window.__INITIAL_MD_CONTENT__.length > 0
    ? window.__INITIAL_MD_CONTENT__
    : `# 欢迎使用 mdX

这是一个**左右分屏**的本地 Markdown 编辑器。

## 左侧编辑

- 纯文本输入，零干扰
- \`Cmd + S\` 保存当前文件
- \`Cmd + Shift + S\` 另存为
- 支持所有标准 Markdown 语法

## 右侧预览

实时渲染 Rust 解析后的 HTML，滚动自动同步。

~~删除线~~ 和 **粗体** 都可以正常渲染。

> 引用块也可以正常显示

\`\`\`rust
fn main() {
    println!("Hello from Rust!");
}
\`\`\`

开始写作吧。
`;

const startState = EditorState.create({
  doc: initialDoc,
  selection: { anchor: initialDoc.length, head: initialDoc.length },
  extensions: [...cmExtensions, dirtyTracker],
});

const view = new EditorView({
  state: startState,
  parent: document.getElementById("editor"),
});

view.focus();
window.editorView = view;

// 初始化
setupScrollSync();
initPreviewToggle();
initSidebarToggle();
initClaudeStatus();
triggerPreviewRender();

// 启动耗时
requestAnimationFrame(() => {
  const t1 = performance.now();
  const elapsed = window.__t0 ? Math.round(t1 - window.__t0) : null;
  const el = document.getElementById("boot-timing");
  if (el && elapsed != null) {
    el.textContent = `boot ${elapsed}ms`;
    el.style.opacity = "1";
    setTimeout(() => { el.style.opacity = "0"; }, 2500);
  }
});
