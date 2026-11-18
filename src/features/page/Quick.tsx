import type { ReactNode } from "react";
import { isAutomationEntry } from "../../core/rules/automation";
import type { SettingDef } from "../../core/rules/types";
import { engineTarget, useShell } from "../../shell";
import { Dot } from "../../ui";
import { SettingControl } from "./controls";
import { useStores } from "./hooks";
import { isEnabled } from "./enabled";

interface Item {
  key: string;
  owner: string;
  name: string;
  def: SettingDef;
}

function quickOf(owner: string, defs: Record<string, SettingDef> | undefined): Item[] {
  return Object.entries(defs ?? {})
    .filter(([, def]) => def.quick)
    .map(([name, def]) => ({ key: `${owner}/${name}`, owner, name, def }));
}

function Row({ item }: { item: Item }) {
  const { def } = item;
  const label = def.type === "engines" ? "主要用" : def.title;
  return (
    <div className={def.type === "boolean" ? "flex h-10 items-center justify-between pr-2 pl-3" : "flex items-center justify-between pl-3"}>
      <span className="text-[13px] text-ink-2">{label}</span>
      <SettingControl owner={item.owner} name={item.name} def={def} compact />
    </div>
  );
}

/** R9.5: every `quick` setting of the enabled features (automation entries show theirs in the 自动化 group, R3.6), plus the missing-key shortcut. */
export function Quick(): ReactNode {
  const { openSettings } = useShell();
  const { storage, resolved, secrets } = useStores();
  const on = (ref: string) => isEnabled(storage, ref);

  const items = resolved.features
    .filter((f) => f.enabled && on(f.ref))
    .flatMap((f) => [
      ...quickOf(f.ref, f.def.settings),
      ...f.entries.filter((e) => e.enabled && on(e.ref) && !isAutomationEntry(e.def)).flatMap((e) => quickOf(e.ref, e.def.settings)),
    ]);
  const keyless = resolved.providers.filter((p) => p.enabled && !secrets.isDisabled(p.ref) && secrets.lookup(p.ref).missing.length > 0);

  return (
    <>
      {items.length > 0 && (
        <div className="flex flex-col rounded-2xl bg-paper px-1 py-1">
          {items.map((it) => (
            <Row key={it.key} item={it} />
          ))}
        </div>
      )}
      {keyless.length > 0 && (
        <button
          type="button"
          onClick={() => openSettings(engineTarget(keyless[0]!.ref))}
          className="flex w-full items-center gap-2 rounded-2xl bg-ginger-soft px-3 py-2 text-left text-[12.5px] text-ginger-ink hover:brightness-[0.98]"
        >
          <Dot tone="ginger" />
          <span className="flex-1">还有 {keyless.length} 个引擎没填 Key</span>
          <span className="font-semibold">去填</span>
        </button>
      )}
    </>
  );
}
