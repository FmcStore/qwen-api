# Implementation Plan - Fix Image Aspect Ratio & Subject Framing Cutoff

## 1. Problem Diagnosis

When editing or generating images in OpenCode (`/v1/chat/completions`), Qwen generates 16:9 landscape crops (1664x928 / 1792x1024) that cut off heads and feet (`1787716929.png`).

### Why this happens today:
1. **`/v1/chat/completions` passes `mediaType = null`**:
   In `server.js:2140`, `handleChatCompletions` calls `buildQwenMessages(history, reqModel, files, null, body)`. Because `mediaType` is `null`, `buildImageConfig()` is completely bypassed.
2. **Missing `default_aspect_ratio` and `image_edit` configuration**:
   Because `buildImageConfig` is bypassed, requests with uploaded files send `chat_type: "t2t"`, `extra.meta.subChatType: "t2t"`, and omit `default_aspect_ratio`. Qwen's backend defaults to a 16:9 canvas.
3. **`normalizeAspectRatio("auto")` returns `null`**:
   In `image.js`, `"auto"` was treated as `null` and omitted entirely. On Alibaba's backend, the official web UI sends literal string `"auto"` (`default_aspect_ratio: "auto"` and `extra.meta.aspectRatio: "auto"`), which tells Qwen's vision model to inherit source image dimensions.

---

## 2. Proposed Changes

### Component 1: `image.js`
- **`normalizeAspectRatio(value)`**:
  - Valid standard ratios (`1:1`, `4:3`, `3:4`, `16:9`, `9:16`) pass through.
  - Dimension strings (e.g. `1024x1792` -> `9:16`, `1792x1024` -> `16:9`) calculate the closest ratio.
  - `"auto"`, `""`, `null`, or `undefined` returns `"auto"`.
- **`buildImageConfig(files, options)`**:
  - When `files.length > 0`: `chatType = "image_edit"`, `subChatType = "image_edit"`.
  - When `files.length === 0`: `chatType = "t2t"`, `subChatType = "t2i"`.
  - `featureConfig.default_aspect_ratio = ratio || "auto"`.
  - `featureConfig.image_generation = true`.
  - `featureConfig.plugins_enabled = true`.
  - `extra.meta.subChatType = subType`.
  - `extra.meta.aspectRatio = ratio || "auto"`.
  - `extra.meta.mode = "image_generation"`.

### Component 2: `server.js`
- **`buildQwenMessages(history, model, files, mediaType, options)`**:
  - Automatically detect when image configuration is needed: if `mediaType === "image"` OR `files.length > 0` (or `options.aspect_ratio` / `options.size` provided).
  - Apply `buildImageConfig(files, options)` for all file-bearing chat turns and image endpoints.
  - When client tool calling is enabled (`body.tools`), preserve native image capabilities if `files.length > 0` so in-chat image editing is not disabled.
- **API route handlers**:
  - Parse `aspect_ratio`, `aspectRatio`, `size` from incoming request body and query params in `/v1/chat/completions`, `/v1/images/generations`, and `/v1/images/edits`.

### Component 3: Unit Tests (`tests/image_aspect_ratio.test.mjs`)
- Update unit tests to verify:
  1. `"auto"`, `null`, `undefined`, and `"Auto"` return `"auto"`.
  2. `buildImageConfig` produces `default_aspect_ratio: "auto"` and `extra.meta.aspectRatio: "auto"` for image edits.
  3. Explicit overrides (e.g. `"9:16"`, `"1:1"`) correctly populate `default_aspect_ratio` and `extra.meta.aspectRatio`.

---

## 3. Verification Plan

### Automated Tests
- Run `npm test` across all 10 test suites (including `tests/image_aspect_ratio.test.mjs`).

### Live Verification
- Send a test chat completion with attached portrait image `1787712452.png` and verify that the outgoing payload carries `default_aspect_ratio: "auto"` and `sub_chat_type: "image_edit"`.
- Verify the generated image output preserves the portrait framing and does not cut off head or feet.
