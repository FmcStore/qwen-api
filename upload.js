// File upload for vision and attachments.
//
// chat.qwen.ai stores attachments in Alibaba OSS. The flow is:
//   1. POST /api/v2/files/getstsToken -> temporary OSS STS credentials + a
//      pre-assigned object path / file id.
//   2. PUT the bytes to OSS, signed with OSS4-HMAC-SHA256 (implemented here; no
//      external OSS SDK needed).
//   3. Reference the returned file url + id in the chat message's `files` array.

import { createHmac, createHash, randomUUID } from "node:crypto";
import dns from "node:dns/promises";
import net from "node:net";

const hmac = (key, data) => createHmac("sha256", key).update(data).digest();
const sha256hex = (data) => createHash("sha256").update(data).digest("hex");
const encodeKey = (key) => key.split("/").map(encodeURIComponent).join("/");

const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 3;

// Everything not routable on the public internet. `file_url` arrives straight
// from a chat message, so without this the proxy is an open SSRF hop —
// http://169.254.169.254/latest/meta-data/ being the obvious one, every LAN
// service being the rest. BlockList also matches IPv4-mapped IPv6 against the
// IPv4 rules, so ::ffff:169.254.169.254 is covered by the /16 below.
const PRIVATE_RANGES = new net.BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],       // "this network"
  ["10.0.0.0", 8],      // RFC1918
  ["100.64.0.0", 10],   // CGNAT
  ["127.0.0.0", 8],     // loopback
  ["169.254.0.0", 16],  // link-local — cloud metadata lives here
  ["172.16.0.0", 12],   // RFC1918
  ["192.0.0.0", 24],    // IETF protocol assignments
  ["192.168.0.0", 16],  // RFC1918
  ["198.18.0.0", 15],   // benchmarking
  ["224.0.0.0", 4],     // multicast
  ["240.0.0.0", 4],     // reserved, includes 255.255.255.255
]) {
  PRIVATE_RANGES.addSubnet(network, prefix, "ipv4");
}
PRIVATE_RANGES.addAddress("::", "ipv6");        // unspecified
PRIVATE_RANGES.addAddress("::1", "ipv6");       // loopback
PRIVATE_RANGES.addSubnet("fc00::", 7, "ipv6");  // unique-local
PRIVATE_RANGES.addSubnet("fe80::", 10, "ipv6"); // link-local
PRIVATE_RANGES.addSubnet("ff00::", 8, "ipv6");  // multicast
PRIVATE_RANGES.addSubnet("64:ff9b::", 96, "ipv6"); // NAT64 — smuggles a v4 target

// Resolve the host and refuse the fetch if any answer lands somewhere private.
// Every address is checked, not just the first: a name with one public and one
// private A record must not be reachable through the second.
//
// ponytail: resolve-then-connect leaves a DNS-rebinding window — an attacker who
// controls the zone can re-point the name between this check and the socket.
// Closing it needs undici's dispatcher with a custom connect.lookup, i.e. a new
// dependency. Upgrade path if this proxy is ever exposed off-box.
async function assertPublicHost(hostname, lookupImpl) {
  const host = hostname.replace(/^\[|\]$/g, ""); // URL keeps the brackets on IPv6 literals
  const answers = await lookupImpl(host, { all: true });
  if (!answers.length) throw new Error(`could not resolve ${host}`);
  for (const { address, family } of answers) {
    if (PRIVATE_RANGES.check(address, family === 6 ? "ipv6" : "ipv4")) {
      throw new Error(`refusing to fetch a private address (${host} -> ${address})`);
    }
  }
}

// Walk redirects by hand. `fetch` follows them silently, so a public host is free
// to 302 straight at the metadata endpoint — every hop has to be re-resolved and
// re-checked.
async function fetchPublicUrl(fileUrl, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const lookupImpl = options.lookupImpl || dns.lookup;
  const timeoutMs = options.timeoutMs || FETCH_TIMEOUT_MS;

  let current = fileUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const parsed = new URL(current);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`unsupported redirect scheme (${parsed.protocol})`);
    }
    await assertPublicHost(parsed.hostname, lookupImpl);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(current, { redirect: "manual", signal: controller.signal });
    } finally {
      clearTimeout(timer);
    }

    if (res.status < 300 || res.status >= 400) return res;

    if (hop === MAX_REDIRECTS) throw new Error("file download exceeded redirect limit");
    const location = res.headers.get("location");
    if (!location) throw new Error("file download returned a redirect without a location");
    current = new URL(location, current).toString();
  }
  throw new Error("file download failed");
}

// Turn an OpenAI image_url (or any file_url) value into raw bytes + mime type.
// Accepts data URLs (base64) and http(s) URLs.
export async function fetchFileBytes(fileUrl, options = {}) {
  if (typeof fileUrl !== "string") throw new Error("file_url must be a string");
  const dataMatch = fileUrl.match(/^data:([^;,]+)?(;base64)?,(.*)$/s);
  if (dataMatch) {
    const mime = dataMatch[1] || "application/octet-stream";
    const isBase64 = Boolean(dataMatch[2]);
    const bytes = isBase64
      ? Buffer.from(dataMatch[3], "base64")
      : Buffer.from(decodeURIComponent(dataMatch[3]), "utf8");
    return { bytes, mime };
  }
  if (/^https?:\/\//i.test(fileUrl)) {
    const res = await fetchPublicUrl(fileUrl, options);
    if (!res.ok) throw new Error(`could not fetch file (${res.status})`);
    const mime = res.headers.get("content-type") || "application/octet-stream";
    const bytes = Buffer.from(await res.arrayBuffer());
    return { bytes, mime: mime.split(";")[0] };
  }
  throw new Error("unsupported file_url (expected data: or http(s) URL)");
}

function extFromMime(mime) {
  const map = {
    // Images
    "image/png": "png", "image/jpeg": "jpg", "image/jpg": "jpg", "image/webp": "webp", "image/gif": "gif",
    // Video
    "video/mp4": "mp4", "video/quicktime": "mov", "video/x-msvideo": "avi", "video/webm": "webm", "video/x-matroska": "mkv",
    // Audio
    "audio/mpeg": "mp3", "audio/wav": "wav", "audio/ogg": "ogg", "audio/flac": "flac", "audio/mp4": "m4a", "audio/aac": "aac",
    // Documents
    "application/pdf": "pdf", "application/msword": "doc", "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
    "application/vnd.ms-excel": "xls", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
    "application/vnd.ms-powerpoint": "ppt", "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
    "text/plain": "txt", "text/markdown": "md", "text/csv": "csv", "application/json": "json", "application/xml": "xml", "text/html": "html",
    "application/zip": "zip"
  };
  return map[mime] || "bin";
}

// PUT bytes to OSS using STS creds, signed with OSS4-HMAC-SHA256.
async function ossPut(sts, bytes, contentType) {
  const region = sts.region.replace(/^oss-/, ""); // oss-ap-southeast-1 -> ap-southeast-1
  const host = `${sts.bucketname}.${sts.endpoint}`;
  const objectKey = sts.file_path;

  const now = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const date = `${now.getUTCFullYear()}${p(now.getUTCMonth() + 1)}${p(now.getUTCDate())}`;
  const iso = `${date}T${p(now.getUTCHours())}${p(now.getUTCMinutes())}${p(now.getUTCSeconds())}Z`;
  const scope = `${date}/${region}/oss/aliyun_v4_request`;
  const payloadHash = "UNSIGNED-PAYLOAD";

  const signed = {
    "content-type": contentType,
    host,
    "x-oss-content-sha256": payloadHash,
    "x-oss-date": iso,
    "x-oss-security-token": sts.security_token,
  };
  const canonicalHeaders = Object.keys(signed).sort().map((k) => `${k}:${signed[k]}\n`).join("");
  const canonicalRequest = [
    "PUT",
    "/" + sts.bucketname + "/" + encodeKey(objectKey),
    "",
    canonicalHeaders,
    "host",
    payloadHash,
  ].join("\n");
  const stringToSign = ["OSS4-HMAC-SHA256", iso, scope, sha256hex(canonicalRequest)].join("\n");

  let key = hmac("aliyun_v4" + sts.access_key_secret, date);
  key = hmac(key, region);
  key = hmac(key, "oss");
  key = hmac(key, "aliyun_v4_request");
  const signature = createHmac("sha256", key).update(stringToSign).digest("hex");

  const authorization =
    `OSS4-HMAC-SHA256 Credential=${sts.access_key_id}/${scope},` +
    `AdditionalHeaders=host,Signature=${signature}`;

  const res = await fetch(`https://${host}/${encodeKey(objectKey)}`, {
    method: "PUT",
    headers: {
      "Content-Type": contentType,
      "x-oss-content-sha256": payloadHash,
      "x-oss-date": iso,
      "x-oss-security-token": sts.security_token,
      Authorization: authorization,
    },
    body: bytes,
  });
  if (res.status !== 200) {
    throw new Error(`OSS upload failed (${res.status}): ${(await res.text()).slice(0, 200)}`);
  }
}

export function getImageDimensions(bytes, mime) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  try {
    if (mime === "image/png" && bytes.length >= 24) {
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
        return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
      }
    }
    if (mime === "image/gif" && bytes.length >= 10) {
      return { width: bytes.readUInt16LE(6), height: bytes.readUInt16LE(8) };
    }
    if ((mime === "image/jpeg" || mime === "image/jpg") && bytes.length >= 4) {
      let offset = 2;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) break;
        const marker = bytes[offset + 1];
        if (marker === 0xd9 || marker === 0xda) break; // EOI or SOS
        const len = bytes.readUInt16BE(offset + 2);
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xcf)) {
          if (marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
            return { height: bytes.readUInt16BE(offset + 5), width: bytes.readUInt16BE(offset + 7) };
          }
        }
        offset += 2 + len;
      }
    }
    if (mime === "image/webp" && bytes.length >= 30) {
      const riff = bytes.toString("ascii", 0, 4);
      const webp = bytes.toString("ascii", 8, 12);
      if (riff === "RIFF" && webp === "WEBP") {
        const type = bytes.toString("ascii", 12, 16);
        if (type === "VP8 " && bytes.length >= 30) {
          const width = bytes.readUInt16LE(26) & 0x3fff;
          const height = bytes.readUInt16LE(28) & 0x3fff;
          return { width, height };
        }
        if (type === "VP8L" && bytes.length >= 25) {
          const b0 = bytes[21], b1 = bytes[22], b2 = bytes[23], b3 = bytes[24];
          const width = 1 + (((b1 & 0x3f) << 8) | b0);
          const height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
          return { width, height };
        }
        if (type === "VP8X" && bytes.length >= 30) {
          const width = 1 + bytes.readUIntLE(24, 3);
          const height = 1 + bytes.readUIntLE(27, 3);
          return { width, height };
        }
      }
    }
  } catch {}
  return null;
}

// Upload any file and return the message `files` entry that references it.
// `headers` is the shared qwenHeaders() function; `base` is the Qwen API origin.
export async function uploadFile(headers, base, bytes, mime, providedFilename = null) {
  let qwenFileType = "file";
  if (mime.startsWith("video/")) qwenFileType = "video";
  else if (mime.startsWith("audio/")) qwenFileType = "audio";
  else if (mime.startsWith("image/")) qwenFileType = "image";

  const filename = providedFilename || `${qwenFileType}-${randomUUID().slice(0, 8)}.${extFromMime(mime)}`;
  
  const res = await fetch(`${base}/api/v2/files/getstsToken`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({ filename, filesize: bytes.length, filetype: qwenFileType }),
  });
  const j = await res.json().catch(() => ({}));
  const sts = j?.data;
  if (!sts?.file_url) throw new Error(`getstsToken failed: ${JSON.stringify(j).slice(0, 200)}`);

  await ossPut(sts, bytes, mime);

  let userId = null;
  const match = sts.file_url.match(/\.com\/([^/]+)\//);
  if (match) userId = match[1];

  const nowTime = Date.now();
  const meta = {
    name: filename,
    size: bytes.length,
    content_type: mime,
  };
  
  return {
    type: qwenFileType,
    file: {
      created_at: nowTime,
      data: {},
      filename: filename,
      hash: null,
      id: sts.file_id,
      user_id: userId,
      meta,
      update_at: nowTime,
      lastModified: nowTime,
      name: filename,
      webkitRelativePath: "",
      size: bytes.length,
      type: mime,
    },
    id: sts.file_id,
    url: sts.file_url,
    name: filename,
    collection_name: "",
    progress: qwenFileType === "file" ? 100 : 0, // Files show 100% progress instantly
    status: "uploaded",
    greenNet: "success",
    size: bytes.length,
    error: "",
    itemId: randomUUID(),
    file_type: mime,
    showType: qwenFileType,
    file_class: qwenFileType === "image" ? "vision" : qwenFileType,
    uploadTaskId: sts.file_id || randomUUID(),
  };
}
