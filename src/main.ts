#!/usr/bin/env node

import { run } from "./cli";

run().catch((error) => {
  console.error(`[ERROR] ${(error as Error).message}`);
  process.exit(1);
});
