import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable } from 'rxjs';

export const IS_PUBLIC_KEY = 'isPublic';

@Injectable()
export class ApiKeyGuard implements CanActivate {
    private readonly logger = new Logger(ApiKeyGuard.name);

    constructor(private reflector: Reflector) {}

    canActivate(
        context: ExecutionContext,
    ): boolean | Promise<boolean> | Observable<boolean> {
        if (context.getType<string>() !== 'http') {
            return true;
        }

        const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
            context.getHandler(),
            context.getClass(),
        ]);
        if (isPublic) return true;

        const request = context.switchToHttp().getRequest();
        const apiKey = request.headers['x-api-key'];
        const hasApiKey = Array.isArray(apiKey)
            ? apiKey.length > 0
            : typeof apiKey === 'string' && apiKey.length > 0;

        const validApiKey = process.env.API_KEY;

        if (!validApiKey) {
            this.logger.error('API_KEY environment variable is not set. Denying all requests for safety.');
            throw new UnauthorizedException('API Key is missing or invalid');
        }

        if (apiKey === validApiKey) {
            return true;
        }

        this.logger.warn(
            `Failed authentication attempt for ${request.method} ${request.originalUrl || request.url}; api key provided: ${hasApiKey}`,
        );
        throw new UnauthorizedException('API Key is missing or invalid');
    }
}
