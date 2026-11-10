#!/usr/bin/env node
// Publication gate for the public adapted-article repository.
// Every file that can be served must pass the shared article contract that
// the pipeline also imports before writing.
import { validateRepository } from './lib/validate.mjs';

const { errors, articleCount, monthCount } = await validateRepository(
  process.cwd(),
);

if (errors.length > 0) {
  console.error(`Content check failed with ${errors.length} error(s):`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Content check OK: ${articleCount} article(s) across ${monthCount} month(s).`,
);
