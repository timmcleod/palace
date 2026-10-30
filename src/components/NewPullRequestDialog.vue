<script setup>
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { issueError } from "../lib/issues.js";
import { commandKey } from "../lib/platform.js";
import { startingText } from "../lib/pullRequests.js";
import MarkdownEditor from "./MarkdownEditor.vue";
import Spinner from "./Spinner.vue";

// The Create Pull Request dialog: the branch to merge into, a title and a Markdown
// description, started from the branch's commits or the repository's template. A
// branch GitHub doesn't have yet, or doesn't have all of, is pushed first.
const props = defineProps({
  // The open repository's path.
  path: { type: String, required: true },
  // pullRequestPlan's plan for the branch.
  plan: { type: Object, required: true },
  // Pushes the branch, resolving to an error message or null.
  push: { type: Function, required: true },
});
// "close" gives the new pull request ({ number, title, html_url }), or nothing.
const emit = defineEmits(["close"]);

const target = computed(() => props.plan.target);
const loading = ref(true);
const branches = ref([]);
const base = ref("");
// The branch's open pull request, if it has one already.
const existing = ref(null);
// { commits, files } the pull request would bring into base, when that can be told
// locally.
const summary = ref(null);
const title = ref("");
const body = ref("");
const draft = ref(false);
const busy = ref("");
const error = ref("");
const pushed = ref(false);
const titleField = ref(null);
const editor = ref(null);

const needsPush = computed(() => props.plan.push && !pushed.value);
const ready = computed(() => !loading.value && !busy.value && base.value && title.value.trim() !== "");
const baseRef = (name) => props.plan.baseRemote && `${props.plan.baseRemote}/${name}`;

onMounted(async () => {
  const { owner, repo } = target.value;
  try {
    const [info, names, template] = await Promise.all([
      invoke("github_branch_pull", { owner, repo, head: props.plan.head }),
      invoke("github_branches", { owner, repo }).catch(() => []),
      invoke("pull_request_template", { path: props.path }),
    ]);
    existing.value = info.pull;
    base.value = info.default_branch;
    branches.value = [info.default_branch, ...names.filter((n) => n !== info.default_branch && n !== props.plan.name)];
    const messages = baseRef(base.value)
      ? await invoke("branch_commit_messages", { path: props.path, base: baseRef(base.value), head: props.plan.branch }).catch(() => [])
      : [];
    ({ title: title.value, body: body.value } = startingText(messages, template, props.plan.branch));
  } catch (e) {
    error.value = issueError(e).text;
  } finally {
    loading.value = false;
  }
  await nextTick();
  titleField.value?.focus();
  titleField.value?.select();
});

// What merging into the chosen branch would bring, from the local copy of it.
watch(base, async (name) => {
  summary.value = null;
  if (!name || !baseRef(name)) return;
  try {
    const comparison = await invoke("compare", { path: props.path, base: baseRef(name), head: props.plan.branch });
    if (name === base.value) summary.value = { commits: comparison.ahead, files: comparison.files.length };
  } catch {
    // The remote's copy of that branch hasn't been fetched.
  }
});

const summaryText = computed(() => {
  const s = summary.value;
  if (!s) return "";
  if (!s.commits) return `“${props.plan.branch}” has no commits that “${base.value}” doesn't have yet.`;
  const commits = s.commits === 1 ? "1 commit" : `${s.commits} commits`;
  const files = s.files === 1 ? "1 changed file" : `${s.files} changed files`;
  return `${commits} and ${files} into “${base.value}”.`;
});

async function create() {
  if (!ready.value) return;
  error.value = "";
  try {
    if (needsPush.value) {
      busy.value = "Pushing…";
      const failed = await props.push();
      if (failed) {
        error.value = failed;
        return;
      }
      pushed.value = true;
    }
    busy.value = "Creating…";
    const { owner, repo } = target.value;
    const pull = await invoke("github_create_pull", {
      owner,
      repo,
      base: base.value,
      head: props.plan.head,
      title: title.value,
      body: body.value,
      draft: draft.value,
    });
    emit("close", pull);
  } catch (e) {
    error.value = issueError(e).text;
  } finally {
    busy.value = "";
  }
}

// Enter in the title moves on to the description; Ctrl+Enter (Cmd+Enter on a Mac)
// creates the pull request from either.
function onTitleKeydown(event) {
  if (event.key !== "Enter") return;
  event.preventDefault();
  if (commandKey(event)) create();
  else editor.value?.focus();
}
</script>

<template>
  <div class="backdrop" @mousedown.self="emit('close')" @keydown.esc="emit('close')">
    <div class="dialog" role="dialog" aria-labelledby="new-pull-title">
      <h2 id="new-pull-title">Create Pull Request</h2>
      <p class="dim">On {{ target.owner }}/{{ target.repo }}</p>

      <div class="branches">
        <label>
          <span>Merge into</span>
          <select v-model="base" :disabled="loading || !!busy">
            <option v-for="name in branches" :key="name" :value="name">{{ name }}</option>
          </select>
        </label>
        <span class="arrow">←</span>
        <label>
          <span>From</span>
          <span class="head" :title="plan.head">{{ plan.branch }}</span>
        </label>
      </div>

      <p v-if="existing" class="notice">
        “{{ plan.branch }}” already has an open pull request:
        <button type="button" class="link-button" @click="openUrl(existing.html_url)">#{{ existing.number }} {{ existing.title }}</button>
      </p>
      <p v-else-if="summaryText" class="summary">{{ summaryText }}</p>

      <div v-if="loading" class="loading"><Spinner /></div>
      <template v-else>
        <input
          ref="titleField"
          v-model="title"
          class="title"
          placeholder="Title"
          spellcheck="true"
          :disabled="!!busy"
          @keydown="onTitleKeydown"
        />
        <MarkdownEditor
          ref="editor"
          v-model="body"
          :repo="target"
          :rows="10"
          placeholder="Describe the changes (optional)"
          :disabled="!!busy"
          @submit="create"
          @cancel="emit('close')"
        />
        <label class="checkbox">
          <input v-model="draft" type="checkbox" :disabled="!!busy" />
          Create as a draft
        </label>
      </template>
      <p v-if="error" class="error">{{ error }}</p>

      <div class="buttons">
        <button type="button" class="secondary-button" :disabled="!!busy" @click="emit('close')">Cancel</button>
        <button type="button" class="primary-button" :disabled="!ready" @click="create">
          {{ busy || (needsPush ? "Push and Create Pull Request" : "Create Pull Request") }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 20;
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 8vh;
  background: rgba(0, 0, 0, 0.25);
}

.dialog {
  display: flex;
  flex-direction: column;
  gap: 12px;
  width: min(680px, calc(100vw - 32px));
  max-height: 84vh;
  overflow-y: auto;
  padding: 22px 24px 20px;
  border-radius: 14px;
  background: var(--content-bg);
  box-shadow: 0 16px 48px rgba(0, 0, 0, 0.28);
}

h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.dim {
  margin: -8px 0 2px;
  font-size: 13px;
  color: var(--text-tertiary);
}

.branches {
  display: flex;
  align-items: flex-end;
  gap: 10px;
}

.branches label {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
  font-size: 12.5px;
  color: var(--text-secondary);
}

.branches select,
.head {
  height: 34px;
  padding: 0 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  background: var(--input-bg);
  font: inherit;
  font-size: 14px;
  color: var(--text-primary);
}

.branches select:focus {
  outline: none;
  border-color: var(--accent);
}

.head {
  display: flex;
  align-items: center;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  background: transparent;
}

.arrow {
  padding-bottom: 7px;
  color: var(--text-tertiary);
}

.summary,
.notice {
  margin: 0;
  font-size: 13px;
  color: var(--text-secondary);
}

.link-button {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--accent);
  text-align: left;
  cursor: pointer;
}

.link-button:hover {
  text-decoration: underline;
}

.loading {
  display: flex;
  justify-content: center;
  padding: 40px 0;
}

.title {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  outline: none;
  background: var(--input-bg);
  font: inherit;
  font-size: 15px;
  color: var(--text-primary);
}

.title:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
}

.checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.checkbox input {
  accent-color: var(--accent);
}

.error {
  margin: 0;
  color: var(--danger);
}

.buttons {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
}

.buttons button {
  min-width: 110px;
}
</style>
