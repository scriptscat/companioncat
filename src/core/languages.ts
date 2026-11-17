export interface Language {
  readonly value: string;
  readonly label: string;
}

/** Target languages offered to users and to rules via `languages()`. Labels are native names. */
export const LANGUAGES: readonly Language[] = [
  { value: "zh-CN", label: "简体中文" },
  { value: "zh-TW", label: "繁體中文" },
  { value: "en", label: "English" },
  { value: "ja", label: "日本語" },
  { value: "ko", label: "한국어" },
  { value: "fr", label: "Français" },
  { value: "de", label: "Deutsch" },
  { value: "es", label: "Español" },
  { value: "pt", label: "Português" },
  { value: "it", label: "Italiano" },
  { value: "ru", label: "Русский" },
  { value: "vi", label: "Tiếng Việt" },
  { value: "th", label: "ไทย" },
  { value: "ar", label: "العربية" },
];

/** The detected-language placeholder (R9 `selection.lang`); not a translation target. */
export const AUTO = "auto";

/** Chinese names, for text such as the card header's "英语 → 简体中文" (R10.1). */
const NAMES = new Map<string, string>([
  ["zh-CN", "简体中文"],
  ["zh-TW", "繁体中文"],
  ["en", "英语"],
  ["ja", "日语"],
  ["ko", "韩语"],
  ["fr", "法语"],
  ["de", "德语"],
  ["es", "西班牙语"],
  ["pt", "葡萄牙语"],
  ["it", "意大利语"],
  ["ru", "俄语"],
  ["vi", "越南语"],
  ["th", "泰语"],
  ["ar", "阿拉伯语"],
  [AUTO, "自动检测"],
]);

/** The Chinese name of a language code (`langName`); unknown codes come back unchanged. */
export function languageName(code: string): string {
  return NAMES.get(code) ?? code;
}

export type DetectedLang = "zh-CN" | "ja" | "ko" | "en" | typeof AUTO;

const count = (text: string, re: RegExp) => text.match(re)?.length ?? 0;

/** Rough script-ratio detection: Han / kana / Hangul against Latin letters. */
export function detectLang(text: string): DetectedLang {
  const han = count(text, /\p{Script=Han}/gu);
  const kana = count(text, /[\p{Script=Hiragana}\p{Script=Katakana}]/gu);
  const hangul = count(text, /\p{Script=Hangul}/gu);
  // Latin is counted in words so one CJK char weighs like one Latin word.
  const latin = count(text, /\p{Script=Latin}+/gu);
  const cjk = han + kana + hangul;
  if (cjk === 0 && latin === 0) return AUTO;
  if (latin > cjk) return "en";
  if (hangul >= han + kana) return "ko";
  return kana > 0 ? "ja" : "zh-CN";
}
