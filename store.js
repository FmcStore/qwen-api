// Tiny persistent conversation store.
//
// Keeps role-tagged messages ({role, content}) per conversation id, in a single
// JSON file. Zero dependencies. Writes are synchronous and atomic-ish (write to a
// temp file then rename) so a crash mid-write won't corrupt the store.

import fs from "node:fs";
import path from "node:path";

const FILE = process.env.MEMORY_FILE || path.join(process.cwd(), "memory.json");
const MAX_CONVERSATIONS = 100;
const MAX_MESSAGES_PER_CONV = 50;
const MAX_BYTES = Number(process.env.QWEN_MEMORY_MAX_BYTES || 512 * 1024);

function readAll() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return {}; // missing or unreadable -> empty store
  }
}

function writeAll(data) {
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, FILE);
}

// Return a *copy* of a conversation's messages (mutating it won't touch the store
// until you call save()).
export function getHistory(conversationId) {
  const all = readAll();
  const list = all[conversationId];
  return Array.isArray(list) ? list.map((m) => ({ ...m })) : [];
}

// Drop oldest conversations until the serialized store fits MAX_BYTES.
// ponytail: one giant single conversation can still exceed the cap alone —
// ceiling accepted; upgrade path is per-message truncation.
// Concurrency note: all callers run inside the single browser mutex today;
// before adding a worker pool (§3.10), wrap saveHistory in read-modify-write locking.
function trimToBytes(all, keepId) {
  let size = Buffer.byteLength(JSON.stringify(all));
  if (size <= MAX_BYTES) return;
  for (const k of Object.keys(all)) {
    if (size <= MAX_BYTES) break;
    if (k === keepId) continue;
    size -= Buffer.byteLength(JSON.stringify(all[k])) + 6; // entry + key/syntax overhead
    delete all[k];
  }
}

// Replace a conversation's messages and persist with size capping.
// Serialized read-modify-write: concurrent callers (worker pool) would otherwise
// drop each other's updates. Callers may fire-and-forget the returned promise.
let saveChain = Promise.resolve();
export function saveHistory(conversationId, messages) {
  saveChain = saveChain.then(() => {
    const all = readAll();
    all[conversationId] = Array.isArray(messages) ? messages.slice(-MAX_MESSAGES_PER_CONV) : messages;

    const keys = Object.keys(all);
    if (keys.length > MAX_CONVERSATIONS) {
      const keysToRemove = keys.slice(0, keys.length - MAX_CONVERSATIONS);
      for (const k of keysToRemove) delete all[k];
    }

    trimToBytes(all, conversationId);
    writeAll(all);
  });
  return saveChain;
}

// Clear one conversation. Returns true if it existed.
export function clearConversation(conversationId) {
  const all = readAll();
  if (!(conversationId in all)) return false;
  delete all[conversationId];
  writeAll(all);
  return true;
}

export const MEMORY_FILE = FILE;
