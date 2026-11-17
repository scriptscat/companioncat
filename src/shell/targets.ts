/** Settings window navigation targets (see ShellApi.openSettings). Dependency-free so views can use it. */
import type { ResolvedFeature } from "../core/rules/types";

const ENGINE_TARGET = "engine:";

export const featureTarget = (f: ResolvedFeature) => `feature:${f.ref}`;
/** The engines page with that engine's detail open (R9.12, R10.5). */
export const engineTarget = (ref: string) => `${ENGINE_TARGET}${ref}`;
/** The provider ref of an `engine:<ref>` target, else undefined. */
export const engineOfTarget = (target?: string) => (target?.startsWith(ENGINE_TARGET) ? target.slice(ENGINE_TARGET.length) || undefined : undefined);
