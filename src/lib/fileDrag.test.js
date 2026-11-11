import { expect, test, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { draggingFiles, onFilesDropped } from "./fileDrag.js";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/webviewWindow", () => ({ getCurrentWebviewWindow: () => ({ label: "window-2" }) }));

const drag = (...types) => ({ types });

test("files dragged in, as macOS and Linux each say so", () => {
  expect(draggingFiles(drag("Files"))).toBe(true);
  // WebKitGTK while they're dragged from the desktop or Files.
  expect(draggingFiles(drag("text/uri-list"))).toBe(true);
});

test("not Palace's own drags, nor text, nor nothing", () => {
  expect(draggingFiles(drag("application/x-palace-commit", "text/plain"))).toBe(false);
  expect(draggingFiles(drag("text/plain"))).toBe(false);
  expect(draggingFiles(null)).toBe(false);
});

test("hands on the paths of files dropped on this window, until stopped", async () => {
  const unlisten = vi.fn();
  vi.mocked(listen).mockResolvedValue(unlisten);
  const dropped = [];
  const stop = onFilesDropped((paths) => dropped.push(paths));
  const [name, handler, options] = vi.mocked(listen).mock.calls[0];
  expect(name).toBe("tauri://drag-drop");
  // This window's drops only, not every window's.
  expect(options).toEqual({ target: { kind: "WebviewWindow", label: "window-2" } });
  handler({ payload: { paths: ["/home/ada/Desktop/shot.png"], position: { x: 10, y: 20 } } });
  expect(dropped).toEqual([["/home/ada/Desktop/shot.png"]]);
  await stop();
  expect(unlisten).toHaveBeenCalled();
});

test("hands on only paths, not a link dragged in from a browser", () => {
  vi.mocked(listen).mockClear().mockResolvedValue(() => {});
  const dropped = [];
  onFilesDropped((paths) => dropped.push(paths));
  const [, handler] = vi.mocked(listen).mock.calls[0];
  handler({ payload: { paths: ["https://example.com/page", "/home/ada/notes.md"] } });
  handler({ payload: { paths: ["https://example.com/page"] } });
  expect(dropped).toEqual([["/home/ada/notes.md"]]);
});
