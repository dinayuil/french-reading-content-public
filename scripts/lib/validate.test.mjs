import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
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

test('rejects an impossible article date', () => {
  const value = clone();
  value.date = '2026-02-30';
  assert.match(messages(validateArticle(value)), /date must be/);
});

function articleOn(date) {
  const value = clone();
  value.id = `${date}-test-article`;
  value.date = date;
  return value;
}

function entryFor(value) {
  return {
    id: value.id,
    title: value.title,
    level: value.level,
    theme: value.theme,
    date: value.date,
    summary: value.summary,
    path: `articles/${value.id}.json`,
  };
}

function fixture(value) {
  return {
    days: [value.date],
    dayFiles: {
      [value.date]: { date: value.date, articles: [entryFor(value)] },
    },
    articles: { [value.id]: value },
  };
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

async function createRepo(
  t,
  { days, dayFiles = {}, articles = {}, manifest, extraFiles = {} },
) {
  const root = await mkdtemp(path.join(tmpdir(), 'frp-content-'));
  t.after(() => rm(root, { recursive: true, force: true }));

  await writeJson(path.join(root, 'manifest.json'), manifest ?? { days });
  for (const [date, index] of Object.entries(dayFiles)) {
    await writeJson(path.join(root, 'days', `${date}.json`), index);
  }
  for (const [id, value] of Object.entries(articles)) {
    await writeJson(path.join(root, 'articles', `${id}.json`), value);
  }
  for (const [relativePath, value] of Object.entries(extraFiles)) {
    await writeJson(path.join(root, relativePath), value);
  }

  return root;
}

test('accepts an empty repository with no days', async (t) => {
  const root = await createRepo(t, { days: [] });
  const { errors, articleCount, dayCount } = await validateRepository(root);
  assert.deepEqual(errors, []);
  assert.equal(articleCount, 0);
  assert.equal(dayCount, 0);
});

test('accepts a valid day index', async (t) => {
  const root = await createRepo(t, fixture(articleOn('2026-11-11')));
  const { errors, articleCount, dayCount } = await validateRepository(root);
  assert.deepEqual(errors, []);
  assert.equal(articleCount, 1);
  assert.equal(dayCount, 1);
});

test('accepts a leap-day index', async (t) => {
  const root = await createRepo(t, fixture(articleOn('2024-02-29')));
  assert.deepEqual((await validateRepository(root)).errors, []);
});

test('rejects duplicate days in the manifest', async (t) => {
  const value = articleOn('2026-11-11');
  const root = await createRepo(t, {
    ...fixture(value),
    days: [value.date, value.date],
  });
  assert.match(
    messages((await validateRepository(root)).errors),
    /days must be unique/,
  );
});

test('rejects an impossible day in the manifest', async (t) => {
  const value = articleOn('2026-11-11');
  const root = await createRepo(t, {
    ...fixture(value),
    days: ['2026-02-30'],
  });
  assert.match(
    messages((await validateRepository(root)).errors),
    /valid YYYY-MM-DD/,
  );
});

test('rejects a manifest that still declares months', async (t) => {
  const root = await createRepo(t, {
    days: [],
    manifest: { days: [], months: ['2026-11'] },
  });
  assert.match(
    messages((await validateRepository(root)).errors),
    /days instead of months/,
  );
});

test('rejects a day index whose date does not match its file name', async (t) => {
  const value = articleOn('2026-11-11');
  const root = await createRepo(t, {
    days: [value.date],
    dayFiles: {
      [value.date]: { date: '2026-11-12', articles: [entryFor(value)] },
    },
    articles: { [value.id]: value },
  });
  assert.match(
    messages((await validateRepository(root)).errors),
    /date must be "2026-11-11"/,
  );
});

test('rejects an entry whose date differs from the day index', async (t) => {
  const value = articleOn('2026-11-11');
  const entry = { ...entryFor(value), date: '2026-11-12' };
  const root = await createRepo(t, {
    days: [value.date],
    dayFiles: { [value.date]: { date: value.date, articles: [entry] } },
    articles: { [value.id]: value },
  });
  assert.match(
    messages((await validateRepository(root)).errors),
    /must match the day index/,
  );
});

test('rejects article metadata that differs from the day index', async (t) => {
  const value = articleOn('2026-11-11');
  const indexed = { ...entryFor(value), title: 'Un autre titre' };
  const root = await createRepo(t, {
    days: [value.date],
    dayFiles: { [value.date]: { date: value.date, articles: [indexed] } },
    articles: { [value.id]: value },
  });
  assert.match(
    messages((await validateRepository(root)).errors),
    /title must match the day index/,
  );
});

test('rejects an article missing from every day index', async (t) => {
  const value = articleOn('2026-11-11');
  const orphan = articleOn('2026-11-10');
  const root = await createRepo(t, {
    ...fixture(value),
    articles: { [value.id]: value, [orphan.id]: orphan },
  });
  assert.match(
    messages((await validateRepository(root)).errors),
    /not referenced by any day index/,
  );
});

test('rejects duplicate entries for one article', async (t) => {
  const value = articleOn('2026-11-11');
  const root = await createRepo(t, {
    days: [value.date],
    dayFiles: {
      [value.date]: {
        date: value.date,
        articles: [entryFor(value), entryFor(value)],
      },
    },
    articles: { [value.id]: value },
  });
  assert.match(
    messages((await validateRepository(root)).errors),
    /duplicates id/,
  );
});

test('rejects an article referenced from more than one day index', async (t) => {
  const value = articleOn('2026-11-09');
  const otherDay = '2026-11-10';
  const root = await createRepo(t, {
    days: [otherDay, value.date],
    dayFiles: {
      [value.date]: { date: value.date, articles: [entryFor(value)] },
      [otherDay]: {
        date: otherDay,
        articles: [{ ...entryFor(value), date: otherDay }],
      },
    },
    articles: { [value.id]: value },
  });
  assert.match(
    messages((await validateRepository(root)).errors),
    /referenced by more than one day index/,
  );
});

test('rejects a day index that is not listed in the manifest', async (t) => {
  const value = articleOn('2026-11-11');
  const extra = articleOn('2026-11-10');
  const root = await createRepo(t, {
    days: [value.date],
    dayFiles: {
      [value.date]: { date: value.date, articles: [entryFor(value)] },
      [extra.date]: { date: extra.date, articles: [entryFor(extra)] },
    },
    articles: { [value.id]: value, [extra.id]: extra },
  });
  assert.match(
    messages((await validateRepository(root)).errors),
    /not listed in manifest\.json/,
  );
});

test('rejects a legacy month index', async (t) => {
  const root = await createRepo(t, {
    ...fixture(articleOn('2026-11-11')),
    extraFiles: {
      'months/2026-11.json': { month: '2026-11', articles: [] },
    },
  });
  assert.match(
    messages((await validateRepository(root)).errors),
    /month index is no longer supported/,
  );
});

test('repository passes', async () => {
  const { errors, articleCount, dayCount } =
    await validateRepository(repoRoot);
  assert.deepEqual(errors, []);
  assert.ok(articleCount >= 1);
  assert.ok(dayCount >= 1);
});
