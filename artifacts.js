// Generated files currently come from Qwen's CDN or Alibaba OSS.
const ALLOWED_HOSTS = ["qwenlm.ai", "alicdn.com", "aliyuncs.com"];

function isAllowedHost(hostname) {
  const host = hostname.toLowerCase();
  return ALLOWED_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}

function isAllowedSource(source) {
  if (typeof source !== "string") return false;
  if (/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(source)) return true;
  try {
    const parsed = new URL(source);
    return parsed.protocol === "https:" && isAllowedHost(parsed.hostname);
  } catch {
    return false;
  }
}

function cleanUrlCandidate(candidate) {
  if (typeof candidate !== "string") return null;
  let value = candidate.trim().replaceAll("\\/", "/");
  value = value.replace(/[),.;]+$/g, "");
  if (!isAllowedSource(value)) return null;
  return value;
}

function isImageHint(key) {
  return /image|img|picture|photo|asset|media|output|result/i.test(key || "");
}

function sourceIdentity(source) {
  if (typeof source !== "string") return source;
  if (source.startsWith("data:")) return source;
  try {
    const parsed = new URL(source);
    return `${parsed.protocol}//${parsed.hostname.toLowerCase()}${parsed.pathname}`;
  } catch {
    return source;
  }
}

function looksLikeImageUrl(value, keyHint = "") {
  if (/^data:image\/(?:png|jpe?g|webp|gif);base64,/i.test(value)) return true;
  try {
    const parsed = new URL(value);
    return (
      /\.(?:png|jpe?g|webp|gif)(?:$|[?#])/i.test(parsed.pathname) ||
      /(?:format|content[-_]?type)=image\//i.test(parsed.search) ||
      isImageHint(keyHint)
    );
  } catch {
    return false;
  }
}

function stringsIn(value, keyHint = "", seen = new Set()) {
  if (typeof value === "string") {
    const results = [];
    const trimmed = value.trim();

    // Raw SSE events are passed as JSON strings. Parse them first so nested
    // field names (image_url, output, attachments, etc.) remain available.
    if ((trimmed.startsWith("{") || trimmed.startsWith("[")) && trimmed.length < 2_000_000) {
      try {
        return stringsIn(JSON.parse(trimmed), keyHint, seen);
      } catch {
        // It is ordinary text, so continue with URL scanning below.
      }
    }

    const candidates = value.match(/https?:\/\/[^\s"'<>]+/gi) || [];
    const dataUrls = value.match(/data:image\/(?:png|jpe?g|webp|gif);base64,[A-Za-z0-9+/=]+/gi) || [];
    for (const candidate of [...candidates, ...dataUrls]) {
      const cleaned = cleanUrlCandidate(candidate);
      if (cleaned && looksLikeImageUrl(cleaned, keyHint)) results.push(cleaned);
    }
    return results;
  }

  if (value === null || typeof value !== "object") return [];
  if (seen.has(value)) return [];
  seen.add(value);

  const results = [];
  if (Array.isArray(value)) {
    for (const item of value) results.push(...stringsIn(item, keyHint, seen));
  } else {
    for (const [key, item] of Object.entries(value)) {
      const nextHint = isImageHint(key) ? key : keyHint;
      results.push(...stringsIn(item, nextHint, seen));
    }
  }
  return results;
}

export function extractQwenImageUrls(value, options = {}) {
  const excluded = new Set(
    Array.from(options.exclude || [])
      .filter((item) => typeof item === "string")
      .map(sourceIdentity),
  );
  const all = [...new Set(stringsIn(value).filter((url) => !excluded.has(sourceIdentity(url))))];
  // Qwen returns 2 URLs per generation: a /t2i/ preview and a /image_gen/ or
  // /image_edit/ final. When both exist, drop the /t2i/ duplicate to avoid
  // saving/displaying the same image twice.
  const hasNonT2i = all.some((url) => !url.includes("/t2i/"));
  if (hasNonT2i && all.length > 1) {
    return all.filter((url) => !url.includes("/t2i/"));
  }
  return all;
}
