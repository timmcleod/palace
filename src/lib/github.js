import { ref } from "vue";
import { invoke } from "@tauri-apps/api/core";
import { openForm } from "./overlays.js";

// The GitHub account Palace is signed in with, shared by Settings and the GitHub view.
export const githubAccount = ref(null);

invoke("github_account")
  .then((account) => (githubAccount.value = account))
  .catch(() => {});

// A new classic token with the scopes Palace uses: private repositories, workflow
// files (pushing changes to .github/workflows), organisations, and SSH keys.
export const NEW_TOKEN_URL =
  "https://github.com/settings/tokens/new?description=Palace&scopes=repo,workflow,read:org,admin:public_key";

// What each scope lets Palace do, for the Account tab.
export const SCOPES = [
  { name: "repo", use: "Fetch, pull and push your repositories, private ones included, and create new ones" },
  { name: "workflow", use: "Push changes to GitHub Actions workflows (.github/workflows)" },
  { name: "read:org", use: "List your organizations and their repositories" },
  { name: "admin:public_key", use: "See, add and remove the SSH keys on your account" },
];

/**
 * Asks for a personal access token and signs in with it. Resolves to an error
 * message, or null when signed in or cancelled.
 */
export async function signInWithToken() {
  const values = await openForm({
    title: "Sign In to GitHub",
    message:
      "Paste a personal access token. Palace keeps it in your system keyring and uses it to fetch, pull and push your GitHub repositories.",
    fields: [{ key: "token", label: "Token", type: "password", placeholder: "ghp_…" }],
    confirmLabel: "Sign In",
  });
  if (!values) return null;
  try {
    githubAccount.value = await invoke("github_sign_in", { token: values.token });
    return null;
  } catch (e) {
    return String(e);
  }
}

export async function signOut() {
  await invoke("github_sign_out");
  githubAccount.value = null;
}
