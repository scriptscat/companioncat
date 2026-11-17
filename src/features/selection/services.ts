import type { Invoker } from "../../core/invoke";
import { coreServices, type ShellServices } from "../../shell/services";

export type CallPort = Pick<Invoker, "invoke" | "preferredEngines">;

export const invokerFor = (services: ShellServices): CallPort => coreServices(services).invoker;
