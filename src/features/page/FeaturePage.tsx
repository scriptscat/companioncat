import type { ReactNode } from "react";
import type { ResolvedEntry, ResolvedFeature, SettingDef } from "../../core/rules/types";
import type { PageProps } from "../../shell";
import { cn, Section, Toggle } from "../../ui";
import { SettingItem } from "./controls";
import { describeEntry } from "./describe";
import { isUnsupported, useEnabled } from "./hooks";

const card = "rounded-[18px] border-[1.5px] border-line bg-fur";

function Settings({ owner, defs }: { owner: string; defs: Record<string, SettingDef> | undefined }) {
  return (
    <>
      {Object.entries(defs ?? {}).map(([name, def]) => (
        <SettingItem key={name} owner={owner} name={name} def={def} />
      ))}
    </>
  );
}

function EntryGroup({ feature, entry }: { feature: ResolvedFeature; entry: ResolvedEntry }) {
  const enabled = useEnabled(entry.ref);
  const unsupported = isUnsupported(entry);
  const broken = !entry.enabled;
  const note: ReactNode = unsupported
    ? "这个版本的陪伴猫还不支持这个入口"
    : broken
      ? // an entry also stops when its feature is broken; then the feature's error is the reason
        `规则有问题，已停用：${[...entry.problems, ...feature.problems].find((p) => p.severity === "error")?.message ?? ""}`
      : null;
  const locked = unsupported || broken;

  return (
    <Section
      title={entry.def.name}
      aside={
        <Toggle
          aria-label={`启用${entry.def.name}`}
          checked={!locked && enabled.on}
          disabled={locked}
          onCheckedChange={enabled.set}
        />
      }
    >
      <div className={cn(card, "overflow-hidden")}>
        {note ? (
          <p className="px-4 py-3 text-[13px] text-ink-3">{note}</p>
        ) : (
          <>
            <ul className="flex flex-col gap-1.5 border-b border-line bg-sunken/70 px-4 py-3 text-[13px]">
              {describeEntry(feature.def, entry.def).map((d) => (
                <li key={d.detail} className="flex flex-col">
                  <span className="text-ink">{d.what}</span>
                  <span className="font-code text-[11px] text-ink-3">{d.detail}</span>
                </li>
              ))}
            </ul>
            <div className="px-4">
              <Settings owner={entry.ref} defs={entry.def.settings} />
            </div>
          </>
        )}
      </div>
    </Section>
  );
}

/** R9.1: the page for one rule feature, generated from its definition (mockup FeatureSection). */
export function FeaturePage({ feature }: PageProps) {
  if (!feature) return null;
  return <Page feature={feature} />;
}

function Page({ feature }: { feature: ResolvedFeature }) {
  const enabled = useEnabled(feature.ref);
  const shared = Object.keys(feature.def.settings ?? {}).length > 0;
  return (
    <div className="cc-scroll relative h-full overflow-y-auto px-6 pb-8">
      <div className="flex max-w-[640px] flex-col gap-6">
        <div className={cn(card, "flex items-center gap-3 p-4")}>
          <div className="min-w-0 flex-1">
            <p className="text-[14.5px] font-semibold">{feature.def.description ?? feature.def.name}</p>
            <p className="mt-0.5 text-[12.5px] text-ink-3">来自规则包「{feature.pack}」</p>
          </div>
          <Toggle
            aria-label={`启用${feature.def.name}`}
            checked={feature.enabled && enabled.on}
            disabled={!feature.enabled}
            onCheckedChange={enabled.set}
          />
        </div>

        {shared && (
          <Section title="共用">
            <div className={cn(card, "px-4")}>
              <Settings owner={feature.ref} defs={feature.def.settings} />
            </div>
          </Section>
        )}

        {feature.entries.map((entry) => (
          <EntryGroup key={entry.ref} feature={feature} entry={entry} />
        ))}
      </div>
    </div>
  );
}
