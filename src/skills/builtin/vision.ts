import { AGENTS } from "../../agents/registry";
import { runVision } from "../../ai/workers-ai";
import type { Skill } from "../types";

export const visionInspect: Skill = {
  id: "vision.inspect",
  description:
    "Look at the image the founder attached and answer a question about it (text, layout, objects, what looks wrong).",
  parameters: {
    type: "object",
    properties: { question: { type: "string" } },
    required: ["question"],
  },
  risk: "read",
  async run(args, ctx) {
    if (!ctx.image) return "No image is attached to this conversation.";
    return runVision(ctx.env.AI, AGENTS.iris.model, {
      task: "query",
      image: ctx.image,
      prompt: String(args.question ?? "Describe this image in detail."),
    });
  },
};
