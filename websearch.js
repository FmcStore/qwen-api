// Virtual web_search tool for tools-on turns.
//
// A tools-on turn has no search at all: the native-plugin kill flags
// (server.js:829) switch Qwen's own web_search off, precisely so emulated
// <tool_call> blocks survive instead of being intercepted upstream. The model
// does not know that — it reaches for Qwen's `web_search` anyway, and since
// 2026-08-25 that attempt renders as prose instead of vanishing.
//
// So we declare the tool ourselves and answer it proxy-side, out of a SECOND,
// isolated Qwen chat that declares no tools and leaves auto_search alone.
// Experiment A (README) is why it has to be a separate chat: search fires on the
// bare single-turn fast path and never on a tools-on turn, because that turn
// collapses history into `User:` / `Assistant:` transcript form. The prompt
// shape is the suppressor, not the flag — so the only way to get a search is to
// ask in a prompt shaped like the one that works.
//
// Lives outside server.js so the parsing is unit-testable (importing server.js
// starts the listener), same as video.js.

export const SEARCH_TOOL_NAME = "web_search";

export const SEARCH_TOOL = {
  type: "function",
  function: {
    name: SEARCH_TOOL_NAME,
    description: "Search the live web and get an answer with current information. Runs on this server. Use for anything time-sensitive: prices, news, releases, today's date.",
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "What to search for, as one plain-language query.",
        },
      },
      required: ["query"],
    },
  },
};

/**
 * The query string out of whatever shape the model produced.
 *
 * Qwen's own native plugin signature is `{"queries": ["..."]}` — an ARRAY under
 * a plural key — and that is what the model emits unprompted (captured
 * 2026-08-25, chat d24c4b53). Our schema declares a single `query` string, so
 * the coercion in toolparse.js leaves the plural key untouched and it has to be
 * read here or the call arrives with no query at all.
 *
 * Returns "" when there is nothing usable — the caller reports that instead of
 * searching for the empty string.
 */
export function searchQueryOf(rawArgs) {
  let args = rawArgs;
  if (typeof args === "string") {
    try { args = JSON.parse(args); } catch { return args.trim(); }
  }
  if (!args || typeof args !== "object") return "";
  const first = (v) => (Array.isArray(v) ? v.find((x) => typeof x === "string" && x.trim()) : v);
  const picked = first(args.query) ?? first(args.queries) ?? first(args.q) ?? first(args.search_query);
  return typeof picked === "string" ? picked.trim() : "";
}

/**
 * Format citation markers [[n]] into clickable markdown links and append a sources footer.
 * searchInfo is an array of objects: { title, url, hostname, index } from delta.extra.web_search_info.
 */
export function formatCitations(text, searchInfo) {
  if (!Array.isArray(searchInfo) || searchInfo.length === 0) return text;

  const byIndex = new Map();
  searchInfo.forEach((site, i) => {
    if (site && site.url) {
      const idx = typeof site.index === "number" ? site.index : i + 1;
      byIndex.set(idx, site);
    }
  });

  const isValidHttpUrl = (url) => {
    try {
      const u = new URL(url);
      return u.protocol === "http:" || u.protocol === "https:";
    } catch {
      return false;
    }
  };

  const getDomain = (site) => {
    if (site?.hostname) return site.hostname.replace(/^www\./i, "");
    try {
      const u = new URL(site.url);
      return u.protocol === "http:" || u.protocol === "https:" ? u.hostname.replace(/^www\./i, "") : (site?.title || "source");
    } catch {
      return site?.title || "source";
    }
  };

  // Collect unique citation indices used in text before replacing
  const usedIndices = [...new Set(
    [...text.matchAll(/\[\[?(\d+)\]\]?/g)].map((m) => parseInt(m[1], 10))
  )].sort((a, b) => a - b);

  // Replace [[n]] or [n] inline with [domain](url)
  let result = text
    .replace(/\[\[(\d+)\]\]/g, (match, numStr) => {
      const n = parseInt(numStr, 10);
      const site = byIndex.get(n);
      if (!site || !isValidHttpUrl(site.url)) return match;
      return `[${getDomain(site)}](${site.url})`;
    })
    .replace(/(?<!\[)\[(\d+)\](?!\()/g, (match, numStr) => {
      const n = parseInt(numStr, 10);
      const site = byIndex.get(n);
      if (!site || !isValidHttpUrl(site.url)) return match;
      return `[${getDomain(site)}](${site.url})`;
    });

  const sourcesList = (usedIndices.length > 0
    ? usedIndices.map((n) => byIndex.get(n)).filter(Boolean)
    : Array.from(byIndex.values())).filter(site => isValidHttpUrl(site?.url));

  const sources = sourcesList
    .map((site, i) => `${i + 1}. [${site.title || getDomain(site)}](${site.url})`)
    .join("\n");

  if (sources) {
    result += `\n\n**Sources:**\n${sources}`;
  }
  return result;
}

/** How a finished search reads in the reply. The answer is already synthesized
    prose — the isolated chat answers the question, it does not return a SERP.

    The chat runs with Qwen's native plugins ON (that is the point), and it
    narrates them: the reply routinely ends with a `<tool_call>` block for
    `web_search` that upstream already executed. Observed in Experiment A's A3
    probe and again on the first live run of this path (2026-08-25) — the block
    reached the client verbatim and read like a failed tool call. It is echo, so
    it goes. An UNCLOSED one is stripped too, since it is the same echo cut off
    by the end of the generation. */
export function buildSearchContent(query, answer, searchInfo = null) {
  let body = String(answer ?? "")
    .replace(/<tool_calls?>[\s\S]*?<\/tool_calls?>/gi, "")
    .replace(/<tool_calls?>[\s\S]*$/i, "")
    .trim();
  if (!body) return `\nWeb search for "${query}" returned nothing.\n`;
  if (searchInfo) {
    body = formatCitations(body, searchInfo);
  }
  return `\n**Web search:** ${query}\n\n${body}\n`;
}
