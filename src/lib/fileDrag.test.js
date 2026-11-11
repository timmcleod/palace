import { expect, test, vi } from "vitest";
import { listen } from "@tauri-apps/api/event";
import { draggingFiles, onFilesDropped } from "./fileDrag.js";

vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn() }));

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

test("hands on the paths of files Tauri takes the drop of, until stopped", async () => {
  const unlisten = vi.fn();
  vi.mocked(listen).mockResolvedValue(unlisten);
  const dropped = [];
  const stop = onFilesDropped((paths) => dropped.push(paths));
  const [name, handler] = vi.mocked(listen).mock.calls[0];
  expect(name).toBe("tauri://drag-drop");
  handler({ payload: { paths: ["/home/ada/Desktop/shot.png"], position: { x: 10, y: 20 } } });
  expect(dropped).toEqual([["/home/ada/Desktop/shot.png"]]);
  await stop();
  expect(unlisten).toHaveBeenCalled();
});
