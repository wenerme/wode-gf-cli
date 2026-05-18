set dotenv-load := false

promql-generate:
    pnpm dlx peggy src/promql/parser.peggy --format es --dts --output src/promql/parser.js
    perl -0pi -e 's/\): any;/\): unknown;/g' src/promql/parser.d.ts
    python3 scripts/promql-postprocess-generated.py

promql-test: promql-generate
    pnpm exec vitest run src/promql/parser.test.ts
