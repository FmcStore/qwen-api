import assert from "node:assert/strict";
import test from "node:test";

import { extractQwenImageUrls } from "../artifacts.js";

test("extractQwenImageUrls finds Qwen-hosted images in nested SSE metadata", () => {
  const event = {
    choices: [{
      delta: {
        content: "Done",
        extra: {
          result: {
            image_url: "https://cdn.qwenlm.ai/results/green-apple.png?token=abc&x=1",
          },
        },
      },
    }],
    unrelated: "https://example.com/not-an-artifact.png",
  };

  assert.deepEqual(extractQwenImageUrls(JSON.stringify(event)), [
    "https://cdn.qwenlm.ai/results/green-apple.png?token=abc&x=1",
  ]);
});

test("extractQwenImageUrls handles markdown and de-duplicates URLs", () => {
  const url = "https://wanx.alicdn.com/output/result.webp?Expires=123";
  const event = { content: `Rendered: ![result](${url})`, output_url: url };

  assert.deepEqual(extractQwenImageUrls(event), [url]);
});

test("extractQwenImageUrls keeps an image hint through nested url fields", () => {
  const event = {
    choices: [{
      delta: {
        images: [{ url: "https://qwen-webui-prod.oss-accelerate.aliyuncs.com/output/generated?signature=abc" }],
      },
    }],
  };

  assert.deepEqual(extractQwenImageUrls(event), [
    "https://qwen-webui-prod.oss-accelerate.aliyuncs.com/output/generated?signature=abc",
  ]);
});

test("extractQwenImageUrls excludes re-signed input image URLs", () => {
  const input = "https://qwen-webui-prod.oss-accelerate.aliyuncs.com/input/apple.jpg?signature=old";
  const echoed = "https://qwen-webui-prod.oss-accelerate.aliyuncs.com/input/apple.jpg?signature=new";
  const generated = "https://qwen-webui-prod.oss-accelerate.aliyuncs.com/output/apple.jpg?signature=new";

  assert.deepEqual(extractQwenImageUrls({ images: [echoed, generated] }, { exclude: [input] }), [generated]);
});
