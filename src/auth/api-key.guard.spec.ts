import { Logger, UnauthorizedException } from '@nestjs/common';
import { ExecutionContext } from '@nestjs/common/interfaces';
import { Reflector } from '@nestjs/core';
import { ApiKeyGuard } from './api-key.guard';

describe('ApiKeyGuard', () => {
  let guard: ApiKeyGuard;
  let loggerWarnSpy: jest.SpyInstance;
  let reflector: Reflector;

  beforeEach(() => {
    process.env.API_KEY = 'secret-key';
    loggerWarnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    reflector = { getAllAndOverride: jest.fn().mockReturnValue(false) } as any;
    guard = new ApiKeyGuard(reflector);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.API_KEY;
  });

  it('не логуює значення API key при невдалій автентифікації', () => {
    const request = {
      headers: { 'x-api-key': 'leaked-key' },
      method: 'GET',
      originalUrl: '/search/tenders',
    };
    const context = {
      switchToHttp: () => ({
        getRequest: () => request,
      }),
      getHandler: () => ({}),
      getClass: () => ({}),
    } as unknown as ExecutionContext;

    expect(() => guard.canActivate(context)).toThrow(UnauthorizedException);
    expect(loggerWarnSpy).toHaveBeenCalledWith(
      'Failed authentication attempt for GET /search/tenders; api key provided: true',
    );
  });
});
