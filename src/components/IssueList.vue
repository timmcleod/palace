<script setup>
import { computed, nextTick, ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import {
  ChevronDown,
  CircleCheck,
  CircleDot,
  CircleSlash,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  MessageSquare,
  Plus,
} from "lucide-vue-next";
import { githubAccount, signInWithToken } from "../lib/github.js";
import { issueFilters } from "../lib/issues.js";
import { openMenu } from "../lib/overlays.js";
import { formatAgo, textColorOn } from "../lib/format.js";
import IssueError from "./IssueError.vue";
import NewIssueDialog from "./NewIssueDialog.vue";
import Spinner from "./Spinner.vue";

// A GitHub repository's issues, newest first, narrowed by state, label, assignee,
// author and the toolbar's search. More load at the bottom, a page at a time. With
// `pulls`, its pull requests instead, narrowed by reviewer rather than assignee.
const props = defineProps({
  // { owner, repo }
  repo: { type: Object, required: true },
  pulls: { type: Boolean, default: false },
  // Words, or GitHub search terms such as "author:octocat", from the toolbar.
  query: { type: String, default: "" },
  selected: { type: Number, default: null },
  refreshKey: { type: Number, default: 0 },
  // An issue changed in the issue view, to update its row.
  updated: { type: Object, default: null },
  // When the issues were last looked at before now (an ISO time): newer ones are
  // marked new.
  seenAt: { type: String, default: null },
});
// "created" is a new issue, already selected; "create" asks for a new pull request.
const emit = defineEmits(["select", "count", "created", "create"]);

// "open" or "closed", and for pull requests, "merged".
const state = ref("open");
const label = ref(null);
// A login, "@me" or "none". For pull requests, whose review was requested.
const assignee = ref(null);
const author = ref(null);

const STATE_TERMS = { open: "is:open", closed: "is:closed", merged: "is:merged" };
const noun = computed(() => (props.pulls ? "pull requests" : "issues"));

const issues = shallowRef(null);
const total = ref(0);
const page = ref(1);
const loading = ref(false);
const error = ref("");

// GitHub search terms for the filters and the search.
const filters = computed(() =>
  [
    // A pull request that's closed without being merged is "closed".
    props.pulls && state.value === "closed" ? "is:closed is:unmerged" : STATE_TERMS[state.value],
    label.value && `label:"${label.value}"`,
    props.pulls
      ? assignee.value && `review-requested:${assignee.value}`
      : assignee.value === "none"
        ? "no:assignee"
        : assignee.value && `assignee:${assignee.value}`,
    author.value && `author:${author.value}`,
    props.query.trim(),
  ]
    .filter(Boolean)
    .join(" "),
);

let loadSeq = 0;
// When the list was last loaded, so refreshes don't use up GitHub's 30 searches a
// minute.
let loadedAt = 0;
const REFRESH_AFTER = 30 * 1000;

// Loads the first page, or with `more`, the next one. A `quiet` refresh, as when the
// window regains focus, updates the list in place without a spinner, keeping any
// further pages already shown.
async function load({ more = false, quiet = false } = {}) {
  if (!githubAccount.value) return;
  if (quiet && Date.now() - loadedAt < REFRESH_AFTER) return;
  const seq = ++loadSeq;
  const next = more ? page.value + 1 : 1;
  loading.value = !quiet;
  try {
    const { owner, repo } = props.repo;
    const result = await invoke("github_issues", { owner, repo, filters: filters.value, page: next, pulls: props.pulls });
    if (seq !== loadSeq) return;
    if (more) {
      issues.value = [...issues.value, ...result.issues];
    } else if (quiet && issues.value) {
      const fresh = new Set(result.issues.map((i) => i.number));
      const rest = issues.value.slice(result.issues.length).filter((i) => !fresh.has(i.number));
      issues.value = [...result.issues, ...rest];
    } else {
      issues.value = result.issues;
    }
    total.value = result.total;
    loadedAt = Date.now();
    // A refresh leaves the later pages, and so the next one to load, as they were.
    if (!quiet) page.value = next;
    error.value = "";
    if (filters.value === "is:open") emit("count", result.total);
  } catch (e) {
    if (seq !== loadSeq) return;
    // A refresh that fails, offline say, keeps showing what was there.
    if (quiet && issues.value) return;
    error.value = String(e);
    if (!more) issues.value = null;
  } finally {
    if (seq === loadSeq) loading.value = false;
  }
}

// Typing in the search waits for a pause; other changes load at once.
let typing = null;
watch(
  () => props.query,
  () => {
    clearTimeout(typing);
    typing = setTimeout(load, 400);
  },
);
// Another repository starts afresh, with one search however many filters it clears.
let resetting = false;
watch([state, label, assignee, author], () => resetting || load());
watch(
  [() => props.repo.owner, () => props.repo.repo, () => githubAccount.value?.login],
  () => {
    issues.value = null;
    resetting = true;
    label.value = assignee.value = author.value = null;
    nextTick(() => (resetting = false));
    load();
  },
  { immediate: true },
);
watch(
  () => props.refreshKey,
  () => load({ quiet: true }),
);

watch(
  () => props.updated,
  (issue) => {
    if (issue && issues.value) issues.value = issues.value.map((i) => (i.number === issue.number ? issue : i));
  },
);

// The New Issue dialog, while it's open.
const creating = ref(false);

function onCreated(issue) {
  creating.value = false;
  if (!issue) return;
  // GitHub's search takes a moment to find it, so it's added here.
  if (state.value === "open") {
    issues.value = [issue, ...(issues.value ?? [])];
    total.value++;
  }
  emit("created", issue);
}

// Whether anything narrows the list beyond its state.
const filtered = computed(() => !!(label.value || assignee.value || author.value || props.query.trim()));

// GitHub's search goes no further than 1,000 results.
const canLoadMore = computed(() => issues.value && issues.value.length < Math.min(total.value, 1000));

// --- Filter menus -----------------------------------------------------------------

const choices = () => issueFilters(props.repo);

const below = (event) => {
  const rect = event.currentTarget.getBoundingClientRect();
  return { clientX: rect.left, clientY: rect.bottom + 4, preventDefault() {} };
};

async function labelMenu(event) {
  const at = below(event);
  const { labels } = await choices();
  openMenu(at, [
    { label: "Any Label", checked: !label.value, action: () => (label.value = null) },
    labels.length && { separator: true },
    ...labels.map((l) => ({ label: l.name, detail: l.description, checked: label.value === l.name, action: () => (label.value = l.name) })),
  ]);
}

async function personMenu(event, which, { none = false } = {}) {
  const at = below(event);
  const { assignees } = await choices();
  const current = which === "assignee" ? assignee : author;
  const pick = (value) => () => (current.value = value);
  openMenu(at, [
    { label: "Anyone", checked: !current.value, action: pick(null) },
    { label: "Me", checked: current.value === "@me", action: pick("@me") },
    none && { label: "Nobody", checked: current.value === "none", action: pick("none") },
    assignees.length && { separator: true },
    ...assignees
      .filter((p) => p.login !== githubAccount.value?.login)
      .map((p) => ({ label: p.login, checked: current.value === p.login, action: pick(p.login) })),
  ]);
}

const personLabel = (value, none) => (value === "@me" ? "Me" : value === "none" ? none : value);

// --- Rows -----------------------------------------------------------------------------

const isNew = (issue) => !!props.seenAt && Date.parse(issue.created_at) > Date.parse(props.seenAt);

function stateIcon(issue) {
  if (issue.pull_request) {
    if (issue.pull_request.merged_at) return { icon: GitMerge, class: "closed", title: "Merged" };
    if (issue.state !== "open") return { icon: GitPullRequestClosed, class: "not-planned", title: "Closed" };
    if (issue.draft) return { icon: GitPullRequestDraft, class: "not-planned", title: "Draft" };
    return { icon: GitPullRequest, class: "open", title: "Open" };
  }
  if (issue.state === "open") return { icon: CircleDot, class: "open", title: "Open" };
  if (issue.state_reason === "not_planned" || issue.state_reason === "duplicate") {
    return { icon: CircleSlash, class: "not-planned", title: "Closed as not planned" };
  }
  return { icon: CircleCheck, class: "closed", title: "Closed as completed" };
}

function onKeydown(event) {
  if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
  event.preventDefault();
  const list = issues.value ?? [];
  if (!list.length) return;
  const at = list.findIndex((i) => i.number === props.selected);
  const next = event.key === "ArrowDown" ? Math.min(at + 1, list.length - 1) : Math.max(at - 1, 0);
  emit("select", list[next]);
}

const signInError = ref("");
async function signIn() {
  signInError.value = (await signInWithToken()) ?? "";
}
</script>

<template>
  <div class="issue-list">
    <NewIssueDialog v-if="creating" :repo="repo" @close="onCreated" />
    <div v-if="githubAccount" class="filter-bar">
      <div class="segmented">
        <button :class="{ active: state === 'open' }" @click="state = 'open'">Open</button>
        <button v-if="pulls" :class="{ active: state === 'merged' }" @click="state = 'merged'">Merged</button>
        <button :class="{ active: state === 'closed' }" @click="state = 'closed'">Closed</button>
      </div>
      <button class="filter" :class="{ set: label }" @click="labelMenu">
        {{ label ?? "Label" }} <ChevronDown :size="13" />
      </button>
      <button v-if="pulls" class="filter" :class="{ set: assignee }" @click="personMenu($event, 'assignee')">
        {{ assignee ? `Review: ${personLabel(assignee)}` : "Reviewer" }} <ChevronDown :size="13" />
      </button>
      <button v-else class="filter" :class="{ set: assignee }" @click="personMenu($event, 'assignee', { none: true })">
        {{ assignee ? `Assigned: ${personLabel(assignee, "Nobody")}` : "Assignee" }} <ChevronDown :size="13" />
      </button>
      <button class="filter" :class="{ set: author }" @click="personMenu($event, 'author')">
        {{ author ? `By ${personLabel(author)}` : "Author" }} <ChevronDown :size="13" />
      </button>
      <span class="spacer" />
      <Spinner v-if="loading && issues" :size="14" class="dim" />
      <span v-else-if="issues" class="count">{{ total.toLocaleString() }}</span>
      <button v-if="pulls" class="icon-button small" title="New Pull Request…" @click="emit('create')"><Plus :size="16" /></button>
      <button v-else class="icon-button small" title="New Issue…" @click="creating = true"><Plus :size="16" /></button>
    </div>

    <div class="rows" tabindex="0" @keydown="onKeydown">
      <div v-if="!githubAccount" class="empty">
        <component :is="pulls ? GitPullRequest : CircleDot" :size="28" :stroke-width="1.25" />
        <p>Sign in to GitHub to see the {{ noun }} for {{ repo.owner }}/{{ repo.repo }}.</p>
        <button class="primary-button" @click="signIn">Sign In with Token…</button>
        <p v-if="signInError" class="error">{{ signInError }}</p>
      </div>
      <IssueError v-else-if="error && !issues" :error="error" class="message" />
      <p v-else-if="!issues" class="message dim"><Spinner /> Loading {{ noun }}…</p>

      <template v-else>
        <div
          v-for="issue in issues"
          :key="issue.number"
          class="issue"
          :class="{ selected: issue.number === selected }"
          @click="emit('select', issue)"
        >
          <component :is="stateIcon(issue).icon" :size="16" class="state" :class="stateIcon(issue).class" />
          <div class="body">
            <div class="title">
              <span v-if="isNew(issue)" class="new-dot" title="New since you last looked" />{{
                issue.title
              }}
            </div>
            <div v-if="issue.labels.length" class="labels">
              <span
                v-for="l in issue.labels"
                :key="l.name"
                class="label"
                :style="{ background: `#${l.color}`, color: textColorOn(l.color) }"
                :title="l.description"
                >{{ l.name }}</span
              >
            </div>
            <div class="meta">
              #{{ issue.number }}
              <template v-if="issue.state === 'open'">opened {{ formatAgo(issue.created_at) }}</template>
              <template v-else-if="issue.pull_request?.merged_at">merged {{ formatAgo(issue.pull_request.merged_at) }}</template>
              <template v-else>closed {{ formatAgo(issue.closed_at ?? issue.created_at) }}</template>
              by {{ issue.user?.login ?? "ghost" }}
            </div>
          </div>
          <div class="side">
            <span v-if="issue.comments" class="comments" :title="`${issue.comments} comments`">
              <MessageSquare :size="13" /> {{ issue.comments }}
            </span>
            <span v-if="issue.assignees.length" class="assignees">
              <img
                v-for="p in issue.assignees.slice(0, 3)"
                :key="p.login"
                :src="p.avatar_url"
                :title="`Assigned to ${p.login}`"
                alt=""
                class="avatar"
              />
            </span>
          </div>
        </div>

        <div v-if="!issues.length" class="empty">
          <component :is="pulls ? GitPullRequest : CircleDot" :size="28" :stroke-width="1.25" />
          <p>No {{ state }} {{ noun }}{{ filtered ? " match" : "" }}.</p>
        </div>
        <IssueError v-if="error" :error="error" class="message" />
        <div v-if="canLoadMore" class="more">
          <button class="secondary-button" :disabled="loading" @click="load({ more: true })">
            <Spinner v-if="loading" :size="13" /> Show More
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.issue-list {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.filter-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}

.segmented {
  display: flex;
  padding: 2px;
  border-radius: 7px;
  background: var(--toolbar-group-bg);
}

.segmented button {
  padding: 1px 10px;
  border: 0;
  border-radius: 5px;
  background: none;
  font: inherit;
  font-size: 13px;
  color: var(--text-primary);
}

.segmented button.active {
  background: var(--row-selected);
}

.filter {
  display: flex;
  align-items: center;
  gap: 3px;
  max-width: 160px;
  padding: 3px 7px;
  overflow: hidden;
  border: 0;
  border-radius: 6px;
  background: none;
  font: inherit;
  font-size: 13px;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--text-secondary);
}

.filter:hover {
  background: var(--button-hover);
}

.filter.set {
  background: color-mix(in srgb, var(--accent) 14%, transparent);
  color: var(--accent);
}

.spacer {
  flex: 1;
}

.count {
  font-size: 12.5px;
  color: var(--text-tertiary);
}

.rows {
  flex: 1;
  overflow-y: auto;
  padding: 6px 8px;
  outline: none;
}

.issue {
  display: flex;
  gap: 10px;
  padding: 9px 10px 10px;
  border-bottom: 1px solid var(--border);
}

.issue.selected {
  border-bottom-color: transparent;
  border-radius: 7px;
  background: var(--row-selected);
}

.state {
  flex-shrink: 0;
  margin-top: 2px;
}

.state.open {
  color: #1a7f37;
}

.state.closed {
  color: #8250df;
}

.state.not-planned {
  color: var(--text-tertiary);
}

:root[data-theme="dark"] .state.open {
  color: #3fb950;
}

:root[data-theme="dark"] .state.closed {
  color: #a371f7;
}

.body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}

.title {
  font-weight: 500;
  overflow-wrap: anywhere;
}

.new-dot {
  display: inline-block;
  width: 7px;
  height: 7px;
  margin: 0 6px 1px 0;
  border-radius: 50%;
  background: var(--accent);
}

.labels {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.label {
  padding: 0 7px;
  border-radius: 10px;
  font-size: 11.5px;
  font-weight: 500;
  line-height: 18px;
}

.meta {
  font-size: 12.5px;
  color: var(--text-tertiary);
}

.side {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 6px;
  flex-shrink: 0;
}

.comments {
  display: flex;
  align-items: center;
  gap: 3px;
  font-size: 12.5px;
  color: var(--text-tertiary);
}

.assignees {
  display: flex;
}

.avatar {
  width: 18px;
  height: 18px;
  margin-left: -4px;
  border: 1.5px solid var(--content-bg);
  border-radius: 50%;
}

.message {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 14px 10px;
}

.message.error,
.error {
  color: var(--danger);
}

.dim {
  color: var(--text-tertiary);
}

.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  max-width: 300px;
  margin: 60px auto 0;
  text-align: center;
  color: var(--text-tertiary);
}

.more {
  display: flex;
  justify-content: center;
  padding: 12px;
}

.more button {
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>
