export class AuthProxyError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 500) {
    super(message);
    this.name = 'AuthProxyError';
    this.statusCode = statusCode;
  }
}

export class UpstreamUnreachableError extends Error {
  readonly statusCode = 502;

  constructor(message: string) {
    super(message);
    this.name = 'UpstreamUnreachableError';
  }
}

export class SessionInvalidError extends Error {
  readonly statusCode = 401;

  constructor(message: string) {
    super(message);
    this.name = 'SessionInvalidError';
  }
}

export class OIDCConfigurationError extends Error {
  readonly statusCode = 500;

  constructor(message: string) {
    super(message);
    this.name = 'OIDCConfigurationError';
  }
}
