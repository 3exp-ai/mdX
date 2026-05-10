// =============================================================
// mdX 前端 —— 左右分屏双栏编辑器
// 架构原则: Fat Rust, Thin UI
//   - 左侧: CodeMirror 6 纯文本编辑区，只负责捕获输入
//   - 右侧: HTML 预览区，Rust 解析后的渲染结果直接注入
//   - Rust 负责: 所有文件 IO、状态管理、冲突检测、原子写入
//
// 核心机制: 防抖全量通信 + 滚动同步 + 双轨保存引擎
//   1. 监听 CM6 updateListener，用户打字停顿时触发 IPC
//   2. 提取编辑器全量文本，发给 Rust parse_markdown_to_html
//   3. Rust 用 pulldown-cmark 零拷贝解析，返回完整 HTML
//   4. 前端直接将 HTML 注入右侧 preview-pane (innerHTML)
//   5. 左侧滚动时，按比例同步右侧 scrollTop，保持视角对齐
//   6. 保存: 1000ms 防抖自动保存 + Cmd+S 手动保存 + Cmd+Shift+S 另存为
//   7. 退出: 拦截 CloseRequested，flush 保存后再关闭
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
let isSaving = false;        // 保存锁：防止并发 IPC 请求
let saveStatus = "idle";     // idle | saving | saved | conflict | draft | error
let isDirty = false;         // 文档是否被修改过
let isLoadingFile = false;   // 是否正在加载文件（避免触发脏状态）
let autoSaveTimer = null;
const AUTO_SAVE_DELAY = 1000;

// 从 Rust 同步的文档信息
let docInfo = {
  path: null,
  isDraft: true,
  lastSaved: null,
};

// =============================================================
// 状态栏更新
// =============================================================
function updateStatusBar(status, detail = null) {
  const bar = document.getElementById("status-bar");
  const text = document.getElementById("status-text");
  if (!bar || !text) return;

  saveStatus = status;
  bar.className = ""; // 清除旧状态类
  bar.classList.add(status);

  switch (status) {
    case "saving":
      text.textContent = "保存中...";
      break;
    case "saved":
      text.textContent = detail ? `已保存 ${detail}` : "已保存";
      // 2秒后淡出为灰色
      setTimeout(() => {
        if (saveStatus === "saved") {
          bar.classList.remove("saved");
          bar.classList.add("idle");
        }
      }, 2000);
      break;
    case "draft":
      text.textContent = "草稿模式 — Cmd+Shift+S 另存为";
      break;
    case "conflict":
      text.textContent = "⚠️ 外部修改冲突 — 请另存为或强制覆盖";
      break;
    case "error":
      text.textContent = detail ? `保存失败: ${detail}` : "保存失败";
      break;
    case "busy":
      text.textContent = "保存进行中...";
      break;
    default:
      text.textContent = docInfo.isDraft
        ? "草稿模式 — Cmd+Shift+S 另存为"
        : docInfo.lastSaved
        ? `已保存 ${docInfo.lastSaved}`
        : "";
  }
}

// =============================================================
// 同步 Rust 文档信息
// =============================================================
async function syncDocumentInfo() {
  if (!invoke) return;
  try {
    const info = await invoke("get_document_info");
    docInfo = {
      path: info.path || null,
      isDraft: info.is_draft,
      lastSaved: info.last_saved || null,
    };
    updateTitle();
    if (docInfo.isDraft) {
      updateStatusBar("draft");
    }
  } catch (e) {
    console.error("Sync doc info failed:", e);
  }
}

// =============================================================
// 标题更新
// =============================================================
let lastTitle = "";
function updateTitle(force = false) {
  if (!invoke) return;
  const name = docInfo.path
    ? docInfo.path.split(/[\\/]/).pop()
    : "未命名";
  const dirtyMark = isDirty ? " *" : "";
  const title = `${name}${dirtyMark} - mdX`;
  if (force || title !== lastTitle) {
    invoke("set_window_title", { title });
    lastTitle = title;
  }
}

// =============================================================
// 核心保存函数 —— 带锁的防弹保存
// =============================================================
async function performSave({ force = false, isAuto = false } = {}) {
  if (!invoke) return;

  // 保存锁：如果已有保存请求在处理中，拦截后续请求
  if (isSaving) {
    if (!isAuto) updateStatusBar("busy");
    return;
  }

  const view = window.editorView;
  if (!view) return;
  const content = view.state.doc.toString();

  // 草稿模式下自动保存不触发（避免频繁提示）
  if (docInfo.isDraft && isAuto && !force) {
    updateStatusBar("draft");
    return;
  }

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
        updateTitle();
        updateStatusBar("saved", result.timestamp);
        break;
      case "Conflict":
        updateStatusBar("conflict");
        // 冲突时保持 dirty 状态
        break;
      case "Draft":
        updateStatusBar("draft");
        break;
      case "Busy":
        updateStatusBar("busy");
        break;
      case "Error":
        updateStatusBar("error", result.message);
        break;
    }
  } catch (e) {
    console.error("Save failed:", e);
    updateStatusBar("error", e.toString());
  } finally {
    isSaving = false;
  }
}

// =============================================================
// 另存为
// =============================================================
async function performSaveAs() {
  if (!invoke) return;
  if (isSaving) {
    updateStatusBar("busy");
    return;
  }

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
        updateTitle();
        updateStatusBar("saved", result.timestamp);
        break;
      case "Error":
        updateStatusBar("error", result.message);
        break;
      case "Busy":
        updateStatusBar("busy");
        break;
    }
  } catch (e) {
    console.error("Save as failed:", e);
    updateStatusBar("error", e.toString());
  } finally {
    isSaving = false;
  }
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
// 加载文件
// =============================================================
async function loadFileFromPath(path) {
  if (!invoke || !path) return false;
  try {
    isLoadingFile = true;
    const content = await invoke("read_file", { path });
    const view = window.editorView;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      selection: { anchor: 0, head: 0 },
    });
    isDirty = false;
    updateTitle();
    isLoadingFile = false;
    // 同步 Rust 状态
    await syncDocumentInfo();
    // 加载后触发预览
    triggerPreviewRender();
    return true;
  } catch (e) {
    isLoadingFile = false;
    console.error("Failed to read file:", e);
    return false;
  }
}

// =============================================================
// 初始化：同步文档信息 + 加载 CLI 文件
// =============================================================
if (isTauri) {
  (async () => {
    await syncDocumentInfo();
    const path = await invoke("get_cli_file");
    if (path) {
      await loadFileFromPath(path);
    } else {
      updateTitle();
      if (docInfo.isDraft) updateStatusBar("draft");
    }
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
      if (e.shiftKey) {
        // Cmd+Shift+S → 另存为
        await performSaveAs();
      } else {
        // Cmd+S → 保存（强制覆盖冲突）
        await performSave({ force: true });
      }
    }
  });
}

// =============================================================
// 优雅退出监听 —— Rust 发来 req-flush-save 时执行最终保存
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
      // 即使失败也通知 Rust 关闭，避免窗口卡死
      await invoke("acknowledge_flush");
    }
  });
}

// =============================================================
// 核心: 防抖预览渲染 + 滚动同步
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
  } catch (e) {
    console.error("Preview render failed:", e);
  } finally {
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
    const sourceMax = source.scrollHeight - source.clientHeight;
    const targetMax = target.scrollHeight - target.clientHeight;
    if (sourceMax <= 0 || targetMax <= 0) return;
    target.scrollTop = (source.scrollTop / sourceMax) * targetMax;
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
// 脏状态追踪 + 预览触发 + 自动保存
// =============================================================
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
// 初始文档
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

// =============================================================
// 组装 EditorState
// =============================================================
const startState = EditorState.create({
  doc: initialDoc,
  selection: { anchor: initialDoc.length, head: initialDoc.length },
  extensions: [
    history(),
    keymap.of([...defaultKeymap, ...historyKeymap]),
    drawSelection(),
    EditorView.lineWrapping,
    dirtyTracker,
    EditorView.theme({
      ".cm-content": {
        padding: "60px 28px 30vh",
        fontFamily: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
        fontSize: "15px",
        lineHeight: "1.75",
        color: "var(--text)",
        caretColor: "var(--accent)",
      },
      ".cm-line": {
        padding: "0 2px",
      },
    }),
  ],
});

// =============================================================
// 挂载 EditorView
// =============================================================
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
