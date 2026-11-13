const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function validPath(value) {
  if (typeof value !== 'string' || !value || /[\0\r\n]/.test(value)) {
    throw new Error('Invalid file path.');
  }
  return value;
}

function validName(value) {
  validPath(value);
  if (value === '.' || value === '..' || /[/\\]/.test(value)) {
    throw new Error('Enter a name, not a path.');
  }
  return value;
}

function sortEntries(entries) {
  return entries.sort((a, b) =>
    Number(b.type === 'directory') - Number(a.type === 'directory') ||
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
}

async function listLocal(directory) {
  const resolved = path.resolve(validPath(directory));
  const entries = await fs.readdir(resolved, { withFileTypes: true });
  const items = await Promise.all(entries.map(async (entry) => {
    try {
      const info = await fs.stat(path.join(resolved, entry.name));
      return {
        name: entry.name,
        type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other',
        size: info.size,
        modified: info.mtimeMs,
      };
    } catch {
      return { name: entry.name, type: 'other', size: 0, modified: 0 };
    }
  }));
  return { path: resolved, parent: path.dirname(resolved), entries: sortEntries(items) };
}

async function downloadSafely(session, remote, destination) {
  validPath(destination);
  const temporary = path.join(path.dirname(destination), `.simple-transfer-${randomUUID()}.part`);
  try {
    await session.download(remote, temporary);
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

module.exports = { validPath, validName, sortEntries, listLocal, downloadSafely };
