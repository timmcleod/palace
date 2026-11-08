/** A commit's hash, short, as git.rs's short_id: "95d90e0". */
export const shortHash = (id) => id.slice(0, 7);

/** The name of the folder or file at `path`, its last part: "palace" for "/code/palace/". */
export const folderName = (path) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;

// A file size for people to read, such as "12.3 KB".
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} bytes`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const relative = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
const UNITS = [
  ["year", 365 * 24 * 3600],
  ["month", 30 * 24 * 3600],
  ["week", 7 * 24 * 3600],
  ["day", 24 * 3600],
  ["hour", 3600],
  ["minute", 60],
];

/** How long ago a time (an ISO string) was, as of `now` (ms), such as "3 days ago" or "yesterday". */
export function formatAgo(time, now = Date.now()) {
  const seconds = (Date.parse(time) - now) / 1000;
  for (const [unit, size] of UNITS) {
    if (Math.abs(seconds) >= size) return relative.format(Math.round(seconds / size), unit);
  }
  return "just now";
}

const WEEK = 7 * 24 * 3600 * 1000;
const monthDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const monthDayYear = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" });

/**
 * When something was, for a list of them: how long ago within the last week ("3 days
 * ago"), else its date ("Oct 22", with the year if it isn't this one), as a run of "2
 * weeks ago" would tell older ones apart no better than not at all. `time` in ms.
 */
export function formatWhen(time, now = Date.now()) {
  // A time ahead of now, as from a clock that's wrong, says how far ahead: "in 2 hours".
  if (now - time < WEEK) return formatAgo(new Date(time).toISOString(), now);
  const sameYear = new Date(time).getFullYear() === new Date(now).getFullYear();
  return (sameYear ? monthDay : monthDayYear).format(time);
}

/** The text color, dark or light, that reads well on a background color ("d73a4a"). */
export function textColorOn(hex) {
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
  return 0.299 * r + 0.587 * g + 0.114 * b > 150 ? "#1f2328" : "#ffffff";
}
