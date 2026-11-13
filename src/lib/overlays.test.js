import { afterEach, expect, test } from "vitest";
import { askConfirm, closeConfirm, closeForm, confirmDialog, formDialog, openForm, overlayOpen } from "./overlays.js";

afterEach(() => {
  while (confirmDialog.value) closeConfirm(false);
  document.body.innerHTML = "";
});

test("a question asked while another's showing waits its turn, and each gets its own answer", async () => {
  const first = askConfirm({ title: "First", message: "" });
  const second = askConfirm({ title: "Second", message: "" });
  expect(confirmDialog.value.title).toBe("First");
  closeConfirm(true);
  expect(confirmDialog.value.title).toBe("Second");
  closeConfirm(false);
  expect(confirmDialog.value).toBeNull();
  expect([await first, await second]).toEqual([true, false]);
});

test("a dialog's open while one shows, the window's or a tab's own, but not a hidden tab's", () => {
  expect(overlayOpen()).toBe(false);
  // A tab's own dialog, as New Issue, drawn in its tab.
  document.body.innerHTML = '<div class="workspace" style="display: none;"><div class="backdrop"></div></div>';
  expect(overlayOpen()).toBe(false);
  document.querySelector(".workspace").style.display = "";
  expect(overlayOpen()).toBe(true);
  document.body.innerHTML = "";
  askConfirm({ title: "Sure?", message: "" });
  expect(overlayOpen()).toBe(true);
});

test("quitting's question goes before one showing, which is asked again after", async () => {
  const other = askConfirm({ title: "Discard?", message: "" });
  const quitting = askConfirm({ title: "Quit Palace?", message: "", first: true });
  expect(confirmDialog.value.title).toBe("Quit Palace?");
  closeConfirm(false);
  expect(confirmDialog.value.title).toBe("Discard?");
  closeConfirm(true);
  expect([await quitting, await other]).toEqual([false, true]);
});

test("each dialog is numbered afresh, and one opened over another of its kind settles that as canceled", async () => {
  const first = openForm({ title: "Rename", fields: [] });
  const id = formDialog.value.id;
  const second = openForm({ title: "Rename", fields: [] });
  expect(await first).toBeNull();
  expect(formDialog.value.id).not.toBe(id);
  closeForm({ name: "next" });
  expect(await second).toEqual({ name: "next" });
});
