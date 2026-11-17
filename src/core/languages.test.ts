import { describe, expect, it } from "vitest";
import { detectLang, languageName, LANGUAGES } from "./languages";

describe("languages", () => {
  it("lists target languages as select options", () => {
    expect(LANGUAGES).toContainEqual({ value: "zh-CN", label: "简体中文" });
    expect(LANGUAGES).toContainEqual({ value: "en", label: "English" });
    expect(LANGUAGES.map((l) => l.value)).toEqual(expect.arrayContaining(["zh-TW", "ja", "ko"]));
    expect(LANGUAGES.map((l) => l.value)).not.toContain("auto");
  });

  it("names a language code, falling back to the code itself", () => {
    expect(languageName("zh-CN")).toBe("简体中文");
    expect(languageName("ja")).toBe("日语");
    expect(languageName("en")).toBe("英语");
    expect(languageName("auto")).toBe("自动检测");
    expect(languageName("xx-YY")).toBe("xx-YY");
  });

  it("roughly detects zh-CN / ja / ko / en / auto by script ratio", () => {
    expect(detectLang("今天天气很好")).toBe("zh-CN");
    expect(detectLang("こんにちは、世界")).toBe("ja");
    expect(detectLang("東京へ行きます")).toBe("ja");
    expect(detectLang("안녕하세요 세계")).toBe("ko");
    expect(detectLang("Hello, world")).toBe("en");
    expect(detectLang("Hello 世界, this is mostly English")).toBe("en");
    expect(detectLang("这是 mostly 中文的句子啊")).toBe("zh-CN");
    expect(detectLang("12345 !?")).toBe("auto");
    expect(detectLang("")).toBe("auto");
  });
});
