import { Btn, EmptyRules } from "../ui/ui";
import { useShell } from "./context";

/** 没有任何规则时（R1.6）：一句说明 + 「订阅官方规则」。气泡里是紧凑的左对齐版本，引擎页是居中版本。 */
export function SubscribeEmpty({ title, body, compact }: { title: string; body: string; compact?: boolean }) {
  const { subscribe } = useShell();
  const disabled = !subscribe.available || subscribe.busy;
  const error = subscribe.error && (
    <p role="alert" className="mt-2 text-[12.5px] leading-relaxed text-berry">
      订阅失败：{subscribe.error}
    </p>
  );
  if (!compact)
    return (
      <EmptyRules title={title} body={body} onSubscribe={subscribe.run} disabled={disabled}>
        {error}
      </EmptyRules>
    );
  return (
    <>
      <p className="text-[15px] font-bold">{title}</p>
      <p className="mt-1 text-[13px] leading-relaxed text-ink-2">{body}</p>
      <Btn size="sm" className="mt-3" onClick={subscribe.run} disabled={disabled}>
        订阅官方规则
      </Btn>
      {error}
    </>
  );
}
