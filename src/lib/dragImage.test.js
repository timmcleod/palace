import { afterEach, expect, test } from "vitest";
import { grabPoint, dragCopy } from "./dragImage.js";

afterEach(() => (document.body.innerHTML = ""));

// A tab, 180 pixels wide at 300 across the page, with a button in it, as a tab's ×.
function tab() {
  const element = document.createElement("div");
  element.className = "tab active drop-before";
  element.innerHTML = `<span class="name">palace</span><button title="Close Tab">×</button>`;
  element.getBoundingClientRect = () => ({ left: 300, top: 10, width: 180, height: 38 });
  document.body.append(element);
  return element;
}

test("a copy looks as the tab it's of does, at its width, without the line of where a drag would land", () => {
  const copy = dragCopy(tab());
  expect(copy.classList.contains("active")).toBe(true);
  expect(copy.classList.contains("drop-before")).toBe(false);
  expect(copy.querySelector(".name").textContent).toBe("palace");
  expect(copy.style.width).toBe("180px");
});

test("and isn't one to the keyboard or a screen reader", () => {
  const copy = dragCopy(tab());
  expect(copy.hasAttribute("inert")).toBe(true);
  expect(copy.getAttribute("aria-hidden")).toBe("true");
});

test("the point it was grabbed at is where in the tab the pointer was", () => {
  expect(grabPoint(tab(), 340, 30)).toEqual({ x: 40, y: 20 });
});
