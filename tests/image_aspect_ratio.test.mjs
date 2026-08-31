import assert from "node:assert/strict";
import test from "node:test";

import { normalizeAspectRatio, buildImageConfig, extractPromptRatio, parseImageCommand, isImageModel, IMAGE_TOOL, IMAGE_EDIT_TOOL, RATIOS } from "../image.js";
import { getImageDimensions } from "../upload.js";

test("normalizeAspectRatio handles exact standard ratios", () => {
  for (const r of RATIOS) {
    assert.equal(normalizeAspectRatio(r), r, `ratio ${r} must pass through`);
  }
});

test("normalizeAspectRatio converts pixel dimensions to nearest standard ratio", () => {
  assert.equal(normalizeAspectRatio("1024x1024"), "1:1");
  assert.equal(normalizeAspectRatio("512x512"), "1:1");
  assert.equal(normalizeAspectRatio("1024x1792"), "9:16");
  assert.equal(normalizeAspectRatio("1080x1920"), "9:16");
  assert.equal(normalizeAspectRatio("1792x1024"), "16:9");
  assert.equal(normalizeAspectRatio("1920x1080"), "16:9");
  assert.equal(normalizeAspectRatio("1152x896"), "4:3");
  assert.equal(normalizeAspectRatio("896x1152"), "3:4");
  assert.equal(normalizeAspectRatio("1536 x 864"), "16:9");
  assert.equal(normalizeAspectRatio("1536 x 1024"), "4:3");
});

test("normalizeAspectRatio returns 'auto' for auto or empty/invalid inputs", () => {
  assert.equal(normalizeAspectRatio("auto"), "auto");
  assert.equal(normalizeAspectRatio("Auto"), "auto");
  assert.equal(normalizeAspectRatio(""), "auto");
  assert.equal(normalizeAspectRatio(null), "auto");
  assert.equal(normalizeAspectRatio(undefined), "auto");
  assert.equal(normalizeAspectRatio("invalid-string"), "auto");
});

test("buildImageConfig sets up Qwen-Image 3.0 Pro correctly", () => {
  // Default t2i without options defaults to 1:1
  const t2iDef = buildImageConfig([], {});
  assert.equal(t2iDef.chatType, "t2i");
  assert.equal(t2iDef.subChatType, "t2i");
  assert.equal(t2iDef.featureConfig.thinking_mode, "Fast");
  assert.equal(t2iDef.extra.meta.subChatType, "t2i");
  assert.equal(t2iDef.extra.meta.model, "qwen-image-3.0-pro");
  assert.equal(t2iDef.extra.meta.size, "1:1");
  assert.equal(t2iDef.ratio, "1:1");

  // With explicit ratio
  const t2iCustom = buildImageConfig([], { aspect_ratio: "9:16" });
  assert.equal(t2iCustom.extra.meta.size, "9:16");
  assert.equal(t2iCustom.ratio, "9:16");

  // Edit with attached files defaults to auto
  const dummyFile = { id: "file-xyz", url: "https://oss/img.png" };
  const editDef = buildImageConfig([dummyFile], {});
  assert.equal(editDef.chatType, "t2i");
  assert.equal(editDef.subChatType, "t2i");
  assert.equal(editDef.extra.meta.model, "qwen-image-3.0-pro");
  assert.equal(editDef.extra.meta.size, "auto");
  assert.equal(editDef.ratio, "auto");
});

test("extractPromptRatio extracts @ markers cleanly", () => {
  const r1 = extractPromptRatio("make a logo for my coffee shop @1:1");
  assert.equal(r1.ratio, "1:1");
  assert.equal(r1.prompt, "make a logo for my coffee shop");

  const r2 = extractPromptRatio("portrait of a cyberpunk hacker @9:16 in rain");
  assert.equal(r2.ratio, "9:16");
  assert.equal(r2.prompt, "portrait of a cyberpunk hacker in rain");

  const r3 = extractPromptRatio("no ratio specified here");
  assert.equal(r3.ratio, null);
  assert.equal(r3.prompt, "no ratio specified here");
});

test("parseImageCommand extracts triggers and ratio markers cleanly", () => {
  const c1 = parseImageCommand("@edit give her a lakers outfit @auto");
  assert.equal(c1.isTrigger, true);
  assert.equal(c1.ratio, "auto");
  assert.equal(c1.prompt, "give her a lakers outfit");

  const c2 = parseImageCommand("@image cyberpunk city at night @16:9");
  assert.equal(c2.isTrigger, true);
  assert.equal(c2.ratio, "16:9");
  assert.equal(c2.prompt, "cyberpunk city at night");

  const c3 = parseImageCommand("what is she wearing in this picture?");
  assert.equal(c3.isTrigger, false);
  assert.equal(c3.ratio, null);
  assert.equal(c3.prompt, "what is she wearing in this picture?");
});

test("isImageModel identifies image models", () => {
  assert.equal(isImageModel("qwen-image"), true);
  assert.equal(isImageModel("qwen-image-edit"), true);
  assert.equal(isImageModel("wan3.0-image"), true);
  assert.equal(isImageModel("qwen3.8-max"), false);
  assert.equal(isImageModel("qwen3.5-plus"), false);
});

test("IMAGE_TOOL and IMAGE_EDIT_TOOL have valid schemas", () => {
  assert.equal(IMAGE_TOOL.function.name, "generate_image");
  assert.equal(IMAGE_EDIT_TOOL.function.name, "edit_image");
  assert.ok(IMAGE_TOOL.function.parameters.properties.prompt);
  assert.ok(IMAGE_EDIT_TOOL.function.parameters.properties.aspect_ratio);
});

test("getImageDimensions parses PNG buffer", () => {
  const pngBuf = Buffer.alloc(30);
  pngBuf[0] = 0x89; pngBuf[1] = 0x50; pngBuf[2] = 0x4e; pngBuf[3] = 0x47;
  pngBuf.writeUInt32BE(100, 16);
  pngBuf.writeUInt32BE(200, 20);
  const dims = getImageDimensions(pngBuf, "image/png");
  assert.deepEqual(dims, { width: 100, height: 200 });
});
