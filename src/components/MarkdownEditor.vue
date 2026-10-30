<script setup>
import { nextTick, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { Bold, Code, Heading, Italic, Link, List, ListChecks, ListOrdered, TextQuote } from "lucide-vue-next";
import { code, continueList, indentList, link, pasteLink, prefixLines, wrap } from "../lib/markdownEditing.js";
import { useIssueSuggestions } from "../lib/issueSuggestions.js";
import { issueError } from "../lib/issues.js";
import { commandKey, shortcut } from "../lib/platform.js";
import IssueSuggestions from "./IssueSuggestions.vue";
import Spinner from "./Spinner.vue";

// A box for writing GitHub Markdown, as on GitHub: Write and Preview tabs, with the
// preview rendered by GitHub itself, a formatting toolbar and its shortcuts, lists
// that continue on Enter, and suggestions for "#" issues and "@" people.
const props = defineProps({
  modelValue: { type: String, required: true },
  // { owner, repo }: whose issues and people to suggest, and how "#123" previews.
  repo: { type: Object, default: null },
  placeholder: { type: String, default: "" },
  rows: { type: Number, default: 5 },
  disabled: { type: Boolean, default: false },
  autofocus: { type: Boolean, default: false },
});
// "submit" is Ctrl+Enter (Cmd+Enter on a Mac); "cancel" is Escape.
const emit = defineEmits(["update:modelValue", "submit", "cancel"]);

const field = ref(null);
const tab = ref("write");

defineExpose({ focus: () => field.value?.focus() });

watch(
  field,
  (el) => {
    if (el && props.autofocus) nextTick(() => el.focus());
  },
  { immediate: true },
);

// --- Formatting ---------------------------------------------------------------------

// Puts a formatting change into the field as an edit of only the part that changed,
// so Ctrl+Z undoes it like typing.
function apply(change) {
  const el = field.value;
  const result = change({ value: el.value, start: el.selectionStart, end: el.selectionEnd });
  if (!result) return false;
  const before = el.value;
  let from = 0;
  while (from < before.length && from < result.value.length && before[from] === result.value[from]) from++;
  let back = 0;
  while (
    back < before.length - from &&
    back < result.value.length - from &&
    before[before.length - 1 - back] === result.value[result.value.length - 1 - back]
  ) {
    back++;
  }
  el.focus();
  el.setSelectionRange(from, before.length - back);
  const inserted = result.value.slice(from, result.value.length - back);
  // execCommand keeps the browser's undo; setting the value is the fallback.
  if (!document.execCommand("insertText", false, inserted) || el.value !== result.value) {
    el.value = result.value;
  }
  emit("update:modelValue", el.value);
  el.setSelectionRange(result.start, result.end);
  return true;
}

const TOOLS = [
  { title: "Heading", icon: Heading, run: (s) => prefixLines(s, "heading") },
  { title: "Bold", key: "B", icon: Bold, run: (s) => wrap(s, "**") },
  { title: "Italic", key: "I", icon: Italic, run: (s) => wrap(s, "_") },
  { title: "Quote", icon: TextQuote, run: (s) => prefixLines(s, "quote") },
  { title: "Code", icon: Code, run: code },
  { title: "Link", key: "K", icon: Link, run: link },
  { separator: true },
  { title: "Bulleted list", icon: List, run: (s) => prefixLines(s, "bullet") },
  { title: "Numbered list", icon: ListOrdered, run: (s) => prefixLines(s, "numbered") },
  { title: "Task list", icon: ListChecks, run: (s) => prefixLines(s, "task") },
];
const toolTitle = (tool) => (tool.key ? `${tool.title} (${shortcut(`Ctrl+${tool.key}`)})` : tool.title);

// --- Keys and pasting -----------------------------------------------------------------

const suggestions = useIssueSuggestions(() => props.repo, { people: true });

function onKeydown(event) {
  if (suggestions.onKeydown(event)) return;
  const key = event.key;
  if (commandKey(event) && !event.altKey) {
    const tool = TOOLS.find((t) => t.key && t.key.toLowerCase() === key.toLowerCase());
    if (tool && !event.shiftKey) {
      event.preventDefault();
      apply(tool.run);
    } else if (key === "Enter") {
      event.preventDefault();
      emit("submit");
    }
    return;
  }
  if (key === "Escape") {
    event.stopPropagation();
    emit("cancel");
  } else if (key === "Enter" && !event.shiftKey && !event.altKey && apply(continueList)) {
    event.preventDefault();
  } else if (key === "Tab" && apply((s) => indentList(s, event.shiftKey))) {
    // Only in lists: elsewhere, Tab moves on to the next control as usual.
    event.preventDefault();
  }
}

function onPaste(event) {
  const pasted = event.clipboardData?.getData("text/plain") ?? "";
  if (apply((s) => pasteLink(s, pasted))) event.preventDefault();
}

function onInput(event) {
  emit("update:modelValue", event.target.value);
  suggestions.onInput(event, (value) => {
    event.target.value = value;
    emit("update:modelValue", value);
  });
}

// --- Preview ------------------------------------------------------------------------

const preview = ref("");
const previewing = ref(false);
const previewError = ref("");

async function showPreview() {
  tab.value = "preview";
  suggestions.close();
  previewError.value = "";
  preview.value = "";
  if (!props.modelValue.trim() || !props.repo) return;
  previewing.value = true;
  try {
    preview.value = await invoke("github_render_markdown", { owner: props.repo.owner, repo: props.repo.repo, text: props.modelValue });
  } catch (e) {
    previewError.value = issueError(e).text;
  } finally {
    previewing.value = false;
  }
}

function showWrite() {
  tab.value = "write";
  nextTick(() => field.value?.focus());
}

// Links in the preview open in the browser rather than in Palace's window.
function onPreviewClick(event) {
  const anchor = event.target.closest?.("a[href]");
  if (!anchor) return;
  event.preventDefault();
  if (/^https?:/.test(anchor.href)) openUrl(anchor.href);
}
</script>

<template>
  <div class="markdown-editor" :class="{ disabled }">
    <div class="bar">
      <div class="tabs">
        <button type="button" :class="{ active: tab === 'write' }" @click="showWrite">Write</button>
        <button type="button" :class="{ active: tab === 'preview' }" @click="showPreview">Preview</button>
      </div>
      <div v-if="tab === 'write'" class="tools">
        <template v-for="(tool, i) in TOOLS" :key="i">
          <span v-if="tool.separator" class="separator" />
          <!-- mousedown, so the field keeps its selection. -->
          <button
            v-else
            type="button"
            class="tool"
            :title="toolTitle(tool)"
            :disabled="disabled"
            @mousedown.prevent="apply(tool.run)"
          >
            <component :is="tool.icon" :size="15" :stroke-width="1.75" />
          </button>
        </template>
      </div>
    </div>

    <textarea
      v-show="tab === 'write'"
      ref="field"
      :value="modelValue"
      :rows="rows"
      :placeholder="placeholder"
      :disabled="disabled"
      spellcheck="true"
      @input="onInput"
      @keydown="onKeydown"
      @paste="onPaste"
      @blur="suggestions.close()"
    />
    <div v-if="tab === 'preview'" class="preview" :style="{ minHeight: `${rows * 1.5 + 1.2}em` }" @click="onPreviewClick">
      <p v-if="previewing" class="dim note"><Spinner /> Rendering…</p>
      <p v-else-if="previewError" class="error note">{{ previewError }}</p>
      <p v-else-if="!modelValue.trim()" class="dim note">Nothing to preview.</p>
      <!-- GitHub's rendering, which it sanitizes as it does on its own pages. -->
      <div v-else class="markdown selectable" v-html="preview" />
    </div>
    <IssueSuggestions :suggestions="suggestions" />
  </div>
</template>

<style scoped>
.markdown-editor {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--input-bg);
}

.markdown-editor:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
}

.disabled {
  opacity: 0.7;
}

.bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 6px;
  padding: 5px 6px;
  border-bottom: 1px solid var(--border);
  border-radius: 8px 8px 0 0;
  background: var(--diff-gutter-bg);
}

.tabs {
  display: flex;
  gap: 2px;
}

.tabs button {
  padding: 3px 10px;
  border: 0;
  border-radius: 6px;
  background: none;
  font: inherit;
  font-size: 13px;
  color: var(--text-secondary);
}

.tabs button.active {
  background: var(--content-bg);
  box-shadow: 0 0 0 1px var(--border);
  color: var(--text-primary);
}

.tools {
  display: flex;
  align-items: center;
  gap: 1px;
}

.tool {
  display: flex;
  padding: 4px 5px;
  border: 0;
  border-radius: 5px;
  background: none;
  color: var(--icon);
}

.tool:hover:not(:disabled) {
  background: var(--button-hover);
  color: var(--text-primary);
}

.separator {
  width: 1px;
  height: 16px;
  margin: 0 4px;
  background: var(--border);
}

textarea {
  width: 100%;
  padding: 8px 10px;
  resize: vertical;
  border: 0;
  border-radius: 0 0 8px 8px;
  outline: none;
  background: none;
  font-family: ui-monospace, "Ubuntu Mono", "DejaVu Sans Mono", monospace;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-primary);
}

.preview {
  padding: 10px 14px;
  overflow-wrap: anywhere;
}

.preview .markdown {
  padding: 0;
}

.note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 13px;
}

.dim {
  color: var(--text-tertiary);
}

.error {
  color: var(--danger);
}
</style>
