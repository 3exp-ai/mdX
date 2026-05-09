// =============================================================
// Markdown 编辑器 —— 基于 CodeMirror 6 的混合渲染实现
// Tauri 桌面版:支持双击打开文件、Ctrl+S 保存
// =============================================================

import {
  EditorView,
  ViewPlugin,
  Decoration,
  keymap,
  drawSelection,
} from "./vendor/@codemirror/view.js";
import { EditorState } from "./vendor/@codemirror/state.js";
import { syntaxTree } from "./vendor/@codemirror/language.js";
import {
  defaultKeymap,
  history,
  historyKeymap,
} from "./vendor/@codemirror/commands.js";
import { markdownSlim, markdownLanguage } from "./markdown-slim.js";

// =============================================================
// Tauri 集成层
// =============================================================
const isTauri = typeof window !== "undefined" && !!window.__TAURI__;
let invoke = null;

if (isTauri) {
  invoke = window.__TAURI__.core?.invoke;
}

// 当前打开的文件路径
let currentFilePath = null;
// 文件是否被修改过
let isDirty = false;
// 正在从磁盘加载文件时置为 true,避免误判为 dirty
let isLoadingFile = false;
// 自动保存防抖定时器
let autoSaveTimer = null;
const AUTO_SAVE_DELAY = 800; // ms

async function loadFileFromPath(path) {
  if (!invoke || !path) return false;
  try {
    isLoadingFile = true;
    const content = await invoke("read_file", { path });
    const view = window.editorView;
    view.dispatch({
      changes: {
        from: 0,
        to: view.state.doc.length,
        insert: content,
      },
      selection: { anchor: 0, head: 0 },
    });
    currentFilePath = path;
    isDirty = false;
    updateTitle();
    isLoadingFile = false;
    return true;
  } catch (e) {
    isLoadingFile = false;
    console.error("Failed to read file:", e);
    return false;
  }
}

async function saveCurrentFile() {
  if (!invoke) return;
  if (!currentFilePath) return;
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
  const title = `${name}${dirtyMark} - mdedit`;
  if (force || title !== lastTitle) {
    invoke("set_window_title", { title });
    lastTitle = title;
  }
}

function showSaveIndicator() {
  const indicator = document.getElementById("save-indicator");
  if (!indicator) return;
  indicator.style.opacity = "1";
  setTimeout(() => {
    indicator.style.opacity = "0";
  }, 1200);
}

// 启动时尝试读取命令行传入的文件
if (isTauri) {
  (async () => {
    const path = await invoke("get_cli_file");
    if (path) {
      await loadFileFromPath(path);
    } else {
      updateTitle();
    }
  })();
}

// 键盘快捷键
if (isTauri) {
  document.addEventListener("keydown", async (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === "s") {
      e.preventDefault();
      await saveCurrentFile();
    }
  });
}

// -------------------------------------------------------------
// 白名单:需要被隐藏 / 弱化的 Markdown 语法符号节点名。
// -------------------------------------------------------------
const HIDABLE_MARKS = new Set(["HeaderMark", "EmphasisMark", "CodeMark"]);

// =============================================================
// 核心插件:动态装饰器 (Hybrid Rendering Plugin)
// =============================================================
const hybridRenderingPlugin = ViewPlugin.fromClass(
  class {
    constructor(view) {
      this.decorations = this.buildDecorations(view);
    }

    update(update) {
      // 增量映射旧 decorations，避免纯文本输入后位置漂移
      this.decorations = this.decorations.map(update.changes);

      // 优化1: 同行内光标移动不重建
      if (
        update.selectionSet &&
        !update.docChanged &&
        !update.viewportChanged
      ) {
        const oldLine = update.startState.doc.lineAt(
          update.startState.selection.main.head
        ).number;
        const newLine = update.state.doc.lineAt(
          update.state.selection.main.head
        ).number;
        if (oldLine === newLine) return;
      }

      // 优化2: 普通文本输入(不跨行、不含 Markdown 标记字符)不重建
      if (
        update.docChanged &&
        !update.selectionSet &&
        !update.viewportChanged
      ) {
        if (update.state.doc.lines === update.startState.doc.lines) {
          let hasMarker = false;
          update.changes.iterChanges((fromA, toA, fromB, toB, inserted) => {
            if (hasMarker) return;
            if (/[#`*_\[\]>\-|!]/.test(inserted.toString())) {
              hasMarker = true;
            }
          });
          if (!hasMarker) return;
        }
      }

      if (update.docChanged || update.selectionSet || update.viewportChanged) {
        this.decorations = this.buildDecorations(update.view);
      }
    }

    buildDecorations(view) {
      const decorations = [];
      const state = view.state;
      const doc = state.doc;

      const activeLines = new Set();
      for (const range of state.selection.ranges) {
        const fromLine = doc.lineAt(range.from).number;
        const toLine = doc.lineAt(range.to).number;
        for (let n = fromLine; n <= toLine; n++) {
          activeLines.add(n);
        }
      }

      for (const { from, to } of view.visibleRanges) {
        syntaxTree(state).iterate({
          from,
          to,
          enter: (node) => {
            const lineNumber = doc.lineAt(node.from).number;
            const cursorOnLine = activeLines.has(lineNumber);

            if (node.name.startsWith("ATXHeading")) {
              const level = node.name.charAt(10);
              const line = doc.lineAt(node.from);
              decorations.push(
                Decoration.line({
                  attributes: {
                    class: `cm-heading cm-heading-${level}`,
                  },
                }).range(line.from)
              );
            }

            if (node.name === "Emphasis") {
              decorations.push(
                Decoration.mark({ class: "cm-em" }).range(
                  node.from,
                  node.to
                )
              );
            } else if (node.name === "StrongEmphasis") {
              decorations.push(
                Decoration.mark({ class: "cm-strong" }).range(
                  node.from,
                  node.to
                )
              );
            } else if (node.name === "InlineCode") {
              decorations.push(
                Decoration.mark({ class: "cm-inline-code" }).range(
                  node.from,
                  node.to
                )
              );
            }

            if (HIDABLE_MARKS.has(node.name)) {
              let from = node.from;
              let to = node.to;
              if (
                node.name === "HeaderMark" &&
                doc.sliceString(to, to + 1) === " "
              ) {
                to += 1;
              }
              if (cursorOnLine) {
                decorations.push(
                  Decoration.mark({ class: "cm-syntax-mark" }).range(
                    from,
                    to
                  )
                );
              } else {
                decorations.push(
                  Decoration.replace({}).range(from, to)
                );
              }
            }
          },
        });
      }

      return Decoration.set(decorations, true);
    }
  },
  {
    decorations: (v) => v.decorations,
  }
);

// =============================================================
// 脏状态追踪:监听文档修改
// =============================================================
const dirtyTracker = ViewPlugin.fromClass(
  class {
    update(update) {
      if (update.docChanged && !isLoadingFile) {
        isDirty = true;
        updateTitle();
        scheduleAutoSave();
      }
    }
  }
);

// =============================================================
// 初始文档:空文档或欢迎语
// =============================================================
const initialDoc = `# 欢迎使用 mdedit

这是一个**沉浸式**的本地 Markdown 编辑器。

## 快捷键

- \`Ctrl + S\` 保存当前文件
- 双击任意 \`.md\` 文件即可用本编辑器打开

### 混合渲染

把光标移动到这一行,你会看到 \`#\` 符号自动出现。
当光标离开后,符号又会悄悄隐藏。

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
    markdownSlim(),
    hybridRenderingPlugin,
    dirtyTracker,
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

// 暴露到全局
window.editorView = view;

// 启动耗时:从 HTML 头里的 window.__t0 起算到编辑器可交互。
// 在屏幕左下角显示几秒后淡出,方便观察启动性能回归。
requestAnimationFrame(() => {
  const t1 = performance.now();
  const elapsed = window.__t0 ? Math.round(t1 - window.__t0) : null;
  const el = document.getElementById("boot-timing");
  if (el && elapsed != null) {
    el.textContent = `boot ${elapsed}ms`;
    el.style.opacity = "1";
    setTimeout(() => {
      el.style.opacity = "0";
    }, 2500);
  }
});
