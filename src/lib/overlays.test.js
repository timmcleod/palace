import { afterEach, expect, test } from "vitest";
import { askConfirm, closeConfirm, confirmDialog, overlayOpen } from "./overlays.js";

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
