// A commit's message as the commit view shows it: its subject as the headline, the rest
// as its body, and the Co-Authored-By trailers as the people it was made with, shown by
// name rather than as text.

// A trailer: "Key: value", as git writes them in a message's last paragraph.
const TRAILER = /^[A-Za-z][\w-]*:\s/;
const CO_AUTHOR = /^co-authored-by:\s*(.+?)\s*<([^>]*)>\s*$/i;

/**
 * `message` as { subject, body, coAuthors: [{ name, email }] }. The subject is the first
 * paragraph, its lines joined, as git takes it. Co-authors come from the last paragraph
 * when it's all trailers; any other trailers there, as Signed-off-by, stay in the body.
 */
export function readMessage(message) {
  const paragraphs = message.replace(/\r\n?/g, "\n").trim().split(/\n\s*\n/);
  const subject = (paragraphs.shift() ?? "").split("\n").map((line) => line.trim()).join(" ");
  const coAuthors = [];
  const last = paragraphs.at(-1)?.split("\n");
  if (last?.every((line) => TRAILER.test(line))) {
    const others = last.filter((line) => {
      const match = line.match(CO_AUTHOR);
      if (match) coAuthors.push({ name: match[1], email: match[2] });
      return !match;
    });
    if (others.length) paragraphs[paragraphs.length - 1] = others.join("\n");
    else paragraphs.pop();
  }
  return { subject, body: paragraphs.join("\n\n"), coAuthors };
}

/**
 * How a commit came to be committed, for its byline: "together", as it was written;
 * "later", by its author, as a rebase, a cherry-pick or an amend does; or "by-other",
 * by someone else, as a maintainer applying a patch. Within a minute is the same moment.
 */
export function howCommitted({ author, committer }) {
  if (author.name !== committer.name || author.email !== committer.email) return "by-other";
  return Math.abs(author.time - committer.time) > 60 ? "later" : "together";
}
