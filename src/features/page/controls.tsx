import { useState } from "react";
import { LANGUAGES } from "../../core/languages";
import type { SettingDef } from "../../core/rules/types";
import { useShell } from "../../shell";
import { cn, Picker, Segments, SettingRow, Tick, Toggle, TextInput } from "../../ui";
import { useStores } from "./hooks";

/** Engines implementing `capability`: rule-enabled, not switched off, with whether their key is missing. */
export function useEngines(capability: string | undefined) {
  const { resolved, secrets } = useStores();
  return resolved.providers
    .filter((p) => p.enabled && !secrets.isDisabled(p.ref) && capability !== undefined && p.def.implements?.[capability])
    .map((p) => ({ ref: p.ref, name: p.def.name, needKey: secrets.lookup(p.ref).missing.length > 0 }));
}

interface ControlProps {
  /** Feature ref or entry ref: part of the storage key (R9.3). */
  owner: string;
  name: string;
  def: SettingDef;
  /** Compact controls for the bubble (R9.5). */
  compact?: boolean;
}

const options = (o: Record<string, string> | undefined) => Object.entries(o ?? {}).map(([value, label]) => ({ value, label }));

/** The renderer for the seven setting types; value and writes go through the settings store. */
export function SettingControl({ owner, name, def, compact }: ControlProps) {
  const { hostname } = useShell();
  const { settings } = useStores();
  const host = def.scope === "site" ? hostname : undefined;
  const value = settings.get(owner, name, def, host);
  const write = (v: unknown) => settings.set(owner, name, def, v, host);
  const engines = useEngines(def.capability);

  switch (def.type) {
    case "boolean":
      return <Toggle aria-label={def.title} checked={value === true} onCheckedChange={write} />;
    case "enum":
      return compact ? (
        <Picker compact label={def.title} value={value as string} onValueChange={write} options={options(def.options)} />
      ) : (
        <Segments label={def.title} value={value as string} onChange={write} options={options(def.options)} />
      );
    case "language":
      return <Picker compact={compact} label={def.title} value={value as string} onValueChange={write} options={[...LANGUAGES]} />;
    case "engine":
      return (
        <Picker
          compact={compact}
          label={def.title}
          value={value as string}
          onValueChange={write}
          options={engines.filter((e) => !e.needKey).map((e) => ({ value: e.ref, label: e.name }))}
        />
      );
    case "engines": {
      const picked = value as string[];
      // engines switched off, removed or no longer implementing the capability are not shown,
      // so they take no place in max and are not the main one
      const shown = picked.filter((r) => engines.some((e) => e.ref === r));
      const capped = (list: string[]) => (def.max === undefined ? list : list.slice(0, def.max));
      if (compact) {
        // quick: "first" shows only the main engine; choosing one moves it to the front
        return (
          <Picker
            compact
            label={def.title}
            value={shown[0]}
            onValueChange={(v) => write(capped([v, ...shown.filter((x) => x !== v)]))}
            options={engines.filter((e) => !e.needKey).map((e) => ({ value: e.ref, label: e.name }))}
          />
        );
      }
      const full = def.max !== undefined && shown.length >= def.max;
      return (
        <div role="group" aria-label={def.title} className="overflow-hidden rounded-2xl border-[1.5px] border-line bg-fur">
          {engines.map((e) => {
            const i = shown.indexOf(e.ref);
            const locked = i < 0 && (e.needKey || full);
            return (
              <label key={e.ref} className="flex h-11 cursor-pointer items-center gap-3 border-b border-line px-4 last:border-b-0 hover:bg-paper/60">
                <Tick
                  checked={i >= 0}
                  disabled={locked}
                  aria-label={e.name}
                  onCheckedChange={(c) => write(c ? [...shown, e.ref] : shown.filter((x) => x !== e.ref))}
                />
                <span className={cn("flex-1 text-[14px]", locked && "text-ink-3")}>
                  {e.name}
                  {e.needKey && "（还没填 Key）"}
                </span>
                {i === 0 && <span className="rounded-full bg-patch px-2 py-px text-[11px] font-semibold text-on-patch">主结果</span>}
                {i > 0 && <span className="text-[12px] text-ink-3">第 {i + 1}</span>}
              </label>
            );
          })}
        </div>
      );
    }
    case "string":
      return <Text {...{ def, value: value as string, write }} />;
    case "number":
      return <Num {...{ def, value: value as number, write }} />;
  }
}

type Editor<T> = { def: SettingDef; value: T; write: (v: T) => boolean };

function Text({ def, value, write }: Editor<string>) {
  const [draft, setDraft] = useState(value);
  return (
    <TextInput
      aria-label={def.title}
      placeholder={def.placeholder}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        write(e.target.value);
      }}
    />
  );
}

/** Keeps what is being typed; only a legal number (within min/max) is stored. */
function Num({ def, value, write }: Editor<number>) {
  const [draft, setDraft] = useState(String(value));
  return (
    <TextInput
      type="number"
      aria-label={def.title}
      min={def.min}
      max={def.max}
      step={def.step}
      value={draft}
      onChange={(e) => {
        setDraft(e.target.value);
        if (e.target.value !== "") write(Number(e.target.value));
      }}
      onBlur={() => setDraft(String(value))}
    />
  );
}

/** A setting in the settings page: switches sit on the right, other controls below (mockup SettingItem). */
export function SettingItem({ owner, name, def }: Omit<ControlProps, "compact">) {
  const { hostname } = useShell();
  const hint = def.description ?? (def.scope === "site" ? `只对当前网站 ${hostname} 生效` : undefined);
  if (def.type === "boolean")
    return (
      <SettingRow label={def.title} hint={hint}>
        <SettingControl owner={owner} name={name} def={def} />
      </SettingRow>
    );
  return (
    <div className="border-b border-line py-3.5 last:border-b-0">
      <p className="text-[14px] text-ink">{def.title}</p>
      {hint && <p className="mt-0.5 text-[12.5px] leading-snug text-ink-3">{hint}</p>}
      <div className="mt-2.5">
        <SettingControl owner={owner} name={name} def={def} />
      </div>
    </div>
  );
}
