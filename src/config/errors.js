class ConfigError extends Error {
  constructor(errors) {
    const messages = Array.isArray(errors) ? errors.map(String) : [String(errors)];
    super(messages.join('\n'));
    this.name = 'ConfigError';
    this.errors = messages;
  }
}

module.exports = { ConfigError };
