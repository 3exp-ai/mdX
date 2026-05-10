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

// =============================================================
// Tauri 集成层
// =============================================================
const isTauri = typeof window !== "undefined" && !!window.__TAURI__;
let invoke = null;
let tauriEvent = null;

if (isTauri) {
  invoke = window.__TAURI__.core?.invoke;
  tauriEvent = window.__TAURI__.event;
}

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
  if (!invoke) return;
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
  if (!invoke) return;
  const name = docInfo.path ? docInfo.path.split(/[\\/]/).pop() : "未命名";
  const dirtyMark = isDirty ? " *" : "";
  const title = `${name}${dirtyMark} - mdX`;
  if (force || title !== lastTitle) { invoke("set_window_title", { title }); lastTitle = title; }
}

// =============================================================
// 核心保存函数
// =============================================================
async function performSave({ force = false, isAuto = false } = {}) {
  if (!invoke) return;
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
  if (!invoke) return;
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
        refreshSidebarTree();
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
if (isTauri && tauriEvent) {
  tauriEvent.listen("req-flush-save", async () => {
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
// 侧边栏: 懒加载文件树
// =============================================================

// 侧边栏根目录（默认从当前文件所在目录开始）
let sidebarRootPath = null;

function initSidebar() {
  const newBtn = document.getElementById("sidebar-new-btn");
  if (newBtn) {
    newBtn.addEventListener("click", () => {
      const parent = sidebarRootPath || "/tmp";
      const name = window.prompt("新文件名:", "untitled.md");
      if (name && name.trim()) createNewFile(parent, name.trim());
    });
  }
  // 确定根目录
  determineSidebarRoot();
}

async function determineSidebarRoot() {
  if (!invoke) return;
  // 优先从当前文件路径推断
  if (docInfo.path) {
    const parts = docInfo.path.split(/[\\/]/);
    parts.pop(); // 去掉文件名
    sidebarRootPath = parts.join("/");
  } else {
    // 草稿模式：用临时目录
    sidebarRootPath = "/tmp";
  }
  await renderSidebarTree(sidebarRootPath, document.getElementById("sidebar-tree"));
}

// 渲染指定路径下的直接子节点到容器
async function renderSidebarTree(dirPath, container, level = 0) {
  if (!invoke || !container) return;
  container.innerHTML = "";
  try {
    const nodes = await invoke("read_dir_tree", { targetPath: dirPath });
    for (const node of nodes) {
      const el = createSidebarNode(node, level);
      container.appendChild(el);
    }
  } catch (e) {
    console.error("Read dir failed:", e);
    container.innerHTML = `<div style="padding:10px 14px;color:var(--muted);font-size:12px;">无法读取目录</div>`;
  }
}

// 创建单个树节点 DOM
function createSidebarNode(node, level) {
  const wrapper = document.createElement("div");
  wrapper.className = "sidebar-node-wrapper";
  wrapper.dataset.path = node.path;
  wrapper.dataset.isDir = node.is_dir;

  const row = document.createElement("div");
  row.className = `sidebar-node ${node.is_dir ? "dir" : "file"}`;
  row.style.paddingLeft = `${14 + level * 12}px`;
  row.title = node.path;

  // 图标
  const icon = document.createElement("span");
  icon.className = "icon";
  row.appendChild(icon);

  // 名称
  const name = document.createElement("span");
  name.className = "name";
  name.textContent = node.name;
  row.appendChild(name);

  wrapper.appendChild(row);

  // 高亮当前活跃文件
  if (!node.is_dir && node.path === activeFilePath) {
    row.classList.add("active");
  }

  // 点击事件
  row.addEventListener("click", async (e) => {
    e.stopPropagation();
    if (node.is_dir) {
      // 文件夹：展开/折叠
      toggleSidebarDir(wrapper, node.path, level);
    } else {
      // 文件：安全切换
      await switchToFile(node.path);
    }
  });

  // 子节点容器（初始折叠）
  if (node.is_dir) {
    const childrenContainer = document.createElement("div");
    childrenContainer.className = "sidebar-children collapsed";
    wrapper.appendChild(childrenContainer);
  }

  return wrapper;
}

// 展开/折叠文件夹
async function toggleSidebarDir(wrapper, dirPath, level) {
  const row = wrapper.querySelector(".sidebar-node");
  const children = wrapper.querySelector(".sidebar-children");
  if (!children) return;

  const isExpanded = row.classList.contains("expanded");

  if (isExpanded) {
    // 折叠
    row.classList.remove("expanded");
    children.classList.add("collapsed");
  } else {
    // 展开：如果子节点为空，懒加载
    if (children.children.length === 0) {
      await renderSidebarTree(dirPath, children, level + 1);
    }
    row.classList.add("expanded");
    children.classList.remove("collapsed");
  }
}

// 高亮当前活跃文件
function highlightSidebarActive() {
  document.querySelectorAll(".sidebar-node").forEach((el) => {
    el.classList.remove("active");
  });
  if (!activeFilePath) return;
  const wrappers = document.querySelectorAll(".sidebar-node-wrapper");
  for (const w of wrappers) {
    if (w.dataset.path === activeFilePath && w.dataset.isDir === "false") {
      const row = w.querySelector(".sidebar-node");
      if (row) row.classList.add("active");
      break;
    }
  }
}

// 新建文件
async function createNewFile(parentPath, filename) {
  if (!invoke) return;
  try {
    const newPath = await invoke("create_new_file", {
      parentPath,
      filename,
    });
    console.log("Created:", newPath);
    // 刷新侧边栏
    refreshSidebarTree();
    // 自动切换到新文件
    await switchToFile(newPath);
  } catch (e) {
    alert("创建文件失败: " + e);
  }
}

// 刷新侧边栏（重新加载根目录）
async function refreshSidebarTree() {
  if (sidebarRootPath) {
    await renderSidebarTree(sidebarRootPath, document.getElementById("sidebar-tree"));
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
