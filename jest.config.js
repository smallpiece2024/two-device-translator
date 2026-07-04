/** @type {import('jest').Config} */
const config = {
  testEnvironment: "node",
  transform: {
    "^.+\\.tsx?$": [
      "ts-jest",
      {
        tsconfig: {
          module: "commonjs",
          moduleResolution: "node",
          esModuleInterop: true,
          allowSyntheticDefaultImports: true,
          strict: false,
          jsx: "react-jsx",
        },
      },
    ],
  },
  moduleNameMapper: {
    "^@shared/(.*)$": "<rootDir>/shared/$1",
    "\\.module\\.css$": "identity-obj-proxy",
    "^@/(.*)$": "<rootDir>/src/$1",
  },
  testMatch: [
    "**/tests/**/*.test.ts",
    "**/tests/**/*.test.tsx",
    "**/__tests__/**/*.test.ts",
    "**/__tests__/**/*.test.tsx",
  ],
  moduleFileExtensions: ["ts", "tsx", "js", "jsx", "json"],
  testTimeout: 20000,
  // .claude/worktrees/ 配下（並列エージェントの作業コピー）を走査対象から除外
  modulePathIgnorePatterns: ["<rootDir>/.claude/", "<rootDir>/.next/", "<rootDir>/dist-server/"],
  testPathIgnorePatterns: ["/node_modules/", "<rootDir>/.claude/"],
};

module.exports = config;
