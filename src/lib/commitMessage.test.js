import { describe, expect, test } from "vitest";
import { howCommitted, readMessage } from "./commitMessage.js";

describe("a commit's message", () => {
  test("is its subject, its body, and those it was made with", () => {
    const message = "Update atlas-pkg to 0.8.2\n\nReports whether nginx needs a restart.\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n";
    expect(readMessage(message)).toEqual({
      subject: "Update atlas-pkg to 0.8.2",
      body: "Reports whether nginx needs a restart.",
      coAuthors: [{ name: "Claude Opus 5.5", email: "noreply@anthropic.com" }],
    });
  });

  test("with only a subject, or nothing, has no body", () => {
    expect(readMessage("Fix the login redirect")).toEqual({ subject: "Fix the login redirect", body: "", coAuthors: [] });
    expect(readMessage("")).toEqual({ subject: "", body: "", coAuthors: [] });
  });

  test("takes its subject's lines together, as git does, and Windows line endings as any", () => {
    expect(readMessage("Fix the login\nredirect\n\nBody").subject).toBe("Fix the login redirect");
    expect(readMessage("Fix it\r\n\r\nBecause.\r\n")).toEqual({ subject: "Fix it", body: "Because.", coAuthors: [] });
  });

  test("finds co-authors among other trailers, which stay", () => {
    const { body, coAuthors } = readMessage("Fix\n\nWhy.\n\nCo-authored-by: Ada <ada@example.com>\nSigned-off-by: Tim <tim@example.com>");
    expect(coAuthors).toEqual([{ name: "Ada", email: "ada@example.com" }]);
    expect(body).toBe("Why.\n\nSigned-off-by: Tim <tim@example.com>");
  });

  test("keeps a Co-Authored-By line in a paragraph that isn't all trailers", () => {
    const { body, coAuthors } = readMessage("Pair on it\n\nCo-authored-by: Ada <ada@example.com>\nwas said first.");
    expect(coAuthors).toEqual([]);
    expect(body).toContain("Co-authored-by: Ada");
  });

  test("several co-authors, in order", () => {
    const { coAuthors } = readMessage("Pair\n\nCo-authored-by: Ada <ada@example.com>\nCo-authored-by: Grace <grace@example.com>");
    expect(coAuthors.map((c) => c.name)).toEqual(["Ada", "Grace"]);
  });
});

describe("how a commit came to be committed", () => {
  const ada = { name: "Ada", email: "ada@example.com", time: 1000 };
  test("as it was written, later by its author, or by someone else", () => {
    expect(howCommitted({ author: ada, committer: { ...ada, time: 1030 } })).toBe("together");
    expect(howCommitted({ author: ada, committer: { ...ada, time: 5000 } })).toBe("later");
    expect(howCommitted({ author: ada, committer: { ...ada, name: "Grace", email: "grace@example.com" } })).toBe("by-other");
  });
});
