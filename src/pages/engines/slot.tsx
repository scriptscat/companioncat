import type { ComponentType } from "react";
import type { Invoker } from "../../core/invoke";
import type { ResolvedContract, ResolvedProvider } from "../../core/rules/types";
import type { SecretStore } from "../../core/stores";

export interface TracePanelProps {
  provider: ResolvedProvider;
  /** Contracts the engine implements, with their samples. */
  contracts: ResolvedContract[];
  invoker: Invoker;
  secrets: SecretStore;
}

/**
 * The trial-run slot of the engine detail (R5.5, R12). Task 15 mounts its panel by creating
 * `./trace/index.tsx` with `export const TracePanel: ComponentType<TracePanelProps>`; nothing else changes.
 */
const found = import.meta.glob<{ TracePanel?: ComponentType<TracePanelProps> }>("./trace/index.tsx", { eager: true });
const Panel = Object.values(found)[0]?.TracePanel;

export function EngineTraceSlot(props: TracePanelProps) {
  return (
    <div data-testid="engine-trace-slot">
      {Panel ? (
        <Panel {...props} />
      ) : (
        <p className="text-[12.5px] leading-relaxed text-ink-3">写规则时用：用契约自带的样例调用一次，逐步展示请求、响应和每个表达式算出的值。Key 会打码。</p>
      )}
    </div>
  );
}
