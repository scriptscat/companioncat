import { useEffect, useRef, useState } from "react";
import { Eye, EyeOff, ExternalLink, Loader2, Lock } from "lucide-react";
import { effectiveOptions, resolveHosts } from "../../core/impl";
import type { Invoker } from "../../core/invoke";
import type { ResolvedContract, ResolvedProvider } from "../../core/rules/types";
import { mask, type SecretStore } from "../../core/stores";
import { Btn, Dot, Field, TextInput } from "../../ui";
import { saveKey, testAndSave, type TestOutcome } from "./keys";
import { useAsync } from "./useAsync";

export const card = "rounded-[18px] border-[1.5px] border-line bg-fur";

const preview = (v: unknown) => {
  const t = typeof v === "string" ? v : (JSON.stringify(v) ?? String(v));
  return t.length > 300 ? `${t.slice(0, 300)}…` : t;
};

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-patch text-[11px] font-bold text-on-patch">{n}</span>
      <span>{children}</span>
    </li>
  );
}

interface Props {
  provider: ResolvedProvider;
  secrets: SecretStore;
  invoker: Invoker;
  contracts: ResolvedContract[];
}

/** R7.1–R7.3: guidance, key input, test-and-save, save-anyway and delete for an engine that declares `secrets`. */
export function KeyPanel({ provider, secrets, invoker, contracts }: Props) {
  const fields = provider.def.secrets ?? [];
  // Uncontrolled: a controlled <input> mirrors the typed key into its `value` attribute.
  const inputs = useRef<Record<string, HTMLInputElement | null>>({});
  const [typed, setTyped] = useState<Record<string, boolean>>({});
  const valueOf = (name: string) => (inputs.current[name]?.value ?? "").trim();
  const clear = () => {
    for (const el of Object.values(inputs.current)) if (el) el.value = "";
    setTyped({});
  };
  const [shown, setShown] = useState(false);
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<TestOutcome | null>(null);
  const hosts = useAsync(() => resolveHosts(provider, effectiveOptions(provider)), [provider]);
  const missing = secrets.lookup(provider.ref).missing;
  const saved = fields.length > 0 && missing.length === 0;
  const first = fields.find((f) => f.helpUrl);
  const filled = fields.every((f) => typed[f.name] || !missing.includes(f.name)) && fields.some((f) => typed[f.name]);
  const deps = { secrets, invoker, contracts };
  const entered = () => Object.fromEntries(fields.filter((f) => valueOf(f.name)).map((f) => [f.name, valueOf(f.name)]));
  const failed = outcome && !outcome.ok ? outcome : null;
  const passed = outcome?.ok ? outcome : null;

  // Leaving the panel stops a running test: a later test must not be overwritten by this one.
  const running = useRef<AbortController | null>(null);
  useEffect(() => () => running.current?.abort(), []);

  const test = async () => {
    const ctrl = (running.current = new AbortController());
    setBusy(true);
    setOutcome(null);
    try {
      const o = await testAndSave(provider, entered(), deps, ctrl.signal);
      if (ctrl.signal.aborted) return;
      setOutcome(o);
      if (o.ok) clear();
    } finally {
      if (!ctrl.signal.aborted) {
        running.current = null;
        setBusy(false);
      }
    }
  };

  return (
    <div className={`${card} flex flex-col gap-4 p-4`}>
      {!saved && first && (
        <ol className="flex flex-col gap-2 text-[13.5px] text-ink-2">
          <Step n={1}>
            打开
            <a href={first.helpUrl} target="_blank" rel="noreferrer" className="mx-1 inline-flex items-center gap-0.5 font-semibold text-ginger-ink hover:underline">
              {first.helpLabel ?? first.helpUrl}
              <ExternalLink className="size-3" />
            </a>
            创建一个 API Key
          </Step>
          <Step n={2}>复制后粘贴到下面，点「测试并保存」</Step>
        </ol>
      )}
      {fields.map((f) => {
        const current = secrets.get(provider.ref, f.name);
        return (
          <Field key={f.name} label={f.title} htmlFor={`secret-${f.name}`} error={failed ? `测试没通过：${failed.message}` : undefined} hint={current ? `已保存：${mask(current)}` : undefined}>
            <div className="relative">
              <TextInput
                id={`secret-${f.name}`}
                type={shown ? "text" : "password"}
                placeholder={current ? "输入新的 Key 可以替换" : f.placeholder}
                ref={(el) => {
                  inputs.current[f.name] = el;
                }}
                onChange={(e) => {
                  const has = e.target.value.trim() !== "";
                  setTyped((t) => (t[f.name] === has ? t : { ...t, [f.name]: has }));
                }}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={failed ? true : undefined}
                className="pr-10 font-code text-[13px]"
              />
              <button
                type="button"
                aria-label={shown ? "隐藏 Key" : "显示 Key"}
                onClick={() => setShown((s) => !s)}
                className="absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-xl text-ink-3 hover:text-ink"
              >
                {shown ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
              </button>
            </div>
          </Field>
        );
      })}
      {passed && (
        <div className="flex flex-col gap-1 text-[13px] text-leaf">
          <p className="flex items-center gap-2">
            <Dot tone="leaf" />
            测试通过，用时 {(passed.ms / 1000).toFixed(1)} 秒
          </p>
          <p className="font-code text-[12px] break-all text-ink-3">输入：{preview(passed.input)}</p>
          <p className="font-code text-[12px] break-all text-ink-2">输出：{preview(passed.output)}</p>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Btn size="sm" disabled={busy || !filled} onClick={() => void test()}>
          {busy && <Loader2 className="animate-spin" />}
          {busy ? "正在测试" : "测试并保存"}
        </Btn>
        {failed && (
          <Btn
            size="sm"
            variant="plain"
            disabled={busy}
            onClick={async () => {
              await saveKey(provider, entered(), deps);
              clear();
              setOutcome(null);
            }}
          >
            不测试，直接保存
          </Btn>
        )}
        {saved && (
          <Btn
            size="sm"
            variant="danger"
            className="ml-auto"
            onClick={() => {
              for (const f of fields) secrets.delete(provider.ref, f.name);
              setOutcome(null);
            }}
          >
            删除 Key
          </Btn>
        )}
      </div>
      <p className="flex gap-2 border-t border-line pt-3 text-[12.5px] leading-relaxed text-ink-3">
        <Lock className="mt-0.5 size-3.5 shrink-0" />
        <span>
          Key 只存在这台电脑上，只会发给 <span className="text-ink-2">{hosts?.join("、") || "（还没有地址）"}</span>。规则更新后如果换了地址，陪伴猫会先问你。
        </span>
      </p>
    </div>
  );
}
