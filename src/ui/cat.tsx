// 占位插画（原型 v5 cat.tsx）：蜷缩睡觉的卡通猫，橘猫 / 三花两种花色（正式 logo 到位后替换此文件）
// 插画颜色固定，不随深浅主题变化；只有描边跟随 --outline。
import { useId } from "react";

export type CatBreed = "ginger" | "calico";

const FUR = {
  ginger: { base: "#F39A2E", mark: "#C4660F" },
  calico: { base: "#FFFFFF", ginger: "#F39A2E", black: "#2A2421" },
};
const LINE = "var(--outline)";

const BODY = "M7 50.5C7 34.5 19.5 23.5 36 23.5C50.5 23.5 58.5 33.5 58.5 43.5C58.5 49 55 52.5 49 52.5H11C8.8 52.5 7 51.8 7 50.5Z";
const EAR_L = "M10 35L11 21.5L19.5 29.5Z";
const EAR_R = "M20.5 28.5L28.5 22L29.5 35Z";
const TAIL = "M55.5 44C60 55.5 43 58.5 27 55.5";

export function Cat({
  breed = "ginger",
  size = 64,
  awake = false,
  zzz = false,
  className,
  title,
}: {
  breed?: CatBreed;
  size?: number;
  awake?: boolean;
  zzz?: boolean;
  className?: string;
  title?: string;
}) {
  const id = useId().replace(/:/g, "");
  const base = breed === "ginger" ? FUR.ginger.base : FUR.calico.base;
  const lift = awake ? -2.5 : 0;

  return (
    <svg width={size} height={size} viewBox="0 0 64 64" className={className} role={title ? "img" : undefined} aria-label={title} aria-hidden={title ? undefined : true}>
      <defs>
        <clipPath id={`b${id}`}>
          <path d={BODY} />
        </clipPath>
        <clipPath id={`h${id}`}>
          <path d={EAR_L} />
          <path d={EAR_R} />
          <circle cx="19.5" cy="40" r="11.5" />
        </clipPath>
      </defs>

      {/* 身体 */}
      <path d={BODY} fill={base} />
      <g clipPath={`url(#b${id})`}>
        {breed === "ginger" ? (
          <g fill="none" stroke={FUR.ginger.mark} strokeWidth="2.6" strokeLinecap="round">
            <path d="M33 23Q35.5 28.5 33.5 34" />
            <path d="M40.5 23.5Q43 29 41 34.5" />
            <path d="M48 26.5Q50.5 31.5 48.5 36" />
          </g>
        ) : (
          <>
            <ellipse cx="45" cy="31" rx="15" ry="10.5" fill={FUR.calico.ginger} />
            <ellipse cx="31" cy="25" rx="7" ry="5.5" fill={FUR.calico.black} />
          </>
        )}
      </g>
      <path d={BODY} fill="none" stroke={LINE} strokeWidth="2" strokeLinejoin="round" />

      {/* 尾巴绕到身前 */}
      <path d={TAIL} fill="none" stroke={LINE} strokeWidth="8.5" strokeLinecap="round" />
      <path d={TAIL} fill="none" stroke={base} strokeWidth="5" strokeLinecap="round" />
      {breed === "calico" && <path d="M33 56.3C30.8 56.1 28.8 55.9 27 55.5" fill="none" stroke={FUR.calico.black} strokeWidth="5" strokeLinecap="round" />}
      {breed === "ginger" && <path d="M38 56.6C35 56.7 31 56.3 27 55.5" fill="none" stroke={FUR.ginger.mark} strokeWidth="5" strokeLinecap="round" strokeDasharray="2.5 3" />}

      {/* 头 */}
      <g transform={`translate(0 ${lift})`}>
        <path d={EAR_L} fill={base} />
        <path d={EAR_R} fill={base} />
        <circle cx="19.5" cy="40" r="11.5" fill={base} />
        <g clipPath={`url(#h${id})`}>
          {breed === "ginger" ? (
            <g fill="none" stroke={FUR.ginger.mark} strokeWidth="2.2" strokeLinecap="round">
              <path d="M17 29.5V33.5" />
              <path d="M21.5 29V33" />
            </g>
          ) : (
            <ellipse cx="26.5" cy="31" rx="7.5" ry="7" fill={FUR.calico.black} />
          )}
        </g>
        <path d="M12.3 31.5L12.7 26L16 29.3Z" fill="var(--nose)" />
        <path d={EAR_L} fill="none" stroke={LINE} strokeWidth="2" strokeLinejoin="round" />
        <path d={EAR_R} fill="none" stroke={LINE} strokeWidth="2" strokeLinejoin="round" />
        <circle cx="19.5" cy="40" r="11.5" fill="none" stroke={LINE} strokeWidth="2" />
        {awake ? (
          <>
            <ellipse cx="15.3" cy="39.6" rx="1.9" ry="2.4" fill={LINE} />
            <ellipse cx="23.7" cy="39.6" rx="1.9" ry="2.4" fill={LINE} />
            <circle cx="15.9" cy="38.8" r="0.7" fill="#fff" />
            <circle cx="24.3" cy="38.8" r="0.7" fill="#fff" />
          </>
        ) : (
          <>
            <path d="M12.8 40.2Q15.2 42.5 17.6 40.2" fill="none" stroke={LINE} strokeWidth="1.7" strokeLinecap="round" />
            <path d="M21.4 40.2Q23.8 42.5 26.2 40.2" fill="none" stroke={LINE} strokeWidth="1.7" strokeLinecap="round" />
          </>
        )}
        <path d="M18.6 44.6H20.4L19.5 45.7Z" fill="var(--nose)" stroke="var(--nose)" strokeWidth="0.9" strokeLinejoin="round" />
      </g>

      {zzz && !awake && (
        <text x="40" y="17" fontSize="10" fontWeight="700" fill="var(--ink-3)" fontFamily="ui-rounded, sans-serif">
          z
          <tspan x="47" y="10" fontSize="7.5">
            z
          </tspan>
        </text>
      )}
    </svg>
  );
}

// 猫爪：划词后出现在选区旁
export function Paw({ size = 18 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      <g fill="#F39A2E" stroke="var(--outline)" strokeWidth="1.3">
        <path d="M12 12.2C15.6 12.2 18.3 15 18.3 17.4C18.3 19.6 16.4 20.4 14.6 19.9C13.6 19.6 12.8 19.4 12 19.4C11.2 19.4 10.4 19.6 9.4 19.9C7.6 20.4 5.7 19.6 5.7 17.4C5.7 15 8.4 12.2 12 12.2Z" />
        <ellipse cx="5.4" cy="10.4" rx="2" ry="2.5" transform="rotate(-18 5.4 10.4)" />
        <ellipse cx="9.4" cy="6.4" rx="2" ry="2.6" transform="rotate(-6 9.4 6.4)" />
        <ellipse cx="14.6" cy="6.4" rx="2" ry="2.6" transform="rotate(6 14.6 6.4)" />
        <ellipse cx="18.6" cy="10.4" rx="2" ry="2.5" transform="rotate(18 18.6 10.4)" />
      </g>
    </svg>
  );
}
