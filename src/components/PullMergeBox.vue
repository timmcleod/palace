<script setup>
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, CircleAlert, CircleCheck, CircleDashed, CircleX, GitMerge, GitPullRequestDraft } from "lucide-vue-next";
import { openMenu } from "../lib/overlays.js";
import { readJson, writeJson } from "../lib/storage.js";
import IssueError from "./IssueError.vue";
import Spinner from "./Spinner.vue";

// Merging an open pull request on GitHub: how its checks stand, whether GitHub will
// merge it and why not, and the merge itself, as a merge commit, a squash or a
// rebase, with the commit message GitHub would write ready to edit.
const props = defineProps({
  // { owner, repo }
  repo: { type: Object, required: true },
  // The pull request's number and its page on GitHub.
  number: { type: Number, required: true },
  url: { type: String, required: true },
  refreshKey: { type: Number, default: 0 },
});
// "merged" gives { base, head, headRepo, branchDeleted }; "changed" says the pull
// request changed otherwise (a draft made ready).
const emit = defineEmits(["merged", "changed"]);

const METHODS = {
  merge: { label: "Create a Merge Commit", button: "Merge Pull Request", detail: "All the commits are added to the base branch with a merge commit." },
  squash: { label: "Squash and Merge", button: "Squash and Merge", detail: "The commits are combined into one commit on the base branch." },
  rebase: { label: "Rebase and Merge", button: "Rebase and Merge", detail: "The commits are added to the base branch one by one, without a merge commit." },
};
// The way chosen last, offered first next time.
const METHOD_KEY = "palace.mergeMethod";
const DELETE_KEY = "palace.deleteMergedBranch";

const state = shallowRef(null);
const error = ref("");
const loading = ref(false);
const method = ref(readJson(METHOD_KEY, "merge"));
// The commit title and message being confirmed, while confirming.
const confirming = ref(false);
const title = ref("");
const message = ref("");
const deleteBranch = ref(readJson(DELETE_KEY, true));
const busy = ref("");
const actionError = ref("");
const titleField = ref(null);

const where = () => ({ owner: props.repo.owner, repo: props.repo.repo });

let loadSeq = 0;
async function load() {
  const seq = ++loadSeq;
  loading.value = true;
  try {
    const result = await invoke("github_merge_state", { ...where(), number: props.number });
    if (seq !== loadSeq) return;
    state.value = result;
    error.value = "";
    if (!result.methods.includes(method.value)) method.value = result.methods[0] ?? "merge";
  } catch (e) {
    if (seq === loadSeq && !state.value) error.value = String(e);
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

watch(
  () => props.number,
  () => {
    state.value = null;
    confirming.value = false;
    actionError.value = "";
    load();
  },
  { immediate: true },
);
// Not while confirming: the message being edited stays as it is.
watch(
  () => props.refreshKey,
  () => confirming.value || busy.value || load(),
);

const checks = computed(() => {
  const c = state.value?.checks;
  if (!c) return null;
  const total = c.passed + c.failed + c.pending;
  if (!total) return null;
  if (c.failed) return { icon: CircleX, class: "bad", text: `${c.failed} of ${total} ${total === 1 ? "check" : "checks"} failed` };
  if (c.pending) return { icon: CircleDashed, class: "waiting", text: `${c.pending} of ${total} ${total === 1 ? "check" : "checks"} still running` };
  return { icon: CircleCheck, class: "good", text: total === 1 ? "The check passed" : `All ${total} checks passed` };
});

// What GitHub says about merging, in words, and whether the button can be used.
const verdict = computed(() => {
  const s = state.value;
  if (!s) return null;
  const base = `“${s.base}”`;
  if (s.draft || s.mergeable_state === "draft") {
    return { icon: GitPullRequestDraft, class: "waiting", text: "This pull request is still a draft. Mark it ready for review before merging.", draft: true };
  }
  switch (s.mergeable_state) {
    case "clean":
    case "has_hooks":
      return { icon: CircleCheck, class: "good", text: `No conflicts with ${base}. It can be merged.`, ok: true };
    case "unstable":
      return { icon: CircleAlert, class: "waiting", text: `No conflicts with ${base}, though some checks haven't passed. They aren't required.`, ok: true };
    case "dirty":
      return { icon: CircleX, class: "bad", text: `This branch has conflicts with ${base}. Merge ${base} into it, resolve them and push, then merge here.` };
    case "behind":
      return { icon: CircleAlert, class: "bad", text: `This branch has to be brought up to date with ${base} before it can be merged.` };
    case "blocked":
      return { icon: CircleX, class: "bad", text: `Merging is blocked until the reviews or checks ${base} requires have passed.` };
    default:
      return { icon: CircleDashed, class: "waiting", text: "GitHub is still working out whether it can be merged.", unknown: true };
  }
});

const canMerge = computed(() => !!state.value?.can_merge && !!verdict.value?.ok && state.value.methods.length > 0);
// GitHub deletes it itself in repositories set up to, and only those who can push to
// the head's repository can delete it there.
const offersDelete = computed(() => !!state.value && !state.value.deletes_branch && !!state.value.head_repo);

function methodMenu(event) {
  const rect = event.currentTarget.getBoundingClientRect();
  openMenu(
    { clientX: rect.left, clientY: rect.bottom + 4, preventDefault() {} },
    state.value.methods.map((m) => ({
      label: METHODS[m].label,
      detail: METHODS[m].detail,
      checked: method.value === m,
      action: () => {
        method.value = m;
        writeJson(METHOD_KEY, m);
      },
    })),
  );
}

async function startMerge() {
  const s = state.value;
  title.value = method.value === "squash" ? s.squash_title : s.merge_title;
  message.value = method.value === "squash" ? s.squash_message : s.merge_message;
  actionError.value = "";
  confirming.value = true;
  await nextTick();
  titleField.value?.focus();
}

async function merge() {
  const s = state.value;
  busy.value = "Merging…";
  actionError.value = "";
  writeJson(DELETE_KEY, deleteBranch.value);
  try {
    const rebase = method.value === "rebase";
    await invoke("github_merge_pull", {
      ...where(),
      number: props.number,
      method: method.value,
      title: rebase ? null : title.value,
      message: rebase ? null : message.value,
      sha: s.head_sha,
    });
    let branchDeleted = s.deletes_branch;
    if (offersDelete.value && deleteBranch.value) {
      busy.value = "Deleting the branch…";
      const [owner, repo] = s.head_repo.split("/");
      branchDeleted = await invoke("github_delete_branch", { owner, repo, branch: s.head })
        .then(() => true)
        .catch(() => false);
    }
    confirming.value = false;
    emit("merged", { base: s.base, head: s.head, headRepo: s.head_repo, branchDeleted });
  } catch (e) {
    actionError.value = String(e);
    // The head may have moved, or GitHub changed its mind: show where it stands now.
    load();
  } finally {
    busy.value = "";
  }
}

async function markReady() {
  busy.value = "Marking ready…";
  actionError.value = "";
  try {
    await invoke("github_ready_for_review", { nodeId: state.value.node_id });
    await load();
    emit("changed");
  } catch (e) {
    actionError.value = String(e);
  } finally {
    busy.value = "";
  }
}
</script>

<template>
  <section class="merge-box">
    <p v-if="error" class="line bad"><CircleX :size="16" /> {{ error }}</p>
    <p v-else-if="!state" class="line dim"><Spinner :size="14" /> Checking whether it can be merged…</p>
    <template v-else>
      <div v-if="checks" class="line">
        <component :is="checks.icon" :size="16" :class="checks.class" />
        <span>{{ checks.text }}</span>
        <button class="link-button" @click="openUrl(`${url}/checks`)">Details</button>
      </div>
      <div class="line">
        <component :is="verdict.icon" :size="16" :class="verdict.class" />
        <span>{{ verdict.text }}</span>
        <button v-if="verdict.unknown" class="link-button" :disabled="loading" @click="load">Check Again</button>
      </div>
      <p v-if="!state.can_merge" class="line dim">Only people who can push to {{ repo.owner }}/{{ repo.repo }} can merge it.</p>

      <div v-if="confirming" class="confirm">
        <template v-if="method !== 'rebase'">
          <input ref="titleField" v-model="title" class="field" placeholder="Commit title" :disabled="!!busy" @keydown.esc="confirming = false" />
          <textarea v-model="message" class="field" rows="5" placeholder="Commit message (optional)" spellcheck="true" :disabled="!!busy" />
        </template>
        <p v-else class="dim">The commits will be added to “{{ state.base }}” one by one.</p>
        <label v-if="offersDelete" class="checkbox">
          <input v-model="deleteBranch" type="checkbox" :disabled="!!busy" />
          Delete “{{ state.head }}” on GitHub afterwards
        </label>
        <IssueError v-if="actionError" :error="actionError" />
        <div class="buttons">
          <Spinner v-if="busy" :size="14" class="dim" />
          <button class="secondary-button" :disabled="!!busy" @click="confirming = false">Cancel</button>
          <button class="primary-button" :disabled="!!busy || (method !== 'rebase' && !title.trim())" @click="merge">
            {{ busy || `Confirm ${METHODS[method].label}` }}
          </button>
        </div>
      </div>
      <template v-else>
        <IssueError v-if="actionError" :error="actionError" />
        <div class="buttons">
          <Spinner v-if="busy" :size="14" class="dim" />
          <button v-if="verdict.draft" class="secondary-button" :disabled="!!busy" @click="markReady">
            {{ busy || "Ready for Review" }}
          </button>
          <div v-if="state.can_merge && state.methods.length" class="split">
            <button class="primary-button" :disabled="!canMerge || !!busy" @click="startMerge">
              <GitMerge :size="15" /> {{ METHODS[method].button }}
            </button>
            <button
              v-if="state.methods.length > 1"
              class="primary-button menu-part"
              :disabled="!!busy"
              title="Choose how to merge"
              @click="methodMenu"
            >
              <ChevronDown :size="15" />
            </button>
          </div>
        </div>
      </template>
    </template>
  </section>
</template>

<style scoped>
.merge-box {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 4px 0 18px;
  padding: 14px 16px;
  border: 1px solid var(--border);
  border-radius: 10px;
}

.line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0;
  font-size: 13.5px;
}

.line > svg {
  flex-shrink: 0;
}

.good {
  color: #1a7f37;
}

.bad {
  color: var(--danger);
}

.waiting {
  color: #9a6700;
}

:root[data-theme="dark"] .good {
  color: #3fb950;
}

:root[data-theme="dark"] .waiting {
  color: #d29922;
}

.link-button {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--accent);
  cursor: pointer;
}

.link-button:hover {
  text-decoration: underline;
}

.confirm {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.confirm p {
  margin: 0;
  font-size: 13px;
}

.field {
  width: 100%;
  padding: 7px 10px;
  border: 1px solid var(--border);
  border-radius: 7px;
  outline: none;
  background: var(--input-bg);
  font: inherit;
  font-size: 13.5px;
  color: var(--text-primary);
  resize: vertical;
}

textarea.field {
  font-family: ui-monospace, "Ubuntu Mono", "DejaVu Sans Mono", monospace;
  font-size: 12.5px;
}

.field:focus {
  border-color: var(--accent);
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

.buttons {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.split {
  display: flex;
}

.split .primary-button {
  display: flex;
  align-items: center;
  gap: 6px;
}

.split .primary-button:first-child:not(:only-child) {
  border-top-right-radius: 0;
  border-bottom-right-radius: 0;
}

.menu-part {
  padding: 0 8px;
  margin-left: 1px;
  border-top-left-radius: 0;
  border-bottom-left-radius: 0;
}
</style>
