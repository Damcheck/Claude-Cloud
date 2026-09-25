import { AGENTS } from "../../agents/registry";
import { runVision } from "../../ai/workers-ai";
import type { Skill } from "../types";
import { str } from "../types";

export const visionInspect: Skill = {
  id: "vision.inspect",
  description:
    "Look at the image in the conversation. task=query answers a question; detect finds objects (returns boxes); point locates things (returns coordinates); caption describes it.",
  parameters: {
    type: "object",
    properties: {
      question: { type: "string", description: "The question, or for detect/point the object to find" },
      task: { type: "string", enum: ["query", "caption", "detect", "point"] },
    },
    required: ["question"],
  },
  risk: "read",
  untrusted: true,
  async run(args, ctx) {
    if (!ctx.image) return "No image is attached to this conversation.";
    const task = (["query", "caption", "detect", "point"].includes(str(args.task)) ? str(args.task) : "query") as
      | "query"
      | "caption"
      | "detect"
      | "point";
    return runVision(ctx.env.AI, AGENTS.iris.model, { task, image: ctx.image, prompt: str(args.question) }, ctx.callOptions);
  },
};
