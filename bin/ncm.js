#!/usr/bin/env node

import { main } from '../src/cli.js';

main(process.argv.slice(2)).catch((error) => {
  if (error?.name === 'AbortError') {
    process.exitCode = 130;
    return;
  }
  console.error(`\n错误：${error.message}`);
  if (process.env.DEBUG) console.error(error.stack);
  process.exitCode = 1;
});
