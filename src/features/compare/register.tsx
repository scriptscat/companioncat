import { defineFeature } from "../../shell";
import { startCompare } from "./runtime";

/** 网页对照: the command, hotkey, menu item and per-site auto start of every inline-after entry (R7). */
export default defineFeature({ id: "compare", start: (ctx) => startCompare(ctx) });
