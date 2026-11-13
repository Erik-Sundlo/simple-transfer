const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validateConnection } = require('./session');

class ConnectionStore {
  constructor(filename, encryption) {
    this.filename = filename;
    this.encryption = encryption;
    this.records = [];
  }

  async load() {
    try {
      const data = JSON.parse(await fs.readFile(this.filename, 'utf8'));
      if (data.version !== 1 || !Array.isArray(data.connections)) throw new Error('Unsupported saved connections format.');
      this.records = data.connections;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  list() {
    return this.records.map(({ encryptedSecrets, ...profile }) => profile);
  }

  requireEncryption() {
    if (!this.encryption.isEncryptionAvailable()) {
      throw new Error('macOS Keychain encryption is unavailable. Unlock your login keychain and try again. Credentials will not be saved in plain text.');
    }
  }

  async resolve(input) {
    const config = validateConnection({
      protocol: input.protocol, host: input.host, port: input.port,
      username: input.username, auth: input.auth, password: input.password || '',
      passphrase: input.passphrase || '', keyPath: input.keyPath || '(stored key)',
    });
    const saved = this.records.find((record) => record.id === input.savedId);
    // Never reuse a saved secret for an edited server identity or authentication method.
    const matches = saved && ['protocol', 'port', 'username', 'auth'].every((key) => saved[key] === config[key]) &&
      saved.host.toLowerCase() === config.host.toLowerCase();
    const useKey = config.protocol === 'sftp' && config.auth === 'key';
    const needsSaved = matches && (useKey ? !input.keyPath : !config.password);
    let secrets = {};
    if (needsSaved) {
      this.requireEncryption();
      secrets = JSON.parse(this.encryption.decryptString(Buffer.from(saved.encryptedSecrets, 'base64')));
    }
    if (useKey) {
      if (input.keyPath) {
        config.privateKey = await fs.readFile(input.keyPath);
      } else if (secrets.privateKey) {
        config.privateKey = Buffer.from(secrets.privateKey, 'base64');
        config.passphrase ||= secrets.passphrase || '';
      } else {
        throw new Error('Choose a private SSH key.');
      }
    } else {
      config.password ||= secrets.password || '';
    }
    delete config.keyPath;
    return config;
  }

  async save(input, config) {
    this.requireEncryption();
    const previous = this.records.find((record) => record.id === input.savedId);
    const useKey = config.protocol === 'sftp' && config.auth === 'key';
    const secrets = useKey
      ? { privateKey: config.privateKey.toString('base64'), passphrase: config.passphrase || '' }
      : { password: config.password || '' };
    const record = {
      id: previous?.id || randomUUID(),
      name: String(input.name || '').trim() || `${config.username}@${config.host}`,
      protocol: config.protocol, host: config.host, port: config.port,
      username: config.username, auth: config.auth,
      keyLabel: useKey ? (input.keyPath ? path.basename(input.keyPath) : previous?.keyLabel || 'Imported SSH key') : '',
      hasKey: useKey,
      hasPassword: Boolean(secrets.password),
      hasPassphrase: Boolean(secrets.passphrase),
      encryptedSecrets: this.encryption.encryptString(JSON.stringify(secrets)).toString('base64'),
    };
    const next = this.records.filter((item) => item.id !== record.id);
    next.push(record);
    await this.persist(next);
    this.records = next;
    return record.id;
  }

  async remove(id) {
    const next = this.records.filter((record) => record.id !== id);
    await this.persist(next);
    this.records = next;
  }

  async persist(records) {
    await fs.mkdir(path.dirname(this.filename), { recursive: true, mode: 0o700 });
    const temporary = `${this.filename}.tmp`;
    try {
      await fs.writeFile(temporary, JSON.stringify({ version: 1, connections: records }, null, 2), { mode: 0o600 });
      await fs.rename(temporary, this.filename);
    } finally {
      await fs.rm(temporary, { force: true });
    }
  }
}

module.exports = { ConnectionStore };
