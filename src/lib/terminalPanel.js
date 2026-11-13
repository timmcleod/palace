import { nextTick, onBeforeUnmount, ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { tell } from "./overlays.js";
import { settings } from "./settings.js";

// terminals.js, with xterm, loads the first time a terminal's wanted.
const terminals = () => import("./terminals.js");

/**
 * The window's terminal panel, below the history and details: whether it's showing,
 * opening tabs in it, and the notices that a terminal's program finished or needs you.
 * `overview` is the open repository's overview ref; `loadRepository(path)` opens
 * another, as for a notice from a terminal of a repository that isn't showing; `window`
 * is this one (getCurrentWebviewWindow), which notices come to: only while `active()`,
 * the workspace calling it is showing, are they shown here. The panel component goes in
 * `panel`, by its ref.
 */
export function useTerminalPanel({ overview, loadRepository, window, active = () => true }) {
  // Showing, and loaded: it loads the first time it's opened, and stays, hidden.
  const open = ref(false);
  const loaded = ref(false);
  // Whether a terminal tab has finished or needs you since you last looked, so the
  // hidden panel's button can say so.
  const unseen = ref(false);
  const panel = ref(null);

  function reveal() {
    open.value = true;
    loaded.value = true;
  }

  function toggle() {
    if (!overview.value) return;
    if (open.value) open.value = false;
    else show();
  }

  // Shows the panel, starting a terminal if the repository has none, or with `newTab`,
  // whatever it has, in `folder` inside the repository if given. The first, unless it's
  // for a folder, is the agent, as Settings has it by default, where it's installed.
  async function show({ newTab = false, folder = "" } = {}) {
    if (!overview.value) return;
    reveal();
    const path = overview.value.path;
    const { agentCommand, missingAgent, openTerminal, tabsFor } = await terminals();
    if (!newTab && tabsFor(path).tabs.length) return panel.value?.focus();
    if (!newTab && !folder && settings.terminalStartsAgent) {
      const command = agentCommand(path);
      // Not installed, it's a shell: the agent's button says how to install it.
      const ready = !(await missingAgent(command));
      // Opened meanwhile, as by a second press while that was asked, it isn't again.
      if (tabsFor(path).tabs.length || overview.value?.path !== path) return panel.value?.focus();
      if (ready) return openTerminal(path, { command, kind: "agent" });
    }
    openTerminal(path, { folder });
  }

  // Shows the terminal tab `key` of the repository at `path`, opening the repository
  // first if another's showing.
  async function showTab({ path, key }) {
    if (overview.value?.path !== path) await loadRepository(path);
    if (overview.value?.path !== path) return;
    reveal();
    const { tabsFor } = await terminals();
    const group = tabsFor(path);
    if (group.tabs.some((tab) => tab.key === key)) group.active = key;
    await nextTick();
    panel.value?.focus();
  }

  // Whether the repository's agent can be started, as before New Agent Task makes a worktree
  // for it. Where it isn't installed, that's said, with an offer to install it, shown in
  // the panel.
  async function agentReady() {
    const path = overview.value?.path;
    if (!path) return false;
    const { agentCommand, missingAgent, offerInstall } = await terminals();
    const agent = await missingAgent(agentCommand(path));
    if (!agent) return true;
    if (await offerInstall(path, agent, { then: "start the task again" })) reveal();
    return false;
  }

  // Starts the repository's agent on `task`, showing the panel, as for a window opened
  // by New Agent Task. Where it can only be put in the agent's prompt, that's said; where the
  // agent didn't start, the task's given back, so it isn't lost.
  async function startTask(task) {
    const path = overview.value?.path;
    if (!path) return;
    reveal();
    const { offerInstall, startAgentOn } = await terminals();
    const how = await startAgentOn(path, task);
    if (how === "pasted") tell("Send the Task", "The task is in the agent's prompt. Check it, then press Enter to send it.");
    else if (how?.missing) {
      if (await offerInstall(path, how.missing, { then: `give it the task again: “${task}”` })) reveal();
    } else if (!how) tell("Couldn't Reach the Agent", `The agent didn't start, so it hasn't the task. Check the agent tab for why. The task was:\n\n${task}`);
  }

  // Puts `text` in the prompt of the repository's agent, showing the panel, and says
  // whether it could.
  async function pasteToAgent(text) {
    const path = overview.value?.path;
    if (!path) return false;
    reveal();
    const { sendToAgent } = await terminals();
    const tab = await sendToAgent(path, text);
    if (!tab) {
      tell("Couldn't Reach the Agent", "The agent tab's agent didn't start. Check the agent tab for why, then try again.");
      return false;
    }
    panel.value?.focus();
    return true;
  }

  // Notices that a terminal's program finished or needs you, sent here by whichever
  // window it's in (see notify in terminals.js), since this is the one you're in. One
  // waiting on you stays a minute, others a few seconds; the tab keeps its mark longer.
  // The newest three show, one a tab.
  const notices = ref([]);
  let nextNotice = 1;
  const unlistenNotice = window.listen("notice", ({ payload }) => {
    if (!active()) return;
    const id = nextNotice++;
    const others = notices.value.filter((n) => n.window !== payload.window || n.key !== payload.key);
    notices.value = [...others, { ...payload, id }].slice(-3);
    setTimeout(() => dismissNotice({ id }), payload.state === "blocked" ? 60000 : 12000);
  });

  function dismissNotice({ id }) {
    notices.value = notices.value.filter((n) => n.id !== id);
  }

  // Brings the notice's tab forward: here, or in its own window, which comes forward.
  function openNotice(notice) {
    dismissNotice(notice);
    if (notice.window === window.label) showTab(notice);
    else invoke("show_terminal_tab", { label: notice.window, path: notice.path, key: notice.key }).catch(() => {});
  }

  // Another window's notice, clicked there, or the system's notification, clicked.
  const unlistenShowTab = window.listen("show-terminal-tab", ({ payload }) => active() && showTab(payload));

  onBeforeUnmount(() => {
    unlistenNotice.then((unlisten) => unlisten());
    unlistenShowTab.then((unlisten) => unlisten());
  });

  return { open, loaded, unseen, panel, toggle, show, showTab, agentReady, startTask, pasteToAgent, notices, dismissNotice, openNotice };
}
