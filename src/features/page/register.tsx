import { defineFeature, definePage } from "../../shell";
import { FeaturePage } from "./FeaturePage";
import { Quick } from "./Quick";

/** The 功能 page for every rule feature, and the bubble's quick items (R9.1, R9.5). */
export default [definePage({ id: "feature", group: "features", component: FeaturePage }), defineFeature({ id: "page", quick: Quick })];
