import { defineFeature } from "../../shell";
import { Quick } from "./Quick";
import { startAutomation } from "./runtime";

/** The automation runtime (triggers, gating, runs, action log) and the bubble's 「自动化」 group. */
export default defineFeature({ id: "automation", quick: Quick, start: (ctx) => startAutomation(ctx) });
