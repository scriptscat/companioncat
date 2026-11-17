/**
 * The fixed set of failure types (R6.3). Rules may override the message of a type in `errors`,
 * but cannot add types; the names match rules/schema/v1.json#/$defs/errorType.
 */
import type { ErrorType } from "./rules";

export type { ErrorType };

export interface ErrorTypeInfo {
  /** Short name shown in lists and the try-run panel. */
  title: string;
  /** Default message when the rule gives none. */
  message: string;
  /** Whether a retry can help; the provider's limits.retry.on still decides. */
  retry: boolean;
}

export const ERROR_TYPES: Readonly<Record<ErrorType, ErrorTypeInfo>> = {
  network: { title: "网络", message: "网络连接失败，请检查网络后再试", retry: true },
  timeout: { title: "超时", message: "等了太久没有回应，已放弃这次请求", retry: true },
  auth: { title: "认证（401/403）", message: "Key 无效、过期，或者没有权限", retry: false },
  rateLimit: { title: "太频繁（429）", message: "请求太频繁了，过一会儿再试", retry: true },
  server: { title: "服务端（5xx）", message: "服务商暂时出错了，稍后再试", retry: true },
  badInput: { title: "输入格式不对", message: "传给引擎的内容格式不对", retry: false },
  badOutput: { title: "返回格式不对", message: "引擎返回的内容格式不对", retry: false },
  hostUndeclared: { title: "域名未声明", message: "要访问的域名不在引擎声明的 hosts 里，已拒绝发送", retry: false },
  hostUnconfirmed: { title: "域名未确认", message: "引擎要访问的域名还没有确认，已暂停发送", retry: false },
  missingKey: { title: "缺 Key", message: "还没有填写这个引擎需要的 Key", retry: false },
  disabled: { title: "已停用", message: "这个引擎或实现已停用", retry: false },
};

/** Where an expression failed, for the try-run view (R12.2). */
export interface ExprFailure {
  /** Position name, e.g. "引擎 output". */
  position: string;
  /** Path of the template string inside the rendered value. */
  path: readonly (string | number)[];
  /** Expression source between `{{` and `}}`. */
  source: string;
  start: number;
  end: number;
  message: string;
}

export interface CallErrorDetail {
  /** HTTP status when a response arrived. */
  status?: number;
  /** First 500 characters of the raw response, keys masked (R4.3). */
  raw?: string;
  /** "request" for the main request, otherwise the step id. */
  step?: string;
  /** The host that was refused or needs confirming. */
  host?: string;
  expr?: ExprFailure;
}

export const RAW_LIMIT = 500;

/** A failed call, always one of the R6.3 types. Messages and details never carry keys. */
export class CallError extends Error {
  override readonly name = "CallError";
  constructor(
    readonly type: ErrorType,
    message: string = ERROR_TYPES[type].message,
    readonly detail: CallErrorDetail = {},
  ) {
    super(message);
  }

  get retry(): boolean {
    return ERROR_TYPES[this.type].retry;
  }
}

export function isCallError(e: unknown): e is CallError {
  return e instanceof CallError;
}

/** Default type for an HTTP status that no `errors` rule matched; undefined for 2xx. */
export function statusErrorType(status: number): ErrorType | undefined {
  if (status >= 200 && status < 300) return undefined;
  if (status === 401 || status === 403) return "auth";
  if (status === 408) return "timeout";
  if (status === 429) return "rateLimit";
  if (status >= 500) return "server";
  if (status >= 400) return "badInput";
  return "network";
}
