import { expect, test } from "vitest";
import { activeTab, closeTab, dropPlace, moveTab, openTab, showNext, showNumber, tabWith, tabsForBackend } from "./tabs.js";

// Tabs with the repositories at `paths` open, the first showing.
function tabsOf(...paths) {
  const tabs = { list: [], active: null };
  for (const path of paths) openTab(tabs, path);
  tabs.active = tabs.list[0]?.id ?? null;
  return tabs;
}
const paths = (tabs) => tabs.list.map((tab) => tab.path);
const showing = (tabs) => activeTab(tabs)?.path;

test("a new tab opens after the one showing, named for its repository, and shows", () => {
  const tabs = tabsOf("/code/a", "/code/b");
  const tab = openTab(tabs, "/code/palace", { task: "Fix the README" });
  expect(paths(tabs)).toEqual(["/code/a", "/code/palace", "/code/b"]);
  expect(tab).toMatchObject({ name: "palace", branch: null, task: "Fix the README" });
  expect(showing(tabs)).toBe("/code/palace");
  // One to choose a repository in.
  expect(openTab(tabs)).toMatchObject({ path: null, name: null });
});

test("closing the tab showing shows the one after it, or with none after, the one before", () => {
  const tabs = tabsOf("/a", "/b", "/c");
  showNumber(tabs, 2);
  closeTab(tabs, tabWith(tabs, "/b").id);
  expect([paths(tabs), showing(tabs)]).toEqual([["/a", "/c"], "/c"]);
  closeTab(tabs, tabWith(tabs, "/c").id);
  expect(showing(tabs)).toBe("/a");
  // Another closing leaves the one showing as it is.
  openTab(tabs, "/d");
  closeTab(tabs, tabWith(tabs, "/a").id);
  expect(showing(tabs)).toBe("/d");
  closeTab(tabs, tabWith(tabs, "/d").id);
  expect([tabs.list, tabs.active]).toEqual([[], null]);
});

test("⌘1 to ⌘8 show that tab, if there is one, and ⌘9 the last", () => {
  const tabs = tabsOf("/a", "/b", "/c");
  showNumber(tabs, 2);
  expect(showing(tabs)).toBe("/b");
  showNumber(tabs, 5);
  expect(showing(tabs)).toBe("/b");
  showNumber(tabs, 9);
  expect(showing(tabs)).toBe("/c");
});

test("the next and previous tabs go round", () => {
  const tabs = tabsOf("/a", "/b", "/c");
  showNext(tabs);
  expect(showing(tabs)).toBe("/b");
  showNext(tabs, -1);
  showNext(tabs, -1);
  expect(showing(tabs)).toBe("/c");
  showNext(tabs);
  expect(showing(tabs)).toBe("/a");
});

test("a tab dragged elsewhere moves there, the one showing still showing", () => {
  const tabs = tabsOf("/a", "/b", "/c");
  moveTab(tabs, tabWith(tabs, "/a").id, 2);
  expect(paths(tabs)).toEqual(["/b", "/c", "/a"]);
  moveTab(tabs, tabWith(tabs, "/c").id, 0);
  expect(paths(tabs)).toEqual(["/c", "/b", "/a"]);
  // Past either end, it goes to the end.
  moveTab(tabs, tabWith(tabs, "/c").id, 10);
  expect(paths(tabs)).toEqual(["/b", "/a", "/c"]);
  expect(showing(tabs)).toBe("/a");
});

test("a tab dropped before or after another goes there, or stays where it is", () => {
  const tabs = tabsOf("/a", "/b", "/c");
  const [a, b, c] = tabs.list.map((tab) => tab.id);
  expect(dropPlace(tabs, a, c, true)).toBe(2);
  expect(dropPlace(tabs, a, c, false)).toBe(1);
  expect(dropPlace(tabs, c, a, false)).toBe(0);
  // Just before or after itself, it stays: no line's drawn there.
  expect(dropPlace(tabs, a, b, false)).toBeNull();
  expect(dropPlace(tabs, b, a, true)).toBeNull();
  expect(dropPlace(tabs, a, a, true)).toBeNull();
  expect(dropPlace(tabs, a, 999, true)).toBeNull();
});

test("the backend's told the repositories open, in order, and which shows among them", () => {
  const tabs = tabsOf("/a");
  openTab(tabs);
  openTab(tabs, "/b");
  expect(tabsForBackend(tabs)).toEqual({ repos: ["/a", "/b"], active: 1 });
  showNumber(tabs, 2);
  expect(tabsForBackend(tabs)).toEqual({ repos: ["/a", "/b"], active: null });
  expect(tabWith(tabs, null)).toBeNull();
});
