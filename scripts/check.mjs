#!/usr/bin/env node
// Publication gate for the public adapted-article repository.
// Every file that can be served must pass the same contract the app expects.
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const errors = [];
const LEVELS = new Set(['A2', 'B1', 'B2']);
const ALLOWED_LICENSE =
  /(^|[^a-z])(pd|public domain|cc0|cc by(-sa)?)([^a-z]|$)/i;
const FORBIDDEN_LICENSE =
  /(^|[^a-z])(nc|nd|nc-nd|all rights reserved|proprietary|unknown)([^a-z]|$)/i;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const rel = (file) => path.relative(root, file).split(path.sep).join('/');
const fail = (file, message) => errors.push(`${rel(file)}: ${message}`);
const isRecord = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value) =>
  typeof value === 'string' && value.trim() !== '';

async function readJson(file) {
  let raw;
  try {
    raw = await readFile(file, 'utf8');
  } catch (error) {
    fail(file, `cannot read (${error.message})`);
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch (error) {
    fail(file, `invalid JSON (${error.message})`);
    return undefined;
  }
}

function requireString(record, key, file, label = key) {
  if (!isRecord(record) || !isNonEmptyString(record[key])) {
    fail(file, `${label} must be a non-empty string`);
    return undefined;
  }
  return record[key];
}

function requireHttpUrl(record, key, file, label = key) {
  const value = requireString(record, key, file, label);
  if (value && !/^https?:\/\//i.test(value)) {
    fail(file, `${label} must be an http(s) URL`);
  }
  return value;
}

function validateSource(article, file) {
  const source = article.source;
  if (!isRecord(source)) {
    fail(file, 'source must be an object');
    return;
  }

  requireString(source, 'site', file, 'source.site');
  requireString(source, 'title', file, 'source.title');
  requireHttpUrl(source, 'url', file, 'source.url');
  requireHttpUrl(source, 'licenseUrl', file, 'source.licenseUrl');
  const retrievedAt = requireString(
    source,
    'retrievedAt',
    file,
    'source.retrievedAt',
  );
  if (retrievedAt && !DATE_RE.test(retrievedAt)) {
    fail(file, 'source.retrievedAt must be YYYY-MM-DD');
  }

  if (
    !Array.isArray(source.authors) ||
    source.authors.length === 0 ||
    source.authors.some((author) => !isNonEmptyString(author))
  ) {
    fail(file, 'source.authors must be a non-empty array of strings');
  }

  const license = requireString(source, 'license', file, 'source.license');
  if (
    license &&
    (!ALLOWED_LICENSE.test(license) || FORBIDDEN_LICENSE.test(license))
  ) {
    fail(
      file,
      `source.license "${license}" is not redistributable; expected PD, CC0, CC BY or CC BY-SA`,
    );
  }
}

function validateAdaptation(article, file) {
  const adaptation = article.adaptation;
  if (!isRecord(adaptation)) {
    fail(file, 'adaptation must be an object');
    return;
  }

  requireString(adaptation, 'model', file, 'adaptation.model');
  const date = requireString(adaptation, 'date', file, 'adaptation.date');
  if (date && !DATE_RE.test(date)) {
    fail(file, 'adaptation.date must be YYYY-MM-DD');
  }
  requireString(adaptation, 'changes', file, 'adaptation.changes');
  requireString(adaptation, 'reviewer', file, 'adaptation.reviewer');
}

function validateLicense(article, file) {
  const license = article.license;
  if (!isRecord(license)) {
    fail(file, 'license must be an object');
    return;
  }
  if (license.name !== 'CC BY-SA 4.0') {
    fail(file, 'license.name must be "CC BY-SA 4.0"');
  }
  requireHttpUrl(license, 'url', file, 'license.url');
}

function validateTranslationMap(value, expected, file, label) {
  if (!isRecord(value)) {
    fail(file, `${label} must be an object`);
    return;
  }

  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    fail(file, `${label} keys must match the article`);
    return;
  }

  for (const key of actualKeys) {
    if (!isNonEmptyString(value[key])) {
      fail(file, `${label}["${key}"] must be a non-empty string`);
    }
  }
}

function validateTranslation(
  article,
  file,
  sentencesByParagraph,
  terms,
  questionIds,
) {
  const translation = isRecord(article.translations)
    ? article.translations.zh
    : undefined;
  if (!isRecord(translation)) {
    fail(file, 'translations.zh must be an object');
    return;
  }

  requireString(translation, 'title', file, 'translations.zh.title');
  requireString(translation, 'summary', file, 'translations.zh.summary');

  if (
    !Array.isArray(translation.paragraphs) ||
    translation.paragraphs.length !== sentencesByParagraph.length
  ) {
    fail(
      file,
      `translations.zh.paragraphs must have ${sentencesByParagraph.length} paragraphs`,
    );
  } else {
    translation.paragraphs.forEach((paragraph, paragraphIndex) => {
      const expected = sentencesByParagraph[paragraphIndex];
      if (
        !isRecord(paragraph) ||
        !Array.isArray(paragraph.sentences) ||
        paragraph.sentences.length !== expected ||
        paragraph.sentences.some((sentence) => !isNonEmptyString(sentence))
      ) {
        fail(
          file,
          `translations.zh.paragraphs[${paragraphIndex}] must align with ${expected} source sentences`,
        );
      }
    });
  }

  validateTranslationMap(
    translation.glossary,
    terms,
    file,
    'translations.zh.glossary',
  );
  validateTranslationMap(
    translation.questions,
    questionIds,
    file,
    'translations.zh.questions',
  );
}

function validateArticle(article, file) {
  if (!isRecord(article)) {
    fail(file, 'article must be an object');
    return;
  }

  requireString(article, 'id', file, 'id');
  requireString(article, 'title', file, 'title');
  requireString(article, 'theme', file, 'theme');
  requireString(article, 'summary', file, 'summary');
  const date = requireString(article, 'date', file, 'date');
  if (date && !DATE_RE.test(date)) {
    fail(file, 'date must be YYYY-MM-DD');
  }
  if (!LEVELS.has(article.level)) {
    fail(file, `level must be one of ${[...LEVELS].join(', ')}`);
  }

  const paragraphs = Array.isArray(article.paragraphs) ? article.paragraphs : [];
  const sentences = new Set();
  if (paragraphs.length === 0) {
    fail(file, 'paragraphs must be a non-empty array');
  }
  paragraphs.forEach((paragraph, paragraphIndex) => {
    if (
      !isRecord(paragraph) ||
      !Array.isArray(paragraph.sentences) ||
      paragraph.sentences.length === 0
    ) {
      fail(
        file,
        `paragraphs[${paragraphIndex}].sentences must be a non-empty array`,
      );
      return;
    }
    paragraph.sentences.forEach((sentence, sentenceIndex) => {
      if (!isNonEmptyString(sentence)) {
        fail(
          file,
          `paragraphs[${paragraphIndex}].sentences[${sentenceIndex}] must be a non-empty string`,
        );
      } else {
        sentences.add(sentence);
      }
    });
  });

  const terms = new Set();
  if (!Array.isArray(article.glossary)) {
    fail(file, 'glossary must be an array');
  } else {
    article.glossary.forEach((entry, entryIndex) => {
      const term = isRecord(entry) ? entry.term : undefined;
      if (!isNonEmptyString(term)) {
        fail(file, `glossary[${entryIndex}].term must be a non-empty string`);
      } else if (terms.has(term)) {
        fail(file, `glossary[${entryIndex}] duplicates "${term}"`);
      } else {
        terms.add(term);
      }
    });
  }

  const questionIds = new Set();
  if (!Array.isArray(article.questions) || article.questions.length === 0) {
    fail(file, 'questions must be a non-empty array');
  } else {
    article.questions.forEach((question, questionIndex) => {
      if (!isRecord(question)) {
        fail(file, `questions[${questionIndex}] must be an object`);
        return;
      }
      const id = requireString(
        question,
        'id',
        file,
        `questions[${questionIndex}].id`,
      );
      if (id) {
        if (questionIds.has(id)) {
          fail(file, `questions[${questionIndex}] duplicates id "${id}"`);
        }
        questionIds.add(id);
      }
      requireString(
        question,
        'prompt',
        file,
        `questions[${questionIndex}].prompt`,
      );

      const options = question.options;
      if (
        !Array.isArray(options) ||
        options.length !== 4 ||
        options.some((option) => !isNonEmptyString(option)) ||
        new Set(options).size !== 4
      ) {
        fail(
          file,
          `questions[${questionIndex}].options must be 4 unique non-empty strings`,
        );
      }
      if (
        !Number.isInteger(question.answerIndex) ||
        question.answerIndex < 0 ||
        question.answerIndex >= (Array.isArray(options) ? options.length : 0)
      ) {
        fail(
          file,
          `questions[${questionIndex}].answerIndex must be within the options range`,
        );
      }

      const evidence = requireString(
        question,
        'evidence',
        file,
        `questions[${questionIndex}].evidence`,
      );
      if (evidence && !sentences.has(evidence)) {
        fail(
          file,
          `questions[${questionIndex}].evidence must be an exact sentence from the article`,
        );
      }
    });
  }

  validateTranslation(
    article,
    file,
    paragraphs.map((paragraph) =>
      Array.isArray(paragraph?.sentences) ? paragraph.sentences.length : 0,
    ),
    terms,
    questionIds,
  );
  validateSource(article, file);
  validateAdaptation(article, file);
  validateLicense(article, file);
}

async function listJsonFiles(directory) {
  try {
    const entries = await readdir(directory, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => path.normalize(path.join(directory, entry.name)));
  } catch {
    return [];
  }
}

const manifestFile = path.join(root, 'manifest.json');
const manifest = await readJson(manifestFile);
const months =
  isRecord(manifest) && Array.isArray(manifest.months) ? manifest.months : [];

if (
  !isRecord(manifest) ||
  !Array.isArray(manifest.months) ||
  manifest.months.length === 0 ||
  manifest.months.some(
    (month) => !isNonEmptyString(month) || !MONTH_RE.test(month),
  )
) {
  fail(manifestFile, 'months must be a non-empty array of YYYY-MM strings');
} else if (new Set(months).size !== months.length) {
  fail(manifestFile, 'months must be unique');
}

const referencedArticles = new Set();
for (const month of months) {
  if (!isNonEmptyString(month) || !MONTH_RE.test(month)) {
    continue;
  }
  const monthFile = path.join(root, 'months', `${month}.json`);
  const index = await readJson(monthFile);
  if (!isRecord(index)) {
    continue;
  }
  if (index.month !== month) {
    fail(monthFile, `month must be "${month}"`);
  }
  if (!Array.isArray(index.articles)) {
    fail(monthFile, 'articles must be an array');
    continue;
  }

  for (const [entryIndex, entry] of index.articles.entries()) {
    if (!isRecord(entry)) {
      fail(monthFile, `articles[${entryIndex}] must be an object`);
      continue;
    }

    const id = requireString(
      entry,
      'id',
      monthFile,
      `articles[${entryIndex}].id`,
    );
    requireString(entry, 'title', monthFile, `articles[${entryIndex}].title`);
    requireString(entry, 'theme', monthFile, `articles[${entryIndex}].theme`);
    requireString(
      entry,
      'summary',
      monthFile,
      `articles[${entryIndex}].summary`,
    );
    const entryDate = requireString(
      entry,
      'date',
      monthFile,
      `articles[${entryIndex}].date`,
    );
    if (entryDate && !DATE_RE.test(entryDate)) {
      fail(monthFile, `articles[${entryIndex}].date must be YYYY-MM-DD`);
    }
    if (!LEVELS.has(entry.level)) {
      fail(monthFile, `articles[${entryIndex}].level must be A2, B1 or B2`);
    }

    const articlePath = requireString(
      entry,
      'path',
      monthFile,
      `articles[${entryIndex}].path`,
    );
    if (id && articlePath !== `articles/${id}.json`) {
      fail(
        monthFile,
        `articles[${entryIndex}].path must be "articles/${id}.json"`,
      );
    }
    if (!articlePath) {
      continue;
    }

    const articleFile = path.normalize(path.join(root, articlePath));
    referencedArticles.add(articleFile);
    const article = await readJson(articleFile);
    if (!isRecord(article)) {
      continue;
    }
    if (id && article.id !== id) {
      fail(articleFile, `id must match the month index ("${id}")`);
    }
    validateArticle(article, articleFile);
  }
}

const articleFiles = await listJsonFiles(path.join(root, 'articles'));
for (const articleFile of articleFiles) {
  if (!referencedArticles.has(articleFile)) {
    fail(articleFile, 'article is not referenced by any month index');
  }
}

const monthFiles = await listJsonFiles(path.join(root, 'months'));
const listedMonths = new Set(
  months
    .filter((month) => isNonEmptyString(month) && MONTH_RE.test(month))
    .map((month) =>
      path.normalize(path.join(root, 'months', `${month}.json`)),
    ),
);
for (const monthFile of monthFiles) {
  if (!listedMonths.has(monthFile)) {
    fail(monthFile, 'month index is not listed in manifest.json');
  }
}

if (errors.length > 0) {
  console.error(`Content check failed with ${errors.length} error(s):`);
  for (const error of errors) {
    console.error(`- ${error}`);
  }
  process.exit(1);
}

console.log(
  `Content check OK: ${articleFiles.length} article(s) across ${monthFiles.length} month(s).`,
);
