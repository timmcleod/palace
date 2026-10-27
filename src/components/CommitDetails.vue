<script setup>
import { computed, provide, reactive, ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, CircleAlert } from "lucide-vue-next";
import Avatar from "./Avatar.vue";
import FileDiff from "./FileDiff.vue";

const props = defineProps({
  path: { type: String, required: true },
  // The selected row from the history list; supplies the id and ref labels.
  commit: { type: Object, required: true },
});

const details = shallowRef(null);
const error = ref("");
const expanded = reactive(new Set());
// File diffs load as they scroll into view within this element.
const scroller = ref(null);
provide("diffScroller", scroller);

let loadSeq = 0;

async function load() {
  const seq = ++loadSeq;
  details.value = null;
  error.value = "";
  expanded.clear();

  try {
    const result = await invoke("commit_details", { path: props.path, id: props.commit.id });
    if (seq === loadSeq) details.value = result;
  } catch (e) {
    if (seq === loadSeq) error.value = String(e);
  }
}

watch(() => [props.path, props.commit.id], load, { immediate: true });

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "long" });
const formatDate = (seconds) => dateFormat.format(seconds * 1000);

const STATUS_LETTER = { added: "A", deleted: "D", modified: "M", renamed: "R", copied: "C", typechange: "T" };

const allExpanded = computed(() => details.value && expanded.size === details.value.files.length);

function toggleAll() {
  if (allExpanded.value) {
    expanded.clear();
  } else {
    details.value.files.forEach((_, i) => expanded.add(i));
  }
}

function toggle(index) {
  expanded.has(index) ? expanded.delete(index) : expanded.add(index);
}

function plural(count, word) {
  return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}

const changeSummary = computed(() => {
  const d = details.value;
  return `Showing ${plural(d.files.length, "changed file")} with ${plural(d.additions, "addition")} and ${plural(d.deletions, "deletion")}`;
});

function splitPath(path) {
  const slash = path.lastIndexOf("/");
  return { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}
</script>

<template>
  <div ref="scroller" class="details selectable">
    <div v-if="error" class="message">
      <CircleAlert :size="28" :stroke-width="1.25" />
      <p>{{ error }}</p>
    </div>

    <template v-else-if="details">
      <section class="meta">
        <dl>
          <dt>Author</dt>
          <dd>{{ details.author.name }} &lt;{{ details.author.email }}&gt;</dd>
          <dt>Author Date</dt>
          <dd>{{ formatDate(details.author.time) }}</dd>
          <dt>Committer</dt>
          <dd>{{ details.committer.name }} &lt;{{ details.committer.email }}&gt;</dd>
          <dt>Committer Date</dt>
          <dd>{{ formatDate(details.committer.time) }}</dd>
          <template v-if="commit.refs.length">
            <dt>Refs</dt>
            <dd class="refs">
              <span v-for="label in commit.refs" :key="label.kind + label.name" class="ref" :class="label.kind">
                {{ label.name }}
              </span>
            </dd>
          </template>
          <dt>Commit Hash</dt>
          <dd class="mono">{{ details.id }}</dd>
          <dt>{{ details.parents.length > 1 ? "Parent Hashes" : "Parent Hash" }}</dt>
          <dd class="mono">
            <div v-for="parent in details.parents" :key="parent">{{ parent }}</div>
            <span v-if="!details.parents.length" class="dim">None (root commit)</span>
          </dd>
          <dt>Tree Hash</dt>
          <dd class="mono">{{ details.tree_id }}</dd>
        </dl>
        <Avatar :name="details.author.name" :email="details.author.email" :size="72" />
      </section>

      <section class="commit-message">{{ details.message }}</section>

      <div class="changes-bar">
        <button v-if="details.files.length" class="link-button" @click="toggleAll">
          {{ allExpanded ? "Collapse All" : "Expand All" }}
        </button>
        <span>{{ changeSummary }}</span>
      </div>
      <p v-if="details.parents.length > 1" class="merge-note">
        This is a merge commit; changes are shown against its first parent.
      </p>

      <div v-for="(file, i) in details.files" :key="i" class="file">
        <div class="file-header" @click="toggle(i)">
          <ChevronRight :size="14" class="chevron" :class="{ open: expanded.has(i) }" />
          <span class="status" :class="file.status">{{ file.status }}</span>
          <span class="badge" :class="file.status">{{ STATUS_LETTER[file.status] }}</span>
          <span class="file-path" :title="file.old_path ? `${file.old_path} → ${file.path}` : file.path">
            <template v-if="file.old_path">
              <span class="dim">{{ file.old_path }} →</span>
            </template>
            <span class="dim">{{ splitPath(file.path).dir }}</span>{{ splitPath(file.path).name }}
          </span>
          <span v-if="file.binary" class="counts dim">binary</span>
          <span v-else class="counts">
            <span v-if="file.additions" class="plus">+{{ file.additions }}</span>
            <span v-if="file.deletions" class="minus">−{{ file.deletions }}</span>
          </span>
        </div>
        <FileDiff v-if="expanded.has(i)" :path="path" :commit-id="details.id" :index="i" />
      </div>
    </template>
  </div>
</template>

<style scoped>
.details {
  flex: 1;
  overflow-y: auto;
}

.meta {
  display: flex;
  gap: 16px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}

dl {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 3px 10px;
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 13px;
}

dt {
  text-align: right;
  color: var(--text-tertiary);
}

dd {
  margin: 0;
  overflow-wrap: anywhere;
}

dd.mono {
  font-size: 12.5px;
}

.refs {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.ref {
  padding: 0 5px;
  border-radius: 4px;
  font-size: 12px;
  line-height: 17px;
  color: white;
}

.ref.head,
.ref.local {
  background: var(--accent);
}

.ref.remote {
  background: var(--ref-remote);
}

.ref.tag {
  background: var(--ref-tag);
}

.commit-message {
  padding: 18px 24px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  line-height: 1.6;
}

.changes-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 6px 16px 6px 24px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
  color: var(--text-secondary);
}

.merge-note {
  margin: 0;
  padding: 8px 24px;
  border-bottom: 1px solid var(--border);
  font-size: 12.5px;
  color: var(--text-tertiary);
}

.link-button {
  padding: 0;
  border: 0;
  background: none;
  font: inherit;
  color: var(--text-secondary);
  cursor: pointer;
}

.link-button:hover {
  color: var(--accent);
}

.file {
  border-bottom: 1px solid var(--border);
}

.file-header {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 34px;
  padding: 0 16px;
  font-size: 13px;
  white-space: nowrap;
}

.file-header:hover {
  background: var(--row-hover);
}

.chevron {
  flex-shrink: 0;
  color: var(--text-tertiary);
  transition: transform 0.12s ease;
}

.chevron.open {
  transform: rotate(90deg);
}

.status {
  flex-shrink: 0;
  width: 66px;
  text-align: right;
}

.badge {
  flex-shrink: 0;
  width: 17px;
  border-radius: 3px;
  font-size: 11px;
  font-weight: 700;
  line-height: 17px;
  text-align: center;
  color: white;
}

.modified {
  --status: var(--accent);
}
.added {
  --status: var(--lane-4);
}
.deleted {
  --status: var(--danger);
}
.renamed,
.copied {
  --status: var(--lane-2);
}
.typechange {
  --status: var(--text-tertiary);
}

.status {
  color: var(--status);
}

.badge {
  background: var(--status);
}

.file-path {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.counts {
  display: flex;
  gap: 6px;
  flex-shrink: 0;
  font-size: 12px;
}

.plus {
  color: var(--diff-added-text);
}

.minus {
  color: var(--diff-removed-text);
}

.message {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  padding: 0 24px;
  color: var(--text-tertiary);
  text-align: center;
}
</style>
