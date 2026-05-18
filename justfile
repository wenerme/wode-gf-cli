set dotenv-load := false

promql-generate:
    pnpm dlx peggy src/promql/parser.peggy --format es --dts --output src/promql/parser.js --return-types '{"Start":"unknown"}'

promql-test: promql-generate
    pnpm exec vitest run src/promql/parser.test.ts
