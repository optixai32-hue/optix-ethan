/**
 * Image generation tool — TypeScript port of
 * backend/onyx/tools/tool_implementations/images/image_generation_tool.py
 * (ImageGenerationTool: NAME="generate_image", DISPLAY_NAME="Image
 * Generation", DESCRIPTION="Generate an image based on a prompt. Do not use
 * unless the user specifically requests an image.") and
 * backend/onyx/image_gen/generation.py (generate_images_with_provider).
 *
 * Provider check performed for this port (per task instructions):
 *   - `z-ai --help` (Bash) confirms the z-ai CLI exposes an `image` command
 *     (and `z-ai-generate`), so spawning the CLI WOULD work;
 *   - the z-ai-web-dev-sdk@0.0.18 .d.ts additionally exposes
 *     `zai.images.generations.create({prompt, size?})` returning
 *     `{created, data: [{base64}]}` — the direct SDK path is used instead of
 *     spawning a subprocess (same backend, no shell dependency).
 *
 * Generated images are saved under FILE_STORE_DIR (configs/constants.py
 * port of the Onyx file store) and the saved path is returned as JSON, with
 * graceful degradation on failure (tool stays registered and reports the
 * problem instead of throwing).
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { getZaiClient } from "../../llm/providers/zai.js";
import type { Tool, ToolResponse } from "../interface.js";
import { FILE_STORE_DIR } from "../../configs/constants.js";
import { getLogger } from "../../utils/logger.js";

const logger = getLogger("tools.image_gen");

export const IMAGE_GEN_TOOL_ID = "generate_image";

const IMAGE_GEN_DESCRIPTION =
  "Generate an image based on a prompt. Do not use unless the user specifically requests an image.";

const IMAGE_SIZES = [
  "1024x1024",
  "768x1344",
  "864x1152",
  "1344x768",
  "1152x864",
  "1440x720",
  "720x1440",
] as const;

type ImageSize = (typeof IMAGE_SIZES)[number];

function isImageSize(value: string): value is ImageSize {
  return (IMAGE_SIZES as readonly string[]).includes(value);
}

export const imageGenTool: Tool = {
  id: IMAGE_GEN_TOOL_ID,
  name: IMAGE_GEN_TOOL_ID,
  displayName: "Image Generation",
  description: IMAGE_GEN_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      prompt: {
        type: "string",
        description: "The prompt describing the image to generate.",
      },
      size: {
        type: "string",
        description: "Image dimensions (default 1024x1024).",
        enum: [...IMAGE_SIZES],
      },
    },
    required: ["prompt"],
  },

  async run(input: Record<string, unknown>): Promise<ToolResponse> {
    const prompt = typeof input.prompt === "string" ? input.prompt : "";
    if (!prompt.trim()) {
      return { content: "Error: the 'prompt' argument is required." };
    }
    const rawSize = typeof input.size === "string" ? input.size : "1024x1024";
    const size: ImageSize = isImageSize(rawSize) ? rawSize : "1024x1024";

    try {
      const zai = await getZaiClient();
      const response = await zai.images.generations.create({ prompt, size });
      const base64 = response.data?.[0]?.base64;
      if (!base64) {
        return { content: "Image generation returned no image data." };
      }

      // Persist to the file store (port of save_files / file-store pathing).
      mkdirSync(FILE_STORE_DIR, { recursive: true });
      const fileName = `generate_image-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.png`;
      const filePath = join(FILE_STORE_DIR, fileName);
      writeFileSync(filePath, Buffer.from(base64, "base64"));

      // Port of ImageResult {file_id, revised_prompt} JSON returned to the LLM.
      return {
        content: JSON.stringify({
          file_id: fileName,
          file_path: filePath,
          size,
          revised_prompt: prompt,
        }),
      };
    } catch (err) {
      // Graceful degradation (image provider unconfigured or call failed).
      logger.warning("image generation failed", { error: String(err) });
      return {
        content:
          "Image generation is currently unavailable (no image generation provider configured or the provider call failed). Describe the requested image in text instead.",
      };
    }
  },
};
