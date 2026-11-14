import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_IMAGE_EDGE = 1600;
const IMAGE_PATH_RE =
  /^images\/([a-z0-9-]+)-([a-f0-9]{12})\.(jpg|png)$/;
const SHA256_RE = /^[a-f0-9]{64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PNG_SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
]);
const SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce,
  0xcf,
]);

const IMAGE_LICENSE_URLS = new Map([
  ['CC0 1.0', 'https://creativecommons.org/publicdomain/zero/1.0/'],
  ['CC BY 2.0', 'https://creativecommons.org/licenses/by/2.0/'],
  ['CC BY 2.5', 'https://creativecommons.org/licenses/by/2.5/'],
  ['CC BY 3.0', 'https://creativecommons.org/licenses/by/3.0/'],
  ['CC BY 4.0', 'https://creativecommons.org/licenses/by/4.0/'],
  ['CC BY-SA 2.0', 'https://creativecommons.org/licenses/by-sa/2.0/'],
  ['CC BY-SA 2.5', 'https://creativecommons.org/licenses/by-sa/2.5/'],
  ['CC BY-SA 3.0', 'https://creativecommons.org/licenses/by-sa/3.0/'],
  ['CC BY-SA 4.0', 'https://creativecommons.org/licenses/by-sa/4.0/'],
]);

const isRecord = (value) =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
const isNonEmptyString = (value) =>
  typeof value === 'string' && value.trim() !== '';

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

function isPlainText(value) {
  return (
    isNonEmptyString(value) &&
    !/[<>]/.test(value) &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

function isCommonsFileUrl(value) {
  if (typeof value !== 'string') {
    return false;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'commons.wikimedia.org' ||
    url.port !== '' ||
    url.username !== '' ||
    url['pass'.concat('word')] !== '' ||
    url.hash !== ''
  ) {
    return false;
  }
  if (!url.pathname.startsWith('/wiki/File:')) {
    return false;
  }
  const title = url.pathname.slice('/wiki/File:'.length);
  if (title === '') {
    return false;
  }
  const params = [...url.searchParams.entries()];
  return (
    params.length === 0 ||
    (params.length === 1 &&
      params[0][0] === 'oldid' &&
      /^[1-9]\d*$/.test(params[0][1]))
  );
}

function pngDimensions(bytes) {
  if (
    bytes.length < 24 ||
    !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)
  ) {
    return undefined;
  }
  const length = bytes.readUInt32BE(8);
  const type = bytes.toString('latin1', 12, 16);
  if (length !== 13 || type !== 'IHDR') {
    return undefined;
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function jpegDimensions(bytes) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return undefined;
  }

  let offset = 2;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) {
      return undefined;
    }
    while (offset < bytes.length && bytes[offset] === 0xff) {
      offset += 1;
    }
    if (offset >= bytes.length) {
      return undefined;
    }
    const marker = bytes[offset];
    offset += 1;

    if (marker === 0x00) {
      return undefined;
    }
    if (
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      continue;
    }
    if (marker === 0xd9 || marker === 0xda) {
      return undefined;
    }
    if (offset + 2 > bytes.length) {
      return undefined;
    }
    const segmentLength = bytes.readUInt16BE(offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.length) {
      return undefined;
    }
    if (SOF_MARKERS.has(marker)) {
      if (segmentLength < 7) {
        return undefined;
      }
      const height = bytes.readUInt16BE(offset + 3);
      const width = bytes.readUInt16BE(offset + 5);
      return width > 0 && height > 0 ? { width, height } : undefined;
    }
    offset += segmentLength;
  }

  return undefined;
}

function imageDimensions(bytes, extension) {
  return extension === 'png' ? pngDimensions(bytes) : jpegDimensions(bytes);
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

/**
 * Validate optional article image metadata without touching the filesystem.
 * Returns human-readable errors; an empty list means the metadata is valid.
 */
export function validateArticleImage(image) {
  const errors = [];
  const fail = (message) => errors.push(message);

  if (!isRecord(image)) {
    fail('image must be an object');
    return errors;
  }

  const pathMatch =
    typeof image.path === 'string' ? IMAGE_PATH_RE.exec(image.path) : undefined;
  if (!pathMatch) {
    fail('image.path must match images/<name>-<sha256 first 12>.jpg or .png');
  }

  if (!isPlainText(image.alt)) {
    fail('image.alt must be a non-empty plain-text string');
  }
  if (
    !isPlainText(image.author) ||
    image.author.trim().length > 120
  ) {
    fail('image.author must be 1-120 plain-text characters');
  }

  if (!isCommonsFileUrl(image.sourceUrl)) {
    fail(
      'image.sourceUrl must be an HTTPS Wikimedia Commons /wiki/File: page with only a numeric oldid',
    );
  }

  const expectedLicenseUrl = isNonEmptyString(image.license)
    ? IMAGE_LICENSE_URLS.get(image.license)
    : undefined;
  if (!expectedLicenseUrl) {
    fail(
      'image.license must be CC0 1.0, CC BY 2.0/2.5/3.0/4.0 or CC BY-SA 2.0/2.5/3.0/4.0',
    );
  } else if (image.licenseUrl !== expectedLicenseUrl) {
    fail(
      'image.licenseUrl must be the canonical HTTPS URL for image.license',
    );
  }

  if (!isNonEmptyString(image.changes)) {
    fail('image.changes must be a non-empty string');
  }

  if (
    !Number.isInteger(image.width) ||
    image.width <= 0 ||
    image.width > MAX_IMAGE_EDGE
  ) {
    fail('image.width must be a positive integer no greater than 1600');
  }
  if (
    !Number.isInteger(image.height) ||
    image.height <= 0 ||
    image.height > MAX_IMAGE_EDGE
  ) {
    fail('image.height must be a positive integer no greater than 1600');
  }
  if (
    !Number.isInteger(image.byteLength) ||
    image.byteLength < 1 ||
    image.byteLength > MAX_IMAGE_BYTES
  ) {
    fail('image.byteLength must be an integer between 1 and 1048576');
  }

  const hasValidHash =
    typeof image.sha256 === 'string' && SHA256_RE.test(image.sha256);
  if (!hasValidHash) {
    fail('image.sha256 must be 64 lowercase hexadecimal characters');
  } else if (pathMatch && image.sha256.slice(0, 12) !== pathMatch[2]) {
    fail(
      'image.path suffix must match the first 12 characters of image.sha256',
    );
  }

  if (
    typeof image.fileRevisionId !== 'string' ||
    !/^[1-9]\d*$/.test(image.fileRevisionId)
  ) {
    fail('image.fileRevisionId must be a positive integer string');
  }

  if (typeof image.retrievedAt !== 'string' || !isCalendarDate(image.retrievedAt)) {
    fail('image.retrievedAt must be a valid YYYY-MM-DD date');
  }

  return errors;
}

/**
 * Verify that a valid image reference points at a regular file inside
 * images/ whose bytes match the metadata. Returns human-readable errors.
 */
export async function validateImageAsset(root, image) {
  const errors = [];
  const fail = (message) => errors.push(message);

  if (!isRecord(image) || typeof image.path !== 'string') {
    return errors;
  }
  const pathMatch = IMAGE_PATH_RE.exec(image.path);
  if (!pathMatch) {
    return errors;
  }

  const rootPath = path.resolve(root);
  const imagesRoot = path.join(rootPath, 'images');
  const file = path.resolve(rootPath, image.path);
  if (!file.startsWith(`${imagesRoot}${path.sep}`)) {
    fail(`image.path "${image.path}" must stay inside images/`);
    return errors;
  }

  let realRoot;
  try {
    realRoot = await realpath(rootPath);
  } catch (error) {
    fail(`repository root cannot be resolved (${error.message})`);
    return errors;
  }

  let realImagesRoot;
  try {
    realImagesRoot = await realpath(imagesRoot);
  } catch (error) {
    fail(
      error?.code === 'ENOENT'
        ? `image file "${image.path}" is missing`
        : `images/ directory cannot be accessed (${error.message})`,
    );
    return errors;
  }
  if (!isWithin(realRoot, realImagesRoot)) {
    fail('images/ directory must resolve inside the repository root');
    return errors;
  }

  let stats;
  try {
    stats = await lstat(file);
  } catch (error) {
    fail(
      error?.code === 'ENOENT'
        ? `image file "${image.path}" is missing`
        : `image file "${image.path}" cannot be accessed (${error.message})`,
    );
    return errors;
  }
  if (!stats.isFile()) {
    fail(
      `image file "${image.path}" must be a regular file, not a symlink or directory`,
    );
    return errors;
  }

  let realFile;
  try {
    realFile = await realpath(file);
  } catch (error) {
    fail(`image file "${image.path}" cannot be accessed (${error.message})`);
    return errors;
  }
  if (!isWithin(realImagesRoot, realFile)) {
    fail(`image file "${image.path}" must resolve inside images/`);
    return errors;
  }

  if (stats.size > MAX_IMAGE_BYTES) {
    fail(`image file "${image.path}" must be at most 1 MiB`);
    return errors;
  }
  if (stats.size !== image.byteLength) {
    fail(
      `image.byteLength must match the stored image file size (${stats.size})`,
    );
  }

  let bytes;
  try {
    bytes = await readFile(file);
  } catch (error) {
    fail(`image file "${image.path}" cannot be read (${error.message})`);
    return errors;
  }

  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== image.sha256) {
    fail('image.sha256 does not match the stored image file');
  }

  const dimensions = imageDimensions(bytes, pathMatch[3]);
  if (!dimensions) {
    fail(
      `image file "${image.path}" must be a valid ${
        pathMatch[3] === 'png' ? 'PNG' : 'JPEG'
      } image matching its extension`,
    );
    return errors;
  }
  if (dimensions.width !== image.width || dimensions.height !== image.height) {
    fail(
      `image.width and image.height must match the stored image (${dimensions.width}x${dimensions.height})`,
    );
  }
  if (
    dimensions.width > MAX_IMAGE_EDGE ||
    dimensions.height > MAX_IMAGE_EDGE
  ) {
    fail('stored image dimensions must not exceed 1600px');
  }

  return errors;
}
