set dotenv-load := false

promql-generate:
    pnpm run generate:promql

promql-test: promql-generate
    pnpm exec vitest run src/promql/parser.test.ts
