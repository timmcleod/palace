import { expect, test } from "vitest";
import { folderName, formatBeside, formatWhen } from "./format.js";

test("names a folder by its last part", () => {
  expect(folderName("/code/palace")).toBe("palace");
  expect(folderName("/code/palace/")).toBe("palace");
  expect(folderName("C:\\code\\palace")).toBe("palace");
  expect(folderName("/")).toBe("/");
});

test("says how long ago within a week, and the date after", () => {
  const now = new Date(2026, 10, 8, 12).getTime();
  const daysAgo = (days) => now - days * 24 * 3600 * 1000;
  expect(formatWhen(daysAgo(3), now)).toBe(new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(-3, "day"));
  expect(formatWhen(now + 2 * 3600 * 1000, now)).toBe(new Intl.RelativeTimeFormat(undefined, { numeric: "auto" }).format(2, "hour"));
  expect(formatWhen(daysAgo(17), now)).toBe(new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(daysAgo(17)));
  const lastYear = new Date(2025, 9, 22).getTime();
  expect(formatWhen(lastYear, now)).toBe(new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(lastYear));
});

test("says a time beside another without its date again, on the same day", () => {
  const committed = new Date(2026, 9, 26, 16, 13).getTime();
  const authored = new Date(2026, 9, 26, 12, 26).getTime();
  const dayBefore = new Date(2026, 9, 25, 12, 26).getTime();
  expect(formatBeside(authored, committed)).toBe(`at ${new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(authored)}`);
  expect(formatBeside(dayBefore, committed)).toBe(new Intl.DateTimeFormat(undefined, { dateStyle: "long", timeStyle: "short" }).format(dayBefore));
});
