<script setup>
import { computed, ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, CircleCheck, CircleDot, CircleSlash, GitCommitHorizontal, Pencil, Settings2 } from "lucide-vue-next";
import { formatAgo, textColorOn } from "../lib/format.js";
import { githubAccount } from "../lib/github.js";
import { issueFilters } from "../lib/issues.js";
import { askConfirm, openForm, openMenu } from "../lib/overlays.js";
import { commandKey } from "../lib/platform.js";
import IssueError from "./IssueError.vue";
import Spinner from "./Spinner.vue";

// One issue: its title, state, labels and assignees, then its description and
// comments, as the HTML GitHub renders from their Markdown, and a box for commenting,
// closing and reopening. What can be changed follows what GitHub allows the account:
// its own issues and comments, or anything for those who can triage.
const props = defineProps({
  // The open repository's path, for the commits that mention the issue.
  path: { type: String, required: true },
  // { owner, repo }
  repo: { type: Object, required: true },
  // The issue from the list, shown until the full one arrives.
  issue: { type: Object, required: true },
  refreshKey: { type: Number, default: 0 },
});
// "updated" is the issue after a change, for the list and the open count;
// "show-commit" asks to show a commit that mentions it.
const emit = defineEmits(["updated", "show-commit"]);

const thread = shallowRef(null);
// The full issue once it's loaded, and the list's until then.
const shown = computed(() => thread.value?.issue ?? props.issue);
const error = ref("");
let loadSeq = 0;

// While a change is being saved, and what went wrong with the last one.
const busy = ref(false);
const actionError = ref("");
// The comment being written.
const draft = ref("");
// { id, text }: the post being edited ("issue" for the description).
const editing = ref(null);

const where = () => ({ owner: props.repo.owner, repo: props.repo.repo });

async function load() {
  const seq = ++loadSeq;
  try {
    const result = await invoke("github_issue", { ...where(), number: props.issue.number });
    if (seq !== loadSeq) return;
    thread.value = result;
    error.value = "";
  } catch (e) {
    if (seq === loadSeq) error.value = String(e);
  }
}

watch(
  () => props.issue.number,
  () => {
    thread.value = null;
    error.value = "";
    actionError.value = "";
    draft.value = "";
    editing.value = null;
    load();
  },
  { immediate: true },
);
watch(() => props.refreshKey, load);

// The commits on any branch whose messages mention the issue ("Fixes #42").
const MAX_MENTIONS = 50;
const mentions = shallowRef([]);
watch(
  [() => props.issue.number, () => props.path, () => props.refreshKey],
  async ([number, path]) => {
    const found = await invoke("commits_mentioning", { path, number, limit: MAX_MENTIONS }).catch(() => []);
    if (number === props.issue.number) mentions.value = found;
  },
  { immediate: true },
);

// --- What the account may change ----------------------------------------------------

const choices = shallowRef({ labels: [], assignees: [], can_triage: false });
watch(
  [() => props.repo.owner, () => props.repo.repo, () => props.refreshKey],
  async () => (choices.value = await issueFilters(props.repo)),
  { immediate: true },
);

const me = computed(() => githubAccount.value?.login);
const isMine = (post) => !!me.value && post.user?.login === me.value;
const canTriage = computed(() => choices.value.can_triage);
// Authors can edit, close and reopen their own issues.
const canEdit = computed(() => canTriage.value || isMine(shown.value));

// --- Changes ------------------------------------------------------------------------

// Runs a change, showing what goes wrong beside the comment box.
async function change(work) {
  busy.value = true;
  actionError.value = "";
  try {
    await work();
    return true;
  } catch (e) {
    actionError.value = String(e);
    return false;
  } finally {
    busy.value = false;
  }
}

// Saves changes to the issue and shows it as GitHub returns it.
async function update(changes) {
  return change(async () => {
    const issue = await invoke("github_update_issue", { ...where(), number: props.issue.number, changes });
    thread.value = { ...thread.value, issue };
    emit("updated", issue);
  });
}

async function editTitle() {
  const values = await openForm({
    title: "Edit Title",
    fields: [{ key: "title", label: "Title", type: "text", value: shown.value.title }],
    confirmLabel: "Save",
  });
  if (values && values.title.trim() !== shown.value.title) update({ title: values.title.trim() });
}

const below = (event) => {
  const rect = event.currentTarget.getBoundingClientRect();
  return { clientX: rect.left, clientY: rect.bottom + 4, preventDefault() {} };
};

// Each pick adds or removes one label or person.
function labelMenu(event) {
  const current = shown.value.labels.map((l) => l.name);
  const toggle = (name) => () =>
    update({ labels: current.includes(name) ? current.filter((n) => n !== name) : [...current, name] });
  openMenu(
    below(event),
    choices.value.labels.length
      ? choices.value.labels.map((l) => ({ label: l.name, detail: l.description, checked: current.includes(l.name), action: toggle(l.name) }))
      : [{ label: "This repository has no labels", disabled: true, action() {} }],
  );
}

function assigneeMenu(event) {
  const current = shown.value.assignees.map((p) => p.login);
  const toggle = (login) => () =>
    update({ assignees: current.includes(login) ? current.filter((l) => l !== login) : [...current, login] });
  const people = choices.value.assignees.map((p) => p.login);
  openMenu(
    below(event),
    people.length
      ? people.map((login) => ({ label: login === me.value ? `${login} (me)` : login, checked: current.includes(login), action: toggle(login) }))
      : [{ label: "Nobody can be assigned", disabled: true, action() {} }],
  );
}

// --- Commenting, closing and reopening ----------------------------------------------

async function comment() {
  const body = draft.value;
  if (!body.trim()) return true;
  return change(async () => {
    const added = await invoke("github_add_comment", { ...where(), number: props.issue.number, body });
    const issue = { ...thread.value.issue, comments: thread.value.issue.comments + 1 };
    thread.value = { issue, comments: [...thread.value.comments, added] };
    draft.value = "";
    emit("updated", issue);
  });
}

// A comment being written goes in first, as on GitHub.
async function setState(state, reason) {
  if (!(await comment())) return;
  await update({ state, state_reason: reason });
}

function closeMenu(event) {
  openMenu(below(event), [
    { label: "Close as Completed", detail: "Done, fixed or answered", action: () => setState("closed", "completed") },
    { label: "Close as Not Planned", detail: "Won't fix, can't reproduce or stale", action: () => setState("closed", "not_planned") },
  ]);
}

function onDraftKeydown(event) {
  if (event.key === "Enter" && commandKey(event)) {
    event.preventDefault();
    comment();
  }
}

// --- Editing the description and comments --------------------------------------------

function startEditing(post) {
  editing.value = { id: post.id, text: post.body ?? "" };
}

async function saveEdit() {
  const { id, text } = editing.value;
  const ok =
    id === "issue"
      ? await update({ body: text })
      : await change(async () => {
          const edited = await invoke("github_edit_comment", { ...where(), id, body: text });
          thread.value = { ...thread.value, comments: thread.value.comments.map((c) => (c.id === id ? edited : c)) };
        });
  if (ok) editing.value = null;
}

// Ctrl+Enter (Cmd+Enter on a Mac) saves, and Escape cancels.
function onEditKeydown(event) {
  if (event.key === "Escape") {
    event.stopPropagation();
    editing.value = null;
  } else if (event.key === "Enter" && commandKey(event)) {
    event.preventDefault();
    saveEdit();
  }
}

async function deleteComment(post) {
  const ok = await askConfirm({
    title: "Delete Comment",
    message: "Delete this comment? It's removed from GitHub for everyone.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  change(async () => {
    await invoke("github_delete_comment", { ...where(), id: post.id });
    const issue = { ...thread.value.issue, comments: thread.value.issue.comments - 1 };
    thread.value = { issue, comments: thread.value.comments.filter((c) => c.id !== post.id) };
    emit("updated", issue);
  });
}

function postMenu(event, post) {
  openMenu(below(event), [
    { label: "Edit", action: () => startEditing(post) },
    post.id !== "issue" && { label: "Delete…", danger: true, action: () => deleteComment(post) },
  ]);
}

// --- Showing it ---------------------------------------------------------------------

const posts = computed(() =>
  thread.value ? [{ ...thread.value.issue, id: "issue", author_association: null }, ...thread.value.comments] : [],
);

const fullDate = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" });

function state(issue) {
  if (issue.state === "open") return { icon: CircleDot, class: "open", label: "Open" };
  if (issue.state_reason === "not_planned" || issue.state_reason === "duplicate") {
    return { icon: CircleSlash, class: "not-planned", label: "Closed as not planned" };
  }
  return { icon: CircleCheck, class: "closed", label: "Closed" };
}

// The repository's own role labels, as GitHub shows them beside a name.
const ROLES = { OWNER: "Owner", MEMBER: "Member", COLLABORATOR: "Collaborator", CONTRIBUTOR: "Contributor" };

// Links in issues open in the browser rather than in Palace's window.
function onClick(event) {
  const link = event.target.closest?.("a[href]");
  if (!link) return;
  event.preventDefault();
  if (/^https?:/.test(link.href)) openUrl(link.href);
}
</script>

<template>
  <div class="issue-details" @click="onClick">
    <header>
      <h2>
        {{ shown.title }} <span class="number">#{{ issue.number }}</span>
        <button v-if="canEdit" class="icon-button small edit-title" title="Edit Title…" @click="editTitle">
          <Pencil :size="14" />
        </button>
      </h2>
      <div class="summary">
        <span class="state" :class="state(shown).class">
          <component :is="state(shown).icon" :size="14" />
          {{ state(shown).label }}
        </span>
        <span class="dim">
          <strong>{{ shown.user?.login ?? "ghost" }}</strong> opened this issue
          <span :title="fullDate.format(new Date(shown.created_at))">{{ formatAgo(shown.created_at) }}</span>
          · {{ shown.comments }} {{ shown.comments === 1 ? "comment" : "comments" }}
        </span>
      </div>
      <div class="tags">
        <button v-if="canTriage" class="tag-button" title="Add or remove labels" @click="labelMenu">
          <Settings2 :size="13" /> Labels
        </button>
        <span
          v-for="l in shown.labels"
          :key="l.name"
          class="label"
          :style="{ background: `#${l.color}`, color: textColorOn(l.color) }"
          :title="l.description"
          >{{ l.name }}</span
        >
        <span v-if="!canTriage && !shown.labels.length" class="dim none">No labels</span>
      </div>
      <div class="tags">
        <button v-if="canTriage" class="tag-button" title="Assign or unassign people" @click="assigneeMenu">
          <Settings2 :size="13" /> Assignees
        </button>
        <span v-for="p in shown.assignees" :key="p.login" class="person">
          <img :src="p.avatar_url" alt="" class="avatar small" />{{ p.login }}
        </span>
        <span v-if="!shown.assignees.length" class="dim none">No one assigned</span>
      </div>
    </header>

    <section v-if="mentions.length" class="mentions">
      <h3>
        Mentioned in {{ mentions.length === MAX_MENTIONS ? "the newest" : "" }} {{ mentions.length }}
        {{ mentions.length === 1 ? "commit" : "commits" }}
      </h3>
      <button
        v-for="c in mentions"
        :key="c.id"
        class="mention"
        :title="`Show ${c.short_id} in the history`"
        @click="emit('show-commit', c)"
      >
        <GitCommitHorizontal :size="15" class="dim" />
        <span class="mono dim">{{ c.short_id }}</span>
        <span class="mention-summary">{{ c.summary }}</span>
        <span class="dim mention-when">{{ c.author_name }}, {{ formatAgo(new Date(c.time * 1000).toISOString()) }}</span>
      </button>
    </section>

    <IssueError v-if="error" :error="error" />
    <p v-else-if="!thread" class="message dim"><Spinner /> Loading the conversation…</p>

    <template v-else>
      <article v-for="post in posts" :key="post.id" class="post">
        <div class="post-header">
          <img v-if="post.user" :src="post.user.avatar_url" alt="" class="avatar" />
          <strong>{{ post.user?.login ?? "ghost" }}</strong>
          <a :href="post.html_url" class="dim when" :title="fullDate.format(new Date(post.created_at))">
            {{ post.id === "issue" ? "opened" : "commented" }} {{ formatAgo(post.created_at) }}
          </a>
          <span class="spacer" />
          <span v-if="ROLES[post.author_association]" class="role">{{ ROLES[post.author_association] }}</span>
          <button
            v-if="post.id === 'issue' ? canEdit : isMine(post)"
            class="icon-button small"
            :title="post.id === 'issue' ? 'Edit the description' : 'Edit or delete this comment'"
            :disabled="busy || !!editing"
            @click="post.id === 'issue' ? startEditing(post) : postMenu($event, post)"
          >
            <Pencil :size="13" />
          </button>
        </div>
        <div v-if="editing?.id === post.id" class="editor">
          <textarea v-model="editing.text" rows="8" spellcheck="true" @keydown="onEditKeydown" />
          <div class="editor-buttons">
            <button class="secondary-button" :disabled="busy" @click="editing = null">Cancel</button>
            <button class="primary-button" :disabled="busy" @click="saveEdit">Save</button>
          </div>
        </div>
        <!-- GitHub's rendering, which it sanitizes as it does on its own pages. -->
        <div v-else-if="post.body_html" class="markdown selectable" v-html="post.body_html" />
        <p v-else class="markdown dim"><em>No description provided.</em></p>
      </article>

      <div class="composer">
        <textarea
          v-model="draft"
          rows="4"
          placeholder="Leave a comment. Markdown works here."
          spellcheck="true"
          :disabled="busy"
          @keydown="onDraftKeydown"
        />
        <IssueError v-if="actionError" :error="actionError" />
        <div class="composer-buttons">
          <Spinner v-if="busy" class="dim" />
          <template v-if="canEdit">
            <button v-if="shown.state === 'open'" class="secondary-button with-menu" :disabled="busy" @click="closeMenu">
              {{ draft.trim() ? "Close with Comment" : "Close Issue" }} <ChevronDown :size="14" />
            </button>
            <button v-else class="secondary-button" :disabled="busy" @click="setState('open', 'reopened')">
              {{ draft.trim() ? "Reopen with Comment" : "Reopen Issue" }}
            </button>
          </template>
          <button class="primary-button" :disabled="busy || !draft.trim()" @click="comment">Comment</button>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.issue-details {
  flex: 1;
  overflow-y: auto;
  padding: 18px 20px 28px;
}

header {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: 16px;
  margin-bottom: 16px;
  border-bottom: 1px solid var(--border);
}

h2 {
  margin: 0;
  font-size: 20px;
  font-weight: 600;
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.number {
  font-weight: 400;
  color: var(--text-tertiary);
}

.summary {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 13px;
}

.summary strong {
  font-weight: 600;
  color: var(--text-secondary);
}

.state {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 3px 10px;
  border-radius: 14px;
  font-weight: 500;
  color: #fff;
}

.state.open {
  background: #1f883d;
}

.state.closed {
  background: #8250df;
}

.state.not-planned {
  background: #6e7781;
}

.tags {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
}

.label {
  padding: 0 8px;
  border-radius: 10px;
  font-size: 12px;
  font-weight: 500;
  line-height: 20px;
}

.person {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 13px;
  color: var(--text-secondary);
}

.none {
  font-size: 13px;
}

.edit-title {
  display: inline-flex;
  vertical-align: 3px;
}

/* Opens the menu for changing an issue's labels or assignees. */
.tag-button {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 96px;
  padding: 2px 6px;
  border: 0;
  border-radius: 6px;
  background: none;
  font: inherit;
  font-size: 12.5px;
  color: var(--text-tertiary);
}

.tag-button:hover {
  background: var(--button-hover);
  color: var(--text-primary);
}

.spacer {
  flex: 1;
}

.mentions {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 18px;
}

.mentions h3 {
  margin: 0 0 6px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text-tertiary);
}

.mention {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border: 0;
  border-radius: 6px;
  background: none;
  font: inherit;
  font-size: 13px;
  text-align: left;
  color: var(--text-primary);
}

.mention:hover {
  background: var(--row-hover);
}

.mention .mono {
  font-family: ui-monospace, "Ubuntu Mono", "DejaVu Sans Mono", monospace;
  font-size: 12px;
}

.mention-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mention-when {
  flex-shrink: 0;
  font-size: 12px;
}

.editor,
.composer {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.editor {
  padding: 10px 12px;
}

.editor textarea,
.composer textarea {
  width: 100%;
  padding: 8px 10px;
  resize: vertical;
  border: 1px solid var(--border);
  border-radius: 7px;
  outline: none;
  background: var(--input-bg);
  font: inherit;
  font-family: ui-monospace, "Ubuntu Mono", "DejaVu Sans Mono", monospace;
  font-size: 13px;
  line-height: 1.5;
  color: var(--text-primary);
}

.editor textarea:focus,
.composer textarea:focus {
  border-color: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 25%, transparent);
}

.editor-buttons,
.composer-buttons {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.editor-buttons button,
.composer-buttons button {
  padding: 5px 14px;
  font-size: 13px;
}

.with-menu {
  display: flex;
  align-items: center;
  gap: 4px;
}

.composer {
  margin-top: 4px;
}

.dim {
  color: var(--text-tertiary);
}

.message {
  display: flex;
  align-items: center;
  gap: 6px;
}

.message.error {
  color: var(--danger);
}

.post {
  margin-bottom: 16px;
  border: 1px solid var(--border);
  border-radius: 8px;
}

.post-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  border-radius: 8px 8px 0 0;
  background: var(--diff-gutter-bg);
  font-size: 13px;
}

.when {
  color: var(--text-tertiary);
  text-decoration: none;
}

.when:hover {
  text-decoration: underline;
}

.role {
  padding: 0 7px;
  border: 1px solid var(--border);
  border-radius: 10px;
  font-size: 11.5px;
  color: var(--text-tertiary);
}

.avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
}

.avatar.small {
  width: 18px;
  height: 18px;
}

/* GitHub's rendered Markdown. */
.markdown {
  margin: 0;
  padding: 12px 16px;
  line-height: 1.55;
  overflow-wrap: anywhere;
}

.markdown :deep(> :first-child) {
  margin-top: 0;
}

.markdown :deep(> :last-child) {
  margin-bottom: 0;
}

.markdown :deep(p),
.markdown :deep(ul),
.markdown :deep(ol),
.markdown :deep(blockquote),
.markdown :deep(pre),
.markdown :deep(table),
.markdown :deep(details) {
  margin: 0 0 12px;
}

.markdown :deep(h1),
.markdown :deep(h2),
.markdown :deep(h3),
.markdown :deep(h4) {
  margin: 18px 0 10px;
  font-weight: 600;
  line-height: 1.25;
}

.markdown :deep(h1) {
  font-size: 1.5em;
}

.markdown :deep(h2) {
  font-size: 1.3em;
}

.markdown :deep(h3) {
  font-size: 1.12em;
}

.markdown :deep(a) {
  color: var(--accent);
  text-decoration: none;
}

.markdown :deep(a:hover) {
  text-decoration: underline;
}

.markdown :deep(ul),
.markdown :deep(ol) {
  padding-left: 2em;
}

.markdown :deep(li + li) {
  margin-top: 3px;
}

.markdown :deep(.task-list-item) {
  list-style: none;
}

.markdown :deep(.task-list-item-checkbox) {
  margin: 0 6px 0 -1.4em;
  vertical-align: middle;
}

.markdown :deep(code) {
  padding: 1px 5px;
  border-radius: 5px;
  background: var(--pill-bg);
  font-family: ui-monospace, "Ubuntu Mono", "DejaVu Sans Mono", monospace;
  font-size: 0.88em;
}

.markdown :deep(pre) {
  padding: 10px 12px;
  overflow-x: auto;
  border-radius: 6px;
  background: var(--diff-gutter-bg);
  border: 1px solid var(--border);
  line-height: 1.45;
}

.markdown :deep(pre code) {
  padding: 0;
  background: none;
  font-size: 12.5px;
}

.markdown :deep(.highlight) {
  margin: 0 0 12px;
}

.markdown :deep(blockquote) {
  padding: 0 12px;
  border-left: 3px solid var(--border);
  color: var(--text-secondary);
}

.markdown :deep(img),
.markdown :deep(video) {
  max-width: 100%;
  height: auto;
  border-radius: 4px;
}

.markdown :deep(table) {
  border-collapse: collapse;
  display: block;
  overflow-x: auto;
}

.markdown :deep(th),
.markdown :deep(td) {
  padding: 5px 10px;
  border: 1px solid var(--border);
}

.markdown :deep(th) {
  font-weight: 600;
  background: var(--diff-gutter-bg);
}

.markdown :deep(hr) {
  height: 1px;
  margin: 16px 0;
  border: 0;
  background: var(--border);
}

.markdown :deep(summary) {
  cursor: pointer;
}

.markdown :deep(.user-mention),
.markdown :deep(.team-mention) {
  font-weight: 600;
  color: var(--text-primary);
}

/* Code GitHub has highlighted, in Palace's syntax colors (see styles.css). */
.markdown :deep(.pl-c) {
  color: var(--syntax-comment);
  font-style: italic;
}

.markdown :deep(.pl-k) {
  color: var(--syntax-keyword);
}

.markdown :deep(.pl-s),
.markdown :deep(.pl-pds),
.markdown :deep(.pl-sr) {
  color: var(--syntax-string);
}

.markdown :deep(.pl-c1),
.markdown :deep(.pl-e) {
  color: var(--syntax-number);
}

.markdown :deep(.pl-en) {
  color: var(--syntax-title);
}

.markdown :deep(.pl-v),
.markdown :deep(.pl-smi) {
  color: var(--syntax-type);
}

.markdown :deep(.pl-ent) {
  color: var(--syntax-tag);
}
</style>
