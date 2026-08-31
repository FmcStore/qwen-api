# Walkthrough - Image Aspect Ratio & Framing Fix

## 1. Summary of Changes

### `upload.js`
- Added `getImageDimensions(bytes, mime)` to extract native `width` and `height` from PNG, JPEG, WebP, and GIF image buffers without external dependencies.
- Added `{ width, height }` to the uploaded file's `meta` object and `file` struct so Qwen's backend knows the exact source image dimensions upon upload.

### `image.js`
- Updated `normalizeAspectRatio` to return literal string `"auto"` for unspecified/empty inputs instead of `null`.
- Updated `buildImageConfig` to serialize `default_aspect_ratio: "auto"` and `extra.meta.aspectRatio: "auto"` for image edits matching the official web UI.
- Added `extractPromptRatio` to extract and strip `@<ratio>` markers (e.g. `@9:16`, `@1:1`, `@16:9`, `@3:4`, `@4:3`) from prompt text.
- Added `isImageModel` helper to recognize direct image model requests (`qwen-image`, `qwen-image-edit`, `wan3.0-image`).
- Added virtual tool schemas `IMAGE_TOOL` (`generate_image`) and `IMAGE_EDIT_TOOL` (`edit_image`).

### `server.js`
- **`buildCompletionPayload`**: Configured top-level `payload.size` for image generation and image edits when an explicit aspect ratio is set.
- **`buildQwenMessages`**: Added routing for direct image models (`isImageModel(model)`) while keeping regular chat turns (`t2t`) untouched so vision Q&A, PDF reading, and thinking are preserved.
- **`handleChatCompletions`**:
  - Injected `IMAGE_TOOL` and `IMAGE_EDIT_TOOL` into `body.tools` for tool-enabled clients (OpenCode).
  - Intercepted `generate_image` and `edit_image` calls via `splitVirtualCalls`, running them in isolated sub-chats with native image plugins enabled.
  - Added direct image model handling for requests targeted at `qwen-image` / `qwen-image-edit`.

### `tests/image_aspect_ratio.test.mjs`
- Updated unit test suite to test `"auto"` serialization, dimension parsing, `@` prompt ratio extraction, image model detection, and virtual tool schemas.

---

## 2. Verification Results

- Ran `npm test`: **66/66 unit tests passing**.
- Daemon restarted and confirmed healthy on `http://127.0.0.1:8787/v1/models`.
