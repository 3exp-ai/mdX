// =============================================================
// mdX 前端 —— 左右分屏双栏编辑器
// 架构原则: Fat Rust, Thin UI
//   - 左侧: CodeMirror 6 纯文本编辑区，只负责捕获输入
//   - 右侧: HTML 预览区，Rust 解析后的渲染结果直接注入
//   - Rust 负责: 所有 Markdown 解析、完整 HTML 树生成
//
// 核心机制: 防抖全量通信 + 滚动同步
//   1. 监听 CM6 updateListener，用户打字停顿时(200ms)触发 IPC
//   2. 提取编辑器全量文本，发给 Rust parse_markdown_to_html
//   3. Rust 用 pulldown-cmark 零拷贝解析，返回完整 HTML
//   4. 前端直接将 HTML 注入右侧 preview-pane (innerHTML)
//   5. 左侧滚动时，按比例同步右侧 scrollTop，保持视角对齐
// =============================================================

console.log("预注数据:", window.__INITIAL_MD_CONTENT__);

import {
  EditorView,
  keymap,
  drawSelection,
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

if (isTauri) {
  invoke = window.__TAURI__.core?.invoke;
}

let currentFilePath = null;
let isDirty = false;
let isLoadingFile = false;
let autoSaveTimer = null;
const AUTO_SAVE_DELAY = 800;

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
    currentFilePath = path;
    isDirty = false;
    updateTitle();
    isLoadingFile = false;
    // 加载文件后立即触发一次预览渲染
    triggerPreviewRender();
    return true;
  } catch (e) {
    isLoadingFile = false;
    console.error("Failed to read file:", e);
    return false;
  }
}

async function saveCurrentFile() {
  if (!invoke || !currentFilePath) return;
  try {
    const content = window.editorView.state.doc.toString();
    await invoke("write_file", { path: currentFilePath, content });
    isDirty = false;
    updateTitle();
    showSaveIndicator();
  } catch (e) {
    console.error("Failed to save file:", e);
  }
}

function scheduleAutoSave() {
  if (!invoke || !currentFilePath) return;
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    if (isDirty) saveCurrentFile();
  }, AUTO_SAVE_DELAY);
}

let lastTitle = "";
function updateTitle(force = false) {
  if (!invoke) return;
  const name = currentFilePath
    ? currentFilePath.split(/[\\/]/).pop()
    : "未命名";
  const dirtyMark = isDirty ? " *" : "";
  const title = `${name}${dirtyMark} - mdX`;
  if (force || title !== lastTitle) {
    invoke("set_window_title", { title });
    lastTitle = title;
  }
}

function showSaveIndicator() {
  const indicator = document.getElementById("save-indicator");
  if (!indicator) return;
  indicator.style.opacity = "1";
  setTimeout(() => { indicator.style.opacity = "0"; }, 1200);
}

if (isTauri) {
  (async () => {
    const path = await invoke("get_cli_file");
    if (path) await loadFileFromPath(path);
    else updateTitle();
  })();
}

if (isTauri) {
  document.addEventListener("keydown", async (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      await saveCurrentFile();
    }
  });
}

// =============================================================
// 核心: 防抖预览渲染 + 滚动同步
// =============================================================

// 防抖定时器 —— 200ms 内连续输入不触发 IPC，停顿后才发送
let previewDebounceTimer = null;
const PREVIEW_DEBOUNCE_MS = 200;

// 标记是否正在等待 IPC 返回，用于避免并发请求堆积
let previewInFlight = false;

// 待发送的文本缓存 —— 防抖期间如果又有新输入，覆盖旧值
let pendingText = null;

/**
 * 触发预览渲染 —— 入口函数。
 * 每次文档变化时调用，内部通过防抖机制控制 IPC 频率。
 */
function triggerPreviewRender() {
  const view = window.editorView;
  if (!view) return;

  // 缓存最新文本（防抖期间持续更新，只保留最后一次）
  pendingText = view.state.doc.toString();

  // 清除旧的定时器，重新计时
  if (previewDebounceTimer) {
    clearTimeout(previewDebounceTimer);
  }

  previewDebounceTimer = setTimeout(() => {
    previewDebounceTimer = null;
    flushPreviewRender();
  }, PREVIEW_DEBOUNCE_MS);
}

/**
 * 实际发送 IPC 请求 —— 防抖结束后执行。
 * 如果已有请求在飞行中，跳过本次（等返回后会检查 pendingText）。
 */
async function flushPreviewRender() {
  if (previewInFlight || pendingText === null) return;

  const text = pendingText;
  pendingText = null;

  previewInFlight = true;
  try {
    // 调用 Rust: 全量文本 -> 完整 HTML
    const html = await invoke("parse_markdown_to_html", { content: text });

    // 直接注入右侧预览区 —— 极简，无 Diff，无 Virtual DOM
    const preview = document.getElementById("preview");
    if (preview) {
      preview.innerHTML = html;
    }
  } catch (e) {
    console.error("Preview render failed:", e);
  } finally {
    previewInFlight = false;
    // 如果防抖期间又有新文本，继续处理
    if (pendingText !== null) {
      flushPreviewRender();
    }
  }
}

// =============================================================
// 滚动同步: 左侧编辑区滚动时，右侧预览区按比例跟随
// =============================================================

function setupScrollSync() {
  const editorPane = document.querySelector("#editor-pane .cm-scroller");
  const previewPane = document.getElementById("preview");
  if (!editorPane || !previewPane) return;

  let isEditorScrolling = false;
  let isPreviewScrolling = false;
  let syncTimer = null;

  /**
   * 计算滚动比例并同步到目标元素。
   * 比例 = scrollTop / (scrollHeight - clientHeight)
   * 这样无论两栏内容高度是否相同，都能保持相对位置对齐。
   */
  function syncScroll(source, target) {
    const sourceMax = source.scrollHeight - source.clientHeight;
    const targetMax = target.scrollHeight - target.clientHeight;
    if (sourceMax <= 0 || targetMax <= 0) return;

    const ratio = source.scrollTop / sourceMax;
    target.scrollTop = ratio * targetMax;
  }

  editorPane.addEventListener("scroll", () => {
    if (isPreviewScrolling) return;
    isEditorScrolling = true;
    syncScroll(editorPane, previewPane);
    // 清除标记，允许另一侧响应
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
// 脏状态追踪 + 预览触发
// =============================================================
const dirtyTracker = ViewPlugin.fromClass(
  class {
    update(update) {
      if (update.docChanged && !isLoadingFile) {
        isDirty = true;
        updateTitle();
        scheduleAutoSave();
        // 文档变化 -> 触发预览渲染（带防抖）
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
- \`Ctrl + S\` 保存当前文件
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

// 初始化: 设置滚动同步 + 首次预览渲染
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
