<script>
// Comments being written, by repository and issue, so they're still there after
// switching to another issue or view, until they're posted.
const drafts = new Map();
// Unsaved edits to a description or comment, by repository and issue, the same way.
const edits = new Map();
</script>

<script setup>
import { computed, onBeforeUnmount, ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  ChevronDown,
  CircleCheck,
  CircleDot,
  CircleSlash,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Pencil,
  Settings2,
} from "lucide-vue-next";
import { formatAgo, textColorOn } from "../lib/format.js";
import { githubAccount } from "../lib/github.js";
import { issueFilters } from "../lib/issues.js";
import { askConfirm, openForm, openMenu } from "../lib/overlays.js";
import IssueError from "./IssueError.vue";
import MarkdownEditor from "./MarkdownEditor.vue";
import PullMergeBox from "./PullMergeBox.vue";
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
// "show-commit" asks to show a commit that mentions it; "merged" is a pull request
// merged here, with PullMergeBox's details.
const emit = defineEmits(["updated", "show-commit", "merged"]);

const thread = shallowRef(null);
// The full issue once it's loaded, and the list's until then.
const shown = computed(() => thread.value?.issue ?? props.issue);
const error = ref("");
let loadSeq = 0;

// While a change is being saved, and what went wrong with the last one.
const busy = ref(false);
const actionError = ref("");
// The comment being written, kept in `drafts` as it's typed.
const draft = ref("");
const draftKey = () => `${props.repo.owner}/${props.repo.repo}#${props.issue.number}`.toLowerCase();
function setDraft(text) {
  draft.value = text;
  if (text) drafts.set(draftKey(), text);
  else drafts.delete(draftKey());
}
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
    // A refresh that fails, offline say, keeps showing the conversation.
    if (seq === loadSeq && !thread.value) error.value = String(e);
  }
}

// An edit with changes is kept for when its issue is shown again.
const changed = (edit) => !!edit && edit.text !== edit.was;
function keepEdit(key) {
  if (key && changed(editing.value)) edits.set(key, editing.value);
}

watch(
  draftKey,
  (key, previous) => {
    keepEdit(previous);
    thread.value = null;
    error.value = "";
    actionError.value = "";
    draft.value = drafts.get(key) ?? "";
    editing.value = edits.get(key) ?? null;
    edits.delete(key);
    load();
  },
  { immediate: true },
);
onBeforeUnmount(() => keepEdit(draftKey()));
watch(() => props.refreshKey, load);

// The commits on any branch whose messages mention the issue ("Fixes #42"). Looked
// for when the issue opens, not on every refresh: in a big repository it takes a while.
const MAX_MENTIONS = 50;
const mentions = shallowRef([]);
watch(
  [() => props.issue.number, () => props.path],
  async ([number, path]) => {
    const found = await invoke("commits_mentioning", { path, number, limit: MAX_MENTIONS }).catch(() => []);
    if (number === props.issue.number) mentions.value = found;
  },
  { immediate: true },
);

// After merging or marking ready, the pull request as it is now goes to the list.
async function reload() {
  await load();
  if (thread.value) emit("updated", thread.value.issue);
}

async function onMerged(details) {
  await reload();
  emit("merged", details);
}

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

// Whether the issue shown is still `key` (a draftKey()), once a change comes back:
// one finishing after switching to another issue mustn't land on that one.
const stillShowing = (key) => draftKey() === key;

// Saves a change to the issue with `command` and shows it as GitHub returns it.
async function save(command, args) {
  const key = draftKey();
  return change(async () => {
    const issue = await invoke(command, { ...where(), number: props.issue.number, ...args });
    if (!stillShowing(key)) return;
    thread.value = { ...thread.value, issue };
    emit("updated", issue);
  });
}

const update = (changes) => save("github_update_issue", { changes });

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

// Each pick adds or removes just that label or person, leaving whatever others
// changed on GitHub meanwhile.
const toggle = (field, name, add) => () => save("github_toggle_issue", { field, name, add });

function labelMenu(event) {
  const current = shown.value.labels.map((l) => l.name);
  openMenu(
    below(event),
    choices.value.labels.length
      ? choices.value.labels.map((l) => {
          const checked = current.includes(l.name);
          return { label: l.name, detail: l.description, checked, action: toggle("labels", l.name, !checked) };
        })
      : [{ label: "This repository has no labels", disabled: true, action() {} }],
  );
}

function assigneeMenu(event) {
  const current = shown.value.assignees.map((p) => p.login);
  const people = choices.value.assignees.map((p) => p.login);
  openMenu(
    below(event),
    people.length
      ? people.map((login) => {
          const checked = current.includes(login);
          return { label: login === me.value ? `${login} (me)` : login, checked, action: toggle("assignees", login, !checked) };
        })
      : [{ label: "Nobody can be assigned", disabled: true, action() {} }],
  );
}

// --- Commenting, closing and reopening ----------------------------------------------

async function comment() {
  const body = draft.value;
  if (!body.trim()) return true;
  const key = draftKey();
  return change(async () => {
    const added = await invoke("github_add_comment", { ...where(), number: props.issue.number, body });
    // Posted: its draft goes, whichever issue is showing now.
    if (drafts.get(key) === body) drafts.delete(key);
    if (!stillShowing(key)) return;
    const issue = { ...thread.value.issue, comments: thread.value.issue.comments + 1 };
    thread.value = { issue, comments: [...thread.value.comments, added] };
    if (draft.value === body) setDraft("");
    emit("updated", issue);
  });
}

// A comment being written goes in first, as on GitHub.
async function setState(state, reason) {
  if (!(await comment())) return;
  await update(reason ? { state, state_reason: reason } : { state });
}

function closeMenu(event) {
  openMenu(below(event), [
    { label: "Close as Completed", detail: "Done, fixed or answered", action: () => setState("closed", "completed") },
    { label: "Close as Not Planned", detail: "Won't fix, can't reproduce or stale", action: () => setState("closed", "not_planned") },
  ]);
}

// --- Editing the description and comments --------------------------------------------

// `was` is the text editing started from: saving checks it's still that on GitHub.
function startEditing(post) {
  editing.value = { id: post.id, text: post.body ?? "", was: post.body ?? "" };
}

// Escape or Cancel asks first when there are changes to throw away.
async function cancelEdit() {
  if (changed(editing.value)) {
    const ok = await askConfirm({
      title: "Discard Changes",
      message: "Discard your changes to this post?",
      confirmLabel: "Discard",
      danger: true,
    });
    if (!ok) return;
  }
  editing.value = null;
}

async function saveEdit() {
  const { id, text, was } = editing.value;
  const key = draftKey();
  const ok =
    id === "issue"
      ? await save("github_edit_issue_body", { body: text, was })
      : await change(async () => {
          const edited = await invoke("github_edit_comment", { ...where(), id, body: text, was });
          if (!stillShowing(key)) return;
          thread.value = { ...thread.value, comments: thread.value.comments.map((c) => (c.id === id ? edited : c)) };
        });
  if (ok && stillShowing(key) && editing.value?.id === id) editing.value = null;
  // Saved after switching away: the copy kept for coming back isn't needed.
  if (ok && edits.get(key)?.id === id) edits.delete(key);
}

async function deleteComment(post) {
  const ok = await askConfirm({
    title: "Delete Comment",
    message: "Delete this comment? It's removed from GitHub for everyone.",
    confirmLabel: "Delete",
    danger: true,
  });
  if (!ok) return;
  const key = draftKey();
  change(async () => {
    await invoke("github_delete_comment", { ...where(), id: post.id });
    if (!stillShowing(key)) return;
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

// "#123" can be a pull request's number, so it's shown as one: merged or not.
const isPull = computed(() => !!shown.value.pull_request);
const kind = computed(() => (isPull.value ? "pull request" : "issue"));

function state(issue) {
  if (issue.pull_request) {
    if (issue.pull_request.merged_at) return { icon: GitMerge, class: "closed", label: "Merged" };
    if (issue.state === "open" && issue.draft) return { icon: GitPullRequestDraft, class: "not-planned", label: "Draft" };
    if (issue.state === "open") return { icon: GitPullRequest, class: "open", label: "Open" };
    return { icon: GitPullRequestClosed, class: "not-planned", label: "Closed" };
  }
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
          <strong>{{ shown.user?.login ?? "ghost" }}</strong> opened this {{ kind }}
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
          <MarkdownEditor
            v-model="editing.text"
            :repo="repo"
            :rows="8"
            :disabled="busy"
            autofocus
            @submit="saveEdit"
            @cancel="cancelEdit"
          />
          <div class="editor-buttons">
            <button class="secondary-button" :disabled="busy" @click="cancelEdit">Cancel</button>
            <button class="primary-button" :disabled="busy" @click="saveEdit">Save</button>
          </div>
        </div>
        <!-- GitHub's rendering, which it sanitizes as it does on its own pages. -->
        <div v-else-if="post.body_html" class="markdown selectable" v-html="post.body_html" />
        <p v-else class="markdown dim"><em>No description provided.</em></p>
      </article>

      <PullMergeBox
        v-if="isPull && shown.state === 'open'"
        :repo="repo"
        :number="issue.number"
        :url="shown.html_url"
        :refresh-key="refreshKey"
        @merged="onMerged"
        @changed="reload"
      />

      <div class="composer">
        <MarkdownEditor
          :model-value="draft"
          @update:model-value="setDraft"
          :repo="repo"
          :rows="4"
          placeholder="Leave a comment"
          :disabled="busy"
          @submit="comment"
        />
        <p class="attach-hint dim">
          Images and files can be attached
          <a :href="shown.html_url">on GitHub</a>.
        </p>
        <IssueError v-if="actionError" :error="actionError" />
        <div class="composer-buttons">
          <Spinner v-if="busy" class="dim" />
          <!-- A merged pull request can't be closed or reopened, and a pull request is
               closed without a reason. -->
          <template v-if="canEdit && !shown.pull_request?.merged_at">
            <button
              v-if="shown.state === 'open' && isPull"
              class="secondary-button"
              :disabled="busy"
              @click="setState('closed', null)"
            >
              {{ draft.trim() ? "Close with Comment" : "Close Pull Request" }}
            </button>
            <button v-else-if="shown.state === 'open'" class="secondary-button with-menu" :disabled="busy" @click="closeMenu">
              {{ draft.trim() ? "Close with Comment" : "Close Issue" }} <ChevronDown :size="14" />
            </button>
            <button v-else class="secondary-button" :disabled="busy" @click="setState('open', isPull ? null : 'reopened')">
              {{ draft.trim() ? "Reopen with Comment" : `Reopen ${isPull ? "Pull Request" : "Issue"}` }}
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

.attach-hint {
  margin: -2px 0 0;
  font-size: 12px;
}

.attach-hint a {
  color: var(--text-tertiary);
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
</style>
