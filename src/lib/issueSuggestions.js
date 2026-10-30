import { computed, nextTick, ref, shallowRef } from "vue";
import { invoke } from "@tauri-apps/api/core";

// Suggests open issues while "#" is typed in a commit message, so "Fixes #42" is
// quick to write: the number, or words from the title, narrow the list, and picking one
// puts in its number. The newest open issues are loaded the first time, and again
// after a few minutes.

const FRESH_FOR = 3 * 60 * 1000;
const loaded = new Map();

function openIssues({ owner, repo }) {
  const key = `${owner}/${repo}`.toLowerCase();
  const cached = loaded.get(key);
  if (!cached || Date.now() - cached.at > FRESH_FOR) {
    const issues = invoke("github_issues", { owner, repo, filters: "is:open", page: 1 })
      .then((page) => page.issues)
      .catch(() => {
        loaded.delete(key);
        return [];
      });
    loaded.set(key, { at: Date.now(), issues });
  }
  return loaded.get(key).issues;
}

// "#" at the start or after a space or bracket, then what's typed since.
const TYPING = /(?:^|[\s([])#(\w*)$/;

/**
 * `repo()` gives the GitHub repository ({ owner, repo }), or null for none. The field
 * calls onInput(event, setValue) as it changes and onKeydown(event) first on each key,
 * which returns true when it handled the key.
 */
export function useIssueSuggestions(repo) {
  const issues = shallowRef([]);
  const query = ref("");
  const index = ref(0);
  // Where the list goes: above the field, which sits at the bottom of the window.
  const position = ref(null);
  let field = null;
  let setValue = null;
  let start = 0;

  const items = computed(() => {
    if (!position.value) return [];
    const q = query.value.toLowerCase();
    const matches = /^\d+$/.test(q)
      ? issues.value.filter((i) => String(i.number).startsWith(q))
      : issues.value.filter((i) => i.title.toLowerCase().includes(q));
    return matches.slice(0, 8);
  });

  async function onInput(event, set) {
    const r = repo();
    const el = event.target;
    const typed = el.value.slice(0, el.selectionStart).match(TYPING);
    if (!r || !typed) {
      close();
      return;
    }
    field = el;
    setValue = set;
    start = el.selectionStart - typed[1].length - 1;
    query.value = typed[1];
    index.value = 0;
    const rect = el.getBoundingClientRect();
    position.value = { left: `${rect.left}px`, bottom: `${window.innerHeight - rect.top + 4}px`, width: `${rect.width}px` };
    issues.value = await openIssues(r);
  }

  function pick(issue) {
    const value = field.value;
    const end = start + 1 + query.value.length;
    const inserted = `#${issue.number} `;
    setValue(value.slice(0, start) + inserted + value.slice(end));
    const caret = start + inserted.length;
    const el = field;
    close();
    nextTick(() => {
      el.focus();
      el.setSelectionRange(caret, caret);
    });
  }

  function onKeydown(event) {
    if (!items.value.length) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      const step = event.key === "ArrowDown" ? 1 : -1;
      index.value = (index.value + step + items.value.length) % items.value.length;
    } else if ((event.key === "Enter" && !event.ctrlKey && !event.metaKey) || event.key === "Tab") {
      pick(items.value[index.value]);
    } else if (event.key === "Escape") {
      close();
      event.stopPropagation();
    } else {
      return false;
    }
    event.preventDefault();
    return true;
  }

  function close() {
    position.value = null;
  }

  return { items, index, position, onInput, onKeydown, pick, close };
}
