import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { validateArticleImage, validateImageAsset } from './image.mjs';

export { validateArticleImage, validateImageAsset } from './image.mjs';

const LEVELS = new Set(['A2', 'B1', 'B2']);
const ARTICLE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const ALLOWED_LICENSE =
  /(^|[^a-z])(pd|public domain|cc0|cc by(-sa)?)([^a-z]|$)/i;
const FORBIDDEN_LICENSE =
  /(^|[^a-z])(nc|nd|nc-nd|all rights reserved|proprietary|unknown)([^a-z]|$)/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_SUMMARY_WORDS = 60;
const MAX_ZH_SUMMARY_CHARACTERS = 200;
const FRENCH_WORD_RE =
  /[A-Za-zÀ-ÖØ-öø-ÿ0-9]+(?:['’\-][A-Za-zÀ-ÖØ-öø-ÿ0-9]+)*/g;

const normalizeWhitespace = (value) => value.replace(/\s+/g, ' ').trim();

function countFrenchWords(value) {
  return value.match(FRENCH_WORD_RE)?.length ?? 0;
}

function articleBodyText(paragraphs) {
  return paragraphs
    .map((paragraph) =>
      isRecord(paragraph) && Array.isArray(paragraph.sentences)
        ? paragraph.sentences.filter(isNonEmptyString).join(' ')
        : '',
    )
    .filter(Boolean)
    .join(' ');
}

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

function requireArticleId(record, fail, label = 'id') {
  const id = requireString(record, 'id', fail, label);
  if (id && !ARTICLE_ID_RE.test(id)) {
    fail(`${label} must be a safe URL path segment`);
    return undefined;
  }
  return id;
}

function requireHttpUrl(record, key, fail, label = key) {
  const value = requireString(record, key, fail, label);
  if (value && !/^https?:\/\//i.test(value)) {
    fail(`${label} must be an http(s) URL`);
  }
  return value;
}

function wikiPageKey(url, title) {
  if (url.pathname.startsWith('/wiki/')) return url.pathname;
  if (url.pathname !== '/w/index.php') return null;
  const pageTitle = url.searchParams.get('title') ?? title;
  return isNonEmptyString(pageTitle)
    ? `/wiki/${encodeURIComponent(pageTitle.replaceAll(' ', '_'))}`
    : null;
}

export function sameArticleSource(left, right) {
  if (!isRecord(left) || !isRecord(right)) return false;
  if (isNonEmptyString(left.url) && left.url === right.url) return true;
  if (!URL.canParse(left.url) || !URL.canParse(right.url)) return false;

  const leftUrl = new URL(left.url);
  const rightUrl = new URL(right.url);
  if (leftUrl.hostname !== rightUrl.hostname) return false;
  if (left.revisionId && left.revisionId === right.revisionId) return true;

  if (leftUrl.hostname === 'fr.globalvoices.org') {
    return leftUrl.pathname.replace(/\/$/, '') === rightUrl.pathname.replace(/\/$/, '');
  }
  if (['fr.wikipedia.org', 'fr.vikidia.org'].includes(leftUrl.hostname)) {
    const leftPage = wikiPageKey(leftUrl, left.title);
    return Boolean(leftPage && leftPage === wikiPageKey(rightUrl, right.title));
  }
  return false;
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

  if (
    source.translators !== undefined &&
    (!Array.isArray(source.translators) ||
      source.translators.length === 0 ||
      source.translators.some((translator) => !isNonEmptyString(translator)))
  ) {
    fail('source.translators must be a non-empty array of strings');
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

function validateQuestionTexts(value, expected, fail, label) {
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
    const entry = value[key];
    if (!isRecord(entry)) {
      fail(`${label}["${key}"] must be an object`);
      continue;
    }
    if (!isNonEmptyString(entry.prompt)) {
      fail(`${label}["${key}"].prompt must be a non-empty string`);
    }
    const options = entry.options;
    if (
      !Array.isArray(options) ||
      options.length !== 4 ||
      options.some((option) => !isNonEmptyString(option)) ||
      new Set(options).size !== 4
    ) {
      fail(`${label}["${key}"].options must be 4 unique non-empty strings`);
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
  const summary = requireString(
    translation,
    'summary',
    fail,
    'translations.zh.summary',
  );
  if (summary) {
    const characterCount = [...summary].length;
    if (characterCount > MAX_ZH_SUMMARY_CHARACTERS) {
      fail(
        `translations.zh.summary must be at most ${MAX_ZH_SUMMARY_CHARACTERS} characters (got ${characterCount})`,
      );
    }
  }

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

  if (translation.questionTexts !== undefined) {
    validateQuestionTexts(
      translation.questionTexts,
      questionIds,
      fail,
      'translations.zh.questionTexts',
    );
  }
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

  requireArticleId(article, fail);
  requireString(article, 'title', fail, 'title');
  requireString(article, 'theme', fail, 'theme');
  const paragraphs = Array.isArray(article.paragraphs) ? article.paragraphs : [];
  const summary = requireString(article, 'summary', fail, 'summary');
  if (summary) {
    const wordCount = countFrenchWords(summary);
    if (wordCount > MAX_SUMMARY_WORDS) {
      fail(
        `summary must be at most ${MAX_SUMMARY_WORDS} words (got ${wordCount})`,
      );
    }
    const body = normalizeWhitespace(articleBodyText(paragraphs));
    if (body && normalizeWhitespace(summary) === body) {
      fail(
        'summary must not copy the full article; write a concise main-idea summary',
      );
    }
  }
  const date = requireString(article, 'date', fail, 'date');
  if (date && !isCalendarDate(date)) {
    fail('date must be a valid YYYY-MM-DD date');
  }
  if (!LEVELS.has(article.level)) {
    fail(`level must be one of ${[...LEVELS].join(', ')}`);
  }

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

      if (
        question.explanation !== undefined &&
        !isNonEmptyString(question.explanation)
      ) {
        fail(
          `questions[${questionIndex}].explanation must be a non-empty string`,
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
  if (article.image !== undefined) {
    validateArticleImage(article.image).forEach(fail);
  }
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

function* dayEntries(articles, fail) {
  for (const [index, primary] of articles.entries()) {
    const label = `articles[${index}]`;
    yield [label, primary];
    if (!isRecord(primary) || primary.variants === undefined) {
      continue;
    }
    if (!Array.isArray(primary.variants)) {
      fail(`${label}.variants must be an array`);
      continue;
    }

    const levels = new Set([primary.level]);
    for (const [variantIndex, variant] of primary.variants.entries()) {
      const variantLabel = `${label}.variants[${variantIndex}]`;
      if (isRecord(variant)) {
        if (variant.variants !== undefined) {
          fail(`${variantLabel}.variants is not allowed`);
        }
        if (LEVELS.has(variant.level) && levels.has(variant.level)) {
          fail(`${variantLabel} duplicates level "${variant.level}" in ${label}`);
        }
        levels.add(variant.level);
      }
      yield [variantLabel, variant, true];
    }
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

    const failEntry = (message) => fail(dayFile, message);
    let primaryArticle;
    for (const [label, entry, isVariant] of dayEntries(index.articles, failEntry)) {
      if (!isVariant) primaryArticle = undefined;
      if (!isRecord(entry)) {
        failEntry(`${label} must be an object`);
        continue;
      }

      const id = requireArticleId(entry, failEntry, `${label}.id`);
      for (const field of ['title', 'theme', 'summary']) {
        requireString(entry, field, failEntry, `${label}.${field}`);
      }
      const entryDate = requireString(entry, 'date', failEntry, `${label}.date`);
      if (entryDate && !isCalendarDate(entryDate)) {
        failEntry(`${label}.date must be a valid YYYY-MM-DD date`);
      } else if (entryDate && entryDate !== day) {
        failEntry(`${label}.date must match the day index ("${day}")`);
      }
      if (!LEVELS.has(entry.level)) {
        failEntry(`${label}.level must be A2, B1 or B2`);
      }

      const articlePath = requireString(entry, 'path', failEntry, `${label}.path`);
      if (id && articlePath !== `articles/${id}.json`) {
        failEntry(`${label}.path must be "articles/${id}.json"`);
      }
      if (!id || articlePath !== `articles/${id}.json`) {
        continue;
      }

      if (referencedIds.get(id) === day) {
        failEntry(`${label} duplicates id "${id}"`);
      } else if (referencedIds.has(id)) {
        failEntry(`${label}.id "${id}" is referenced by more than one day index`);
      }
      referencedIds.set(id, day);

      const articleFile = path.normalize(path.join(absoluteRoot, articlePath));
      if (!articleFile.startsWith(`${articlesRoot}${path.sep}`)) {
        failEntry(`${label}.path must stay inside articles/`);
        continue;
      }
      referencedArticles.add(articleFile);
      const article = await readJson(articleFile, fail);
      if (!isRecord(article)) {
        if (article !== undefined) {
          fail(articleFile, 'article must be an object');
        }
        continue;
      }
      if (!isVariant) {
        primaryArticle = article;
      } else if (primaryArticle && !sameArticleSource(primaryArticle.source, article.source)) {
        failEntry(`${label} must share the primary article's source`);
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
      if (
        isRecord(article.image) &&
        validateArticleImage(article.image).length === 0
      ) {
        for (const message of await validateImageAsset(
          absoluteRoot,
          article.image,
        )) {
          fail(articleFile, message);
        }
      }
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
