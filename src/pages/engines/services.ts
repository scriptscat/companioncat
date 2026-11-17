import type { Invoker } from "../../core/invoke";
import type { SecretStore } from "../../core/stores";
import { coreServices, type ShellServices } from "../../shell/services";

/** The secret store and invoker of the shell, with safe defaults. */
export const engineServices = (services: ShellServices): { secrets: SecretStore; invoker: Invoker } => coreServices(services);
