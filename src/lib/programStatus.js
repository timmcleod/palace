// The Program Status Protocol (OSC 7501): a program in a terminal says what it's doing,
// working, waiting on the user, or done, as Claude Code does from v2.1.295. Palace
// shows it on the terminal tabs, and tells the system when one finishes or needs you
// while you're looking elsewhere. The protocol, by Mitchell Hashimoto:
// https://www.superlogical.com/rex/docs/build/program-status

/** The OSC number, and what Palace answers a program asking whether it's understood. */
export const OSC = 7501;
export const SUPPORTED_REPLY = "\x1b]7501;?\x1b\\";

const STATES = new Set(["idle", "working", "done", "blocked", "error"]);
const KINDS = new Set(["permission", "question", "auth"]);
const MAX_RECORDS = 64;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
// Characters that reorder or hide text, which a message shouldn't bring into a notification.
const INVISIBLE = /[​-‏‪-‮⁦-⁩﻿]/g;

// Standard base64 of UTF-8, without control characters, or undefined if it isn't.
function decode(value, maxEncoded, maxDecoded) {
  if (value.length > maxEncoded) return undefined;
  try {
    const bytes = Uint8Array.from(atob(value), (c) => c.charCodeAt(0));
    if (bytes.length > maxDecoded) return undefined;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return CONTROL.test(text) ? undefined : text.replace(INVISIBLE, "");
  } catch {
    return undefined;
  }
}

/**
 * What a report's body (what follows "7501;") says: "query" for a program asking
 * whether it's understood, a report as { id, state, kind, msg, title, app }, or null
 * for one to ignore, as the protocol says.
 */
export function parseReport(body) {
  if (body.length > 4090) return null;
  if (body.trim() === "?") return "query";
  const pairs = {};
  for (const pair of body.split(":")) {
    const at = pair.indexOf("=");
    if (at < 0) continue;
    const key = pair.slice(0, at).trim();
    const value = pair.slice(at + 1).trim();
    if (!/^[a-z]+$/.test(key) || key.length > 16 || !/^[A-Za-z0-9_.,+/=-]*$/.test(value)) continue;
    pairs[key] = value;
  }
  const state = pairs.state;
  if (state !== "clear" && !STATES.has(state)) return null;
  const id = pairs.id ?? "";
  if (id && (id.length > 128 || !/^[A-Za-z0-9_.+-]{1,32}(\/[A-Za-z0-9_.+-]{1,32}){0,7}$/.test(id))) return null;
  const report = { id, state };
  if (state === "blocked" && KINDS.has(pairs.kind)) report.kind = pairs.kind;
  if (pairs.app && /^[A-Za-z0-9_.+-]{1,32}$/.test(pairs.app)) report.app = pairs.app;
  for (const [key, encoded, decoded] of [
    ["msg", 2732, 2048],
    ["title", 256, 192],
  ]) {
    if (pairs[key] === undefined) continue;
    const text = decode(pairs[key], encoded, decoded);
    // A message that won't decode throws the whole report out.
    if (text === undefined) return null;
    report[key] = text;
  }
  return report;
}

/**
 * Applies a report to `records`, a Map of id to record: replacing the record, or for
 * "clear", removing it and those beneath it (all of them, with no id).
 */
export function applyReport(records, report) {
  const { id } = report;
  if (report.state === "clear") {
    for (const key of [...records.keys()]) {
      if (!id || key === id || key.startsWith(`${id}/`)) records.delete(key);
    }
    return;
  }
  records.delete(id);
  // The least recently updated one makes room, past the limit.
  if (records.size >= MAX_RECORDS) records.delete(records.keys().next().value);
  records.set(id, report);
}

// Most in need of the user first.
const URGENCY = ["blocked", "error", "done", "working", "idle"];

/** The record that says most about the terminal: one waiting on the user, say. */
export function summarize(records) {
  let best = null;
  for (const record of records.values()) {
    if (!best || URGENCY.indexOf(record.state) < URGENCY.indexOf(best.state)) best = record;
  }
  return best;
}

/** Drops the records that end with the program, as when the shell's prompt is back. */
export function dropRunning(records) {
  for (const [key, record] of records) {
    if (record.state === "working" || record.state === "blocked") records.delete(key);
  }
}

/** What a notification about it says, as { title, body }, or null for none. */
export function describe(record, agent, repository) {
  const who = agent || "A program";
  const what = {
    done: `${who} finished`,
    error: `${who} stopped with an error`,
    blocked:
      {
        permission: `${who} needs your permission`,
        question: `${who} has a question`,
        auth: `${who} needs you to sign in`,
      }[record.kind] ?? `${who} is waiting on you`,
  }[record.state];
  if (!what) return null;
  return { title: `${what} in ${repository}`, body: record.msg ?? record.title ?? "" };
}
