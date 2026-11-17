import type { ReactNode } from "react";

type Schema = { type?: string; title?: string; properties?: Record<string, Schema>; items?: Schema } | undefined;

const kind = (v: unknown, schema: Schema) => {
  if (Array.isArray(v)) return "array";
  if (v !== null && typeof v === "object") return "object";
  if (v === undefined || v === null) return schema?.type === "array" ? "array" : schema?.type === "object" ? "object" : "scalar";
  return "scalar";
};

/** Auto view (R9.10): string -> text, object -> key/value table, array -> list. */
export function AutoView({ value, schema }: { value: unknown; schema?: unknown }): ReactNode {
  const s = (schema && typeof schema === "object" ? schema : undefined) as Schema;
  const k = kind(value, s);
  if (k === "array") {
    const list = Array.isArray(value) ? value : [];
    return (
      <ul className="list-disc space-y-1 pl-5" data-part="auto-list">
        {list.map((v, i) => (
          <li key={i}>
            <AutoView value={v} schema={s?.items} />
          </li>
        ))}
      </ul>
    );
  }
  if (k === "object") {
    const o = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(s?.properties ?? {}), ...Object.keys(o)])].filter((x) => x in o);
    return (
      <table className="w-full text-[13.5px]" data-part="auto-table">
        <tbody>
          {keys.map((key) => (
            <tr key={key} className="align-top">
              <th scope="row" className="pr-3 pb-1 text-left font-medium whitespace-nowrap text-ink-3">
                {s?.properties?.[key]?.title ?? key}
              </th>
              <td className="pb-1 text-ink">
                <AutoView value={o[key]} schema={s?.properties?.[key]} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    );
  }
  return <span className="font-read text-ink">{value === undefined || value === null ? "" : String(value)}</span>;
}
