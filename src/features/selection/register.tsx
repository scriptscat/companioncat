import { defineFeature } from "../../shell";
import { startSelection } from "./runtime";

/** The selection entry runtime: paw → near-selection card for every rule entry with a selection trigger. */
export default defineFeature({ id: "selection", start: startSelection });
