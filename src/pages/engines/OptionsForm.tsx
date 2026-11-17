import { useId, useState } from "react";
import { effectiveOptions } from "../../core/impl";
import type { OptionDef, ResolvedProvider } from "../../core/rules/types";
import type { Storage } from "../../platform/storage";
import { Field, Section, Segments, TextInput, Toggle } from "../../ui";
import { LOCAL_PACK_ID } from "../../core/rules";
import { LOCAL_RULES_KEY } from "../rules/RulesPage";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

/** The parsed local rules; `null` when the text is not a JSON object (never overwritten then). */
function readLocal(storage: Storage): Obj | null {
  const text = storage.get<string>(LOCAL_RULES_KEY);
  if (!text?.trim()) return { schema: 1, id: LOCAL_PACK_ID };
  try {
    const v: unknown = JSON.parse(text);
    return isObj(v) ? v : null;
  } catch {
    return null;
  }
}

/** This engine's option overrides in the local rules: `{ [option]: { default } }`. */
function overridesOf(storage: Storage, ref: string): Obj {
  const o = readLocal(storage)?.overrides;
  const entry = isObj(o) ? o[ref] : undefined;
  return isObj(entry) && isObj(entry.options) ? entry.options : {};
}

/**
 * Edits `overrides[ref].options` inside the local rules pack (R5.5) and removes whatever becomes
 * empty, down to the whole text. Returns false, writing nothing, when the local text is not valid JSON.
 */
function editLocal(storage: Storage, ref: string, edit: (options: Obj) => void): boolean {
  const pack = readLocal(storage);
  if (!pack) return false;
  const overrides = isObj(pack.overrides) ? { ...pack.overrides } : {};
  const entry: Obj = isObj(overrides[ref]) ? { ...(overrides[ref] as Obj) } : {};
  const options: Obj = isObj(entry.options) ? { ...entry.options } : {};
  edit(options);
  if (Object.keys(options).length) entry.options = options;
  else delete entry.options;
  if (Object.keys(entry).length) overrides[ref] = entry;
  else delete overrides[ref];
  if (Object.keys(overrides).length) pack.overrides = overrides;
  else delete pack.overrides;
  const empty = Object.keys(pack).every((k) => k === "schema" || k === "id");
  if (empty) storage.delete(LOCAL_RULES_KEY);
  else storage.set(LOCAL_RULES_KEY, JSON.stringify(pack, null, 2));
  return true;
}

/** Writes (or, for `undefined`, removes) one option override. */
export const writeOption = (storage: Storage, ref: string, name: string, value: unknown) =>
  editLocal(storage, ref, (o) => {
    if (value === undefined) delete o[name];
    else o[name] = { default: value };
  });

export const restoreOptions = (storage: Storage, ref: string) =>
  editLocal(storage, ref, (o) => {
    for (const k of Object.keys(o)) delete o[k];
  });
export const hasOverrides = (storage: Storage, ref: string) => Object.keys(overridesOf(storage, ref)).length > 0;

/** Options an engine shows a form for: the ones with a title and a type (R5.5 generated from `options`). */
export const formOptions = (p: ResolvedProvider): [string, OptionDef][] =>
  Object.entries(p.def.options ?? {}).filter(([, o]) => o.title && o.type);

/** 「模型与参数」: a form generated from the engine's `options`; changes are local overrides (R5.5). */
export function OptionsSection({ provider, storage }: { provider: ResolvedProvider; storage: Storage }) {
  const id = useId();
  // Text being typed; it may be empty while the stored override already fell back to the official value.
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [error, setError] = useState(false);
  const stored = overridesOf(storage, provider.ref);
  const values = effectiveOptions(provider, Object.fromEntries(Object.entries(stored).map(([k, v]) => [k, isObj(v) ? v.default : undefined])));
  const fields = formOptions(provider);
  if (!fields.length) return null;
  return (
    <Section
      title="模型与参数"
      aside={
        hasOverrides(storage, provider.ref) && (
          <button
            type="button"
            onClick={() => {
              setError(!restoreOptions(storage, provider.ref));
              setDrafts({});
            }}
            className="text-[12.5px] font-semibold text-ginger-ink hover:underline"
          >
            恢复官方设置
          </button>
        )
      }
    >
      {error && <p className="mb-2 text-[12.5px] text-berry">本地规则不是合法的 JSON，没有改动它。先到「规则」页修好再回来。</p>}
      <div className="flex flex-col gap-4 rounded-[18px] border-[1.5px] border-line bg-fur p-4">
      {fields.map(([name, o]) => {
        const hint = [
          name in stored ? "你改过这一项，写在本地规则的 overrides 里，规则更新后会保留你的选择。" : "",
          o.description ?? "",
        ]
          .filter(Boolean)
          .join(" ");
        const set = (v: unknown) => setError(!writeOption(storage, provider.ref, name, v));
        const control = (() => {
          if (o.type === "enum")
            return (
              <Segments
                label={o.title!}
                value={String(values[name] ?? "")}
                onChange={set}
                options={Object.entries(o.options ?? {}).map(([value, label]) => ({ value, label }))}
              />
            );
          if (o.type === "boolean") return <Toggle aria-label={o.title} checked={values[name] === true} onCheckedChange={set} />;
          const text = drafts[name] ?? String(values[name] ?? "");
          return (
            <TextInput
              id={`${id}${name}`}
              type={o.type === "number" ? "number" : "text"}
              value={text}
              placeholder={o.placeholder}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => {
                const raw = e.target.value;
                setDrafts({ ...drafts, [name]: raw });
                if (raw === "") return set(undefined);
                const n = Number(raw);
                if (o.type === "number") return Number.isFinite(n) && set(n);
                set(raw);
              }}
            />
          );
        })();
        return (
          <Field key={name} label={o.title} htmlFor={`${id}${name}`} hint={hint || undefined}>
            {control}
          </Field>
        );
      })}
      </div>
    </Section>
  );
}

