import { Fragment, type ReactNode } from "react";
import type { ResolvedEntry, ResolvedFeature, SettingDef } from "../../core/rules/types";
import { type PageProps, useShell } from "../../shell";
import { Btn, cn, Section, Toggle } from "../../ui";
import { SettingItem } from "./controls";
import { useAsync } from "../../pages/engines/useAsync";
import { type DescribeCtx, describeEntry } from "./describe";
import { isLocalEntry, preferredOf, providerHosts, requestConsent, settingValues } from "./ConfirmEnable";
import { AutomationLog } from "./AutomationLog";
import { isAutomationEntry } from "../../core/rules/automation";
import { gateOf } from "./enabled";
import { useEnabled, useStores } from "./hooks";
import { LOCAL_PACK_ID } from "../../core/rules";
import { listTeachRules } from "../teach/store";
import { openTeach } from "../teach/register";

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
  const broken = !entry.enabled;
  const note: ReactNode = broken
    ? // an entry also stops when its feature is broken; then the feature's error is the reason
      `规则有问题，已停用：${[...entry.problems, ...feature.problems].find((p) => p.severity === "error")?.message ?? ""}`
    : null;
  const locked = broken;
  const { storage, resolved } = useStores();
  const { hostname, layer, services } = useShell();
  const hosts = useAsync(() => providerHosts(resolved), [resolved]);
  const ctx: DescribeCtx = { providers: resolved.providers, values: settingValues(storage, feature, entry, hostname), hosts, preferred: preferredOf(services) };
  // R3.1-R3.4: a subscribed automation entry is on only with consent that still matches
  const on = gateOf(storage, entry, { local: isLocalEntry(entry), describe: ctx }) === "on";

  return (
    <Section
      title={entry.def.name}
      aside={
        <Toggle
          aria-label={`启用${entry.def.name}`}
          checked={!locked && on}
          disabled={locked}
          // turning on may ask first (R3.2); declining leaves the switch as it was
          onCheckedChange={(next) => (next ? void requestConsent({ layer, services, hostname }, entry.ref) : enabled.set(false))}
        />
      }
    >
      <div className={cn(card, "overflow-hidden")}>
        {note ? (
          <p className="px-4 py-3 text-[13px] text-ink-3">{note}</p>
        ) : (
          <>
            <ul className="flex flex-col gap-1.5 border-b border-line bg-sunken/70 px-4 py-3 text-[13px]">
              {describeEntry(feature.def, entry.def, ctx).map((d) => (
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
export function FeaturePage({ feature, anchor }: PageProps & { anchor?: "log" }) {
  if (!feature) return null;
  return <Page feature={feature} anchor={anchor} />;
}

function Page({ feature, anchor }: { feature: ResolvedFeature; anchor?: "log" }) {
  const enabled = useEnabled(feature.ref);
  const shared = Object.keys(feature.def.settings ?? {}).length > 0;
  const { storage } = useStores();
  // R6.8: only a local rule that was written with the AI has a conversation to continue
  const aiWritten = feature.pack === LOCAL_PACK_ID && listTeachRules(storage).some((r) => r.featureId === feature.id);
  return (
    <div className="cc-scroll relative h-full overflow-y-auto px-6 pb-8">
      <div className="flex max-w-[640px] flex-col gap-6">
        <div className={cn(card, "flex items-center gap-3 p-4")}>
          <div className="min-w-0 flex-1">
            <p className="text-[14.5px] font-semibold">{feature.def.description ?? feature.def.name}</p>
            <p className="mt-0.5 text-[12.5px] text-ink-3">来自规则包「{feature.pack}」</p>
          </div>
          {aiWritten && (
            <Btn variant="soft" size="sm" onClick={() => void openTeach({ featureId: feature.id })}>
              继续和小猫改
            </Btn>
          )}
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
          <Fragment key={entry.ref}>
            <EntryGroup feature={feature} entry={entry} />
            {/* R2.3, R3.7: automation entries also show where they always act and what they did */}
            {isAutomationEntry(entry.def) && <AutomationLog entry={entry} focusLog={anchor === "log"} />}
          </Fragment>
        ))}
      </div>
    </div>
  );
}
