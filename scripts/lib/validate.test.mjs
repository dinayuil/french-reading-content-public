import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
// Generic temporary repositories use a text-only fixture; image scenarios
// attach their own metadata and bytes explicitly.
delete article.image;

const clone = () => structuredClone(article);
const messages = (errors) => errors.join('\n');

test('valid article passes', () => {
  assert.deepEqual(validateArticle(clone(), 'article'), []);
});

const frenchSummary = (words) =>
  Array.from({ length: words }, () => 'mot').join(' ');

test('accepts a 60-word French summary and rejects 61 words', () => {
  const accepted = clone();
  accepted.summary = frenchSummary(60);
  assert.deepEqual(validateArticle(accepted, 'article'), []);

  const rejected = clone();
  rejected.summary = frenchSummary(61);
  assert.match(
    messages(validateArticle(rejected)),
    /summary must be at most 60 words/,
  );
});

test('accepts a 200-code-point Chinese summary and rejects 201', () => {
  const accepted = clone();
  accepted.translations.zh.summary = '中'.repeat(200);
  assert.deepEqual(validateArticle(accepted, 'article'), []);

  const rejected = clone();
  rejected.translations.zh.summary = '中'.repeat(201);
  assert.match(
    messages(validateArticle(rejected)),
    /translations\.zh\.summary must be at most 200 characters/,
  );

  const emoji = clone();
  emoji.translations.zh.summary = '😀'.repeat(200);
  assert.deepEqual(validateArticle(emoji, 'article'), []);
});

test('rejects a summary copied from the article body after whitespace normalization', () => {
  const value = clone();
  value.paragraphs = [
    { sentences: ['Bonjour le monde.', 'Ceci est un test.'] },
  ];
  value.summary = '  Bonjour   le monde.\n\nCeci est un test.  ';
  value.translations.zh.paragraphs = [
    { sentences: ['你好世界。', '这是一个测试。'] },
  ];
  value.questions.forEach((question) => {
    question.evidence = 'Bonjour le monde.';
  });

  const errors = validateArticle(value);
  assert.equal(errors.length, 1, messages(errors));
  assert.match(messages(errors), /summary must not copy the full article/);
  assert.doesNotMatch(messages(errors), /summary must be at most/);
});

test('does not throw on malformed paragraph and summary shapes', () => {
  const cases = [
    [
      'missing paragraphs',
      (value) => {
        delete value.paragraphs;
      },
    ],
    [
      'null paragraph',
      (value) => {
        value.paragraphs = [null];
      },
    ],
    [
      'string sentences',
      (value) => {
        value.paragraphs = [{ sentences: 'Bonjour le monde.' }];
      },
    ],
    [
      'non-string sentence',
      (value) => {
        value.paragraphs = [{ sentences: [null, 42] }];
      },
    ],
    [
      'non-string summary',
      (value) => {
        value.summary = 42;
      },
    ],
    [
      'non-string Chinese summary',
      (value) => {
        value.translations.zh.summary = null;
      },
    ],
    [
      'malformed Chinese paragraphs',
      (value) => {
        value.paragraphs = [{ sentences: ['Bonjour le monde.'] }];
        value.translations.zh.paragraphs = [null];
      },
    ],
  ];

  for (const [label, mutate] of cases) {
    const value = clone();
    mutate(value);
    assert.doesNotThrow(() => validateArticle(value), label);
  }
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

function withQuestionLanguages(value = clone()) {
  value.questions.forEach((question, index) => {
    question.explanation = `Explication en français numéro ${index + 1}.`;
  });
  value.translations.zh.questionTexts = Object.fromEntries(
    value.questions.map((question, index) => [
      question.id,
      {
        prompt: `问题题干 ${index + 1}`,
        options: question.options.map(
          (_option, optionIndex) => `选项 ${index + 1}-${optionIndex + 1}`,
        ),
      },
    ]),
  );
  return value;
}

const PNG_2X3 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAADCAYAAAC56t6BAAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAAAMSURBVBhXY8AFGBgAABsAAQcaKa0AAAAASUVORK5CYII=',
  'base64',
);
const JPEG_2X3 = Buffer.from(
  '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/2wBDAQkJCQwLDBgNDRgyIRwhMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjIyMjL/wAARCAADAAIDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwD5/ooooA//2Q==',
  'base64',
);

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

function imageAsset(bytes, extension, overrides = {}) {
  const hash = sha256(bytes);
  return {
    path: `images/2026-11-12-test-image-${hash.slice(0, 12)}.${extension}`,
    alt: 'Une illustration de test',
    author: 'Auteur Exemple',
    sourceUrl:
      'https://commons.wikimedia.org/wiki/File:Example.jpg?oldid=12345',
    license: 'CC BY-SA 4.0',
    licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
    changes: 'Redimensionnée à 2 × 3 pixels.',
    width: 2,
    height: 3,
    byteLength: bytes.length,
    sha256: hash,
    fileRevisionId: '12345',
    retrievedAt: '2026-11-12',
    ...overrides,
  };
}

function withImage(image, value = clone()) {
  value.image = image;
  return value;
}

test('accepts optional French explanations and Chinese question translations', () => {
  assert.deepEqual(validateArticle(withQuestionLanguages(), 'article'), []);
});

test('accepts legacy articles without the new language fields', () => {
  assert.deepEqual(validateArticle(clone(), 'article'), []);
});

test('accepts each optional language field on its own', () => {
  const explanationsOnly = clone();
  explanationsOnly.questions.forEach((question, index) => {
    question.explanation = `Explication ${index + 1}.`;
  });
  assert.deepEqual(validateArticle(explanationsOnly, 'article'), []);

  const translationsOnly = withQuestionLanguages();
  translationsOnly.questions.forEach((question) => {
    delete question.explanation;
  });
  assert.deepEqual(validateArticle(translationsOnly, 'article'), []);
});

test('rejects a present but empty French explanation', () => {
  const value = withQuestionLanguages();
  value.questions[0].explanation = '';
  value.questions[1].explanation = '   ';
  value.questions[2].explanation = null;
  const output = messages(validateArticle(value));
  assert.match(
    output,
    /questions\[0\]\.explanation must be a non-empty string/,
  );
  assert.match(
    output,
    /questions\[1\]\.explanation must be a non-empty string/,
  );
  assert.match(
    output,
    /questions\[2\]\.explanation must be a non-empty string/,
  );
});

test('rejects questionTexts that is not an object', () => {
  for (const wrong of [null, [], '中文题干', 42]) {
    const value = withQuestionLanguages();
    value.translations.zh.questionTexts = wrong;
    assert.match(
      messages(validateArticle(value)),
      /translations\.zh\.questionTexts must be an object/,
      `wrong value: ${JSON.stringify(wrong)}`,
    );
  }
});

test('rejects questionTexts keys that do not match the questions', () => {
  const missing = withQuestionLanguages();
  delete missing.translations.zh.questionTexts.q6;
  assert.match(
    messages(validateArticle(missing)),
    /translations\.zh\.questionTexts keys must match the article/,
  );

  const extra = withQuestionLanguages();
  extra.translations.zh.questionTexts.q99 = {
    prompt: '多余的问题',
    options: ['甲', '乙', '丙', '丁'],
  };
  assert.match(
    messages(validateArticle(extra)),
    /translations\.zh\.questionTexts keys must match the article/,
  );
});

test('rejects a questionTexts entry that is not an object', () => {
  const value = withQuestionLanguages();
  value.translations.zh.questionTexts.q1 = null;
  assert.match(
    messages(validateArticle(value)),
    /translations\.zh\.questionTexts\["q1"\] must be an object/,
  );
});

test('rejects malformed Chinese question prompts and options', () => {
  const cases = [
    [
      'missing prompt',
      (entry) => {
        delete entry.prompt;
      },
      /\.prompt must be a non-empty string/,
    ],
    [
      'empty prompt',
      (entry) => {
        entry.prompt = '  ';
      },
      /\.prompt must be a non-empty string/,
    ],
    [
      'non-string prompt',
      (entry) => {
        entry.prompt = 1;
      },
      /\.prompt must be a non-empty string/,
    ],
    [
      'options not an array',
      (entry) => {
        entry.options = '四个选项';
      },
      /\.options must be 4 unique non-empty strings/,
    ],
    [
      'too few options',
      (entry) => {
        entry.options.pop();
      },
      /\.options must be 4 unique non-empty strings/,
    ],
    [
      'too many options',
      (entry) => {
        entry.options.push('第五个选项');
      },
      /\.options must be 4 unique non-empty strings/,
    ],
    [
      'duplicate options',
      (entry) => {
        entry.options[1] = entry.options[0];
      },
      /\.options must be 4 unique non-empty strings/,
    ],
    [
      'empty option',
      (entry) => {
        entry.options[3] = ' ';
      },
      /\.options must be 4 unique non-empty strings/,
    ],
    [
      'non-string option',
      (entry) => {
        entry.options[2] = 3;
      },
      /\.options must be 4 unique non-empty strings/,
    ],
  ];

  for (const [label, mutate, pattern] of cases) {
    const value = withQuestionLanguages();
    mutate(value.translations.zh.questionTexts.q1);
    assert.match(messages(validateArticle(value)), pattern, label);
  }
});

test('keeps the legacy Chinese explanation map as strings', () => {
  const value = withQuestionLanguages();
  value.translations.zh.questions.q1 = { text: '不是字符串' };
  assert.match(
    messages(validateArticle(value)),
    /translations\.zh\.questions\["q1"\] must be a non-empty string/,
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

test('accepts optional French translator names', () => {
  const value = clone();
  value.source.translators = ['Guillaume Cottin'];
  assert.deepEqual(validateArticle(value, 'article'), []);
});

test('rejects malformed optional translator lists without throwing', () => {
  const cases = [
    ['null', null],
    ['empty array', []],
    ['string', 'Guillaume Cottin'],
    ['object', { name: 'Guillaume Cottin' }],
    ['blank string', ['   ']],
    ['null item', [null]],
    ['number item', [42]],
    ['nested array item', [['Guillaume Cottin']]],
    ['object item', [{ name: 'Guillaume Cottin' }]],
  ];

  for (const [label, translators] of cases) {
    const value = clone();
    value.source.translators = translators;
    assert.match(
      messages(validateArticle(value)),
      /source\.translators must be a non-empty array of strings/,
      label,
    );
  }
});

test('accepts optional valid image metadata', () => {
  const cases = [
    ['PNG', PNG_2X3, 'png'],
    ['JPEG', JPEG_2X3, 'jpg'],
    [
      'CC0',
      PNG_2X3,
      'png',
      {
        license: 'CC0 1.0',
        licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
      },
    ],
    [
      'Public domain',
      PNG_2X3,
      'png',
      {
        license: 'Public domain',
        licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/',
      },
    ],
  ];

  for (const [label, bytes, extension, overrides] of cases) {
    const value = withImage(imageAsset(bytes, extension, overrides));
    assert.deepEqual(validateArticle(value, 'article'), [], label);
  }
});

test('rejects a present but null image', () => {
  const value = withImage(null);
  assert.match(messages(validateArticle(value)), /image must be an object/);
});

test('rejects incomplete image metadata', () => {
  const fields = [
    ['path', /image\.path/],
    ['alt', /image\.alt/],
    ['author', /image\.author/],
    ['sourceUrl', /image\.sourceUrl/],
    ['license', /image\.license/],
    ['licenseUrl', /image\.licenseUrl/],
    ['changes', /image\.changes/],
    ['width', /image\.width/],
    ['height', /image\.height/],
    ['byteLength', /image\.byteLength/],
    ['sha256', /image\.sha256/],
    ['fileRevisionId', /image\.fileRevisionId/],
    ['retrievedAt', /image\.retrievedAt/],
  ];

  for (const [field, pattern] of fields) {
    const image = imageAsset(PNG_2X3, 'png');
    delete image[field];
    assert.match(messages(validateArticle(withImage(image))), pattern, field);
  }
});

test('rejects unsafe or malformed image paths', () => {
  const valid = imageAsset(PNG_2X3, 'png');
  const suffix = valid.sha256.slice(0, 12);
  const cases = [
    ['parent traversal', `images/../${suffix}.png`],
    ['absolute path', `/images/2026-11-12-test-image-${suffix}.png`],
    ['Windows separator', `images\\2026-11-12-test-image-${suffix}.png`],
    ['query string', `images/2026-11-12-test-image-${suffix}.png?x=1`],
    ['fragment', `images/2026-11-12-test-image-${suffix}.png#x`],
    ['protocol', `https://images/2026-11-12-test-image-${suffix}.png`],
    ['wrong extension', `images/2026-11-12-test-image-${suffix}.jpeg`],
    ['uppercase name', `images/2026-11-12-TEST-IMAGE-${suffix}.png`],
    ['uppercase hash', `images/2026-11-12-test-image-${suffix.toUpperCase()}.png`],
  ];

  for (const [label, imagePath] of cases) {
    const image = { ...valid, path: imagePath };
    assert.match(
      messages(validateArticle(withImage(image))),
      /image\.path/,
      label,
    );
  }
});

test('rejects an image filename hash that does not match sha256', () => {
  const image = imageAsset(PNG_2X3, 'png');
  const other = image.sha256.startsWith('0123456789ab')
    ? 'abcdefabcdef'
    : '0123456789ab';
  image.path = image.path.replace(image.sha256.slice(0, 12), other);
  assert.match(
    messages(validateArticle(withImage(image))),
    /image\.path suffix must match/,
  );
});

test('rejects malformed Commons image source URLs', () => {
  const cases = [
    ['http', 'http://commons.wikimedia.org/wiki/File:Example.jpg'],
    ['other host', 'https://example.com/wiki/File:Example.jpg'],
    ['lookalike host', 'https://commons.wikimedia.org.example/wiki/File:Example.jpg'],
    ['not a file page', 'https://commons.wikimedia.org/wiki/Category:Example'],
    ['empty file title', 'https://commons.wikimedia.org/wiki/File:'],
    ['nonnumeric oldid', 'https://commons.wikimedia.org/wiki/File:Example.jpg?oldid=abc'],
    ['zero oldid', 'https://commons.wikimedia.org/wiki/File:Example.jpg?oldid=0'],
    ['extra query', 'https://commons.wikimedia.org/wiki/File:Example.jpg?oldid=12&x=1'],
    ['fragment', 'https://commons.wikimedia.org/wiki/File:Example.jpg#section'],
    ['non-default port', 'https://commons.wikimedia.org:8443/wiki/File:Example.jpg'],
  ];

  for (const [label, sourceUrl] of cases) {
    const image = { ...imageAsset(PNG_2X3, 'png'), sourceUrl };
    assert.match(
      messages(validateArticle(withImage(image))),
      /image\.sourceUrl/,
      label,
    );
  }
});

test('rejects unsupported or mismatched image licenses', () => {
  const cases = [
    [
      'noncommercial license',
      {
        license: 'CC BY-NC 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-nc/4.0/',
      },
      /image\.license/,
    ],
    [
      'wrong canonical URL',
      {
        license: 'CC BY-SA 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/4.0/',
      },
      /image\.licenseUrl.*canonical/,
    ],
    [
      'wrong version URL',
      {
        license: 'CC BY-SA 4.0',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/3.0/',
      },
      /image\.licenseUrl.*canonical/,
    ],
    [
      'http license URL',
      {
        license: 'CC BY 4.0',
        licenseUrl: 'http://creativecommons.org/licenses/by/4.0/',
      },
      /image\.licenseUrl.*canonical/,
    ],
    [
      'missing trailing slash',
      {
        license: 'CC BY 3.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/3.0',
      },
      /image\.licenseUrl.*canonical/,
    ],
    [
      'arbitrary PD label',
      {
        license: 'PD',
        licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/',
      },
      /image\.license/,
    ],
    [
      'lowercase public domain label',
      {
        license: 'public domain',
        licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/',
      },
      /image\.license/,
    ],
    [
      'unknown license',
      {
        license: 'Unknown',
        licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/',
      },
      /image\.license/,
    ],
    [
      'unsupported old CC version',
      {
        license: 'CC BY 1.0',
        licenseUrl: 'https://creativecommons.org/licenses/by/1.0/',
      },
      /image\.license/,
    ],
    [
      'Public domain with CC0 URL',
      {
        license: 'Public domain',
        licenseUrl: 'https://creativecommons.org/publicdomain/zero/1.0/',
      },
      /image\.licenseUrl.*canonical/,
    ],
    [
      'Public domain with mismatched URL',
      {
        license: 'Public domain',
        licenseUrl: 'https://creativecommons.org/licenses/by-sa/4.0/',
      },
      /image\.licenseUrl.*canonical/,
    ],
    [
      'Public domain with PDM query',
      {
        license: 'Public domain',
        licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/?x=1',
      },
      /image\.licenseUrl.*canonical/,
    ],
    [
      'Public domain with PDM deed',
      {
        license: 'Public domain',
        licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/deed.en',
      },
      /image\.licenseUrl.*canonical/,
    ],
    [
      'CC0 with PDM URL',
      {
        license: 'CC0 1.0',
        licenseUrl: 'https://creativecommons.org/publicdomain/mark/1.0/',
      },
      /image\.licenseUrl.*canonical/,
    ],
  ];

  for (const [label, overrides, pattern] of cases) {
    const image = imageAsset(PNG_2X3, 'png', overrides);
    assert.match(
      messages(validateArticle(withImage(image))),
      pattern,
      label,
    );
  }
});

test('rejects invalid image alt text and attribution text', () => {
  const altCases = [
    ['blank', '   '],
    ['null', null],
    ['number', 42],
    ['HTML', '<b>Une illustration</b>'],
  ];
  for (const [label, alt] of altCases) {
    const image = imageAsset(PNG_2X3, 'png', { alt });
    assert.match(
      messages(validateArticle(withImage(image))),
      /image\.alt/,
      label,
    );
  }

  const authorCases = [
    ['blank', '   '],
    ['null', null],
    ['HTML', '<b>Auteur</b>'],
    ['over 120 characters', 'a'.repeat(121)],
  ];
  for (const [label, author] of authorCases) {
    const image = imageAsset(PNG_2X3, 'png', { author });
    assert.match(
      messages(validateArticle(withImage(image))),
      /image\.author/,
      label,
    );
  }

  const changesCases = [
    ['blank', '   '],
    ['null', null],
    ['number', 1],
  ];
  for (const [label, changes] of changesCases) {
    const image = imageAsset(PNG_2X3, 'png', { changes });
    assert.match(
      messages(validateArticle(withImage(image))),
      /image\.changes/,
      label,
    );
  }
});

test('rejects invalid image dimensions and byte sizes', () => {
  const cases = [
    ['zero width', { width: 0 }, /image\.width/],
    ['negative height', { height: -1 }, /image\.height/],
    ['fractional width', { width: 1.5 }, /image\.width/],
    ['string height', { height: '3' }, /image\.height/],
    ['oversized width', { width: 1601 }, /image\.width/],
    ['oversized height', { height: 1601 }, /image\.height/],
    ['zero byteLength', { byteLength: 0 }, /image\.byteLength/],
    ['fractional byteLength', { byteLength: 1.5 }, /image\.byteLength/],
    ['string byteLength', { byteLength: '119' }, /image\.byteLength/],
    [
      'over 1 MiB',
      { byteLength: 1024 * 1024 + 1 },
      /image\.byteLength/,
    ],
  ];

  for (const [label, overrides, pattern] of cases) {
    const image = imageAsset(PNG_2X3, 'png', overrides);
    assert.match(
      messages(validateArticle(withImage(image))),
      pattern,
      label,
    );
  }
});

test('rejects an invalid image hash, date, or file revision', () => {
  const cases = [
    [
      'uppercase sha256',
      { sha256: sha256(PNG_2X3).toUpperCase() },
      /image\.sha256/,
    ],
    ['short sha256', { sha256: 'abc' }, /image\.sha256/],
    ['impossible date', { retrievedAt: '2026-02-30' }, /image\.retrievedAt/],
    ['slashed date', { retrievedAt: '12/11/2026' }, /image\.retrievedAt/],
    ['zero revision', { fileRevisionId: '0' }, /image\.fileRevisionId/],
    ['leading-zero revision', { fileRevisionId: '0123' }, /image\.fileRevisionId/],
    ['numeric revision', { fileRevisionId: 123 }, /image\.fileRevisionId/],
  ];

  for (const [label, overrides, pattern] of cases) {
    const image = imageAsset(PNG_2X3, 'png', overrides);
    assert.match(
      messages(validateArticle(withImage(image))),
      pattern,
      label,
    );
  }
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

async function writeImage(root, imagePath, bytes) {
  const file = path.join(root, imagePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, bytes);
}

async function linkDirectory(target, link) {
  await symlink(
    target,
    link,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
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

function variantFixture() {
  const primary = { ...articleOn('2026-11-11'), level: 'A2' };
  const variant = { ...primary, id: `${primary.id}-b1`, level: 'B1' };
  const legacy = { ...primary, id: `${primary.id}-legacy` };
  const repo = fixture(primary);
  const entries = repo.dayFiles[primary.date].articles;
  const variantEntry = entryFor(variant);
  entries[0].variants = [variantEntry];
  entries.push(entryFor(legacy));
  Object.assign(repo.articles, { [variant.id]: variant, [legacy.id]: legacy });
  return { repo, entries, variant, variantEntry };
}

test('accepts A2 and B1 variants alongside a legacy entry', async (t) => {
  const { repo } = variantFixture();
  const root = await createRepo(t, repo);
  assert.deepEqual(await validateRepository(root), {
    errors: [], articleCount: 3, dayCount: 1,
  });
});

test('rejects unsafe URL path segments as primary and variant IDs', async (t) => {
  for (const id of ['nested/path', 'nested\\path', 'article%2fother', 'article?query', 'article#hash', 'article\n', '.hidden']) {
    const { repo, entries, variantEntry } = variantFixture();
    for (const entry of [entries[0], variantEntry]) {
      entry.id = id;
      entry.path = `articles/${id}.json`;
    }
    const root = await createRepo(t, repo);
    const result = messages((await validateRepository(root)).errors);
    assert.match(result, /articles\[0\]\.id must be a safe URL path segment/);
    assert.match(result, /variants\[0\]\.id must be a safe URL path segment/);
  }
});

test('accepts ASCII URL-safe article IDs', () => {
  const value = { ...articleOn('2026-11-11'), id: 'Legacy_1.2~a-b' };
  assert.deepEqual(validateArticle(value), []);
});

test('checks source article identity for each variant', async (t) => {
  const cases = [
    ['exact URL', 'https://example.org/article', 'https://example.org/article', undefined, true],
    ['same-host revision', 'https://example.org/article', 'https://example.org/revision', '42', true],
    ['wiki page and revision', 'https://fr.wikipedia.org/wiki/Un_article', 'https://fr.wikipedia.org/w/index.php?title=Un+article&oldid=42', undefined, true],
    ['Vikidia title fallback', 'https://fr.vikidia.org/wiki/Un_article', 'https://fr.vikidia.org/w/index.php?oldid=42', undefined, true],
    ['Global Voices path', 'https://fr.globalvoices.org/2026/11/11/article/', 'https://fr.globalvoices.org/2026/11/11/article?ref=feed', undefined, true],
    ['unrelated URLs', 'https://example.org/article', 'https://example.org/other', undefined, false],
    ['cross-host revision', 'https://example.org/article', 'https://other.example/article', '42', false],
    ['different wiki pages', 'https://fr.wikipedia.org/wiki/Un_article', 'https://fr.wikipedia.org/wiki/Autre_article', undefined, false],
  ];

  for (const [label, primaryUrl, variantUrl, revisionId, accepted] of cases) {
    await t.test(label, async (subtest) => {
      const { repo, entries, variant } = variantFixture();
      const primary = repo.articles[entries[0].id];
      primary.source = { ...primary.source, url: primaryUrl, title: 'Un article', revisionId };
      variant.source = { ...variant.source, url: variantUrl, title: 'Un article', revisionId };
      const root = await createRepo(subtest, repo);
      const { errors } = await validateRepository(root);
      if (accepted) {
        assert.deepEqual(errors, []);
      } else {
        assert.match(messages(errors), /variants\[0\] must share the primary article's source/);
      }
    });
  }
});

test('validates the shape, metadata and references of variants', async (t) => {
  const cases = [
    ['non-array', ({ entries }) => { entries[0].variants = null; }, /variants must be an array/],
    ['non-object', ({ entries }) => { entries[0].variants.push(null); }, /variants\[1\] must be an object/],
    ['nested', ({ variantEntry }) => { variantEntry.variants = []; }, /variants\[0\]\.variants is not allowed/],
    ['missing file', ({ repo, variant }) => { delete repo.articles[variant.id]; }, /articles\/.*-b1\.json:.*ENOENT/],
    ['bad path', ({ variantEntry }) => { variantEntry.path = 'articles/other.json'; }, /variants\[0\]\.path must be/],
    ['metadata mismatch', ({ variantEntry }) => { variantEntry.title = 'Another title'; }, /title must match the day index/],
    ['invalid article', ({ variant }) => { delete variant.license; }, /articles\/.*-b1\.json:.*license/],
    ['other day', ({ variantEntry }) => { variantEntry.date = '2026-11-12'; }, /variants\[0\]\.date must match the day index/],
    ['same level', ({ variant, variantEntry }) => { variant.level = variantEntry.level = 'A2'; }, /duplicates level "A2"/],
    ['repeated variant', ({ entries, variantEntry }) => { entries[0].variants.push(variantEntry); }, /duplicates level "B1"/],
    ['repeated primary', ({ entries }) => { entries[0].variants.push(entries[1]); }, /duplicates id/],
    ['repeated across families', ({ entries, variantEntry }) => { entries[1].variants = [variantEntry]; }, /duplicates id/],
  ];

  for (const [label, change, expected] of cases) {
    await t.test(label, async (subtest) => {
      const setup = variantFixture();
      change(setup);
      const root = await createRepo(subtest, setup.repo);
      assert.match(messages((await validateRepository(root)).errors), expected);
    });
  }
});

test('repository accepts valid referenced PNG and JPEG assets', async (t) => {
  const cases = [
    ['PNG', PNG_2X3, 'png'],
    ['JPEG', JPEG_2X3, 'jpg'],
  ];

  for (const [label, bytes, extension] of cases) {
    const value = articleOn('2026-11-11');
    value.image = imageAsset(bytes, extension);
    const root = await createRepo(t, fixture(value));
    await writeImage(root, value.image.path, bytes);
    assert.deepEqual(
      (await validateRepository(root)).errors,
      [],
      label,
    );
  }
});

test('repository rejects a missing referenced image', async (t) => {
  const value = articleOn('2026-11-11');
  value.image = imageAsset(PNG_2X3, 'png');
  const root = await createRepo(t, fixture(value));
  assert.match(
    messages((await validateRepository(root)).errors),
    /image file "images\/.*\.png" is missing/,
  );
});

test('repository reports a missing referenced image inside an existing images directory', async (t) => {
  const value = articleOn('2026-11-11');
  value.image = imageAsset(PNG_2X3, 'png');
  const root = await createRepo(t, fixture(value));
  await mkdir(path.join(root, 'images'), { recursive: true });
  assert.match(
    messages((await validateRepository(root)).errors),
    /image file "images\/.*\.png" is missing/,
  );
});

test('repository rejects an image whose hash does not match metadata', async (t) => {
  const value = articleOn('2026-11-11');
  value.image = imageAsset(PNG_2X3, 'png');
  const corrupted = Buffer.from(PNG_2X3);
  corrupted[corrupted.length - 1] ^= 0xff;
  const root = await createRepo(t, fixture(value));
  await writeImage(root, value.image.path, corrupted);
  assert.match(
    messages((await validateRepository(root)).errors),
    /image\.sha256 does not match the stored image file/,
  );
});

test('repository rejects an image whose byteLength does not match the file', async (t) => {
  const value = articleOn('2026-11-11');
  value.image = imageAsset(PNG_2X3, 'png', {
    byteLength: PNG_2X3.length - 1,
  });
  const root = await createRepo(t, fixture(value));
  await writeImage(root, value.image.path, PNG_2X3);
  assert.match(
    messages((await validateRepository(root)).errors),
    /image\.byteLength must match the stored image file size/,
  );
});

test('repository rejects an image file larger than 1 MiB', async (t) => {
  const value = articleOn('2026-11-11');
  value.image = imageAsset(PNG_2X3, 'png', {
    byteLength: 1024 * 1024,
  });
  const root = await createRepo(t, fixture(value));
  await writeImage(root, value.image.path, Buffer.alloc(1024 * 1024 + 1));
  assert.match(
    messages((await validateRepository(root)).errors),
    /must be at most 1 MiB/,
  );
});

test('repository rejects a corrupt referenced image', async (t) => {
  const truncated = PNG_2X3.subarray(0, 16);
  const value = articleOn('2026-11-11');
  value.image = imageAsset(truncated, 'png', { width: 2, height: 3 });
  const root = await createRepo(t, fixture(value));
  await writeImage(root, value.image.path, truncated);
  assert.match(
    messages((await validateRepository(root)).errors),
    /must be a valid PNG image/,
  );
});

test('repository rejects an asset whose signature does not match its extension', async (t) => {
  const value = articleOn('2026-11-11');
  value.image = imageAsset(JPEG_2X3, 'png', { width: 2, height: 3 });
  const root = await createRepo(t, fixture(value));
  await writeImage(root, value.image.path, JPEG_2X3);
  assert.match(
    messages((await validateRepository(root)).errors),
    /must be a valid PNG image/,
  );
});

test('repository rejects dimensions that do not match the stored image', async (t) => {
  const value = articleOn('2026-11-11');
  value.image = imageAsset(PNG_2X3, 'png', { width: 3, height: 2 });
  const root = await createRepo(t, fixture(value));
  await writeImage(root, value.image.path, PNG_2X3);
  assert.match(
    messages((await validateRepository(root)).errors),
    /image\.width and image\.height must match the stored image/,
  );
});

test('repository rejects a referenced image path that is not a regular file', async (t) => {
  const value = articleOn('2026-11-11');
  value.image = imageAsset(PNG_2X3, 'png');
  const root = await createRepo(t, fixture(value));
  await mkdir(path.join(root, value.image.path), { recursive: true });
  assert.match(
    messages((await validateRepository(root)).errors),
    /must be a regular file/,
  );
});

test('repository rejects a symlinked referenced image', async (t) => {
  const value = articleOn('2026-11-11');
  value.image = imageAsset(PNG_2X3, 'png');
  const root = await createRepo(t, fixture(value));
  const realFile = path.join(root, 'real-image.png');
  await writeFile(realFile, PNG_2X3);
  await mkdir(path.join(root, 'images'), { recursive: true });
  try {
    await symlink(realFile, path.join(root, value.image.path));
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip(`symlinks unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.match(
    messages((await validateRepository(root)).errors),
    /must be a regular file/,
  );
});

test('repository rejects an images directory linked outside the repository', async (t) => {
  const value = articleOn('2026-11-11');
  value.image = imageAsset(PNG_2X3, 'png');
  const root = await createRepo(t, fixture(value));
  const external = await mkdtemp(path.join(tmpdir(), 'frp-external-images-'));
  t.after(() => rm(external, { recursive: true, force: true }));
  await writeFile(path.join(external, path.basename(value.image.path)), PNG_2X3);
  try {
    await linkDirectory(external, path.join(root, 'images'));
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip(`directory links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.match(
    messages((await validateRepository(root)).errors),
    /images\/ directory must resolve inside the repository root/,
  );
});

test('repository accepts a valid image when the root itself is a symlink', async (t) => {
  const value = articleOn('2026-11-11');
  value.image = imageAsset(PNG_2X3, 'png');
  const root = await createRepo(t, fixture(value));
  await writeImage(root, value.image.path, PNG_2X3);
  const aliasParent = await mkdtemp(path.join(tmpdir(), 'frp-root-alias-'));
  t.after(() => rm(aliasParent, { recursive: true, force: true }));
  const alias = path.join(aliasParent, 'repo');
  try {
    await linkDirectory(root, alias);
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOSYS'].includes(error.code)) {
      t.skip(`directory links unavailable: ${error.code}`);
      return;
    }
    throw error;
  }
  assert.deepEqual((await validateRepository(alias)).errors, []);
});

test('repository ignores unreferenced optional image files', async (t) => {
  const value = articleOn('2026-11-11');
  const root = await createRepo(t, fixture(value));
  await writeImage(root, 'images/unreferenced.png', PNG_2X3);
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
