import { afterEach, describe, expect, test, vi } from "vitest";
import { createApp, h } from "vue";
import { shortcutFor, useShortcuts } from "./shortcuts.js";

// A key press: "Cmd+Shift+Z", "Ctrl+T", "Alt+ArrowLeft", "/". `code` is the physical key,
// where it matters (' and T), as a layout can put the character elsewhere.
function press(keys, code) {
  const parts = keys.split("+");
  const key = parts.pop();
  return {
    key,
    code: code ?? (key.length === 1 && /[a-z]/i.test(key) ? `Key${key.toUpperCase()}` : key),
    metaKey: parts.includes("Cmd"),
    ctrlKey: parts.includes("Ctrl"),
    shiftKey: parts.includes("Shift"),
    altKey: parts.includes("Alt"),
  };
}

// Nowhere in particular, with a repository open and no dialog.
const anywhere = { inTerminal: false, inTextField: false, inEditor: false, dialogOpen: false, repository: true };
const mac = (keys, where = {}, code) => shortcutFor(press(keys, code), { ...anywhere, ...where }, true);
const linux = (keys, where = {}, code) => shortcutFor(press(keys, code), { ...anywhere, ...where }, false);

describe("shortcutFor", () => {
  test("names each shortcut, with Cmd on a Mac and Ctrl elsewhere", () => {
    const shortcuts = {
      n: "newWindow",
      z: "undo",
      "Shift+z": "redo",
      y: "redo",
      r: "refresh",
      p: "findFile",
      f: "search",
      ",": "settings",
    };
    for (const [keys, name] of Object.entries(shortcuts)) {
      expect(mac(`Cmd+${keys}`), `Cmd+${keys}`).toBe(name);
      expect(linux(`Ctrl+${keys}`), `Ctrl+${keys}`).toBe(name);
      // Not with the other platform's key.
      expect(mac(`Ctrl+${keys}`), `Ctrl+${keys} on a Mac`).toBeNull();
      expect(linux(`Cmd+${keys}`), `Cmd+${keys} on Linux`).toBeNull();
    }
  });

  test("shows or hides the terminal with Cmd+' by the key, whatever the layout types", () => {
    expect(mac("Cmd+'", {}, "Quote")).toBe("terminal");
    expect(linux("Ctrl+ä", {}, "Quote")).toBe("terminal");
    // From the terminal too, to hide it.
    expect(mac("Cmd+'", { inTerminal: true }, "Quote")).toBe("terminal");
    expect(mac("Cmd+'", { repository: false }, "Quote")).toBeNull();
  });

  test("opens a terminal tab with Cmd+T on a Mac and Ctrl+Shift+T on Linux, from a terminal too", () => {
    expect(mac("Cmd+t")).toBe("newTerminalTab");
    expect(mac("Cmd+t", { inTerminal: true })).toBe("newTerminalTab");
    expect(linux("Ctrl+Shift+T")).toBe("newTerminalTab");
    expect(linux("Ctrl+Shift+T", { inTerminal: true })).toBe("newTerminalTab");
    // Ctrl+T is the shell's on Linux, and Cmd+Shift+T isn't it on a Mac.
    expect(linux("Ctrl+t")).toBeNull();
    expect(mac("Cmd+Shift+T")).toBeNull();
  });

  test("leaves everything else typed in a terminal to it", () => {
    for (const keys of ["Cmd+z", "Cmd+r", "Cmd+p", "Cmd+f", "Cmd+,", "/", "Alt+ArrowLeft"]) {
      expect(mac(keys, { inTerminal: true }), keys).toBeNull();
    }
    // Cmd+N is Palace's in a Mac's terminal; Ctrl+N is the shell's on Linux.
    expect(mac("Cmd+n", { inTerminal: true })).toBe("newWindow");
    expect(linux("Ctrl+n", { inTerminal: true })).toBeNull();
  });

  test("goes to the search with /, wherever it isn't typed", () => {
    expect(mac("/")).toBe("search");
    // A layout that needs Shift for it still types "/".
    expect(linux("Shift+/", {}, "Digit7")).toBe("search");
    expect(mac("/", { inTextField: true })).toBeNull();
    expect(mac("/", { inTextField: true, inEditor: true })).toBeNull();
    expect(mac("/", { dialogOpen: true })).toBeNull();
    expect(mac("Cmd+/")).toBeNull();
  });

  test("leaves Cmd+F to the Files view's editor, which finds in the file", () => {
    expect(mac("Cmd+f", { inEditor: true, inTextField: true })).toBeNull();
    // A text field's own: the search goes there from one.
    expect(mac("Cmd+f", { inTextField: true })).toBe("search");
  });

  test("leaves undo and redo to text fields and dialogs", () => {
    expect(mac("Cmd+z", { inTextField: true })).toBeNull();
    expect(mac("Cmd+z", { dialogOpen: true })).toBeNull();
    expect(mac("Cmd+Alt+z")).toBeNull();
  });

  test("goes back and forward with Alt and the arrows, except in text fields", () => {
    expect(mac("Alt+ArrowLeft")).toBe("back");
    expect(linux("Alt+ArrowRight")).toBe("forward");
    expect(mac("Alt+ArrowLeft", { inTextField: true })).toBeNull();
    expect(mac("ArrowLeft")).toBeNull();
  });

  test("needs a repository open for what acts on one, and no dialog", () => {
    for (const keys of ["Cmd+r", "Cmd+p", "Cmd+,", "Cmd+t"]) {
      expect(mac(keys, { repository: false }), keys).toBeNull();
      expect(mac(keys, { dialogOpen: true }), keys).toBeNull();
    }
    // A new window needs none.
    expect(mac("Cmd+n", { repository: false })).toBe("newWindow");
  });

  test("leaves plain typing alone", () => {
    for (const keys of ["a", "Shift+A", "Enter", "Escape", "ArrowDown"]) expect(mac(keys), keys).toBeNull();
  });
});

describe("useShortcuts", () => {
  let app;
  afterEach(() => app?.unmount());

  function listen(actions) {
    app = createApp({
      setup() {
        useShortcuts(() => anywhere, actions);
        return () => h("div");
      },
    });
    app.mount(document.createElement("div"));
  }
  const keydown = (init) => {
    const event = new KeyboardEvent("keydown", { cancelable: true, ...init });
    window.dispatchEvent(event);
    return event;
  };

  test("does the shortcut, keeping the key from anything else", () => {
    const search = vi.fn();
    listen({ search });
    expect(keydown({ key: "/" }).defaultPrevented).toBe(true);
    expect(search).toHaveBeenCalledWith(anywhere);
  });

  test("leaves the key alone when the action says it didn't apply", () => {
    listen({ search: () => false });
    expect(keydown({ key: "/" }).defaultPrevented).toBe(false);
  });

  test("leaves keys that aren't shortcuts alone, and stops listening once unmounted", () => {
    const search = vi.fn();
    listen({ search });
    expect(keydown({ key: "a" }).defaultPrevented).toBe(false);
    app.unmount();
    app = null;
    keydown({ key: "/" });
    expect(search).not.toHaveBeenCalled();
  });
});
