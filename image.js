// Image generation and edit helpers.
//
// Lives outside server.js so ratio math and payload shapes are unit-testable
// without starting the HTTP listener.

export const RATIOS = ["1:1", "4:3", "3:4", "16:9", "9:16"];

export const ratioOf = (r) => {
  const [w, h] = r.split(":").map(Number);
  return w / h;
};

/**
 * Normalizes input dimensions or ratio strings into supported Qwen ratios.
 * "1024x1792" -> "9:16", "1792x1024" -> "16:9", "1152x896" -> "4:3", etc.
 * Known ratios pass through.
 * Unspecified, null, undefined, "", or "auto" returns "auto".
 */
export function normalizeAspectRatio(value) {
  const s = String(value ?? "").trim().toLowerCase();
  if (!s || s === "auto") return "auto";
  if (RATIOS.includes(s)) return s;
  const m = s.match(/^(\d+)\s*x\s*(\d+)$/);
  if (!m) return "auto";
  const want = Number(m[1]) / Number(m[2]);
  return RATIOS.reduce((a, b) => (Math.abs(ratioOf(a) - want) <= Math.abs(ratioOf(b) - want) ? a : b));
}

/**
 * Build featureConfig and extra.meta for image turns (t2i and image_edit).
 */
export function buildImageConfig(files = [], options = {}) {
  const isEdit = Array.isArray(files) && files.length > 0;
  const rawRatio = options.aspect_ratio || options.size || options.aspectRatio;
  const ratio = rawRatio ? normalizeAspectRatio(rawRatio) : (isEdit ? "auto" : "1:1");

  const featureConfig = {
    thinking_enabled: false,
    output_schema: "phase",
    research_mode: "normal",
    auto_thinking: false,
    thinking_mode: "Fast",
    auto_search: true,
  };

  const extra = {
    meta: {
      subChatType: "t2i",
      size: ratio,
      model: "qwen-image-3.0-pro",
    },
  };

  return { chatType: "t2i", subChatType: "t2i", featureConfig, extra, ratio };
}

export const isImageModel = (model) => {
  if (typeof model !== "string") return false;
  const lower = model.toLowerCase();
  return lower.includes("image") || lower.startsWith("dall-e");
};

/**
 * Extracts prompt ratio markers like "@9:16", "@16:9", "@1:1", "@4:3", "@3:4", "@auto".
 * Strips the marker from the returned text prompt.
 */
export function extractPromptRatio(prompt) {
  if (typeof prompt !== "string") return { prompt: "", ratio: null };
  const match = prompt.match(/(?:^|\s)@(\d+:\d+|\d+x\d+|auto)(?:\s|$)/i);
  if (!match) return { prompt, ratio: null };
  const ratio = normalizeAspectRatio(match[1]);
  const cleaned = prompt.replace(match[0], " ").replace(/\s+/g, " ").trim();
  return { prompt: cleaned, ratio };
}

/**
 * Detects and extracts @image, @edit, @i2i, @t2i prefix/tag and ratio markers.
 * Strips all markers so the diffusion model receives only pure prompt text.
 * Returns { isTrigger, prompt, ratio }
 */
export function parseImageCommand(prompt) {
  if (typeof prompt !== "string") return { isTrigger: false, prompt: "", ratio: null };
  let p = prompt.trim();
  let isTrigger = false;

  const triggerMatch = p.match(/(?:^|\s)@(image|edit|i2i|t2i)(?:\s|$)/i);
  if (triggerMatch) {
    isTrigger = true;
    p = p.replace(triggerMatch[0], " ").replace(/\s+/g, " ").trim();
  }

  const { prompt: cleanedPrompt, ratio } = extractPromptRatio(p);
  return { isTrigger, prompt: cleanedPrompt, ratio };
}

export const IMAGE_TOOL_NAME = "generate_image";
export const IMAGE_EDIT_TOOL_NAME = "edit_image";

export const IMAGE_TOOL = {
  type: "function",
  function: {
    name: IMAGE_TOOL_NAME,
    description: "Generate a new image from a text prompt using Qwen's image generation engine. The result is an image URL.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Detailed description of the image to generate.",
        },
        aspect_ratio: {
          type: "string",
          enum: ["1:1", "16:9", "9:16", "4:3", "3:4", "auto"],
          description: "Aspect ratio for the generated image. Defaults to 1:1 for new images.",
        },
      },
      required: ["prompt"],
    },
  },
};

export const IMAGE_EDIT_TOOL = {
  type: "function",
  function: {
    name: IMAGE_EDIT_TOOL_NAME,
    description: "Edit, modify, or restyle an attached image using Qwen's image editing engine. Preserves source framing by default.",
    parameters: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description: "Detailed instruction for how to edit or modify the attached image.",
        },
        aspect_ratio: {
          type: "string",
          enum: ["1:1", "16:9", "9:16", "4:3", "3:4", "auto"],
          description: "Aspect ratio for the edited image. Defaults to 'auto' to preserve source framing.",
        },
      },
      required: ["prompt"],
    },
  },
};
