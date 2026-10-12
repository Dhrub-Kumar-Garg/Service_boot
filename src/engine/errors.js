class EngineError extends Error {
  constructor(message, { reason, serviceName }) {
    super(message);
    this.name = 'EngineError';
    this.reason = reason;
    this.serviceName = serviceName;
  }
}

module.exports = { EngineError };
