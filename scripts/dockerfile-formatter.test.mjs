import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import * as prettier from "prettier";

test("Dockerfile formatting handles JSON ENTRYPOINT without silent fallback", async () => {
  const filepath = fileURLToPath(
    new URL("../mage/Dockerfile", import.meta.url),
  );
  const options = { ...(await prettier.resolveConfig(filepath)), filepath };
  const source =
    'FROM node:22\nENV NODE_ENV production\nENTRYPOINT ["npm", "run", "start-production"]\n';
  const expected =
    'FROM node:22\nENV NODE_ENV=production\nENTRYPOINT ["npm", "run", "start-production"]\n';

  assert.equal(await prettier.check(source, options), false);
  const formatted = await prettier.format(source, options);
  assert.equal(formatted, expected);
  assert.equal(await prettier.format(formatted, options), formatted);
});
