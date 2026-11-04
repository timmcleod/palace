<script setup>
import { computed, nextTick, onBeforeUnmount, provide, reactive, ref, shallowRef, watch } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { ChevronRight, CircleAlert } from "lucide-vue-next";
import Avatar from "./Avatar.vue";
import FileDiff from "./FileDiff.vue";
import FileIcon from "./FileIcon.vue";
import { splitIssueRefs } from "../lib/issues.js";

const props = defineProps({
  path: { type: String, required: true },
  // The selected row from the history list; supplies the id and ref labels.
  commit: { type: Object, default: null },
  // { base, head }: in place of a commit, everything `head` changed since it split
  // from `base`.
  comparison: { type: Object, default: null },
  // A file to open and scroll to, such as the one whose history is being shown.
  focusFile: { type: String, default: null },
  // A stash: its changes are shown against the commit it was made on.
  stash: { type: Boolean, default: false },
  // Whether "#123" in the message links to that GitHub issue.
  issueLinks: { type: Boolean, default: false },
});
// "show-issue" asks to open an issue mentioned in the message, by number.
const emit = defineEmits(["show-issue"]);

const details = shallowRef(null);
const error = ref("");
const expanded = reactive(new Set());
// File diffs load as they scroll into view within this element.
const scroller = ref(null);
provide("diffScroller", scroller);

let loadSeq = 0;

const messagePieces = computed(() =>
  props.issueLinks ? splitIssueRefs(details.value?.message ?? "") : [{ text: details.value?.message ?? "" }],
);

async function load() {
  const seq = ++loadSeq;
  details.value = null;
  error.value = "";
  expanded.clear();

  try {
    const result = props.comparison
      ? await invoke("compare", { path: props.path, base: props.comparison.base, head: props.comparison.head })
      : await invoke("commit_details", { path: props.path, id: props.commit.id });
    if (seq !== loadSeq) return;
    heights = new Array(result.files.length).fill(ROW_HEIGHT);
    held.clear();
    layout.value++;
    details.value = result;
    scrollTop.value = scroller.value?.scrollTop ?? 0;
    if (props.focusFile) focus(props.focusFile);
  } catch (e) {
    if (seq === loadSeq) error.value = String(e);
  }
}

watch(() => [props.path, props.commit?.id, props.comparison?.base, props.comparison?.head], load, { immediate: true });

// Older commits may have the file under a previous name, which still shows up as
// the old side of a rename or, failing that, as a file with the same name.
async function focus(file) {
  const files = details.value.files;
  const name = file.slice(file.lastIndexOf("/") + 1);
  let index = files.findIndex((f) => f.path === file || f.old_path === file);
  if (index < 0) index = files.findIndex((f) => f.path.endsWith(`/${name}`) || f.path === name);
  if (index < 0) return;
  expanded.add(index);
  await nextTick();
  if (windowed.value) {
    scroller.value.scrollTop = listEl.value.offsetTop + offsets.value[index];
  } else {
    scroller.value?.querySelectorAll(".file")[index]?.scrollIntoView({ block: "start" });
  }
}

// --- Drawing only the files in view -----------------------------------------------
// A commit can change tens of thousands of files, as one adding a vendored folder
// does, and a row for each froze the window. Past WINDOW_FROM files, only those in
// view and a little either side are drawn, one after another, moved down to where the
// first of them falls in the list.
// Rows are ROW_HEIGHT until drawn and measured; an open file's diff makes it taller.
// A diff that scrolls out of view loads again when it's back, so an open file keeps
// its height until then, rather than shrinking to "Loading…" and moving what's below.
// Only until then: held any longer, a file didn't shrink back as it should, as on
// canceling a comment, where WebKit lays the diff's table out again late.

const WINDOW_FROM = 300;
const ROW_HEIGHT = 35;
const OVERSCAN = 800;
const windowed = computed(() => (details.value?.files.length ?? 0) > WINDOW_FROM);
const listEl = ref(null);
const scrollTop = ref(0);
const viewHeight = ref(0);
// Each file's height, as last measured; `layout` changes when one does.
let heights = [];
const layout = ref(0);
// The open files back in view whose diffs are loading again, which keep their heights.
const held = reactive(new Set());

// Where each file starts in the list, and, last, how tall the list is.
const offsets = computed(() => {
  layout.value;
  const result = new Array(heights.length + 1);
  result[0] = 0;
  for (let i = 0; i < heights.length; i++) result[i + 1] = result[i] + heights[i];
  return result;
});

// The files to draw, as [file, index], and how far down the first of them goes.
const shownFiles = computed(() => {
  const files = details.value?.files ?? [];
  if (!windowed.value) return { top: 0, files: files.map((file, i) => [file, i]) };
  const at = offsets.value;
  const from = scrollTop.value - (listEl.value?.offsetTop ?? 0) - OVERSCAN;
  const to = from + viewHeight.value + 2 * OVERSCAN;
  // The first file ending below `from`.
  let lo = 0;
  let hi = files.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (at[mid + 1] <= from) lo = mid + 1;
    else hi = mid;
  }
  const shown = [];
  for (let i = lo; i < files.length && at[i] < to; i++) shown.push([files[i], i]);
  return { top: at[lo], files: shown };
});

function onScroll() {
  if (windowed.value) scrollTop.value = scroller.value.scrollTop;
}

const sizes = new ResizeObserver((entries) => {
  let changed = false;
  for (const entry of entries) {
    const el = entry.target;
    if (!el.isConnected || el.dataset.index === undefined) continue;
    const i = Number(el.dataset.index);
    // The file's own height, with its border: not the box around it, which an open
    // file's kept height may hold taller than it is.
    const box = el.parentElement;
    const height = el.offsetHeight + box.offsetHeight - box.clientHeight;
    // A diff loading again keeps the height it had.
    if (held.has(i) && height < heights[i]) continue;
    if (heights[i] !== undefined && heights[i] !== height) {
      heights[i] = height;
      changed = true;
    }
  }
  if (changed) layout.value++;
  if (scroller.value) viewHeight.value = scroller.value.clientHeight;
});
watch(
  scroller,
  (el, old) => {
    if (old) sizes.unobserve(old);
    if (el) sizes.observe(el);
  },
  { immediate: true },
);
// Files are measured as they're drawn, and let go of when they're not.
const measured = new Map();
function measure(el, i) {
  const was = measured.get(i);
  if (was === el) return;
  if (was) sizes.unobserve(was);
  measured.delete(i);
  if (el && windowed.value) {
    // Drawn again, open, as it comes back into view.
    if (!was && expanded.has(i) && heights[i] > ROW_HEIGHT) held.add(i);
    sizes.observe(el);
    measured.set(i, el);
  } else {
    held.delete(i);
  }
}
onBeforeUnmount(() => sizes.disconnect());

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
  if (expanded.has(index)) {
    expanded.delete(index);
    // Its kept height goes with it (see "Drawing only the files in view").
    heights[index] = ROW_HEIGHT;
    held.delete(index);
    layout.value++;
  } else {
    expanded.add(index);
  }
}

function plural(count, word) {
  return `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;
}

const changeSummary = computed(() => {
  const d = details.value;
  const files = plural(d.files.length, "changed file");
  // Past a few thousand files, the lines aren't counted (see commit.rs).
  if (!d.counted) return `Showing ${files}`;
  return `Showing ${files} with ${plural(d.additions, "addition")} and ${plural(d.deletions, "deletion")}`;
});

function splitPath(path) {
  const slash = path.lastIndexOf("/");
  return { dir: path.slice(0, slash + 1), name: path.slice(slash + 1) };
}
</script>

<template>
  <div ref="scroller" class="details selectable" @scroll="onScroll">
    <div v-if="error" class="message">
      <CircleAlert :size="28" :stroke-width="1.25" />
      <p>{{ error }}</p>
    </div>

    <template v-else-if="details">
      <section v-if="!comparison" class="meta">
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

      <!-- One line, as the section keeps its whitespace. -->
      <section v-if="!comparison" class="commit-message"><template v-for="(piece, i) in messagePieces" :key="i"><a v-if="piece.issue" href="#" class="issue-ref" :title="`Show issue ${piece.text}`" @click.prevent="emit('show-issue', piece.issue)">{{ piece.text }}</a><template v-else>{{ piece.text }}</template></template></section>

      <div class="changes-bar">
        <button v-if="details.files.length" class="link-button" @click="toggleAll">
          {{ allExpanded ? "Collapse All" : "Expand All" }}
        </button>
        <span>{{ changeSummary }}</span>
      </div>
      <p v-if="comparison" class="merge-note">
        Changes made on “{{ comparison.head }}” since it split from “{{ comparison.base }}”.
      </p>
      <p v-else-if="details.parents.length > 1 && !stash" class="merge-note">
        This is a merge commit; changes are shown against its first parent.
      </p>

      <div ref="listEl" class="files" :style="windowed ? { height: `${offsets[offsets.length - 1]}px` } : null">
        <div :style="windowed ? { transform: `translateY(${shownFiles.top}px)` } : null">
          <div
            v-for="[file, i] in shownFiles.files"
            :key="i"
            class="file"
            :style="held.has(i) ? { minHeight: `${heights[i]}px` } : null"
          >
            <div :ref="(el) => measure(el, i)" class="file-body" :data-index="i">
              <div class="file-header" @click="toggle(i)">
                <ChevronRight :size="14" class="chevron" :class="{ open: expanded.has(i) }" />
                <span class="status" :class="file.status">{{ file.status }}</span>
                <span class="badge" :class="file.status">{{ STATUS_LETTER[file.status] }}</span>
                <FileIcon :name="file.path" :size="15" />
                <span class="file-path" :title="file.old_path ? `${file.old_path} → ${file.path}` : file.path">
                  <template v-if="file.old_path">
                    <span class="dim">{{ file.old_path }} →</span>
                  </template>
                  <span class="dim">{{ splitPath(file.path).dir }}</span>{{ splitPath(file.path).name }}
                </span>
                <span v-if="file.binary" class="counts dim">binary</span>
                <span v-else-if="details.counted" class="counts">
                  <span v-if="file.additions" class="plus">+{{ file.additions }}</span>
                  <span v-if="file.deletions" class="minus">−{{ file.deletions }}</span>
                </span>
              </div>
              <FileDiff
                v-if="expanded.has(i)"
                :path="path"
                :commit-id="details.id ?? null"
                :comparison="comparison"
                :index="i"
                :file="file.path"
                @loaded="held.delete(i)"
              />
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>

<style scoped>
.details {
  position: relative;
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

.issue-ref {
  color: var(--accent);
  text-decoration: none;
}

.issue-ref:hover {
  text-decoration: underline;
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

.files {
  position: relative;
}

.file {
  border-bottom: 1px solid var(--border);
}

/* Holding in the diff's margin, so it counts in the file's measured height. */
.file-body {
  display: flow-root;
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
