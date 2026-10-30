<script setup>
import { computed, ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CircleAlert, CircleCheck, CircleDot, CircleSlash } from "lucide-vue-next";
import { formatAgo, textColorOn } from "../lib/format.js";
import Spinner from "./Spinner.vue";

// One issue: its title, state and labels, then its description and comments, as the
// HTML GitHub renders from their Markdown.
const props = defineProps({
  // { owner, repo }
  repo: { type: Object, required: true },
  // The issue from the list, shown until the full one arrives.
  issue: { type: Object, required: true },
  refreshKey: { type: Number, default: 0 },
});

const thread = shallowRef(null);
// The full issue once it's loaded, and the list's until then.
const shown = computed(() => thread.value?.issue ?? props.issue);
const error = ref("");
let loadSeq = 0;

async function load() {
  const seq = ++loadSeq;
  try {
    const result = await invoke("github_issue", { owner: props.repo.owner, repo: props.repo.repo, number: props.issue.number });
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
    load();
  },
  { immediate: true },
);
watch(() => props.refreshKey, load);

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
      <div v-if="shown.labels.length || shown.assignees.length" class="tags">
        <span
          v-for="l in shown.labels"
          :key="l.name"
          class="label"
          :style="{ background: `#${l.color}`, color: textColorOn(l.color) }"
          :title="l.description"
          >{{ l.name }}</span
        >
        <span v-if="shown.assignees.length" class="assigned dim">
          Assigned to
          <span v-for="p in shown.assignees" :key="p.login" class="person">
            <img :src="p.avatar_url" alt="" class="avatar small" />{{ p.login }}
          </span>
        </span>
      </div>
    </header>

    <p v-if="error" class="message error"><CircleAlert :size="15" /> {{ error }}</p>
    <p v-else-if="!thread" class="message dim"><Spinner /> Loading the conversation…</p>

    <template v-else>
      <article
        v-for="post in [{ ...thread.issue, id: 'issue', author_association: null }, ...thread.comments]"
        :key="post.id"
        class="post"
      >
        <div class="post-header">
          <img v-if="post.user" :src="post.user.avatar_url" alt="" class="avatar" />
          <strong>{{ post.user?.login ?? "ghost" }}</strong>
          <a :href="post.html_url" class="dim when" :title="fullDate.format(new Date(post.created_at))">
            {{ post.id === "issue" ? "opened" : "commented" }} {{ formatAgo(post.created_at) }}
          </a>
          <span v-if="ROLES[post.author_association]" class="role">{{ ROLES[post.author_association] }}</span>
        </div>
        <!-- GitHub's rendering, which it sanitizes as it does on its own pages. -->
        <div v-if="post.body_html" class="markdown selectable" v-html="post.body_html" />
        <p v-else class="markdown dim"><em>No description provided.</em></p>
      </article>
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

.assigned {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  font-size: 13px;
}

.person {
  display: flex;
  align-items: center;
  gap: 4px;
  color: var(--text-secondary);
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
  margin-left: auto;
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
