declare module "virtual:builtin-packs" {
  /** Commit of the rules repository the snapshot was taken from. */
  export const commit: string;
  /** The parsed packs in rules/packs, baked at build time. */
  export const packs: unknown[];
}
