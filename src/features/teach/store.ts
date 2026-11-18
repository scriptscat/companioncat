/**
 * Where AI-written rules live (R6.7–R6.9): the rule is an ordinary feature of the local rules
 * (cc:rules:local, so it takes effect like any local rule, R3.4), and its conversation sits beside it
 * under `cc:teach:<featureId>`; the rule itself carries no extra field. A conversation not saved yet
 * is kept under `cc:teach:unsaved` so 「接着上次没写完的」 can bring it back after a reload.
 */
import { appendFeature, featureIds, freeFeatureId, getFeature, removeFeature, replaceFeature } from "../../core/rules/local-edit";
import { checkLocalRules } from "../../core/rules/local";
import { isObject } from "../../core/rules/merge";
import type { Storage } from "../../platform/storage";
import { LOCAL_RULES_KEY } from "../../pages/rules/RulesPage";
import { enabledKey } from "../page/enabled";
import type { Conversation, SavedConversation, Version } from "./conversation";

export const TEACH_PREFIX = "cc:teach:";
export const UNSAVED_KEY = `${TEACH_PREFIX}unsaved`;
export const teachKey = (featureId: string) => `${TEACH_PREFIX}${featureId}`;

/** `Version.turn` of a version taken from a hand edit in the local rules editor (no turn produced it). */
export const HAND_EDIT_TURN = "hand-edit";
export const isHandEdited = (v: Version) => v.turn === HAND_EDIT_TURN;

export type TeachResult<T = object> = ({ ok: true } & T) | { ok: false; error: string };

type Saveable = Pick<Conversation, "toJSON">;
type TeachStorage = Pick<Storage, "get" | "set" | "delete" | "keys">;

const localText = (storage: Pick<Storage, "get">) => storage.get<string>(LOCAL_RULES_KEY) ?? "";

/**
 * An id is taken by an orphan conversation (other than the one being saved, `own`) or by a leftover
 * off switch of a deleted local feature, which would leave the new rule switched off (R3.4).
 */
function leftover(storage: Pick<Storage, "get" | "keys">, id: string, own?: string): boolean {
  if (id !== own && storage.get(teachKey(id)) !== undefined) return true;
  const on = enabledKey(`local/${id}`);
  return storage.keys(on).some((k) => k === on || k.startsWith(`${on}.`));
}

/**
 * Saves `draft` as a local feature with the conversation beside it. The first save (no `featureId`,
 * or its feature is gone) appends it under a free `teach-<slug>` id; later saves replace only that
 * feature. Invalid local rules are never touched.
 */
export function saveDraft(
  storage: TeachStorage,
  conversation: Saveable,
  draft: unknown,
  opts: { featureId?: string } = {},
): TeachResult<{ featureId: string }> {
  const edit = withDraft(storage, draft, opts.featureId);
  if (!edit.ok) return edit;
  const { featureId } = edit;
  const check = checkLocalRules(edit.text);
  if (!check.canSave) {
    const first = check.problems.find((p) => p.severity === "error");
    return { ok: false, error: `草稿放进本地规则后通不过校验：${first?.path ?? ""} ${first?.message ?? ""}`.trim() };
  }
  // The rule first: a conversation is never stored without its feature (see pruneTeachRecords).
  storage.set(LOCAL_RULES_KEY, edit.text);
  storage.set(teachKey(featureId), conversation.toJSON());
  storage.delete(UNSAVED_KEY);
  return { ok: true, featureId };
}

/**
 * The local rules text with `draft` put in, not stored: replacing the feature `featureId` while it is
 * there, else appended under a free `teach-<slug>` id. Shared by 存进本地规则 and 「自己改」.
 */
export function withDraft(
  storage: Pick<Storage, "get" | "keys">,
  draft: unknown,
  featureId?: string,
): TeachResult<{ text: string; featureId: string }> {
  if (!isObject(draft)) return { ok: false, error: "草稿不是一个功能对象" };
  const text = localText(storage);
  const replacing = featureId !== undefined && getFeature(text, featureId) !== undefined;
  const id = replacing
    ? featureId!
    : freeFeatureId(text, featureId ?? (typeof draft.id === "string" ? draft.id : undefined), (x) => leftover(storage, x, featureId));
  const feature = { ...draft, id };
  const edit = replacing ? replaceFeature(text, id, feature) : appendFeature(text, feature);
  return edit.ok ? { ok: true, text: edit.text, featureId: id } : edit;
}

/** Light shape check; fromJSON() does the full one when the panel restores it. */
function isSaved(v: unknown): v is SavedConversation {
  return (
    isObject(v) &&
    v.v === 1 &&
    Array.isArray(v.turns) &&
    Array.isArray(v.versions) &&
    Number.isInteger(v.current) &&
    (v.current as number) >= 0 &&
    (v.current as number) <= v.versions.length
  );
}

/** JSON text with object keys sorted, so key order alone is not an edit. */
function canonical(v: unknown): string {
  return JSON.stringify(v, (_k, x: unknown) =>
    isObject(x) ? Object.fromEntries(Object.keys(x).sort().map((k) => [k, x[k]])) : x,
  );
}

/**
 * The conversation saved with the local feature `featureId`, or undefined when either is missing.
 * When the feature in the editor differs from the conversation's current draft (the user edited it
 * by hand), the edited feature is added as a new version marked hand-edited and made current (R6.8).
 */
export function loadConversation(
  storage: Pick<Storage, "get">,
  featureId: string,
  opts: { now?: () => number } = {},
): SavedConversation | undefined {
  const saved = storage.get(teachKey(featureId));
  const feature = getFeature(localText(storage), featureId);
  if (!isSaved(saved) || !feature) return undefined;
  const current = saved.versions[saved.current - 1];
  const asSaved = isObject(current?.draft) ? { ...current.draft, id: featureId } : undefined;
  if (canonical(asSaved) === canonical(feature)) return saved;
  const n = saved.versions.length + 1;
  const version: Version = { n, draft: feature, turn: HAND_EDIT_TURN, at: (opts.now ?? Date.now)() };
  return { ...saved, versions: [...saved.versions, version], current: n };
}

export interface TeachRule {
  featureId: string;
  name?: string;
}

/** The local features written with the AI (those with a saved conversation), in editor order. */
export function listTeachRules(storage: Pick<Storage, "get" | "keys">): TeachRule[] {
  const text = localText(storage);
  const kept = new Set(storage.keys(TEACH_PREFIX));
  return (featureIds(text) ?? [])
    .filter((id) => kept.has(teachKey(id)))
    .map((featureId) => {
      const name = getFeature(text, featureId)?.name;
      return typeof name === "string" ? { featureId, name } : { featureId };
    });
}

/** Deletes the rule from the local rules and its conversation with it (R6.8). */
export function deleteTeachRule(storage: TeachStorage, featureId: string): TeachResult {
  const text = localText(storage);
  if (getFeature(text, featureId)) {
    const edit = removeFeature(text, featureId);
    if (!edit.ok) return edit;
    storage.set(LOCAL_RULES_KEY, edit.text);
  } else if (featureIds(text) === undefined) {
    return { ok: false, error: "本地规则不是有效的 JSON，没有改动" };
  }
  storage.delete(teachKey(featureId));
  return { ok: true };
}

/** Drops the conversations whose feature is no longer in the local rules; invalid text drops nothing. */
export function pruneTeachRecords(storage: TeachStorage): void {
  const ids = featureIds(localText(storage));
  if (!ids) return;
  const live = new Set(ids.map(teachKey));
  for (const key of storage.keys(TEACH_PREFIX)) {
    if (key !== UNSAVED_KEY && !live.has(key)) storage.delete(key);
  }
}

/** Prunes whenever this tab changes the local rules (the editor deleting a teach feature). Returns stop. */
export function watchTeachRecords(storage: TeachStorage & Pick<Storage, "onChange">): () => void {
  return storage.onChange((key, _old, _new, remote) => {
    if (key === LOCAL_RULES_KEY && !remote) pruneTeachRecords(storage);
  });
}

export interface UnsavedRecord {
  conversation: SavedConversation;
  /** The saved rule this conversation continues (「继续和小猫改」), if any. */
  featureId?: string;
  at: number;
}

/** Keeps a conversation that has a draft not saved yet, for 「接着上次没写完的」 (R6.9). */
export function saveUnsaved(
  storage: Pick<Storage, "set">,
  conversation: Saveable,
  opts: { featureId?: string; now?: () => number } = {},
): void {
  const record: UnsavedRecord = {
    conversation: conversation.toJSON(),
    ...(opts.featureId !== undefined ? { featureId: opts.featureId } : {}),
    at: (opts.now ?? Date.now)(),
  };
  storage.set(UNSAVED_KEY, record);
}

/** The unsaved conversation left by a reload or a closed page; undefined when there is none. */
export function loadUnsaved(storage: Pick<Storage, "get">): UnsavedRecord | undefined {
  const r = storage.get(UNSAVED_KEY);
  if (!isObject(r) || !isSaved(r.conversation) || typeof r.at !== "number") return undefined;
  if (r.featureId !== undefined && typeof r.featureId !== "string") return undefined;
  return r as unknown as UnsavedRecord;
}

/** 「丢掉」: forgets the unsaved conversation. */
export function discardUnsaved(storage: Pick<Storage, "delete">): void {
  storage.delete(UNSAVED_KEY);
}
