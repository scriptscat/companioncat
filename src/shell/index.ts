export { mount, HOST_TAG, type MountOptions, type ShellHandle } from "./mount";
export { boot, MENU_OPEN_SETTINGS, type BootOptions, type GmApi } from "./boot";
export { useShell, type ShellApi } from "./context";
export {
  collect,
  defineFeature,
  definePage,
  BUILTIN_PAGES,
  type BuiltinPage,
  PAUSED_NOTICE,
  type Command,
  type CommandApi,
  type FeatureRegistration,
  type NavGroup,
  type PageProps,
  type PageRegistration,
  type Registration,
  type RuntimeContext,
} from "./registry";
export { coreServices, EMPTY_RESOLVED, isBare, staticRules, type RulesSource, type ShellServices } from "./services";
export { readPrefs, writePref, PREF_PREFIX, type ShellPrefs, type Theme, type CatPos } from "./prefs";
export { engineOfTarget, engineTarget, featureTarget } from "./targets";
