import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { validateArticle, validateRepository } from './validate.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const articleFile = new URL(
  '../../articles/2026-11-09-tour-eiffel.json',
  import.meta.url,
);
const article = JSON.parse(await readFile(articleFile, 'utf8'));

const clone = () => structuredClone(article);
const messages = (errors) => errors.join('\n');

test('valid article passes', () => {
  assert.deepEqual(validateArticle(clone(), 'article'), []);
});

test('rejects a non-redistributable source license', () => {
  const value = clone();
  value.source.license = 'CC BY-ND 4.0';
  assert.match(messages(validateArticle(value)), /source\.license/);
});

test('rejects evidence that is not an exact sentence', () => {
  const value = clone();
  value.questions[0].evidence = 'Cette phrase n existe pas dans le texte.';
  assert.match(
    messages(validateArticle(value)),
    /evidence must be an exact sentence/,
  );
});

test('rejects a misaligned Chinese translation', () => {
  const value = clone();
  value.translations.zh.paragraphs[0].sentences.pop();
  assert.match(
    messages(validateArticle(value)),
    /translations\.zh\.paragraphs\[0\]/,
  );
});

test('rejects duplicate options', () => {
  const value = clone();
  value.questions[0].options[1] = value.questions[0].options[0];
  assert.match(
    messages(validateArticle(value)),
    /4 unique non-empty strings/,
  );
});

test('rejects an invalid level', () => {
  const value = clone();
  value.level = 'C1';
  assert.match(messages(validateArticle(value)), /level must be one of/);
});

test('accepts optional publishedAt and attributionPosition', () => {
  const value = clone();
  value.source.publishedAt = '2026-11-08';
  value.source.attributionPosition = 'top';
  assert.deepEqual(validateArticle(value, 'article'), []);
});

test('rejects malformed optional source fields', () => {
  const value = clone();
  value.source.publishedAt = '08/11/2026';
  value.source.attributionPosition = 'middle';
  const output = messages(validateArticle(value));
  assert.match(output, /source\.publishedAt/);
  assert.match(output, /source\.attributionPosition/);
});

test('repository passes', async () => {
  const { errors, articleCount, monthCount } =
    await validateRepository(repoRoot);
  assert.deepEqual(errors, []);
  assert.ok(articleCount >= 1);
  assert.ok(monthCount >= 1);
});
