// @ts-check Let TS check this config file

import zotero from "@zotero-plugin/eslint-config";

export default zotero({
  overrides: [
    {
      // tests/acceptance/ 是锁定验收测试（hash 锁定、不可修改），对其风格规则做豁免
      files: ["tests/acceptance/**/*.mjs"],
      rules: {
        "no-useless-escape": "off",
      },
    },
    {
      files: ["**/*.ts"],
      rules: {
        // We disable this rule here because the template
        // contains some unused examples and variables
        "@typescript-eslint/no-unused-vars": "off",
        // 预设 0.6.10 起随 ESLint 10 recommended 开启。本仓 13 处命中全是
        // 「let x = 兜底值; try { x = … } catch { return / 重赋 }」的防御性初始值，
        // 不是死赋值；为它重排产品代码没有收益，关掉（2026-09-14）
        "no-useless-assignment": "off",
      },
    },
  ],
});
