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
      },
    },
  ],
});
