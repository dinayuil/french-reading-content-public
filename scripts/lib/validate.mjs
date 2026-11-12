import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const LEVELS = new Set(['A2', 'B1', 'B2']);
const ALLOWED_LICENSE =
  /(^|[^a-z])(pd|public domain|cc0|cc by(-sa)?)([^a-z]|$)/i;
const FORBIDDEN_LICENSE =
  /(^|[^a-z])(nc|nd|nc-nd|all rights reserved|proprietary|unknown)([^a-z]|$)/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function isCalendarDate(value) {
  if (typeof value !== 'string' || !DATE_RE.test(value)) {
    return false;
  }
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

const isRecord = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value) =>
  typeof value === 'string' && value.trim() !== '';

function requireString(record, key, fail, label = key) {
  if (!isRecord(record) || !isNonEmptyString(record[key])) {
    fail(`${label} must be a non-empty string`);
    return undefined;
  }
  return record[key];
}

function requireHttpUrl(record, key, fail, label = key) {
  const value = requireString(record, key, fail, label);
  if (value && !/^https?:\/\//i.test(value)) {
    fail(`${label} must be an http(s) URL`);
  }
  return value;
}

function validateSource(article, fail) {
  const source = article.source;
  if (!isRecord(source)) {
    fail('source must be an object');
    return;
  }

  requireString(source, 'site', fail, 'source.site');
  requireString(source, 'title', fail, 'source.title');
  requireHttpUrl(source, 'url', fail, 'source.url');
  requireHttpUrl(source, 'licenseUrl', fail, 'source.licenseUrl');
  const retrievedAt = requireString(
    source,
    'retrievedAt',
    fail,
    'source.retrievedAt',
  );
  if (retrievedAt && !isCalendarDate(retrievedAt)) {
    fail('source.retrievedAt must be a valid YYYY-MM-DD date');
  }

  if (
    !Array.isArray(source.authors) ||
    source.authors.length === 0 ||
    source.authors.some((author) => !isNonEmptyString(author))
  ) {
    fail('source.authors must be a non-empty array of strings');
  }

  const license = requireString(source, 'license', fail, 'source.license');
  if (
    license &&
    (!ALLOWED_LICENSE.test(license) || FORBIDDEN_LICENSE.test(license))
  ) {
    fail(
      `source.license "${license}" is not redistributable; expected PD, CC0, CC BY or CC BY-SA`,
    );
  }

  if (source.publishedAt !== undefined) {
    if (
      typeof source.publishedAt !== 'string' ||
      !isCalendarDate(source.publishedAt)
    ) {
      fail('source.publishedAt must be a valid YYYY-MM-DD date');
    }
  }

  if (
    source.attributionPosition !== undefined &&
    source.attributionPosition !== 'top' &&
    source.attributionPosition !== 'bottom'
  ) {
    fail('source.attributionPosition must be "top" or "bottom"');
  }
}

function validateAdaptation(article, fail) {
  const adaptation = article.adaptation;
  if (!isRecord(adaptation)) {
    fail('adaptation must be an object');
    return;
  }

  requireString(adaptation, 'model', fail, 'adaptation.model');
  const date = requireString(adaptation, 'date', fail, 'adaptation.date');
  if (date && !isCalendarDate(date)) {
    fail('adaptation.date must be a valid YYYY-MM-DD date');
  }
  requireString(adaptation, 'changes', fail, 'adaptation.changes');
  requireString(adaptation, 'reviewer', fail, 'adaptation.reviewer');
}

function validateLicense(article, fail) {
  const license = article.license;
  if (!isRecord(license)) {
    fail('license must be an object');
    return;
  }
  if (license.name !== 'CC BY-SA 4.0') {
    fail('license.name must be "CC BY-SA 4.0"');
  }
  requireHttpUrl(license, 'url', fail, 'license.url');
}

function validateTranslationMap(value, expected, fail, label) {
  if (!isRecord(value)) {
    fail(`${label} must be an object`);
    return;
  }

  const actualKeys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  if (
    actualKeys.length !== expectedKeys.length ||
    actualKeys.some((key, index) => key !== expectedKeys[index])
  ) {
    fail(`${label} keys must match the article`);
    return;
  }

  for (const key of actualKeys) {
    if (!isNonEmptyString(value[key])) {
      fail(`${label}["${key}"] must be a non-empty string`);
    }
  }
}

function validateTranslation(
  article,
  fail,
  sentencesByParagraph,
  terms,
  questionIds,
) {
  const translation = isRecord(article.translations)
    ? article.translations.zh
    : undefined;
  if (!isRecord(translation)) {
    fail('translations.zh must be an object');
    return;
  }

  requireString(translation, 'title', fail, 'translations.zh.title');
  requireString(translation, 'summary', fail, 'translations.zh.summary');

  if (
    !Array.isArray(translation.paragraphs) ||
    translation.paragraphs.length !== sentencesByParagraph.length
  ) {
    fail(
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
          `translations.zh.paragraphs[${paragraphIndex}] must align with ${expected} source sentences`,
        );
      }
    });
  }

  validateTranslationMap(
    translation.glossary,
    terms,
    fail,
    'translations.zh.glossary',
  );
  validateTranslationMap(
    translation.questions,
    questionIds,
    fail,
    'translations.zh.questions',
  );
}

/**
 * Validate a single article object against the publication contract.
 * Returns a list of human-readable errors; an empty list means valid.
 */
export function validateArticle(article, file = 'article') {
  const errors = [];
  const fail = (message) => errors.push(`${file}: ${message}`);

  if (!isRecord(article)) {
    fail('article must be an object');
    return errors;
  }

  requireString(article, 'id', fail, 'id');
  requireString(article, 'title', fail, 'title');
  requireString(article, 'theme', fail, 'theme');
  requireString(article, 'summary', fail, 'summary');
  const date = requireString(article, 'date', fail, 'date');
  if (date && !isCalendarDate(date)) {
    fail('date must be a valid YYYY-MM-DD date');
  }
  if (!LEVELS.has(article.level)) {
    fail(`level must be one of ${[...LEVELS].join(', ')}`);
  }

  const paragraphs = Array.isArray(article.paragraphs) ? article.paragraphs : [];
  const sentences = new Set();
  if (paragraphs.length === 0) {
    fail('paragraphs must be a non-empty array');
  }
  paragraphs.forEach((paragraph, paragraphIndex) => {
    if (
      !isRecord(paragraph) ||
      !Array.isArray(paragraph.sentences) ||
      paragraph.sentences.length === 0
    ) {
      fail(
        `paragraphs[${paragraphIndex}].sentences must be a non-empty array`,
      );
      return;
    }
    paragraph.sentences.forEach((sentence, sentenceIndex) => {
      if (!isNonEmptyString(sentence)) {
        fail(
          `paragraphs[${paragraphIndex}].sentences[${sentenceIndex}] must be a non-empty string`,
        );
      } else {
        sentences.add(sentence);
      }
    });
  });

  const terms = new Set();
  if (!Array.isArray(article.glossary)) {
    fail('glossary must be an array');
  } else {
    article.glossary.forEach((entry, entryIndex) => {
      const term = isRecord(entry) ? entry.term : undefined;
      if (!isNonEmptyString(term)) {
        fail(`glossary[${entryIndex}].term must be a non-empty string`);
      } else if (terms.has(term)) {
        fail(`glossary[${entryIndex}] duplicates "${term}"`);
      } else {
        terms.add(term);
      }
    });
  }

  const questionIds = new Set();
  if (!Array.isArray(article.questions) || article.questions.length === 0) {
    fail('questions must be a non-empty array');
  } else {
    article.questions.forEach((question, questionIndex) => {
      if (!isRecord(question)) {
        fail(`questions[${questionIndex}] must be an object`);
        return;
      }
      const id = requireString(
        question,
        'id',
        fail,
        `questions[${questionIndex}].id`,
      );
      if (id) {
        if (questionIds.has(id)) {
          fail(`questions[${questionIndex}] duplicates id "${id}"`);
        }
        questionIds.add(id);
      }
      requireString(
        question,
        'prompt',
        fail,
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
          `questions[${questionIndex}].options must be 4 unique non-empty strings`,
        );
      }
      if (
        !Number.isInteger(question.answerIndex) ||
        question.answerIndex < 0 ||
        question.answerIndex >= (Array.isArray(options) ? options.length : 0)
      ) {
        fail(
          `questions[${questionIndex}].answerIndex must be within the options range`,
        );
      }

      const evidence = requireString(
        question,
        'evidence',
        fail,
        `questions[${questionIndex}].evidence`,
      );
      if (evidence && !sentences.has(evidence)) {
        fail(
          `questions[${questionIndex}].evidence must be an exact sentence from the article`,
        );
      }
    });
  }

  validateTranslation(
    article,
    fail,
    paragraphs.map((paragraph) =>
      Array.isArray(paragraph?.sentences) ? paragraph.sentences.length : 0,
    ),
    terms,
    questionIds,
  );
  validateSource(article, fail);
  validateAdaptation(article, fail);
  validateLicense(article, fail);

  return errors;
}

async function readJson(file, fail) {
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

/**
 * Validate a content repository (manifest -> day indexes -> articles).
 * Returns the collected errors and the number of article/day files seen.
 */
export async function validateRepository(root = process.cwd()) {
  const absoluteRoot = path.resolve(root);
  const errors = [];
  const rel = (file) =>
    path.relative(absoluteRoot, file).split(path.sep).join('/') || '.';
  const fail = (file, message) => errors.push(`${rel(file)}: ${message}`);

  const manifestFile = path.join(absoluteRoot, 'manifest.json');
  const manifest = await readJson(manifestFile, fail);
  const days =
    isRecord(manifest) && Array.isArray(manifest.days) ? manifest.days : [];

  if (
    !isRecord(manifest) ||
    !Array.isArray(manifest.days) ||
    manifest.days.some((day) => !isCalendarDate(day))
  ) {
    fail(manifestFile, 'days must be an array of valid YYYY-MM-DD dates');
  } else if (manifest.months !== undefined) {
    fail(manifestFile, 'manifest must use days instead of months');
  } else if (new Set(days).size !== days.length) {
    fail(manifestFile, 'days must be unique');
  }

  const referencedArticles = new Set();
  const referencedIds = new Map();
  const seenDays = new Set();
  const articlesRoot = path.join(absoluteRoot, 'articles');

  for (const day of days) {
    if (!isCalendarDate(day) || seenDays.has(day)) {
      continue;
    }
    seenDays.add(day);

    const dayFile = path.join(absoluteRoot, 'days', `${day}.json`);
    const index = await readJson(dayFile, fail);
    if (!isRecord(index)) {
      if (index !== undefined) {
        fail(dayFile, 'day index must be an object');
      }
      continue;
    }
    if (index.date !== day) {
      fail(dayFile, `date must be "${day}"`);
    }
    if (!Array.isArray(index.articles)) {
      fail(dayFile, 'articles must be an array');
      continue;
    }

    const dayIds = new Set();
    for (const [entryIndex, entry] of index.articles.entries()) {
      if (!isRecord(entry)) {
        fail(dayFile, `articles[${entryIndex}] must be an object`);
        continue;
      }

      const id = requireString(
        entry,
        'id',
        (message) => fail(dayFile, message),
        `articles[${entryIndex}].id`,
      );
      requireString(
        entry,
        'title',
        (message) => fail(dayFile, message),
        `articles[${entryIndex}].title`,
      );
      requireString(
        entry,
        'theme',
        (message) => fail(dayFile, message),
        `articles[${entryIndex}].theme`,
      );
      requireString(
        entry,
        'summary',
        (message) => fail(dayFile, message),
        `articles[${entryIndex}].summary`,
      );
      const entryDate = requireString(
        entry,
        'date',
        (message) => fail(dayFile, message),
        `articles[${entryIndex}].date`,
      );
      if (entryDate && !isCalendarDate(entryDate)) {
        fail(
          dayFile,
          `articles[${entryIndex}].date must be a valid YYYY-MM-DD date`,
        );
      } else if (entryDate && entryDate !== day) {
        fail(
          dayFile,
          `articles[${entryIndex}].date must match the day index ("${day}")`,
        );
      }
      if (!LEVELS.has(entry.level)) {
        fail(dayFile, `articles[${entryIndex}].level must be A2, B1 or B2`);
      }

      const articlePath = requireString(
        entry,
        'path',
        (message) => fail(dayFile, message),
        `articles[${entryIndex}].path`,
      );
      if (id && articlePath !== `articles/${id}.json`) {
        fail(
          dayFile,
          `articles[${entryIndex}].path must be "articles/${id}.json"`,
        );
      }
      if (!id || articlePath !== `articles/${id}.json`) {
        continue;
      }

      if (dayIds.has(id)) {
        fail(dayFile, `articles[${entryIndex}] duplicates id "${id}"`);
      }
      dayIds.add(id);
      if (referencedIds.has(id) && referencedIds.get(id) !== day) {
        fail(
          dayFile,
          `articles[${entryIndex}].id "${id}" is referenced by more than one day index`,
        );
      }
      referencedIds.set(id, day);

      const articleFile = path.normalize(path.join(absoluteRoot, articlePath));
      if (!articleFile.startsWith(`${articlesRoot}${path.sep}`)) {
        fail(dayFile, `articles[${entryIndex}].path must stay inside articles/`);
        continue;
      }
      referencedArticles.add(articleFile);
      const article = await readJson(articleFile, fail);
      if (!isRecord(article)) {
        continue;
      }
      if (article.id !== id) {
        fail(articleFile, `id must match the day index ("${id}")`);
      }
      if (article.date !== entry.date) {
        fail(articleFile, `date must match the day index ("${day}")`);
      }
      for (const field of ['title', 'level', 'theme', 'summary']) {
        if (article[field] !== entry[field]) {
          fail(articleFile, `${field} must match the day index`);
        }
      }
      errors.push(...validateArticle(article, rel(articleFile)));
    }
  }

  const articleFiles = await listJsonFiles(articlesRoot);
  for (const articleFile of articleFiles) {
    if (!referencedArticles.has(articleFile)) {
      fail(articleFile, 'article is not referenced by any day index');
    }
  }

  const dayFiles = await listJsonFiles(path.join(absoluteRoot, 'days'));
  const listedDays = new Set(
    days
      .filter((day) => isCalendarDate(day))
      .map((day) =>
        path.normalize(path.join(absoluteRoot, 'days', `${day}.json`)),
      ),
  );
  for (const dayFile of dayFiles) {
    if (!listedDays.has(dayFile)) {
      fail(dayFile, 'day index is not listed in manifest.json');
    }
  }

  const legacyMonthFiles = await listJsonFiles(
    path.join(absoluteRoot, 'months'),
  );
  for (const monthFile of legacyMonthFiles) {
    fail(monthFile, 'month index is no longer supported; use days/');
  }

  return {
    errors,
    articleCount: articleFiles.length,
    dayCount: dayFiles.length,
  };
}
