import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

const LEVELS = new Set(['A2', 'B1', 'B2']);
const ALLOWED_LICENSE =
  /(^|[^a-z])(pd|public domain|cc0|cc by(-sa)?)([^a-z]|$)/i;
const FORBIDDEN_LICENSE =
  /(^|[^a-z])(nc|nd|nc-nd|all rights reserved|proprietary|unknown)([^a-z]|$)/i;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
  if (retrievedAt && !DATE_RE.test(retrievedAt)) {
    fail('source.retrievedAt must be YYYY-MM-DD');
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
      !DATE_RE.test(source.publishedAt)
    ) {
      fail('source.publishedAt must be YYYY-MM-DD');
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
  if (date && !DATE_RE.test(date)) {
    fail('adaptation.date must be YYYY-MM-DD');
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
  if (date && !DATE_RE.test(date)) {
    fail('date must be YYYY-MM-DD');
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
 * Validate a content repository (manifest -> month indexes -> articles).
 * Returns the collected errors and the number of article/month files seen.
 */
export async function validateRepository(root = process.cwd()) {
  const absoluteRoot = path.resolve(root);
  const errors = [];
  const rel = (file) =>
    path.relative(absoluteRoot, file).split(path.sep).join('/') || '.';
  const fail = (file, message) => errors.push(`${rel(file)}: ${message}`);

  const manifestFile = path.join(absoluteRoot, 'manifest.json');
  const manifest = await readJson(manifestFile, fail);
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
    const monthFile = path.join(absoluteRoot, 'months', `${month}.json`);
    const index = await readJson(monthFile, fail);
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
        (message) => fail(monthFile, message),
        `articles[${entryIndex}].id`,
      );
      requireString(
        entry,
        'title',
        (message) => fail(monthFile, message),
        `articles[${entryIndex}].title`,
      );
      requireString(
        entry,
        'theme',
        (message) => fail(monthFile, message),
        `articles[${entryIndex}].theme`,
      );
      requireString(
        entry,
        'summary',
        (message) => fail(monthFile, message),
        `articles[${entryIndex}].summary`,
      );
      const entryDate = requireString(
        entry,
        'date',
        (message) => fail(monthFile, message),
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
        (message) => fail(monthFile, message),
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

      const articleFile = path.normalize(path.join(absoluteRoot, articlePath));
      referencedArticles.add(articleFile);
      const article = await readJson(articleFile, fail);
      if (!isRecord(article)) {
        continue;
      }
      if (id && article.id !== id) {
        fail(articleFile, `id must match the month index ("${id}")`);
      }
      errors.push(...validateArticle(article, rel(articleFile)));
    }
  }

  const articleFiles = await listJsonFiles(
    path.join(absoluteRoot, 'articles'),
  );
  for (const articleFile of articleFiles) {
    if (!referencedArticles.has(articleFile)) {
      fail(articleFile, 'article is not referenced by any month index');
    }
  }

  const monthFiles = await listJsonFiles(path.join(absoluteRoot, 'months'));
  const listedMonths = new Set(
    months
      .filter((month) => isNonEmptyString(month) && MONTH_RE.test(month))
      .map((month) =>
        path.normalize(path.join(absoluteRoot, 'months', `${month}.json`)),
      ),
  );
  for (const monthFile of monthFiles) {
    if (!listedMonths.has(monthFile)) {
      fail(monthFile, 'month index is not listed in manifest.json');
    }
  }

  return {
    errors,
    articleCount: articleFiles.length,
    monthCount: monthFiles.length,
  };
}
